# The wallet frontend

A browser wallet for the teecash flow. A user signs in, sees a balance, deposits, claims
the notes that the mint signs, and sends money to any address.

The command line client already runs the whole flow. This document specifies the same
flow as a web application. The cryptography does not change. `lib-blind` stays the one
implementation of it.

## Scope

In scope:

- Sign in with any method that Privy offers.
- Show one balance across every note the user holds.
- Start a deposit. The user's own wallet pays it.
- Claim each note when the mint announces it.
- Send any amount to any address.

Out of scope for this version. Each one is a deliberate omission, not an oversight:

- **Claim spacing and batching.** A backend that spaces claims must receive the whole
  batch to schedule it. That backend then holds the link that blinding removes. A
  correct version batches announcements across many deposits. That is beyond a
  demonstration.
- **Note merging.** A note is a normal wallet. Nothing needs to merge notes to spend
  them.
- **Balance privacy against Privy.** Privy knows which wallets one user holds. The
  trust table in `README.md` already states this.

## Decisions

### The user's own wallet pays the deposit

Privy sign-in gives identity. The deposit transaction goes to the user's external wallet
for a signature. The money enters the contract from a wallet that the user already funds.
No wallet sits between the user and `deposit`.

### A note is a Privy embedded wallet that the user owns

The client asks Privy for one embedded wallet per point. Privy holds the key. The browser
never holds a note private key.

This choice gives recovery. After a claim, the value sits in wallets that belong to the
Privy account. A user who signs in on another device sees the same balance and can spend
it. Nothing outside Privy has to survive.

**Verify this first.** The client SDK must create more than one embedded wallet for one
user. The command line client uses server side wallets, which is a different API. If the
client SDK refuses, the fallback is a server side wallet that the backend creates and
maps to the Privy user identifier. That fallback gives the backend the deposit to note
link, which this design otherwise avoids.

### The mint is a service and the frontend does not call it

`cre workflow simulate ./blindmint --listen --broadcast` runs as a daemon. It fires on
every `Deposited` log and it re-arms. The frontend deposits and then reads the `Announced`
event. It never triggers the mint.

### The relayer is one endpoint and holds no state

A note wallet has no money until its claim lands, so it cannot pay for its own claim. A
claim must also not come from the depositor. One backend route therefore sends it.

The route takes one note. The client sends the notes one at a time. The route keeps no
record. It does not group the notes of one deposit, because a service that sees the group
holds the link that blinding removes.

### A spend uses whole notes and one partial note

A note is a normal wallet. The client picks notes until they cover the amount. It empties
every note except the last. It sends the remainder from the last note. The rest stays
there.

The recipient receives more than one transfer. That is a consequence of cash, not a
defect.

## Architecture

```
app/            Next.js. The pages. There is no server route.
  page.tsx        balance and notes
  deposit/        start a deposit
  send/           send an amount to an address
lib/
  notes.ts        the note record and its IndexedDB store
  chain.ts        the viem clients and the contract calls
  privy.ts        wallet creation and signing
```

The application builds with webpack and not with Turbopack. Privy names several Solana
packages as optional peer dependencies. teecash installs none of them, because it only
uses Ethereum. Turbopack checks each named import and stops. webpack accepts the alias in
`next.config.mjs` that maps each absent package to an empty module.

The application imports `@teecash/lib-blind` directly. That package exports TypeScript
source and has no build step, so Next.js must carry it in `transpilePackages`. Its only
dependencies are `@noble/curves` and `@noble/hashes`, and both run in a browser.

`lib/chain.ts` repeats what `cli/src/chain.ts` does. The two stay separate. The command
line client reads files and environment variables that a browser does not have.

## The note record and where it lives

One record per point:

| Field | Lives until |
|---|---|
| `address` | forever. Privy also holds it. |
| `walletId` | forever. Privy addresses the wallet by it. |
| `pointIndex` | the claim |
| `blinded` | the announcement |
| `r` | the unblinding |
| `denom`, `sig` | the claim |
| `status` | forever |

`useWallets` returns the wallets in an order that is not the order of creation. Nothing
must therefore match a wallet to a point by its position in that list. The record holds
`address` and `walletId`, and those two fields are the only link.

The records live in IndexedDB under the Privy user identifier. They never reach a server.
A server that held them could match a deposit to a claim, and that match is the thing
blinding removes.

`r` is deleted as soon as the client unblinds. `sig` is deleted as soon as the claim
confirms.

**The consequence.** A record that disappears has two different costs, and the
announcement divides them.

Before the announcement the deposit is still `Pending`. `refundByDepositor` returns it
after the deadline. The money is safe and only the unlinkability of that deposit is lost.

After the announcement there is no way back. `announce` sets the deposit to `Announced`,
and `_refund` accepts `Pending` only. That refusal is correct and it must stay. A refund
plus a signature that reappears later is a double spend, and the contract cannot
invalidate a signature that it never saw. The blind signatures sit in the `Announced`
event for anyone to read, but nobody unblinds them without `r`. The value stays in the
contract for good.

The window between the announcement and the claim is therefore the dangerous one. It is
short. The mint answers a deposit in about a minute, and the wait screen claims as soon
as it reads the announcement. The screen must still hold the user until the claims land.
It must not put a confirmation in front of a user who can walk away.

After the claim, recovery needs a Privy sign in and nothing else.

## The screens

**Balance.** One number. Below it, the notes as denominations, and the pending deposits
with their state. Two actions: deposit and send.

**Deposit.** The user types an amount. The client shows the smallest split and the number
of points it will use. On confirm the client creates the wallets, blinds each address,
and asks the external wallet to sign `deposit`. The screen then waits for the
announcement.

**Waiting for the mint.** The screen polls for the `Announced` event of that deposit. On
arrival the client unblinds each signature and verifies it against the public key of its
denomination. It then sends the claims one at a time to the relayer, and it shows each
note as it is paid.

**Send.** An address and an amount. The client shows which notes it will use. Each note
signs its own transaction through Privy, and each pays its own fee.

## The relayer

The relayer is a separate Go service in `workflow/relayer`. It is not a route of this
application. `docs/relayer-spec.md` holds its design.

The browser calls it directly. The service answers CORS, so no proxy sits between them.

`POST /claim` with `{ wallet, sig }`. The frontend sends no denomination. The service
finds the rung that verifies the signature, and the contract confirms that rung.

The service verifies the signature before it spends any gas. A bad signature costs a
revert, so the check is worth its cost. It then calls `claim` and returns the transaction
hash. It logs nothing about the note. A log of the address and the time is the same leak
as a batch.

## Risks, in the order to test them

Risk 1 and risk 2 are proven. `app/app/debug` ran against the live Privy application and a
local node on chain 5042002. A user with no wallet received three distinct wallets. A
signature for chain 5042002 recovered to the wallet that signed it.


1. **More than one embedded wallet per Privy user, from the client SDK.** The whole design
   rests on it. Test it before anything else. The fallback costs the backend its blindness.

   The type declarations of `@privy-io/react-auth` version 3 answer this. `useCreateWallet`
   gives `createWallet`, and `CreateWalletOptions` carries `createAdditional`. There is a
   rule on the first wallet. `createAdditional: true` throws when the user holds no
   Ethereum embedded wallet, and the default of `false` returns the wallet that exists. The
   client therefore omits the flag for the first wallet of a user and sets it for every
   later wallet. `walletIndex` is a second form of the same call that names the HD index.

   `app/app/debug` proves this against the live application. Run it.

2. **A browser signature for chain 5042002.** The command line client proved that Privy
   signs for Arc through the server API. The client SDK path needs the same proof.

   `useSignTransaction` gives `signTransaction(input, { address })` and it returns
   `{ signature }`. `UnsignedTransactionRequest` carries an optional `chainId`, and it names
   the gas cap `gasLimit` and not `gas`. `app/app/debug` recovers the signer from the
   result. A recovered address that equals the note address is the proof. The returned hex
   string alone is not.
3. **The external wallet on Arc.** The user's wallet must carry the Arc network. A wallet
   that refuses the chain cannot deposit.
4. **The log search.** Arc prunes history. Every `Announced` search starts at the deposit
   block, as `cli/src/commands.ts` already does.

## Open questions

- The relayer needs a funded key. The deployer key serves for a demonstration. Anything
  further needs its own account and a spend limit.
- The refund path has no screen. A deposit that the mint refuses stays pending until the
  deadline. The balance screen should show that state and offer `refundByDepositor`.
- The announced but unclaimed window has no safety net. An export of the pending records
  would give one, at the cost of a file that carries the deposit to note link. A user who
  holds that file holds the link, which is acceptable. A user who loses it to somebody
  else gives that link away.
