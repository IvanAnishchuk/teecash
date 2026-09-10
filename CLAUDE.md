# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `README.md` first. It holds the protocol, the trust model and the deployment.

## Commands

```bash
# TypeScript library and client
cd lib-blind && npm test && npm run typecheck
cd lib-blind && npm run vectors          # after ANY change to the crypto
cd cli && npm run typecheck

# Contracts
cd contracts && forge build && forge test && forge fmt

# Go workflow
cd workflow && go test ./mint/... ./announce/... -count=1
cd workflow && GOOS=wasip1 GOARCH=wasm go build -o /dev/null ./blindmint/

# One local end-to-end run
anvil --chain-id 5042002 --hardfork osaka --base-fee 0 --gas-price 0
cd cli && npm run teecash -- demo 3

# A single test
cd contracts && forge test --match-test test_fullPath_depositAnnounceClaim -vvv
cd lib-blind && npx vitest run test/vectors.test.ts
cd workflow && go test ./mint/ -run TestSplit -v
```

Go builds and any heavy compile stay at two jobs. `GOMAXPROCS=2`.

## The rule that breaks everything

**`lib-blind/vectors.json` is the contract between three implementations.** TypeScript
generates it. Solidity and Go both read it. Change any crypto and regenerate it, then run
all three suites. A disagreement between off-chain unblinding and on-chain verification
does not show up anywhere else.

## Invariants

- **The deposit ledger and the claim ledger never reference each other.** `claim` reads
  `mintPubkeys` and `claimed` only. The contract never stores a blinded point. Never add
  a lookup that would need to match a claim to an announcement.
- **The mint chooses the split.** The client blinds an address and nothing else, so the
  denomination comes only from the key that signs. The client sends a cap, not a
  prediction.
- `announce` publishes the denominations, so the contract enforces
  `sum(denoms) == mintable(X)`, distinct point indexes and indexes in range.
- **The mint tax is one rung plus the remainder below the rung.** `mintable` appears in
  Solidity, in Go and in TypeScript. All three must agree, or every announcement reverts.
  The tax goes to the treasury at the announcement. A refund pays no tax.
- **The tax is extra and not part of the amount that a client asks for.** `grossFor` adds
  the rung before the deposit. A client that subtracted the tax from a round amount would
  change a three-note split into a twenty-note split.
- A deposit of any amount is legal. A deposit below two rungs mints nothing and announces
  no note.
- `claim` cannot tell whether a signature was announced. `totalClaimed <= totalAnnounced`
  is the only bound on a mint that signs off band.
- Blind the **address**, not a public key. The contract recomputes `H_to_G2(A)` from the
  address it pays.
- The claimed set is keyed on the address alone, so a wallet's balance equals its
  denomination.
- The domain tag covers `(chainId, contractAddress)` and not the denomination. One key
  per denomination already binds that.
- A wallet signs nothing during the mint or the claim.

## Arc

- **The native token uses 18 decimals.** The ERC-20 interface at `0x3600...0000` reports
  6 and shows the same balance divided by 10^12. Everything on chain uses native units.
- **A native value move emits an ERC-20 `Transfer` log** from `0xff...fe`. A deposit
  event therefore sits at **log index 1**, so `cre simulate` needs
  `--evm-event-index 1`.
- **History is pruned.** Bound every log search.
- **A transfer that empties a fresh account reverts.** Leave one base unit.
- A local anvil must use `--chain-id 5042002`. The domain tag comes from `block.chainid`.
- `arc-testnet` is a supported CRE chain. Selector `3034092155422581607`, forwarder
  `0x76c9cf548b4179F8901cda1f8623568b58215E62`, mock forwarder
  `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`. `cre workflow supported-chains` prints
  them.

## CRE workflow

- The enclave must be deterministic. Use `runtime.now()`. **Never log inside the
  enclave.**
- `runtime.UsingTheDons()` is one way. Cross back, then `GenerateReport` with
  `EncoderName: "evm"`, `SigningAlgo: "ecdsa"`, `HashingAlgo: "keccak256"`, then
  `WriteReport`.
- Triggers, chain reads and chain writes never run inside the enclave.
- **A receiver must answer `supportsInterface`.** The forwarder checks ERC-165 before it
  delivers. A receiver that fails the check gets no report, and the forwarder's own
  transaction still succeeds. `BlindMint` is the receiver and answers the check itself.
- **`cre workflow simulate --listen` runs the mint as a service.** It fires on every
  matching log and it re-arms. A one-shot run needs `--evm-tx-hash` and
  `--evm-event-index` instead.
- `cre` needs a login. Staging targets a local anvil. Production targets Arc.
- Secrets reach the enclave through environment variables that `secrets.yaml` maps.

## Conventions

- **Comments and docstrings follow ASD-STE100.** Short active sentences, one idea each,
  no phrasal verbs, no semicolons. Prefer the plainest word.
- **Commit messages describe repository changes.** They are not documentation. Do not
  explain how a mechanism works, do not list every file, and do not narrate the work.
  Conventional Commits, with DCO sign-off (`git commit -s`).
- Never edit a JSON file through a JavaScript round trip. It corrupts 64-bit values such
  as the chain selector.
- `.env` files stay local. `example.env` and `.env.example` are the templates.
