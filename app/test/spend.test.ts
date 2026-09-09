/**
 * The note selection.
 *
 * These tests state what the selection must protect. A send must move the exact amount,
 * and it must break a note only when no set of whole notes gives that amount.
 */

import { describe, expect, it } from "vitest";
import type { Note } from "../lib/notes";
import { InsufficientFunds, selectNotes, valueOf } from "../lib/spend";

const USDC = 10n ** 18n;

/** Build a claimed note of one value. The address only has to be different each time. */
let counter = 0;
function note(usdc: bigint, status: Note["status"] = "claimed"): Note {
  counter += 1;
  return {
    address: `0x${counter.toString(16).padStart(40, "0")}` as Note["address"],
    userId: "user",
    depositId: "1",
    walletId: `w${counter}`,
    pointIndex: counter,
    blinded: "0x00",
    denom: (usdc * USDC).toString(),
    status,
  };
}

const sum = (legs: { amount: bigint }[]) => legs.reduce((t, l) => t + l.amount, 0n);

describe("selectNotes", () => {
  it("sends the exact amount", () => {
    const wallet = [note(100n), note(10n), note(10n), note(1n), note(1n), note(1n)];
    const picked = selectNotes(wallet, 12n * USDC);
    expect(sum(picked.legs)).toBe(12n * USDC);
    expect(picked.total).toBe(12n * USDC);
  });

  it("prefers a set of whole notes and breaks nothing", () => {
    const wallet = [note(100n), note(10n), note(10n), note(1n), note(1n), note(1n)];
    const picked = selectNotes(wallet, 12n * USDC);
    expect(picked.legs.every((leg) => leg.remainder === 0n)).toBe(true);
    expect(picked.legs.map((leg) => leg.amount).sort()).toEqual(
      [10n * USDC, 1n * USDC, 1n * USDC].sort(),
    );
  });

  it("leaves the large note whole when the small notes cover the amount", () => {
    const wallet = [note(100n), note(10n), note(10n), note(1n), note(1n), note(1n)];
    const picked = selectNotes(wallet, 12n * USDC);
    const used = picked.legs.map((leg) => leg.note.address);
    const hundred = wallet.find((n) => valueOf(n) === 100n * USDC) as Note;
    expect(used).not.toContain(hundred.address);
  });

  it("breaks one note when no set of whole notes gives the amount", () => {
    // 5 is not reachable from 10 and 100, so one note has to break.
    const wallet = [note(100n), note(10n)];
    const picked = selectNotes(wallet, 5n * USDC);
    const broken = picked.legs.filter((leg) => leg.remainder > 0n);
    expect(broken).toHaveLength(1);
    expect(sum(picked.legs)).toBe(5n * USDC);
  });

  it("breaks the smallest note that covers the rest", () => {
    const wallet = [note(100n), note(10n)];
    const picked = selectNotes(wallet, 5n * USDC);
    const broken = picked.legs.find((leg) => leg.remainder > 0n);
    expect(valueOf(broken!.note)).toBe(10n * USDC);
    expect(broken!.remainder).toBe(5n * USDC);
  });

  it("keeps the small notes whole when emptying them would break a larger note", () => {
    // 25 from {100, 10, 10}. Emptying both tens leaves only the hundred to break, and it
    // strands 95. Breaking the hundred at once strands 75 and keeps both tens on the
    // ladder.
    const wallet = [note(100n), note(10n), note(10n)];
    const picked = selectNotes(wallet, 25n * USDC);
    expect(sum(picked.legs)).toBe(25n * USDC);
    expect(picked.legs).toHaveLength(1);
    expect(picked.legs[0].remainder).toBe(75n * USDC);
  });

  it("empties the small notes when that strands less than one large break", () => {
    // 25 from {100, 20, 10}. The twenty goes whole and the ten covers the last five, so
    // only 5 is stranded. Breaking the hundred would strand 75.
    const wallet = [note(100n), note(20n), note(10n)];
    const picked = selectNotes(wallet, 25n * USDC);
    expect(sum(picked.legs)).toBe(25n * USDC);
    expect(picked.legs.at(-1)?.remainder).toBe(5n * USDC);
  });

  it("puts the broken note last and empties every earlier one", () => {
    // 25 from {100, 20, 10} takes the twenty whole and then breaks the ten.
    const wallet = [note(100n), note(20n), note(10n)];
    const picked = selectNotes(wallet, 25n * USDC);
    expect(picked.legs.length).toBeGreaterThan(1);
    expect(picked.legs.at(-1)?.remainder).toBeGreaterThan(0n);
    expect(picked.legs.slice(0, -1).every((leg) => leg.remainder === 0n)).toBe(true);
  });

  it("spends a whole wallet", () => {
    const wallet = [note(10n), note(1n)];
    const picked = selectNotes(wallet, 11n * USDC);
    expect(sum(picked.legs)).toBe(11n * USDC);
    expect(picked.legs.every((leg) => leg.remainder === 0n)).toBe(true);
  });

  it("refuses an amount the notes do not cover", () => {
    const wallet = [note(1n), note(1n)];
    expect(() => selectNotes(wallet, 3n * USDC)).toThrow(InsufficientFunds);
  });

  it("refuses an amount of zero or less", () => {
    expect(() => selectNotes([note(1n)], 0n)).toThrow();
    expect(() => selectNotes([note(1n)], -1n * USDC)).toThrow();
  });

  it("ignores a note that is not claimed", () => {
    const wallet = [note(10n, "ready"), note(1n), note(1n)];
    expect(() => selectNotes(wallet, 10n * USDC)).toThrow(InsufficientFunds);
  });

  it("spends a note that was already broken once", () => {
    // A broken note holds a value that is not on the ladder. It stays spendable.
    const wallet = [note(100n), { ...note(1n), denom: (7n * USDC).toString() }];
    const picked = selectNotes(wallet, 7n * USDC);
    expect(sum(picked.legs)).toBe(7n * USDC);
    expect(picked.legs).toHaveLength(1);
    expect(picked.legs[0].remainder).toBe(0n);
  });
});
