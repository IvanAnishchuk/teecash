/**
 * One short sentence for one failure.
 *
 * viem writes a long report for a failed call. The report holds the calldata, a link to the
 * documentation and a version. That report helps a developer and it does not help the person
 * who holds the money. This file keeps the report in the console and gives the screen a
 * sentence.
 *
 * Each sentence says what happened and what to do next. A sentence that says neither is a
 * bad sentence.
 */

/** The words that name each failure. A message from viem or from a wallet carries them. */
const CAUSES: [RegExp, string][] = [
  [
    /wallet timeout|request timed out|timeout/i,
    "Your wallet did not answer. Open the wallet application and try again.",
  ],
  [
    /user rejected|user denied|rejected the request|4001/i,
    "You rejected the request in your wallet.",
  ],
  [
    /failed to fetch|http request failed|network error|fetch failed/i,
    "The node did not answer. Check the network and try again.",
  ],
  [
    /insufficient funds|exceeds the balance/i,
    "The paying wallet does not hold enough for this amount and the gas.",
  ],
  [
    /chain mismatch|does not match the target chain|unrecognized chain/i,
    "Your wallet is on another chain. Change it to this network and try again.",
  ],
  [/already claimed/i, "This note is already claimed."],
  [
    // Each note is a wallet, and the wallet provider counts the wallets of one user. A
    // balance of many small notes reaches that count. The message must say so, because
    // nothing the user can see explains why a send stops.
    /cannot be attributed to more than \d+ wallets|too many wallets/i,
    "This account reached the wallet limit of the wallet provider. Send the small notes together, or sign in with another account.",
  ],
];

/**
 * Give one sentence for `err`, and write the whole error to the console.
 *
 * `fallback` is the sentence for a failure that matches nothing. Name the step in it, so
 * that the screen still says which step failed.
 */
export function explain(err: unknown, fallback: string): string {
  console.error(err);
  const text = err instanceof Error ? err.message : String(err);
  for (const [pattern, sentence] of CAUSES) {
    if (pattern.test(text)) return sentence;
  }
  return fallback;
}
