/**
 * How a send picks the notes it spends.
 *
 * A note is a normal wallet and a wallet pays its own gas. A send therefore empties whole
 * notes into one new wallet, and it then makes one payment out of that wallet. The
 * recipient sees one transfer and not one transfer for each note.
 *
 * The new wallet keeps whatever the payment does not use. That remainder waits for a melt.
 * A melt makes ladder notes from it. Until the melt exists the remainder stays in the
 * wallet, and the balance still counts it.
 *
 * A note therefore never breaks. Every note goes whole or it stays whole, so no note ever
 * holds a value that is not on the ladder. `lib-blind/src/denominations.ts` explains why that
 * matters: a note that holds a ladder value matches many other notes, and a note that holds
 * a value off that ladder matches none.
 */

import { fromAmount } from "./notes";
import type { Note } from "./notes";

export class InsufficientFunds extends Error {
  constructor(
    readonly available: bigint,
    readonly wanted: bigint,
  ) {
    super(`spend: the wallet holds ${available} and the send needs ${wanted}`);
  }
}

/** The value of one note. A note without a denomination is not spendable. */
export function valueOf(note: Note): bigint {
  return note.denom ? fromAmount(note.denom) : 0n;
}

/**
 * The notes a send may use.
 *
 * A note must be claimed. It must also hold more than the cost of one transaction. A note
 * that holds less cannot pay the gas to move itself, so it can deliver nothing.
 */
export function spendable(notes: Note[], cost = 0n): Note[] {
  return notes.filter((n) => n.status === "claimed" && valueOf(n) > cost);
}

/** The sum of every note. */
export function balanceOfNotes(notes: Note[]): bigint {
  return notes.reduce((total, note) => total + valueOf(note), 0n);
}

export interface SweepPlan {
  /** The notes to empty. Each one goes whole into the new wallet. */
  notes: Note[];
  /** What the recipient receives. */
  amount: bigint;
  /**
   * What the whole send pays the chain.
   *
   * One transaction empties each note and one more makes the payment, so the send pays for
   * the note count plus one.
   */
  cost: bigint;
  /** What stays in the new wallet after the payment. It waits for the melt. */
  remainder: bigint;
}

/**
 * Choose the notes for one send.
 *
 * `notes` is every note of the user. `amount` is what the recipient must receive, in native
 * base units. `cost` is what one transaction costs, which is the gas fee plus the base unit
 * that Arc keeps in an account.
 *
 * The function takes the largest notes first, so a send uses as few notes as it can. Each
 * note it takes adds one transaction, and each transaction adds one cost, so the target
 * grows as the set grows. The loop therefore tests the target again after every note.
 */
export function planSweep(notes: Note[], amount: bigint, cost = 0n): SweepPlan {
  if (amount <= 0n) throw new Error("spend: the amount must be more than zero");
  if (cost < 0n) throw new Error("spend: the cost must not be less than zero");

  const usable = spendable(notes, cost);
  const largestFirst = [...usable].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    return x < y ? 1 : x > y ? -1 : 0;
  });

  const chosen: Note[] = [];
  let held = 0n;
  for (const note of largestFirst) {
    chosen.push(note);
    held += valueOf(note);

    // One transaction for each note, and one more for the payment.
    const spent = BigInt(chosen.length + 1) * cost;
    if (held >= amount + spent) {
      return { notes: chosen, amount, cost: spent, remainder: held - amount - spent };
    }
  }

  // Report what the notes can deliver and not what they hold. The difference is the gas of
  // every note, and a wallet that holds the amount can still fail to send it.
  const deliverable = held - BigInt(chosen.length + 1) * cost;
  throw new InsufficientFunds(deliverable > 0n ? deliverable : 0n, amount);
}
