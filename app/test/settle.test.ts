/**
 * The settler decisions.
 *
 * `finished` decides whether the settler asks the chain about a deposit again. A deposit
 * that never finishes is a deposit that the timer asks about every few seconds, for as long
 * as the application stays open.
 *
 * `deploymentOf` decides which contract answers. `onChainId` counts from one inside one
 * deployment, so the wrong contract answers about a different deposit that carries the same
 * number.
 */

import { describe, expect, it } from "vitest";
import { deploymentOf, finished, settled } from "../lib/settle";
import type { Deposit, DepositStatus, Note } from "../lib/notes";

const OLD = "0x0A36c0F06E960E9d073A4790653e06cF3E241B8f";

function deposit(status: DepositStatus, contract?: string): Deposit {
  return {
    id: "local-1",
    userId: "user-1",
    amount: "1000000000000000000",
    block: "100",
    status,
    createdAt: 0,
    contract,
  };
}

describe("finished", () => {
  it("keeps working on a deposit that can still move", () => {
    expect(finished(deposit("pending"))).toBe(false);
    expect(finished(deposit("announced"))).toBe(false);
  });

  it("stops on a deposit that reached its end", () => {
    expect(finished(deposit("claimed"))).toBe(true);
    expect(finished(deposit("refunded"))).toBe(true);
  });

  it("stops on a stranded deposit", () => {
    // Without this the timer asks the chain about a dead deposit for ever.
    expect(finished(deposit("stranded"))).toBe(true);
  });
});

describe("deploymentOf", () => {
  it("uses the deployment that the record names", () => {
    expect(deploymentOf(deposit("pending", OLD))).toBe(OLD);
  });

  it("names none for a record from a build without the field", () => {
    // A guess is never safe here. A deposit number counts from one inside one deployment,
    // so the current contract holds a different deposit under the same number. Every step
    // that followed a guess would read that stranger.
    expect(deploymentOf(deposit("pending"))).toBeUndefined();
  });
});

describe("settled", () => {
  function note(status: Note["status"]): Note {
    return {
      address: "0x0000000000000000000000000000000000000001",
      userId: "user-1",
      depositId: "local-1",
      walletId: "w1",
      pointIndex: 0,
      blinded: "0x00",
      status,
    };
  }

  it("counts a note that needs nothing more", () => {
    expect(settled(note("claimed"))).toBe(true);
    expect(settled(note("unused"))).toBe(true);
    expect(settled(note("spent"))).toBe(true);
  });

  it("keeps a note that still needs a step", () => {
    expect(settled(note("awaiting-mint"))).toBe(false);
    expect(settled(note("ready"))).toBe(false);
  });
});
