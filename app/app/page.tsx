"use client";

/**
 * The balance screen.
 *
 * One number and two actions. A person who holds cash knows the total, so this screen
 * shows the total first.
 *
 * The notes, the denominations and the deposits sit behind a summary that stays closed. A
 * developer reads them when the client fails. A user does not need them.
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
      {loading && <p className="sub">Reading the notes.</p>}

      <div className="row">
        <Link href="/deposit">
          <button>Add money</button>
        </Link>
        <Link href="/send">
          <button className="ghost" disabled={balance === 0n}>
            Send
          </button>
        </Link>
      </div>

      {unfinished.length > 0 && (
        <div className="card">
          <strong>Waiting</strong>
          {unfinished.map((deposit) => (
            <div key={deposit.id} className="line">
              <span>{usdc(fromAmount(deposit.amount))}</span>
              <span className="dim">{deposit.status}</span>
              <Link href={`/deposit/${deposit.id}`}>open</Link>
            </div>
          ))}
        </div>
      )}

      {balance === 0n && unfinished.length === 0 && !loading && (
        <p className="sub">There is no money here yet. Add some.</p>
      )}

      {groups.length > 0 && (
        <details>
          <summary className="sub">Notes</summary>
          <div className="card">
            {groups.map((group) => (
              <div key={group.denom.toString()} className="line">
                <span>{usdc(group.denom)}</span>
                <span className="dim">{group.count}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <button className="ghost" onClick={logout}>
        Sign out
      </button>
    </main>
  );
}
