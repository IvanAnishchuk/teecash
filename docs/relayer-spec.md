# The relayer

A small Go service. It takes one unblinded note, it checks that the note is good, and it
sends the claim.

## Why it exists

A note wallet holds nothing until its claim lands, so it cannot pay for its own claim.
The claim must also not come from the depositor. A depositor who claims puts the deposit
and the note in one transaction history, and blinding then buys nothing.

So a third party sends the claim and pays the gas. That is the whole job.

## What it does not do

- **It does not hold notes.** One request carries one note. The service keeps nothing
  after it answers.
- **It does not group the notes of a deposit.** A service that sees the group holds the
  link that blinding removes. The client sends the notes one at a time, and the service
  must not be able to rebuild the set.
- **It does not schedule.** Claim spacing needs the whole batch, and the point above
  rules that out. A production design batches announcements from many deposits before it
  spaces anything. That is not this service.

## The check

The service verifies the signature itself. It does not ask the node whether the note is
good.

`gnark-crypto` hashes the wallet address to G2 with the teecash domain tag and checks the
pairing `e(pk, H_to_G2(A)) == e(G1, S)`. This is the same check that `BLS.verify` runs in
Solidity and that `verify` runs in `lib-blind`.

**The code goes in `workflow/mint`, not in the relayer.** Go is already the third
implementation of this cryptography. It signs blinded points today and it has no
hash-to-G2 and no verify, so those two are new Go code. They belong beside the Go code
that `lib-blind/vectors.json` already tests. The relayer then imports them and stays a
network service with no cryptography of its own.

A verifier written inside the relayer would be the thing that makes a fourth
implementation. Do not write one there.

The new functions read `vectors.json` in their tests exactly as the other Go tests do.
The vectors already carry a `hashToG2` value and a `sig` value for each note, so the test
data exists.

A service that pays for a transaction must know that the transaction is good. Passing
that question to the node makes the service depend on a node answering honestly, and it
gives up the one job the service has.

The service then reads two things from the contract before it sends:

- `claimed(wallet)`. A repeat claim reverts, and the answer is `409`.
- `totalAnnounced` and `totalClaimed`. A note that passes the bound reverts. This can
  only happen when the mint signs off band, so the answer is `503` and not `400`. The
  note can be good.

  The service reads the bound again for every request. It does not latch. A latch would
  take the service down for every caller after one bad note, and the bound clears by
  itself when the next announcement lands. The cost of the choice is that a mint which
  signs off band gets probed until an operator reads the failure count.

## The denomination is derived, not declared

The client sends the wallet and the signature. It does not send the denomination.

A denomination is the key that signed. The service holds the public key of every rung of
the ladder, so it tries each one and keeps the rung that verifies. The ladder has three
rungs, so the cost is at most three pairing checks and usually one.

The contract call still takes a denomination. The service passes the one it derived. A
client therefore cannot name a denomination that its signature does not carry, because it
never names one at all.

The service reads each public key from `mintPubkeys` on the contract at startup. The
contract is the source of truth for the ladder, and no key material sits in the
configuration.

## The interface

`POST /claim`

```json
{ "wallet": "0x...", "sig": "0x..." }
```

Answers `200` with the transaction hash, the gas used and the denomination it derived.
Answers `400` when no rung of the ladder verifies the signature. Answers `409` when the
wallet already claimed. Answers `503` when the announced bound is reached.

`GET /health` answers the chain identifier, the contract address and the relayer balance.
It carries no note data.

The browser calls this service directly. It therefore needs CORS with an origin
allowlist. A proxy through the web application would work too and would hide the service,
but it puts the note data through a second process for no gain.

## The shape

```
workflow/
  mint/
    verify.go       hash to G2 and the pairing check
    verify_test.go  against lib-blind/vectors.json
  relayer/
    main.go         configuration, the HTTP server, the worker and the rate limit
    claim.go        the derive, the check and the send
    claim_test.go   the derive against vectors.json, the rest against a local anvil
```

`claim_test.go` derives a denomination from `vectors.json` with no chain, because derive
needs the ladder and the domain tag only. The chain test reads a live contract and it
sends nothing, so it costs no gas. It runs when `RELAYER_CONTRACT` is set and it skips
otherwise. The CLI covers the send path end to end with `teecash relay`.

The relayer sits in the `workflow` module and not in a module of its own. It imports
`workflow/mint` for the verify, and one module keeps that import plain. A separate module
would need a `replace` directive to reach a package in the same repository.

Only `blindmint/` compiles to wasip1. `mint` and `announce` already build for the host,
and `relayer` joins them. Nothing about a network service reaches the enclave build.

The name `workflow/` now covers more than the CRE workflow. That is the cost of the
choice and it is worth one directory rename later if the module grows further.

## Configuration

| Variable | Meaning |
|---|---|
| `RELAYER_RPC` | the node |
| `RELAYER_KEY` | the account that pays for claims |
| `RELAYER_CONTRACT` | the `BlindMint` address |
| `RELAYER_LISTEN` | the address to serve on |
| `RELAYER_ORIGINS` | the CORS allowlist |

`RELAYER_KEY` is the deployer key for now. The same account deploys, mints and relays.
That is a simplification for a demonstration and not a design. In production the three
are separate accounts: the relayer never needs deploy rights, and the mint account is the
one thing that must never be reachable from a network service.

## Transactions run one at a time

One account has one nonce. Two claims in flight from one account race, and the second one
replaces or fails.

The service therefore sends through a single worker. Requests queue. A request waits for
its receipt and then answers. A claim costs about 371,000 gas the first time and about
354,000 after, so a queue is short in practice.

This is also the reason the service does not need to remember anything. The queue holds a
request only while it runs.

## Abuse

Anybody can post to `/claim`. A bad note costs no gas and no node call. The signature
check runs first, so a note that no rung signed never reaches the chain reads. The cost
of an attack is therefore one pairing check for each rung, and nothing else.

A token bucket for each caller is enough for a demonstration. The burst is the size of
one deposit, because a browser claims every note of a deposit at once. The refill then
bounds sustained use. The service drops a bucket that goes idle, so the map cannot grow
without a bound.

Note that the limit must key on the caller and never on the wallet in the request. A
limit keyed on the note would count the notes of one user together, which is the grouping
this service must not do. The caller is the peer address. It is never a header, because a
caller sets its own headers.

## Logs

The service logs a request count, an error count and every failure reason. It never logs
a wallet address, a signature or a denomination.

A log line with an address and a timestamp is the same leak as a batch. Anybody who reads
the log then sees which notes arrived together.
