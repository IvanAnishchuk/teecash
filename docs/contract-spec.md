# The contract

`BlindMint` is the only contract. It holds the deposits, it publishes the blind
signatures, and it pays a wallet that presents a good note.

## Why it exists

A Chaumian mint needs one public place. The depositor must be able to lock value where the
mint can see it. The mint must be able to publish a signature where the client can read
it. The holder of a note must be able to present it to something that pays.

The contract is that place. It is also the only part of the system that a user must trust
to hold money, because the mint never touches the value.

## What it does not do

- **It does not link a claim to a deposit.** This is the whole point of the design, and it
  is a property of the storage layout and not of a policy. See below.
- **It does not choose a denomination.** The mint chooses the split. The contract checks
  the sum. See [the mint](mint-spec.md).
- **It does not know which wallet belongs to which depositor.** It never learns this,
  because a blinded point carries no address.
- **It does not verify that a signature was announced.** `claim` cannot tell. The bound
  `totalClaimed <= totalAnnounced` is the only defence against a mint that signs off band.

## The ledgers never meet

The contract keeps two records and they share no field.

| Ledger | Holds | Read by |
|---|---|---|
| `deposits` | the depositor, the amount, the point count, the deadline and the status | `announce`, `refundByMint`, `refundByDepositor` |
| `claimed` | one flag for each address that took a note | `claim` |

`claim` reads `mintPubkeys` and `claimed`. It reads nothing else. It never looks at a
deposit identifier, and it has no way to find one.

**The contract never stores a blinded point.** A point reaches the chain in the
`Deposited` event and in the `Announced` event. An event is not storage, and no function
reads one. So the contract holds no value that a later claim could match against.

This is a structural property. It cannot be weakened by mistake, only by somebody who adds
a lookup. Do not add one.

## The state

```solidity
enum Status { None, Pending, Announced, Refunded }

struct Deposit {
    address depositor;
    uint96  amount;
    uint32  points;
    uint64  deadline;
    Status  status;
}
```

The struct fits in two words. `uint96` bounds a deposit, which is why `deposit` rejects a
value above `type(uint96).max`.

| Immutable | Meaning |
|---|---|
| `forwarder` | the CRE forwarder, the only caller that can announce or refund by mint |
| `treasury` | the account that receives the mint tax |
| `refundDelay` | the wait before a depositor can reclaim a pending deposit |
| `rung` | the smallest denomination of the ladder |

The constructor takes the ladder as `denoms` and `pubkeys` of equal length. It writes
`mintPubkeys[denom]` for each rung, and it takes `rung` as the smallest denomination it
saw. A zero denomination is rejected, and a public key of the wrong length is rejected.

`dst` is built once in the constructor from the chain identifier and the contract address.

## The tax

```solidity
function mintable(uint256 amount) public view returns (uint256) {
    if (amount < rung) return 0;
    return (amount / rung - 1) * rung;
}
```

The tax is one rung plus every base unit below the rung. The result is always a multiple
of the rung, so the ladder can express it.

Three consequences follow and each one matters.

- **A deposit below two rungs mints nothing.** `mintable` returns zero. The deposit is
  legal, and the treasury takes all of it. A melt uses this to empty a wallet of dust.
- **The tax pays for the mint transaction and the claim transaction.** The treasury holds
  no other role. It cannot announce, it cannot refund and it cannot claim.
- **A refund pays no tax.** The mint signed nothing, so it takes nothing. `_refund`
  returns the whole amount.

`mintable` appears in Solidity, in Go and in TypeScript. All three must agree. When they
disagree, every announcement reverts with `SumMismatch`, and nothing else shows the fault.

## `deposit`

```solidity
function deposit(bytes[] calldata blindedPoints) external payable returns (uint256 id)
```

The caller sends value and a list of blinded G2 points of 256 bytes each. The count is the
ceiling on the split, and not a prediction of it. Send more points than the smallest split
needs.

The checks are:

| Check | Reason |
|---|---|
| a point list may be empty only when `mintable(msg.value)` is zero | such a deposit takes no note, so a point would cost the depositor a wallet for nothing |
| `blindedPoints.length <= MAX_POINTS` (256) | the duplicate check in `announce` is a 256-bit map |
| `msg.value != 0` | a deposit of nothing has no meaning |
| `msg.value <= type(uint96).max` | the struct field |
| every point is 256 bytes | the EIP-2537 G2 layout |

The deposit takes the next identifier, it records a deadline of `block.timestamp +
refundDelay`, and it emits `Deposited`.

## `announce`

```solidity
function announce(uint256 id, uint256[] pointIndexes, uint256[] denoms, bytes[] blindSigs)
    external onlyForwarder
```

Only the forwarder can call it. `onReport` decodes the same four values out of a CRE
report and calls the same private function, so the two paths cannot drift.

The denominations are public, so the contract can add them. Blinding hides the address of
a note. Blinding does not hide the key that signed it.

The checks are:

- the deposit is `Pending`
- the three arrays have equal length
- every point index is below the deposit's point count
- no point index repeats, tracked in a 256-bit map
- every denomination is a known rung
- every signature is 256 bytes
- **`sum(denoms) == mintable(amount)`**

The sum check is the one that matters. It is why the mint cannot inflate the supply by
announcing more value than the deposit holds, whatever happens inside the enclave.

An empty note list is a legal announcement. It is legal only for a deposit that mints
nothing, because the sum must still agree. No separate count check is needed.

The function then sets the status to `Announced`, it adds the sum to `totalAnnounced`, it
emits `Announced`, and it sends the tax to the treasury **last**. The transfer runs after
every write. A treasury that refused the value would revert the forwarder's delivery.

## `claim`

```solidity
function claim(uint256 denom, address wallet, bytes calldata sig) external
```

Any account can send this call. The value goes to the signed address, so a stolen call
funds a wallet that the thief does not hold. This is why a relayer is safe to run.

The checks, in order:

1. the denomination is a known rung
2. `claimed[wallet]` is false
3. `totalClaimed + denom <= totalAnnounced`
4. `BLS.verify(pubkey, wallet, sig, dst)`

Check 3 is the bound on a mint that signs off band. The contract cannot tell whether a
signature was announced, so it bounds the total instead. A mint that signs a note it never
announced steals from the last honest claimant and not from the contract.

The contract then sets the flag, it adds the denomination to `totalClaimed`, it emits
`Claimed`, and it pays.

**The claimed set is keyed on the address alone.** It is not keyed on the address and the
denomination. So a wallet's balance equals its denomination, and one address cannot take
two notes.

## The verification

`BLS.verify` recomputes `H_to_G2(A)` from the address it is about to pay. It does not take
a point from the caller.

```
e(pk, H_to_G2(A)) == e(G1, S)
```

The library runs this as one pairing check of two pairs, `e(pk, Y) * e(-G1, S) == 1`,
against the EIP-2537 precompiles.

| Precompile | Address | Use |
|---|---|---|
| `MODEXP` | `0x05` | reduce a 64-byte value modulo p |
| `G2ADD` | `0x0d` | add the two mapped points |
| `PAIRING` | `0x0f` | the pairing check |
| `MAP_FP2_TO_G2` | `0x11` | map an Fp2 element to G2 |

`hashToG2` follows RFC 9380. It expands the message to 256 uniform bytes with
`expand_message_xmd` over SHA-256, it reads two Fp2 elements, it maps each one, and it
adds the results. The precompile clears the cofactor for each point. Cofactor clearing is
a scalar multiplication and it distributes over addition, so the order of the two steps
does not change the result.

A public key is a G1 point of 128 bytes. A signature is a G2 point of 256 bytes with c0
before c1. Each coordinate takes one 64-byte word with 16 leading zero bytes.

## The domain tag

```
TEECASH_V1_<chainid>_<lowercase 0x address>_BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_
```

The tag covers the chain identifier and the contract address. It does not cover the
denomination, because one key for each denomination already binds that.

The tag is built in the constructor and it must equal the tag that
`lib-blind/src/domain.ts` builds for the same chain and address. A local anvil must
therefore run with `--chain-id 5042002` to reuse a mainnet vector.

## Refunds

| Function | Caller | Condition |
|---|---|---|
| `refundByMint` | the forwarder | the deposit is `Pending` |
| `refundByDepositor` | the depositor | the deposit is `Pending` and `block.timestamp >= deadline` |

The first is for a mint that reads a deposit and refuses to sign it. **The current mint
never calls it.** A deposit that the mint cannot answer stays `Pending`, and the depositor
reclaims it with the second function. A dead mint cannot keep the money.

A refund returns the whole deposit and takes no tax.

## ERC-165

```solidity
function supportsInterface(bytes4 interfaceId) external pure returns (bool)
```

The forwarder checks ERC-165 before it delivers a report. **A receiver that fails the
check gets no report, and the forwarder's own transaction still succeeds.** The failure is
therefore silent, and this function is necessary rather than decorative.

`BlindMint` is the receiver itself. Nothing sits between the forwarder and the mint.

## Deployment

The contract deploys through the canonical CREATE2 deployer at
`0x4e59b44847b379578588920cA78FbF26c0B4956C` under a fixed salt. Its address therefore
depends on the forwarder, the ladder and the mint public keys alone.

The same inputs give the same address on every chain and on every run, and no
configuration file has to follow the address.

## Gas

A claim costs about 371,000 gas the first time and about 354,000 after. The pairing check
dominates. The first claim pays for a cold storage slot that later claims find warm.
