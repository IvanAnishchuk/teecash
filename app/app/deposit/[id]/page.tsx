"use client";

/**
 * The detail of one deposit.
 *
 * The screen shows what each point of the deposit became. It drives nothing. The settler in
 * `lib/settler.ts` reads the receipt, applies the announcement and sends every claim, and it
 * runs for as long as the application is open. This screen therefore only reads.
 *
 * A user can leave at any moment. The deposit finishes anyway, on any screen.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usdc } from "../../../lib/chain";
import { depositsOf, discardDeposit, fromAmount, notesOfDeposit } from "../../../lib/notes";
import type { Deposit, Note } from "../../../lib/notes";
import { settled } from "../../../lib/settle";
import { useVault } from "../../../lib/vault";

/** The settler works on a timer, so this screen reads again on the same beat. */
const READ_MS = 2000;

export default function DepositScreen() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { userId } = useVault();
  const [deposit, setDeposit] = useState<Deposit>();
  const [notes, setNotes] = useState<Note[]>([]);

  const load = useCallback(async () => {
    if (!userId) return;
    const [found, all] = await Promise.all([notesOfDeposit(id), depositsOf(userId)]);
    setNotes(found);
    setDeposit(all.find((d) => d.id === id));
  }, [id, userId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), READ_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!userId) return <main>Sign in first.</main>;
  if (!deposit) return <main>Reading the deposit.</main>;

  const done = notes.length > 0 && notes.every(settled);
  const paid = notes.filter((n) => n.status === "claimed").length;
  const waiting = notes.filter((n) => n.status === "awaiting-mint" || n.status === "ready").length;

  return (
    <main>
      <h1>{usdc(fromAmount(deposit.amount))}</h1>
      <p className="sub">
        {done ? "Finished." : deposit.txHash === undefined ? "Not sent." : "Settling."} {paid} note
        {paid === 1 ? "" : "s"} paid{waiting > 0 ? `, ${waiting} to go` : ""}.
      </p>

      {deposit.txHash === undefined && (
        <p className="sub">
          This deposit never reached your wallet, so it holds no money and it cannot continue.{" "}
          <button
            className="ghost"
            onClick={async () => {
              await discardDeposit(deposit);
              router.push("/");
            }}
          >
            Discard it
          </button>
        </p>
      )}

      <p>
        <Link href="/">Back to the balance</Link>
      </p>

      <details>
        <summary className="sub">Points</summary>
        <div className="card">
          {notes.map((note) => (
            <div key={note.address} className="line">
              <span className="mono">{note.address.slice(0, 12)}…</span>
              <span>{note.denom ? usdc(fromAmount(note.denom)) : "—"}</span>
              <span className={note.status === "claimed" ? "pass dim" : "dim"}>{note.status}</span>
            </div>
          ))}
        </div>
      </details>
    </main>
  );
}
