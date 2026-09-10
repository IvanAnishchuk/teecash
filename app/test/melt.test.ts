/**
 * The melt arithmetic.
 *
 * The contract accepts any amount, so the melt no longer rounds. It deposits everything
 * that the wallet holds, less the gas and one base unit of dust. These tests state that
 * the melt never asks the chain for more than the wallet holds, and that it leaves nothing
 * behind that it could have sent.
 */

import { MIN_DENOM, mintable } from "@teecash/lib-blind";
import { describe, expect, it } from "vitest";
import { DUST } from "../lib/privy";
import { meltable } from "../lib/melt";

const USDC = 10n ** 18n;

describe("meltable", () => {
  it("leaves the gas and the base unit behind", () => {
    const gas = MIN_DENOM / 2n;
    expect(meltable(10n * MIN_DENOM + gas + DUST, gas)).toBe(10n * MIN_DENOM);
  });

  it("keeps the remainder below one rung", () => {
    // The old melt rounded this away and abandoned it in the change wallet. The contract
    // takes it as tax now, so the wallet empties.
    const gas = MIN_DENOM / 2n;
    expect(meltable(10n * MIN_DENOM + 137n + gas + DUST, gas)).toBe(10n * MIN_DENOM + 137n);
  });

  it("never returns more than the wallet holds", () => {
    const gas = MIN_DENOM / 4n;
    for (const balance of [0n, 1n, MIN_DENOM, MIN_DENOM * 7n + 13n, USDC]) {
      expect(meltable(balance, gas) + gas + DUST).toBeLessThanOrEqual(
        balance > gas + DUST ? balance : gas + DUST,
      );
    }
  });

  it("gives zero when the gas and the dust take everything", () => {
    expect(meltable(MIN_DENOM, MIN_DENOM)).toBe(0n);
    expect(meltable(0n, 0n)).toBe(0n);
    expect(meltable(DUST, 0n)).toBe(0n);
  });

  it("reports a balance that is too small to mint anything", () => {
    // `meltable` answers what the wallet can send. It does not decide whether to send it.
    // `meltWallet` stops when the deposit would mint nothing, because every deposit costs
    // `SLACK` embedded wallets and the provider never returns one.
    const balance = MIN_DENOM / 2n + DUST;
    expect(meltable(balance, 0n)).toBe(MIN_DENOM / 2n);
    expect(mintable(meltable(balance, 0n))).toBe(0n);
  });
});
