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
 * Values are native base units.
 *
 * The native token of Arc is USDC and it uses 18 decimals. One USDC is 10^18 base units.
 * The ERC-20 interface at 0x3600...0000 reports 6 decimals and shows the same balance
 * truncated to those 6. A native balance is therefore the ERC-20 balance times 10^12.
 * `deposit` and `claim` both use native units.
 */

const USDC = 10n ** 18n;

/** One hundredth of a USDC. The ladder starts here. */
export const CENT = USDC / 100n;

/**
 * The denominations, from small to large.
 *
 * The ladder starts at one cent so that a wallet can make any amount to the cent. A send
 * of an exact amount then needs to break a note less often.
 */
export const LADDER: readonly bigint[] = [1n * CENT, 10n * CENT, 1n * USDC, 10n * USDC, 100n * USDC];

/**
 * The name of the mint key of each denomination.
 *
 * The name is a table and not a calculation. An earlier version built the name from
 * `denom / USDC`, and that division gives zero for every denomination below one USDC. The
 * one cent rung and the ten cent rung then share one name.
 */
const SECRET_IDS: ReadonlyMap<bigint, string> = new Map([
  [1n * CENT, "MINT_KEY_1_CENT"],
  [10n * CENT, "MINT_KEY_10_CENT"],
  [1n * USDC, "MINT_KEY_1_USDC"],
  [10n * USDC, "MINT_KEY_10_USDC"],
  [100n * USDC, "MINT_KEY_100_USDC"],
]);

/** The name of the mint key of one denomination. The function throws on a value off the ladder. */
export function secretId(denom: bigint): string {
  const name = SECRET_IDS.get(denom);
  if (name === undefined) throw new Error(`denominations: ${denom} is not a denomination`);
  return name;
}

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
