"use client";

/**
 * The send screen.
 *
 * An address and an amount. The user gives nothing else.
 *
 * The send empties whole notes into one new wallet and then pays the recipient from that
 * wallet. The recipient sees one transfer, whatever the note count is. The sweeps move
 * money that stays with the user, so Privy signs them without a prompt. The payment is the
 * one step the user confirms.
 *
 * The new wallet keeps the change. That change stays spendable and it waits for a melt.
 * A melt makes ladder notes from it.
 */

import { useCreateWallet, useSignTransaction, useWallets } from "@privy-io/react-auth";
import Link from "next/link";
import { useEffect, useState } from "react";
import { isAddress, parseUnits } from "viem";
import type { Address } from "viem";
import { usdc } from "../../lib/chain";
import { explain } from "../../lib/errors";
import { putNotes } from "../../lib/notes";
import { createNoteWallets, legCost, sendFromWallet } from "../../lib/privy";
import { InsufficientFunds, planSweep, valueOf } from "../../lib/spend";
import type { SweepPlan } from "../../lib/spend";
import { useVault } from "../../lib/vault";

export default function SendScreen() {
  const { userId, notes, balance, reload } = useVault();
  const { signTransaction } = useSignTransaction();
  const { createWallet } = useCreateWallet();
  const { wallets } = useWallets();
  const [to, setTo] = useState("");
  const [amountText, setAmountText] = useState("");
  const [step, setStep] = useState<string>();
  const [sent, setSent] = useState<bigint>();
  const [error, setError] = useState<string>();
  const [cost, setCost] = useState<bigint>();

  // The plan needs the gas price, and the gas price comes from the chain. Read it once.
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

  let plan: SweepPlan | undefined;
  let planError: string | undefined;
  if (amountText.length > 0) {
    try {
      if (cost !== undefined) plan = planSweep(notes, parseUnits(amountText, 18), cost);
    } catch (err) {
      planError =
        err instanceof InsufficientFunds
          ? `You can send ${usdc(err.available)}. The rest of the balance pays the gas.`
          : explain(err, "That amount does not work. Check it and try again.");
    }
  }

  const valid = isAddress(to);

  async function send() {
    if (!plan || !valid || !userId) return;
    setError(undefined);
    setSent(undefined);
    try {
      // The new wallet holds the money for one moment. It belongs to this user, so the
      // money stays with the user until the payment.
      setStep("Preparing.");
      const embedded = wallets.filter((w) => w.connectorType === "embedded");
      const [pocket] = await createNoteWallets(createWallet, embedded.length, 1);

      // Each note goes whole and each sweep pays one share of the gas. A note that gave
      // everything is spent. The record changes as each sweep lands, so a failure in the
      // middle leaves a balance that matches the chain.
      const each = plan.cost / BigInt(plan.notes.length + 1);
      for (const note of plan.notes) {
        setStep(`Collecting ${usdc(valueOf(note))}.`);
        await sendFromWallet(
          signTransaction,
          note.address,
          pocket.address,
          valueOf(note) - each,
          false,
        );
        await putNotes([{ ...note, denom: "0", status: "spent" as const }]);
      }

      setStep("Confirm the payment in your wallet.");
      const paid = await sendFromWallet(
        signTransaction,
        pocket.address,
        to as Address,
        plan.amount,
        true,
      );

      // The change stays in the new wallet and the balance still counts it.
      if (plan.remainder > 0n) {
        await putNotes([
          {
            address: pocket.address,
            userId,
            depositId: "change",
            walletId: pocket.walletId,
            pointIndex: 0,
            blinded: "0x00",
            denom: plan.remainder.toString(),
            status: "claimed" as const,
          },
        ]);
      }

      setSent(paid.sent);
      setStep(undefined);
      await reload();
    } catch (err) {
      setStep(undefined);
      setError(explain(err, "The send stopped. Your balance shows what moved."));
      await reload();
    }
  }

  if (!userId) return <main>Sign in first.</main>;

  return (
    <main>
      <h1>Send</h1>
      <p className="sub">You can send up to {usdc(balance)}.</p>

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
          placeholder="0.00"
        />
      </label>

      {to.length > 0 && !valid && <p className="fail">That is not an address.</p>}
      {planError && <p className="fail">{planError}</p>}

      {plan && (
        <p className="sub">
          The recipient receives {usdc(plan.amount)} in one transfer. The gas costs{" "}
          {usdc(plan.cost)}.
        </p>
      )}

      <button onClick={send} disabled={!plan || !valid || step !== undefined}>
        {step ?? "Send"}
      </button>

      {sent !== undefined && <p className="pass">The recipient received {usdc(sent)}.</p>}
      {error && <p className="fail">{error}</p>}

      {plan && (
        <details>
          <summary className="sub">What this uses</summary>
          <div className="card">
            {plan.notes.map((note) => (
              <div key={note.address} className="line">
                <span className="mono">{note.address.slice(0, 12)}…</span>
                <span>{usdc(valueOf(note))}</span>
              </div>
            ))}
            <div className="line">
              <span>Change kept</span>
              <span className="dim">{usdc(plan.remainder)}</span>
            </div>
          </div>
        </details>
      )}

      <p>
        <Link href="/">Back to the balance</Link>
      </p>
    </main>
  );
}
