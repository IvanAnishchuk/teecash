/**
 * The mint tax.
 *
 * `BlindMint.mintable` and `mint.Mintable` in Go must agree with these numbers. A
 * disagreement makes every announcement revert.
 */

import { describe, expect, it } from "vitest";
import { CENT, MIN_DENOM, SLACK, grossFor, mintable, pointCount, splitGreedy, tax } from "../src/index.ts";

const USDC = 100n * CENT;

describe("mintable", () => {
  it("keeps one rung of a whole number of rungs", () => {
    expect(mintable(3n * USDC)).toBe(3n * USDC - CENT);
    expect(mintable(2n * CENT)).toBe(CENT);
    expect(mintable(CENT)).toBe(0n);
  });

  it("keeps one rung and the remainder below it", () => {
    expect(mintable(3n * USDC + 7n)).toBe(3n * USDC - CENT);
    expect(mintable(CENT + CENT / 2n)).toBe(0n);
  });

  it("mints nothing below one rung", () => {
    expect(mintable(MIN_DENOM - 1n)).toBe(0n);
    expect(mintable(1n)).toBe(0n);
    expect(mintable(0n)).toBe(0n);
  });

  it("always returns a multiple of the rung", () => {
    for (const amount of [0n, 1n, CENT, CENT + 1n, 7n * CENT + 13n, USDC, 123n * USDC + 4567n]) {
      expect(mintable(amount) % MIN_DENOM).toBe(0n);
    }
  });

  it("never mints more than the deposit", () => {
    for (const amount of [0n, 1n, CENT, 7n * CENT + 13n, USDC]) {
      expect(mintable(amount)).toBeLessThanOrEqual(amount);
    }
  });
});

describe("tax", () => {
  it("is one rung plus the remainder", () => {
    expect(tax(3n * USDC)).toBe(CENT);
    expect(tax(3n * USDC + 7n)).toBe(CENT + 7n);
  });

  it("takes the whole deposit when nothing can be minted", () => {
    expect(tax(CENT)).toBe(CENT);
    expect(tax(CENT - 1n)).toBe(CENT - 1n);
  });

  it("is at least one rung on any deposit that mints", () => {
    for (const amount of [2n * CENT, 7n * CENT + 13n, USDC, 123n * USDC]) {
      expect(tax(amount)).toBeGreaterThanOrEqual(MIN_DENOM);
    }
  });
});

describe("grossFor", () => {
  it("mints exactly what the user asked for", () => {
    for (const net of [CENT, 5n * CENT, 3n * USDC, 100n * USDC]) {
      expect(mintable(grossFor(net))).toBe(net);
    }
  });

  it("keeps the split the size it was without the tax", () => {
    // The tax must go on top. A deposit of three USDC that minted 2.99 would need nine
    // notes of every rung below one USDC.
    expect(splitGreedy(mintable(grossFor(3n * USDC)))).toHaveLength(3);
    expect(splitGreedy(mintable(grossFor(10n * USDC)))).toHaveLength(1);
  });

  it("mints the whole rungs of a net that is not a whole number of rungs", () => {
    expect(mintable(grossFor(3n * USDC + 7n))).toBe(3n * USDC);
  });

  it("costs one rung", () => {
    expect(grossFor(3n * USDC) - 3n * USDC).toBe(MIN_DENOM);
  });
});

describe("pointCount", () => {
  it("counts the split of the mintable part", () => {
    expect(pointCount(grossFor(3n * USDC))).toBe(3 + SLACK);
  });

  it("counts no point when the deposit mints nothing", () => {
    // The mint signs none of them, so a point would only cost a wallet. `BlindMint.deposit`
    // accepts an empty list for exactly this deposit.
    expect(pointCount(CENT)).toBe(0);
    expect(pointCount(1n)).toBe(0);
  });
});
