/**
 * The melt arithmetic.
 *
 * A deposit must be a multiple of the smallest denomination, and the transaction costs gas.
 * These tests state that the melt never asks the chain for more than the wallet holds.
 */

import { MIN_DENOM } from "@teecash/lib-blind";
import { describe, expect, it } from "vitest";
import { DUST } from "../lib/privy";
import { meltable, roundToRung } from "../lib/melt";

const USDC = 10n ** 18n;

describe("roundToRung", () => {
  it("keeps a value that is already a multiple", () => {
    expect(roundToRung(3n * MIN_DENOM)).toBe(3n * MIN_DENOM);
  });

  it("lowers a value to the multiple below it", () => {
    expect(roundToRung(3n * MIN_DENOM + 1n)).toBe(3n * MIN_DENOM);
    expect(roundToRung(MIN_DENOM - 1n)).toBe(0n);
  });

  it("gives zero for zero and for less", () => {
    expect(roundToRung(0n)).toBe(0n);
    expect(roundToRung(-1n * USDC)).toBe(0n);
  });
});

describe("meltable", () => {
  it("leaves the gas and the base unit behind", () => {
    const gas = MIN_DENOM / 2n;
    expect(meltable(10n * MIN_DENOM + gas + DUST, gas)).toBe(10n * MIN_DENOM);
  });

  it("never returns more than the wallet holds", () => {
    const gas = MIN_DENOM / 4n;
    for (const balance of [0n, 1n, MIN_DENOM, MIN_DENOM * 7n + 13n, USDC]) {
      expect(meltable(balance, gas) + gas + DUST).toBeLessThanOrEqual(
        balance > gas + DUST ? balance : gas + DUST,
      );
    }
  });

  it("gives zero when the balance cannot cover one rung and the gas", () => {
    expect(meltable(MIN_DENOM, MIN_DENOM)).toBe(0n);
    expect(meltable(0n, 0n)).toBe(0n);
  });
});
