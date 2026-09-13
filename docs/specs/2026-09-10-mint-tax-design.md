# The mint tax

## The problem

`deposit` accepts any value, but `announce` demands `sum(denoms) == amount`. The ladder
starts at one cent, so a deposit that is not a whole number of cents can never be
announced. The money stays in the contract until the refund deadline.

The melt avoids this. It lowers the change to a whole cent and it leaves the remainder in
the change wallet. That remainder is a mark on the money. A melt exists to remove such a
mark.

Nothing pays for the mint transaction or the relayer transaction. Both come from the
deployer account and nothing returns value to it.

## The change

The contract mints less than the deposit. The difference is the mint tax. The tax goes to
the treasury.

    rung        = the smallest denomination, one cent
    mintable(X) = X < rung ? 0 : (X / rung - 1) * rung
    tax(X)      = X - mintable(X)

The tax is therefore one cent plus every base unit below the cent. A deposit below one
cent mints nothing. All of it is tax.

`announce` checks `sum(denoms) == mintable(amount)` in place of `sum(denoms) == amount`.
It then sends `amount - sum` to the treasury.

## The client adds the tax

The tax is extra. It is not part of the amount that a user asks for. A user who wants
three USDC of notes signs a transaction for 3.01.

    grossFor(net) = net + rung

This rule is more important than it looks. A client that subtracted the cent from a round
amount would make the greedy split use every rung of the ladder. A split of 2.99 holds
twenty notes. A split of 3.00 holds three. An added cent keeps each split the size it is
today.

A net amount that is not a whole number of cents also works. `grossFor(3.007)` sends 3.017
and the contract mints 3.00. The part below the cent becomes tax.

## The melt deposits what it holds

A melt has no user to charge. It therefore deposits the whole spendable balance and the
tax takes what it must. `roundToRung` is removed. A melt that holds less than one cent
still deposits. It mints nothing and it gives the dust to the treasury. The change wallet
then empties, which is the purpose of the melt.

## Zero notes

A deposit with a `mintable(X)` of zero accepts an announcement of an empty note list. The
`sum == mintable` check already covers this, so `_announce` no longer needs its own
`NoPoints` guard. The deposit reaches `Announced` and the treasury takes the whole amount.

`deposit` still refuses a value of zero. It still needs one blinded point or more.

## Refunds

A refund returns the whole deposit. The mint refused to sign, so it earns nothing.

## The treasury

`address public immutable treasury` is a constructor argument beside `forwarder`. It is
the deployer account, which is also the relayer and the CRE writer. There is no owner and
no setter. A new treasury needs a new deployment, because the CREATE2 address changes with
every constructor argument.

The transfer is a push. It is the last statement of `_announce` and it runs after every
state write. The forwarder delivers the report. A treasury that could not accept value
would revert that delivery. The treasury is an account with no code, so it always accepts.

## What changes where

- `contracts/src/BlindMint.sol` — the `treasury` and `rung` immutables, a `mintable` view,
  the new sum check, a `Taxed` event and the push.
- `lib-blind/src/denominations.ts` — `mintable`, `tax` and `grossFor`. `pointCount` counts
  the split of the mintable part.
- `workflow/mint/mint.go` — `Mint` holds its rung. `Split` splits the mintable part. It
  returns an empty split in place of an error when that part is zero.
- `cli/src/commands.ts` — `deploy` passes the treasury. `deposit` sends the gross amount.
  `mint` splits the mintable part.
- `app/lib/melt.ts` — `roundToRung` is removed. `meltable` returns the whole spendable
  balance.
- `app/app/deposit/page.tsx` — the typed amount is the net. The screen shows the tax and
  sends the gross amount.

The ladder does not change, so `vectors.json` does not change.
