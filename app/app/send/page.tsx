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
 * The recipient receives the amount exactly. The notes pay the fee in addition to it, so
 * the wallet loses more than the amount. The screen shows both numbers.
 */

import { useSignTransaction } from "@privy-io/react-auth";
import Link from "next/link";
import { useEffect, useState } from "react";
import { isAddress, parseUnits } from "viem";
import type { Address } from "viem";
import { usdc } from "../../lib/chain";
import { explain } from "../../lib/errors";
import { putNotes } from "../../lib/notes";
import { legCost, sendFromNote } from "../../lib/privy";
import { InsufficientFunds, selectNotes } from "../../lib/spend";
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
  const [cost, setCost] = useState<bigint>();

  // The plan needs the fee, and the fee comes from the chain. Read it once for the screen.
  useEffect(() => {
    let live = true;
    legCost().then(
      (found) => live && setCost(found),
      () => live && setCost(undefined),
    );
    return () => {
      live = false;
    };
  }, []);

  let plan: Selection | undefined;
  let planError: string | undefined;
  try {
    if (cost !== undefined) plan = selectNotes(notes, parseUnits(amountText, 18), cost);
  } catch (err) {
    planError =
      err instanceof InsufficientFunds
        ? `The notes can send ${usdc(err.available)} and the send needs ${usdc(err.wanted)}. ` +
          "The difference is the fee that each note pays."
        : explain(err, "That amount does not work. Check it and try again.");
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

        // `leg.remainder` is the value the note keeps. It already excludes the fee, so it
        // is the new denomination. A note that keeps nothing is spent.
        await putNotes([
          leg.remainder > 0n
            ? { ...leg.note, denom: leg.remainder.toString() }
            : { ...leg.note, denom: "0", status: "spent" as const },
        ]);
      }
      setSent(moved);
      setStep(undefined);
      await reload();
    } catch (err) {
      setStep(undefined);
      setError(explain(err, "The send stopped. Read the notes below for what moved."));
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
      {cost === undefined && !planError && <p className="sub">Reading the fee.</p>}

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
            The recipient receives {usdc(plan.total)}. The notes pay {usdc(plan.cost)} in fees,
            so the wallet loses {usdc(plan.total + plan.cost)}.
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
