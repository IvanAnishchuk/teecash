/**
 * The failure messages.
 *
 * These tests state that a person reads a sentence and not a report. The strings come from
 * viem and from the wallets, so a change in either can break the match.
 */

import { describe, expect, it, vi } from "vitest";
import { explain } from "../lib/errors";

describe("explain", () => {
  it("names the wallet that did not answer", () => {
    const viem = new Error(
      "An unknown RPC error occurred. Request Arguments: from: 0x17ac to: 0x0A36 " +
        "Details: Wallet timeout Version: viem@2.56.3",
    );
    expect(explain(viem, "fallback")).toBe(
      "Your wallet did not answer. Open the wallet application and try again.",
    );
  });

  it("names a rejection", () => {
    expect(explain(new Error("User rejected the request."), "fallback")).toBe(
      "You rejected the request in your wallet.",
    );
  });

  it("names a node that did not answer", () => {
    const viem = new Error(
      "HTTP request failed. URL: https://rpc.testnet.arc.io/ Details: Failed to fetch",
    );
    expect(explain(viem, "fallback")).toBe(
      "The node did not answer. Check the network and try again.",
    );
  });

  it("gives the fallback for a failure it does not know", () => {
    expect(explain(new Error("something else entirely"), "fallback")).toBe("fallback");
  });

  it("takes a value that is not an error", () => {
    expect(explain({ weird: true }, "fallback")).toBe("fallback");
  });

  it("keeps the whole error in the console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("Wallet timeout");
    explain(err, "fallback");
    expect(spy).toHaveBeenCalledWith(err);
    spy.mockRestore();
  });
});
