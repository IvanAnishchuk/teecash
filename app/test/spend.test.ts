/**
 * The note selection.
 *
 * These tests state what a send must protect. The recipient receives the exact amount, the
 * notes cover every transaction the send makes, and no note breaks.
 */

import { describe, expect, it } from "vitest";
import type { Note } from "../lib/notes";
import { InsufficientFunds, planSweep, valueOf } from "../lib/spend";

const USDC = 10n ** 18n;
const CENT = USDC / 100n;

/** Build a claimed note of one value. The address only has to be different each time. */
let counter = 0;
function note(value: bigint, status: Note["status"] = "claimed"): Note {
  counter += 1;
  return {
    address: `0x${counter.toString(16).padStart(40, "0")}` as Note["address"],
    userId: "user",
    depositId: "1",
    walletId: `w${counter}`,
    pointIndex: counter,
    blinded: "0x00",
    denom: value.toString(),
    status,
  };
}

const held = (notes: Note[]) => notes.reduce((t, n) => t + valueOf(n), 0n);

describe("planSweep", () => {
  it("delivers the exact amount", () => {
    const wallet = [note(100n * USDC), note(10n * USDC), note(1n * USDC)];
    const plan = planSweep(wallet, 5n * USDC);
    expect(plan.amount).toBe(5n * USDC);
  });

  it("takes the largest note first, so a send uses as few notes as it can", () => {
    const wallet = [note(1n * USDC), note(100n * USDC), note(10n * USDC)];
    const plan = planSweep(wallet, 5n * USDC);
    expect(plan.notes).toHaveLength(1);
    expect(valueOf(plan.notes[0])).toBe(100n * USDC);
  });

  it("takes more notes when one does not cover the amount", () => {
    const wallet = [note(1n * USDC), note(1n * USDC), note(1n * USDC)];
    const plan = planSweep(wallet, 2n * USDC);
    expect(plan.notes.length).toBeGreaterThan(1);
  });

  it("accounts for every note and the payment", () => {
    const cost = CENT;
    const wallet = [note(10n * USDC), note(1n * USDC)];
    const plan = planSweep(wallet, 5n * USDC, cost);
    // One transaction for each note it empties, and one more for the payment.
    expect(plan.cost).toBe(BigInt(plan.notes.length + 1) * cost);
    // Nothing appears and nothing disappears.
    expect(held(plan.notes)).toBe(plan.amount + plan.cost + plan.remainder);
  });

  it("keeps the change as the remainder", () => {
    const wallet = [note(10n * USDC)];
    const plan = planSweep(wallet, 3n * USDC);
    expect(plan.remainder).toBe(7n * USDC);
  });

  it("breaks no note", () => {
    const wallet = [note(10n * USDC), note(1n * USDC)];
    const plan = planSweep(wallet, 4n * USDC);
    // Every chosen note is a note of the wallet, whole and unchanged.
    for (const chosen of plan.notes) {
      expect(wallet.some((n) => n.address === chosen.address)).toBe(true);
    }
  });

  it("refuses when the notes cover the amount but not the gas", () => {
    const wallet = [note(1n * USDC)];
    expect(() => planSweep(wallet, 1n * USDC, CENT)).toThrow(InsufficientFunds);
  });

  it("refuses an amount the notes do not cover", () => {
    const wallet = [note(1n * USDC), note(1n * USDC)];
    expect(() => planSweep(wallet, 3n * USDC)).toThrow(InsufficientFunds);
  });

  it("refuses an amount of zero or less", () => {
    expect(() => planSweep([note(1n * USDC)], 0n)).toThrow();
    expect(() => planSweep([note(1n * USDC)], -1n * USDC)).toThrow();
  });

  it("ignores a note that is not claimed", () => {
    const wallet = [note(10n * USDC, "ready"), note(1n * USDC)];
    expect(() => planSweep(wallet, 10n * USDC)).toThrow(InsufficientFunds);
  });

  it("ignores a note that cannot pay its own gas", () => {
    const dust = note(CENT / 2n);
    const wallet = [note(1n * USDC), dust];
    const plan = planSweep(wallet, USDC / 2n, CENT);
    expect(plan.notes.map((n) => n.address)).not.toContain(dust.address);
  });

  it("spends the cent rungs", () => {
    const wallet = [note(10n * CENT), note(1n * CENT)];
    const plan = planSweep(wallet, 5n * CENT);
    expect(plan.amount).toBe(5n * CENT);
    expect(plan.notes).toHaveLength(1);
  });
});
