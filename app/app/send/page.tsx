"use client";

/**
 * The send screen.
 *
 * An address and an amount. The screen shows which notes it will use before it sends
 * anything. Each note signs its own transaction through Privy and each note pays its own
 * fee.
 *
 * The recipient receives more than one transfer when the send uses more than one note.
 * That is a consequence of cash and not a defect.
 *
 * The fee comes out of the notes, so the recipient receives less than the amount. The
 * screen shows both numbers, because the difference is the fee of every leg together.
 */

import { useSignTransaction } from "@privy-io/react-auth";
import Link from "next/link";
import { useState } from "react";
import { isAddress, parseUnits } from "viem";
import type { Address } from "viem";
import { usdc } from "../../lib/chain";
import { putNotes } from "../../lib/notes";
import { sendFromNote } from "../../lib/privy";
import { InsufficientFunds, selectNotes, valueOf } from "../../lib/spend";
import type { Selection } from "../../lib/spend";
import { useVault } from "../../lib/vault";

export default function SendScreen() {
  const { userId, notes, balance, reload } = useVault();
  const { signTransaction } = useSignTransaction();
  const [to, setTo] = useState("");
  const [amountText, setAmountText] = useState("1");
  const [step, setStep] = useState<string>();
  const [sent, setSent] = useState<bigint>();
  const [error, setError] = useState<string>();

  let plan: Selection | undefined;
  let planError: string | undefined;
  try {
    plan = selectNotes(notes, parseUnits(amountText, 18));
  } catch (err) {
    planError =
      err instanceof InsufficientFunds
        ? `The wallet holds ${usdc(err.available)} and the send needs ${usdc(err.wanted)}.`
        : err instanceof Error
          ? err.message
          : String(err);
  }

  const valid = isAddress(to);

  async function send() {
    if (!plan || !valid) return;
    setError(undefined);
    let moved = 0n;
    try {
      // The legs go in order. The last leg is the one that breaks a note, so an
      // interruption leaves the broken note for last and every earlier note empty.
      for (const leg of plan.legs) {
        setStep(`Sending ${usdc(leg.amount)} from ${leg.note.address.slice(0, 12)}…`);
        const transfer = await sendFromNote(signTransaction, leg.note, to as Address, leg.amount);
        moved += transfer.sent;

        // A note that gave everything it could is spent. A note that kept a remainder is
        // still a note, and its value is now what the chain says it is.
        const remainder = valueOf(leg.note) - leg.amount;
        await putNotes([
          remainder > 0n
            ? { ...leg.note, denom: remainder.toString() }
            : { ...leg.note, denom: "0", status: "spent" as const },
        ]);
      }
      setSent(moved);
      setStep(undefined);
      await reload();
    } catch (err) {
      setStep(undefined);
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    }
  }

  if (!userId) return <main>Sign in first.</main>;

  return (
    <main>
      <h1>Send</h1>
      <p className="sub">The wallet holds {usdc(balance)}.</p>

      <label>
        <span>To</span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x…"
          disabled={step !== undefined}
        />
      </label>

      <label>
        <span>Amount in USDC</span>
        <input
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          disabled={step !== undefined}
          inputMode="decimal"
        />
      </label>

      {to.length > 0 && !valid && <p className="fail">That is not an address.</p>}
      {planError && <p className="fail">{planError}</p>}

      {plan && (
        <div className="card">
          <strong>
            {plan.legs.length} transfer{plan.legs.length === 1 ? "" : "s"}
          </strong>
          {plan.legs.map((leg) => (
            <div key={leg.note.address} className="line">
              <span className="mono">{leg.note.address.slice(0, 12)}…</span>
              <span>{usdc(leg.amount)}</span>
              <span className="dim">
                {leg.remainder > 0n ? `keeps ${usdc(leg.remainder)}` : "empties"}
              </span>
            </div>
          ))}
          <p className="sub">
            Each note pays its own fee, so the recipient receives a little less than{" "}
            {usdc(plan.total)}.
          </p>
        </div>
      )}

      <button onClick={send} disabled={!plan || !valid || step !== undefined}>
        {step ?? "Send"}
      </button>

      {sent !== undefined && <p className="pass">The recipient received {usdc(sent)}.</p>}
      {error && <p className="fail">{error}</p>}

      <p>
        <Link href="/">Back to the balance</Link>
      </p>
    </main>
  );
}
