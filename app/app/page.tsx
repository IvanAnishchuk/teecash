"use client";

/**
 * The balance screen.
 *
 * One number, then the notes as denominations, then the deposits that are not finished.
 * Two actions leave this screen. One deposits and one sends.
 */

import { usePrivy } from "@privy-io/react-auth";
import Link from "next/link";
import { usdc } from "../lib/chain";
import { fromAmount } from "../lib/notes";
import type { Note } from "../lib/notes";
import { useVault } from "../lib/vault";

/** Group the claimed notes by denomination, largest first. */
function byDenomination(notes: Note[]): { denom: bigint; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    if (note.status !== "claimed" || !note.denom) continue;
    counts.set(note.denom, (counts.get(note.denom) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([denom, count]) => ({ denom: fromAmount(denom), count }))
    .sort((a, b) => (a.denom < b.denom ? 1 : -1));
}

export default function Balance() {
  const { login, logout } = usePrivy();
  const { ready, userId, notes, deposits, balance, loading } = useVault();

  if (!ready) return <main>Loading.</main>;

  if (!userId) {
    return (
      <main>
        <h1>teecash</h1>
        <p className="sub">Blind signed cash on Arc.</p>
        <button onClick={login}>Sign in with Privy</button>
      </main>
    );
  }

  const groups = byDenomination(notes);
  const unfinished = deposits.filter((d) => d.status !== "claimed" && d.status !== "refunded");

  return (
    <main>
      <h1>{usdc(balance)}</h1>
      <p className="sub">{loading ? "Reading the notes." : `${groups.length} denomination(s)`}</p>

      <div className="row">
        <Link href="/deposit">
          <button>Deposit</button>
        </Link>
        <Link href="/send">
          <button className="ghost" disabled={balance === 0n}>
            Send
          </button>
        </Link>
      </div>

      {groups.length > 0 && (
        <div className="card">
          <strong>Notes</strong>
          {groups.map((group) => (
            <div key={group.denom.toString()} className="line">
              <span>{usdc(group.denom)}</span>
              <span className="dim">{group.count}</span>
            </div>
          ))}
        </div>
      )}

      {unfinished.length > 0 && (
        <div className="card">
          <strong>Deposits</strong>
          {unfinished.map((deposit) => (
            <div key={deposit.id} className="line">
              <span>{usdc(fromAmount(deposit.amount))}</span>
              <span className="dim">{deposit.status}</span>
              <Link href={`/deposit/${deposit.id}`}>open</Link>
            </div>
          ))}
        </div>
      )}

      {groups.length === 0 && unfinished.length === 0 && !loading && (
        <p className="sub">There are no notes yet. Start with a deposit.</p>
      )}

      <button className="ghost" onClick={logout}>
        Sign out
      </button>
    </main>
  );
}
