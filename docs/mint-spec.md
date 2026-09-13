# The mint

A Chainlink CRE workflow. It watches the deposit ledger, it blind-signs the points of a
deposit inside a TEE, and it announces the signatures through the forwarder.

The Go source is `workflow/blindmint`. The cryptography is `workflow/mint`. The encoding
is `workflow/announce`.

## Why it exists

A Chaumian mint holds the signing key. Whoever holds that key can sign a note that nobody
deposited for, so the classic design asks the user to trust the operator not to inflate
the supply.

A Confidential Workflow moves the key somewhere the operator cannot read it. The key is
released by the Vault DON into an attested enclave. The handler that uses it runs inside
that enclave. Node operators never see the scalar.

**The enclave holds the mint keys. It never holds funds.** A broken enclave can refuse to
sign. It cannot move money.

## What it does not do

- **It does not hold value.** The contract holds every deposit. The mint has no balance
  and no withdrawal path.
- **It does not choose which addresses get notes.** It signs blinded points. It cannot see
  an address, and it learns nothing from signing one.
- **It does not refund.** `refundByMint` exists on the contract and the mint never calls
  it. A deposit the mint cannot answer stays `Pending` until the depositor reclaims it
  after the deadline.
- **It does not log.** A log inside the enclave leaks timing, and timing is the link that
  blinding removes.

## The two triggers

`InitWorkflow` registers both handlers with `cre.HandlerInTee`, against
`cre.OneOfTees{cre.Nitro{Regions: []cre.NitroRegion{cre.NitroUsWest2}}}`.

```go
return cre.Workflow[*Config]{
    cre.HandlerInTee(trigger, onDeposit, teeRequirements),
    cre.HandlerInTee(sweep, onSweep, teeRequirements),
}, nil
```

| Trigger | Fires on | Handler |
|---|---|---|
| `evm.LogTrigger` | `Deposited(uint256,address,uint256,bytes[])` at the `BlindMint` address | `onDeposit` |
| `cron.Trigger` | `0 */5 * * * *` by default, a six-field form with seconds | `onSweep` |

The log trigger is the normal path. The sweep is the catch-up, and the next section says
why it is necessary.

`InitWorkflow` refuses an empty ladder and a zero chain selector. It discards the logger
and the secrets provider arguments, because neither may be used from a handler.

## The sweep exists because a log trigger can miss

A log trigger answers the events it sees. It does not answer an event it did not see. A
restart, a re-deployment, or a window where no workflow was running all leave a deposit
`Pending` with nobody to sign it.

The deposit ledger is the record that does not depend on catching an event. `onSweep`
reads it:

1. `nextId()` through one `CallContract`.
2. `deposits(id)` for each id from 1 to `nextId - 1`.
3. Keep the rows where `Status == StatusPending`, through `DepositState.Waiting()`.

If nothing waits, the handler returns `"no deposit waits"` and makes no log search at all.

**The ledger row says which deposits wait. It does not say what to sign.** The row carries
`Points` as a count, not as values, because the contract never stores a blinded point. So
the handler then reads the one `Deposited` log for that identifier, filtered on two topic
slots, the event signature and `IDTopic(id)`.

That log search is bounded to `CatchUpBlocks`, 20,000 by default, back from the head. Arc
refuses a wider range. A deposit whose log has fallen outside the served range is skipped
with a `continue`. Its money is not lost, because the depositor reclaims it after the
deadline.

The sweep holds no cursor and keeps no state. It rescans every identifier on every tick.
`announce` refuses a deposit that is not `Pending`, so a deposit that the log trigger
already answered costs one reverted write at worst. Nothing double mints.

The handler returns `"answered %d of %d waiting deposits"`.

**Known limitation.** The scan is one `CallContract` for each identifier, from 1 upward,
and it grows without a bound. A production mint needs a cursor or a paged ledger read.

## What crosses the enclave boundary

The handler body runs inside the enclave. Every chain interaction crosses back out through
one call:

```go
don := runtime.UsingTheDons()
```

`UsingTheDons` is not a one-way door. It returns a `cre.Runtime`. The handler stays inside
the enclave and only the requests leave.

| Inside the enclave | On the DON |
|---|---|
| `runtime.GetSecrets(...)`, the mint scalars | `don.GenerateReport(...)` |
| `mint.New`, `SignDeposit`, `Key.BlindSign` | `client.WriteReport(don, ...)` |
| `announce.DecodeDeposit`, `announce.EncodeReport` | `client.CallContract(don, ...)` |
| | `client.HeaderByNumber`, `client.FilterLogs` |

The one sensitive input is the set of per-denomination BLS12-381 secret scalars. They are
fetched by secret identifier, trimmed of `0x`, parsed base 16, and held in the unexported
field `Key.sk`.

Only the blind signatures cross to the DON. A blind signature is public once announced, so
nothing confidential leaves the enclave.

This is what satisfies the Chainlink requirement that the confidential portion process at
least one sensitive value, and that it be meaningfully integrated. The mint key is the
whole product. There is no version of teecash where the enclave is a placeholder.

## The mint chooses the split

The client sends a cap. It does not send a prediction.

`SignDeposit(amount, blindedPoints)` calls `Split(amount, len(blindedPoints))`. The number
of blinded points in the deposit is therefore the ceiling on the number of notes, and
nothing else constrains the mint's choice.

```go
func (m *Mint) Mintable(amount *big.Int) *big.Int {
	if amount == nil || amount.Cmp(m.rung) < 0 {
		return new(big.Int)
	}
	out := new(big.Int).Div(amount, m.rung)
	out.Sub(out, big.NewInt(1))
	return out.Mul(out, m.rung)
}
```

That is `(amount/rung - 1) * rung`. It must agree with `BlindMint.mintable` in Solidity and
`mintable` in `lib-blind/src/denominations.ts`. A disagreement makes every announcement
revert, and it shows up nowhere else.

`Split` is greedy over a ladder sorted largest first:

1. A non-positive amount is an error.
2. `Mintable(amount)` of zero returns an empty split and **no error**. This check runs
   before the point check, so a melt of dust with no points is legal.
3. Zero points with a non-zero mintable value is an error.
4. Take the largest rung that fits, repeatedly. Running past `maxPoints` is an error.
5. A remainder the ladder cannot express is an error.

Greedy gives the fewest notes. The contract checks the sum and the point indexes only, so
the mint is free in its choice. A later version can pick a split that makes notes harder to
distinguish, and nothing on chain has to change.

A note carries `PointIndex`, `Denom` and `BlindSig`. Points are consumed in order from
index 0.

## A deposit that mints nothing

`Mintable` returns zero below two rungs. `Split` returns an empty slice. `SignDeposit`
returns no notes. `EncodeReport` packs the identifier with three empty arrays, and the
announcement is written with zero notes. The contract accepts it, because the sum still
agrees.

`DecodeDeposit` therefore permits an empty `bytes[]`.

An earlier version refused the empty list there. The refusal ran before the split, so the
mint stopped on every melt of dust, and it stopped inside the enclave where a log is
forbidden. The deposit stayed `Pending` with nothing anywhere to say why. This is the
failure mode the no-logging rule creates, and it is worth remembering.

## The report path

Both handlers funnel into `signAndAnnounce`.

1. `loadKeys` fetches every secret in one batched `GetSecrets`, then `mint.New(keys)`.
2. `m.SignDeposit(deposit.Amount, deposit.BlindedPoints)`.
3. `announce.EncodeReport(deposit.ID, notes)`.
4. Cross to the DON and sign the report:

```go
signed, err := don.GenerateReport(&cre.ReportRequest{
    EncodedPayload: payload,
    EncoderName:    "evm",
    SigningAlgo:    "ecdsa",
    HashingAlgo:    "keccak256",
}).Await()
```

5. `client.WriteReport(don, write)` with `Receiver` set to the `BlindMint` address.

The forwarder delivers the report to `onReport`, which decodes it and announces. The Go
code never names a forwarder address; the forwarder is the mechanism behind `WriteReport`.

The report payload is:

```
id            uint256
pointIndexes  uint256[]
denoms        uint256[]
blindSigs     bytes[]
```

Both sides must use this field order. `BlindMint.onReport` decodes exactly these four.

`DecodeReport` exists for tests only. The contract does the same work in Solidity.

A receiver must answer `supportsInterface`. The forwarder checks ERC-165 before it
delivers, and a receiver that fails the check gets no report while the forwarder's own
transaction still succeeds. That failure is silent.

## The ladder and the secrets

Five rungs, in base units of an 18-decimal token:

| Denomination | Secret identifier |
|---|---|
| `10000000000000000` | `MINT_KEY_1_CENT` |
| `100000000000000000` | `MINT_KEY_10_CENT` |
| `1000000000000000000` | `MINT_KEY_1_USDC` |
| `10000000000000000000` | `MINT_KEY_10_USDC` |
| `100000000000000000000` | `MINT_KEY_100_USDC` |

`secrets.yaml` maps each identifier to an environment variable, `MINT_KEY_1_CENT` to
`SECRET_MINT_KEY_1_CENT` and so on. The Vault DON releases them into the attested enclave.

**The CRE templates permit 11 secrets for each invocation, so the ladder stops there.** All
five are fetched on every deposit.

`NewKey` validates that the denomination is above zero and that the scalar is in the range
1 to order-1.

**One absent value stops every mint, and it stops it silently**, because the enclave asks
for all five and cannot log the failure.

## Configuration

| Field | Meaning |
|---|---|
| `chainSelector` | `3034092155422581607` for Arc testnet |
| `blindMint` | the contract address |
| `ladder` | `denom` in base units and `secretId`, for each rung |
| `catchUpSchedule` | default `0 */5 * * * *` |
| `catchUpBlocks` | default `20000` |

`workflow.yaml` names two targets, `staging-settings` and `production-settings`.
`project.yaml` points staging at a local anvil on `127.0.0.1:8545` and production at
`rpc.testnet.arc.io`, both under the chain name `arc-testnet`.

A local anvil must run with `--chain-id 5042002`, because the contract builds its domain
tag from `block.chainid`.

## The build

`blindmint/main.go` is the whole WASM entry point and it carries `//go:build wasip1`:

```go
func main() {
	wasm.NewRunner(cre.ParseJSON[Config]).Run(InitWorkflow)
}
```

The tag means the host toolchain sees `workflow.go` without a `main` function, so `go test`
and `go vet` work on the package.

`mint` and `announce` carry no build tag and no CRE dependency. Their tests run on the
host, against `lib-blind/vectors.json`, and they are the reason the Go side of the
cryptography is testable at all.

```
GOOS=wasip1 GOARCH=wasm go build -o /dev/null ./blindmint/
```

## Running it

`cre workflow simulate --listen` runs the mint as a service. It fires on every matching log
and it re-arms. A one-shot run needs `--evm-tx-hash` and `--evm-event-index` instead, and
on Arc the event index is 1 because a native value move emits an ERC-20 `Transfer` log
first.

A second trigger makes the simulator prompt for a choice. Every recipe therefore passes
`--trigger-index` and `--non-interactive`, or the run dies with "could not open a new TTY".

`--listen` does not support cron, so the sweep runs by hand locally with `just mint-sweep`.
In a DON its own schedule fires it. `just mint-pending` lists what waits and reads only.

## What is not demonstrated

**The mint has not run inside a real enclave.** `cre workflow simulate` executes the TEE
handler locally and the simulator states that it is not a real TEE. Confidential Workflows
is in private beta and this account does not hold deploy access.

So the inflation property holds by design and not by demonstration. In every run so far the
mint key sat in a local file and a local process read it.

A real deployment must run the handler in an attested enclave. Until it does, the mint is
trusted not to sign off band, exactly as in a classic Chaumian mint. The contract check
`totalClaimed <= totalAnnounced` bounds the damage either way.

A design that is properly immune to inflation would generate ephemeral keys inside the
enclave, and would rotate the contract address, the signing keys and the mint code as one
atomic unit.
