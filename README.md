# teecash

**Trustless Encrypted eCash.**

A client blinds a set of wallet addresses and deposits USDC against them. A Chainlink CRE
Confidential Workflow acts as the mint. Inside a TEE it blind-signs those addresses, each
with a per-denomination BLS12-381 key. The client unblinds. Anyone can then present an
unblinded signature, and the contract pays that wallet its denomination. A relayer is the
practical way to present it, because the claim must not come from the depositor.

The result is a set of ordinary funded wallets. No chain observer can tie them to the
deposit.

On Arc the denomination is the gas token. A wallet that receives a note can spend it at
once and needs no funding transaction.

A Confidential Workflow addresses the central weakness of the classic Chaumian design.
The mint key never leaves the enclave, so an operator cannot sign off band and inflate
the supply. See **Status** below for how far this is demonstrated.

Privy addresses as receivers remove the long-term client-side secret. The blinding factor
is ephemeral and the client discards it after unblinding. Nothing else needs to survive.

## Status

Proof of concept. The whole path runs on Arc testnet: deposit, mint, announce, claim and
spend.

**The mint has not run inside a real enclave.** `cre workflow simulate` executes the TEE
handler locally, and the simulator states that it is not a real TEE. Chainlink
Confidential Workflows is in private beta, and this account does not hold deploy access.
In every run so far the mint key sat in a local file and a local process read it.

The inflation property above therefore holds by design and not by demonstration. A real
deployment must run the handler in an attested enclave. Until it does, the mint is trusted
not to sign off band, exactly as in a classic Chaumian mint. The contract check
`totalClaimed <= totalAnnounced` bounds the damage either way.

An implementation that is properly immune to inflation would use ephemeral private keys
generated within the enclave, and would rotate contract address, signing keys, and mint
code as a single atomic entity. That, plus a proper audit of new versions of the code,
would make attacks by the operator practically impossible. Guidelines for upgrades are
well researched and tested by L2 teams.

The anonymity set is not properly modeled here. Realistically it requires batching
announcements from multiple deposit operations within the short minting window.
It is an essential part of any serious privacy project and it comes with a time
vs anonymity pool size tradeoff.

Hiding total balance and making account unlinkable from Privy point of view is a
non-goal for this PoC although hard privacy of that kind is possible at the cost
of managing a bunch of private keys client-side. Making those links unobservable
to external actors without introducing trust assumptions (like custodial
services do) or unwieldy UX (like hardcore mixers do) was a goal, and this
demonstrates that it is possible.

Well-researched constructions exist for aggregate blind signatures and are not
used in this PoC. It is possible to introduce mint multi-signatures without
changes into verifier code.

PQ-safe constructions for blind signatures also exist. Switching to one of them
once optimized verification is available is trivial although would likely add
significant computation and gas tradeoffs. Importantly, long-term fund safety does
not depend on the quantum-safety of the mint signature scheme. Minting is meant to
be reasonably quick, and beyond it funds sit in regular accounts, with no security
assumptions beyond those of the underlying chain.

## Deployment

Arc testnet, chain ID 5042002.

| Contract | Address |
|---|---|
| `BlindMint` | `0xfa862110c5b64395c3dffea7c8b7e9b3b08971f4` |
| `MintConsumer` | `0x1e65a452d0a31ba125af2bf1e8e617053b336946` |

Measured cost on Arc:

| Step | Gas | Cost |
|---|---|---|
| Deploy both contracts | — | 0.0565 USDC |
| `deposit` | 123,026 | 0.0026 USDC |
| `claim` | 371,486 | 0.0078 USDC |
| `spend` | 21,000 | 0.00042 USDC |

## The flow

```
1 blind      the client picks secret scalars rᵢ
             Yᵢ = H_to_G2(Aᵢ)
             Bᵢ = rᵢ·Yᵢ            (i = 1..N)

2 deposit    deposit([B₁..B_N]) with X USDC from a visible wallet

3 mint       a deposit event fires the CRE trigger
             inside the enclave: choose a split of X, read the mint keys,
             S'ᵢ = sk_dᵢ·Bᵢ
             return to the DON, report, forwarder → announce

4 unblind    the client computes Sᵢ = rᵢ⁻¹·S'ᵢ
             it verifies Sᵢ against pk_dᵢ and discards rᵢ

5 claim      anyone calls claim(d, Aᵢ, Sᵢ)
             the contract checks e(pk_d, H_to_G2(Aᵢ)) == e(G1, Sᵢ)
             it checks Aᵢ is unclaimed, then pays d to Aᵢ

6 spend      Aᵢ signs its own transaction and pays its own fee
```

Steps 3 and 4 are the unlinkable pair. The chain holds `S' = sk·(r·Y)` from the
announcement and `S = sk·Y` from the claim. A match between them needs `r`. Only the
client held `r`, and the client has discarded it.

## The mint chooses the split

The client blinds an address and nothing else. No denomination enters the signed message.
The denomination comes only from the key that signs. The client cannot choose the split.
The mint picks any assignment whose denominations sum to the deposit.

- `N` is a cap and not a prediction. The client sends the smallest split plus slack. The
  mint may use fewer points and leave the rest unsigned.
- The client reads the assignment from the `announce` event. The deposit amount is
  already public, so this reveals nothing further.
- `announce` publishes the denominations. The contract therefore enforces
  `sum(denoms) == X`. It also checks that every point index is distinct and in range.
  Blinding hides the address that a signature is for. It does not hide the key that
  signed.
- `claim` verifies a pairing. It cannot check whether a signature was ever announced,
  because that check needs the link that blinding destroys. A mint that signs off band
  can therefore issue notes beyond the pool. The contract bounds the damage with
  `totalClaimed <= totalAnnounced`. The mint key stays inside the enclave, where
  operators cannot reach it.

## Layout

```
lib-blind/   TypeScript. blind, unblind, verify, the EIP-2537 codec, the ladder.
             No chain dependency. vectors.json is generated here.
contracts/   Foundry. BlindMint.sol, BLS.sol, MintConsumer.sol.
workflow/    Go. The CRE project. mint/ and announce/ hold the logic and test on the
             host. blindmint/ holds the workflow itself.
cli/         The client. deploy, deposit, mint, sync, claim, spend, sweep.
```

Three implementations of the same cryptography agree on one file. The TypeScript
generates `lib-blind/vectors.json`. The Solidity tests and the Go tests both read it.

59 tests pass: 18 in TypeScript, 30 in Solidity, 11 in Go.

## Run it

Local, against an anvil that emulates Arc:

```bash
anvil --chain-id 5042002 --hardfork osaka --base-fee 0 --gas-price 0

cd contracts && forge build
cd ../lib-blind && npm install && npm run vectors && npm test
cd ../cli && npm install
npm run teecash -- demo 3
```

Use the same chain ID. `BlindMint` builds its domain tag from `block.chainid`. A different
chain ID gives a different tag, and every signature then fails.

Against Arc testnet, with the CRE mint doing the signing:

```bash
cp cli/example.env cli/.env            # set TEECASH_DEPLOYER_KEY
cp workflow/.env.example workflow/.env # set the mint keys

export TEECASH_RPC=https://rpc.testnet.arc.io
export TEECASH_CRE_FORWARDER=0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1

cd cli
npm run teecash -- deploy
npm run teecash -- deposit 3           # prints the transaction hash

# put the two addresses into workflow/blindmint/config.production.json, then:
cd ../workflow
cre workflow simulate ./blindmint --target production-settings -e .env \
  --trigger-index 0 --evm-tx-hash <hash> --evm-event-index 1 --broadcast

cd ../cli
npm run teecash -- sync
npm run teecash -- claim
npm run teecash -- spend
npm run teecash -- sweep
```

## Notes on Arc

- **EIP-2537 is live.** The contract runs RFC 9380 hash-to-G2 itself, with
  `expand_message_xmd` in Solidity and two `MAP_FP2_TO_G2` calls.
- **The native token uses 18 decimals.** The ERC-20 interface at `0x3600...0000` reports
  6 and shows the same balance divided by 10^12. `deposit` and `claim` use native units.
- **Every native value move emits an ERC-20 `Transfer` log** from address
  `0xff...fe`. A deposit event therefore sits at log index 1.
- **A transfer that empties a fresh account reverts.** Every transfer here leaves one
  base unit in the account.
- **History is pruned.** A log search must set a lower bound.
- `PREVRANDAO` is `0` and EIP-4788 is absent. There is no on-chain randomness.

## Wallet providers

The protocol treats a wallet as a passive recipient. Nothing signs during the mint or the
claim. A wallet signs only when its holder spends it.

`TEECASH_WALLETS` selects the provider. `local` keeps a private key in the state file.
`privy` asks Privy for a wallet and lets Privy hold the key.

Privy does not need to support Arc. Its `signTransaction` takes a plain `chainId` and no
CAIP-2 network, so Privy signs and this client broadcasts over its own RPC. Gas
sponsorship is the one feature that would need Privy to know the chain.

## Trust model

| Party | Can steal? | Can link? |
|---|---|---|
| CRE node operators | No. The enclave never holds funds. | Nothing. They see blinded points. |
| Claim submitter | No. The value goes to the signed address. | The claim, not the deposit. |
| Privy | No | Which wallets share a user. Not the deposit. |
| Chain observer | No | Deposits, and that wallets hold standard denominations. Not the grouping. |
| Mint | No. It can refuse to sign. | Nothing, if it does not log timing. |

Timing is the practical leak. The cryptography does not hide that a deposit of 3 USDC was
followed by three claims of 1 USDC. The anonymity set of a note is the set of other notes
of the same denomination in the same window. Claim spacing is a client-side schedule and
this version does not implement one.

## Not implemented

Compliance screening, batching across deposits, threshold or multi-mint signing, and claim
spacing.

## Reuse

The ancestor design is [`nozkash`](https://github.com/IvanAnishchuk/nozkash): the same
primitive with one fixed denomination and one mint key. This project takes its
cryptographic conventions and none of its application code. The RFC 9380 hash-to-G2 with
an `AUG_` domain tag, the EIP-2537 encodings and the cross-language vector discipline
apply here. The denomination ladder, the mint-chosen split, the TEE mint and every
contract are new.

`nozkash` needs an EIP-712 spend signature, MEV protection and a redeem step, because its
funds go to a caller-named recipient. Here they go to the signed address. All three are
absent.

See [`AI.md`](AI.md) for the AI attribution.

## License

[`CC0-1.0 OR Apache-2.0 OR WTFPL`](LICENSE.md), at your option. Contributions are inbound
equals outbound and need a DCO sign-off (`git commit -s`, see [DCO.md](DCO.md)).
