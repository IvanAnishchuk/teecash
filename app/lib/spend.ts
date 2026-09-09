/**
 * How a send picks the notes it spends.
 *
 * A note is a normal wallet. A send therefore moves money out of one wallet or several.
 * The client empties every note except the last one, and it sends the remainder from the
 * last note. Whatever is left stays there.
 *
 * The recipient receives more than one transfer. That is a consequence of cash and not a
 * defect.
 *
 * There is one thing to know before reading `selectNotes`. A note that is spent in part
 * stops being a ladder denomination. `lib-blind/src/denominations.ts` keeps the ladder
 * short so that many deposits produce notes of the same few values, and that is what gives
 * each note a large anonymity set. A note holding 3.5 USDC matches no other note in the
 * system. The selection therefore decides how much of that property survives a send.
 */

import { fromAmount } from "./notes";
import type { Note } from "./notes";

/** One note and the amount to move out of it. */
export interface Leg {
  note: Note;
  /** What the recipient receives from this note. */
  amount: bigint;
  /**
   * What this leg costs the note. It is the gas fee plus the base unit that Arc keeps.
   *
   * The note pays it, because a note is the only account that holds its own money. The
   * cost is the same on every leg, so a send of many legs pays it many times.
   */
  cost: bigint;
  /** The spendable value left in the note. Zero on every leg except the last. */
  remainder: bigint;
}

export interface Selection {
  legs: Leg[];
  /** The sum of every leg. It equals the requested amount. */
  total: bigint;
  /** What every leg costs together. The notes pay it and the recipient does not see it. */
  cost: bigint;
}

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
 * A note must be claimed. It must also hold more than the cost of one leg. A note that
 * holds less cannot pay the fee to move itself, so it can deliver nothing.
 */
export function spendable(notes: Note[], cost = 0n): Note[] {
  return notes.filter((n) => n.status === "claimed" && valueOf(n) > cost);
}

/** Sort the values from large to small. A bigint has no default sort. */
const descending = (a: bigint, b: bigint) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * Look for a set of whole notes that sums to the amount exactly.
 *
 * The pass takes the largest value first, bounded by how many notes hold that value.
 *
 * This finds an exact set whenever every value is a ladder denomination, because each rung
 * of the ladder divides the next. A note that was spent in part holds a value that is not
 * on the ladder, and the pass can then miss an exact set that exists. The cost of that miss
 * is one more broken note. It is never a wrong amount.
 */
function exactSubset(notes: Note[], amount: bigint): Note[] | undefined {
  const byValue = new Map<bigint, Note[]>();
  for (const note of notes) {
    const value = valueOf(note);
    const held = byValue.get(value);
    if (held) held.push(note);
    else byValue.set(value, [note]);
  }

  const chosen: Note[] = [];
  let rest = amount;
  for (const value of [...byValue.keys()].sort(descending)) {
    const held = byValue.get(value) as Note[];
    const want = rest / value;
    const take = want > BigInt(held.length) ? held.length : Number(want);
    chosen.push(...held.slice(0, take));
    rest -= BigInt(take) * value;
  }
  return rest === 0n ? chosen : undefined;
}

/**
 * Choose the notes for one send.
 *
 * `notes` is every note of the user. `amount` is what the recipient must receive, in native
 * base units. `cost` is what one leg costs the note that sends it, which is the gas fee plus
 * the base unit that Arc keeps in the account.
 *
 * The notes pay the cost, so the wallet loses `amount` plus one cost for each leg. The
 * recipient receives `amount` exactly.
 *
 * The function looks for an exact set of whole notes first. Such a send leaves every note
 * on the ladder, so it keeps the anonymity set of the notes that stay.
 *
 * A cost above zero makes an exact set unlikely. A note that pays a fee delivers its value
 * minus the fee, and that result is not a ladder value. Almost every send on a chain with a
 * gas price therefore breaks one note. This is a cost of the exact amount, and
 * `docs/frontend-spec.md` records it.
 *
 * When no exact set exists, one note must break. The function builds two plans and keeps
 * the plan that strands the smaller amount in the broken note. `emptyThenBreak` and
 * `breakOneNote` describe them. Neither plan is the best plan for every wallet, and the
 * pair covers the cases that a short ladder produces.
 *
 * The broken note is the last leg, as `docs/frontend-spec.md` describes.
 */
export function selectNotes(notes: Note[], amount: bigint, cost = 0n): Selection {
  if (amount <= 0n) throw new Error("spend: the amount must be more than zero");
  if (cost < 0n) throw new Error("spend: the cost must not be less than zero");

  const usable = spendable(notes, cost);

  // The wallet must pay one cost for each leg. The total decides the plan and the plan
  // decides the number of legs, so the two depend on each other. Try each leg count and
  // keep the first count that its own plan agrees with. A low count comes first, so the
  // send uses the fewest notes it can.
  for (let legs = 1; legs <= usable.length; legs++) {
    const gross = plan(usable, amount + BigInt(legs) * cost);
    if (!gross || gross.length !== legs) continue;
    return {
      legs: gross.map((leg) => ({ ...leg, amount: leg.amount - cost, cost })),
      total: amount,
      cost: BigInt(legs) * cost,
    };
  }

  // Report what the notes can deliver and not what they hold. The difference is the fee of
  // every note, and a wallet that holds the amount can still fail to send it.
  const held = usable.reduce((total, note) => total + valueOf(note), 0n);
  const deliverable = held - BigInt(usable.length) * cost;
  throw new InsufficientFunds(deliverable > 0n ? deliverable : 0n, amount);
}

/**
 * Build the legs that take `target` out of the notes. `target` is the gross amount, so it
 * covers the fee of every leg.
 *
 * The return is undefined when the notes cannot reach the target.
 */
function plan(usable: Note[], target: bigint): Leg[] | undefined {
  const available = usable.reduce((total, note) => total + valueOf(note), 0n);
  if (available < target) return undefined;

  const exact = exactSubset(usable, target);
  if (exact) {
    return exact.map((note) => ({ note, amount: valueOf(note), cost: 0n, remainder: 0n }));
  }

  // One note must break. Two plans are worth comparing, and the cheaper one wins.
  const plans = [emptyThenBreak(usable, target), breakOneNote(usable, target)];
  return plans
    .filter((built): built is Leg[] => built !== undefined)
    .sort((a, b) => {
      const residue = descending(strandedOf(b), strandedOf(a)); // Smaller residue first.
      return residue !== 0 ? residue : a.length - b.length;
    })[0];
}

/** The value left in the broken note. It is the amount that stops matching the ladder. */
function strandedOf(legs: Leg[]): bigint {
  return legs.reduce((total, leg) => total + leg.remainder, 0n);
}

/**
 * Plan one. Empty every whole note that fits, then break the smallest note that covers
 * what is left.
 *
 * This gives the fewest notes left behind. It can strand a large amount, because emptying
 * the small notes first leaves only a large note to break.
 */
function emptyThenBreak(notes: Note[], amount: bigint): Leg[] | undefined {
  const legs: Leg[] = [];
  const untouched: Note[] = [];
  let owed = amount;

  for (const note of [...notes].sort((a, b) => descending(valueOf(a), valueOf(b)))) {
    const value = valueOf(note);
    if (value <= owed) {
      legs.push({ note, amount: value, cost: 0n, remainder: 0n });
      owed -= value;
    } else {
      untouched.push(note);
    }
  }
  if (owed === 0n) return legs;

  // `untouched` runs from large to small, and every note in it is larger than `owed`.
  const cover = untouched.at(-1);
  if (!cover) return undefined;
  legs.push({ note: cover, amount: owed, cost: 0n, remainder: valueOf(cover) - owed });
  return legs;
}

/**
 * Plan two. Break the smallest single note that covers the whole amount.
 *
 * This is one transfer and it keeps every other note whole. It is the better plan when the
 * small notes nearly reach the amount, because plan one would spend them and then break a
 * much larger note.
 */
function breakOneNote(notes: Note[], amount: bigint): Leg[] | undefined {
  const cover = [...notes]
    .filter((note) => valueOf(note) >= amount)
    .sort((a, b) => descending(valueOf(b), valueOf(a)))[0];
  if (!cover) return undefined;
  return [{ note: cover, amount, cost: 0n, remainder: valueOf(cover) - amount }];
}
