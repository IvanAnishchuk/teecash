/**
 * The denomination ladder.
 *
 * Each denomination has one mint key. A short ladder gives each note a large anonymity
 * set. Many deposits then produce notes of the same few values.
 *
 * The cost is the note count. A coarse ladder needs more notes for one amount. The CRE
 * templates permit 11 secrets for each invocation. A longer ladder is possible if the
 * note count becomes a problem.
 *
 * Values are USDC base units. USDC uses 6 decimals.
 */

const USDC = 1_000_000n;

/** The denominations, from small to large. */
export const LADDER: readonly bigint[] = [1n * USDC, 10n * USDC, 100n * USDC];

export const MIN_DENOM = LADDER[0];

/** Report whether `d` is a denomination in the ladder. */
export function isDenom(d: bigint): boolean {
  return LADDER.includes(d);
}

/** Extra blinded points in each deposit. Calldata is cheap. A short deposit is not cheap. */
export const SLACK = 4;

/**
 * Count the blinded points to put in a deposit.
 *
 * The mint can only sign points that the deposit contains. This count is therefore the
 * ceiling on the split. The count is the smallest possible note count plus `SLACK`.
 */
export function pointCount(amount: bigint): number {
  return splitGreedy(amount).length + SLACK;
}

/**
 * Split an amount into ladder denominations, largest first.
 *
 * This split has the smallest possible note count for the amount. The mint may pick a
 * different split with more notes.
 *
 * The function throws an error when `amount` is not a multiple of the smallest
 * denomination.
 */
export function splitGreedy(amount: bigint): bigint[] {
  if (amount <= 0n) throw new Error("denominations: amount must be more than zero");
  if (amount % MIN_DENOM !== 0n) throw new Error(`denominations: amount is not a multiple of ${MIN_DENOM}`);
  const out: bigint[] = [];
  let rest = amount;
  for (let i = LADDER.length - 1; i >= 0; i--) {
    const d = LADDER[i];
    while (rest >= d) {
      out.push(d);
      rest -= d;
    }
  }
  return out;
}
