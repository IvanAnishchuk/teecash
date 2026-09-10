/**
 * The reclaim predicate.
 *
 * `reclaimable` decides whether a screen offers the money of a deposit back. A wrong yes
 * shows a button that the contract refuses, and a wrong no leaves the money in the contract
 * with nothing on any screen to say so. These tests state each condition.
 */

import { describe, expect, it } from "vitest";
import { paidBy, reclaimable } from "../lib/refund";
import type { Deposit, Note } from "../lib/notes";

const DEADLINE = 1_700_000_000;
const AFTER = (DEADLINE + 1) * 1000;
const BEFORE = (DEADLINE - 1) * 1000;

function deposit(over: Partial<Deposit> = {}): Deposit {
  return {
    id: "d1",
    userId: "u1",
    amount: "3000000000000000000",
    block: "10",
    status: "pending",
    createdAt: 0,
    onChainId: "1",
    deadline: String(DEADLINE),
    depositor: "0xAbCdEf0000000000000000000000000000000001",
    ...over,
  };
}

const note = { address: "0x01" } as unknown as Note;

describe("reclaimable", () => {
  it("says yes after the deadline", () => {
    expect(reclaimable(deposit(), [note], AFTER)).toBe(true);
  });

  it("says no before the deadline", () => {
    expect(reclaimable(deposit(), [note], BEFORE)).toBe(false);
  });

  it("says no once the mint has answered", () => {
    // The contract refuses a deposit that is no longer pending, so a reclaim of an
    // announced deposit would revert and the notes are claimable anyway.
    for (const status of ["announced", "claimed", "refunded", "stranded"] as const) {
      expect(reclaimable(deposit({ status }), [note], AFTER)).toBe(false);
    }
  });

  it("says no before the contract numbers the deposit", () => {
    expect(reclaimable(deposit({ onChainId: undefined }), [note], AFTER)).toBe(false);
  });

  it("says no for a record that never read the chain", () => {
    expect(reclaimable(deposit({ deadline: undefined }), [note], AFTER)).toBe(false);
  });

  it("says no for a deposit that carries no note", () => {
    // A melt of a wallet below two rungs. The depositor is the change wallet, and the melt
    // emptied it, so it holds no gas to reclaim its own dust.
    expect(reclaimable(deposit({ amount: "0" }), [], AFTER)).toBe(false);
  });
});

describe("paidBy", () => {
  const wallet = (address: string) => ({ address }) as unknown as Parameters<typeof paidBy>[1];

  it("matches the depositor whatever the case", () => {
    expect(paidBy(deposit(), wallet("0xabcdef0000000000000000000000000000000001"))).toBe(true);
    expect(paidBy(deposit(), wallet("0xABCDEF0000000000000000000000000000000001"))).toBe(true);
  });

  it("refuses another wallet", () => {
    expect(paidBy(deposit(), wallet("0xAbCdEf0000000000000000000000000000000002"))).toBe(false);
  });

  it("refuses when there is no wallet or no depositor", () => {
    expect(paidBy(deposit(), undefined)).toBe(false);
    expect(paidBy(deposit({ depositor: undefined }), wallet("0x01"))).toBe(false);
  });
});
