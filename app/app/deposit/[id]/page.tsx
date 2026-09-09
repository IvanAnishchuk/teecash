"use client";

/**
 * The wait screen of one deposit.
 *
 * The screen polls for the `Announced` event of this deposit. On arrival the client
 * unblinds each signature and checks it against the public key of its denomination. It
 * then sends the claims to the relayer one at a time, and it shows each note as the
 * relayer pays it.
 *
 * This screen holds the user through the one window that has no way back. Before the
 * announcement the deposit is `Pending`, and `refundByDepositor` returns the money after
 * the deadline. After the announcement `_refund` refuses, because a refund plus a
 * signature that reappears later is a double spend. The value then depends on a claim that
 * only this browser can make.
 *
 * The screen therefore must not put a confirmation in front of a user who can walk away.
 * It claims as soon as it reads the announcement.
 */

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { blindMintAbi } from "../../../lib/abi";
import { explain } from "../../../lib/errors";
import { contract, publicClient, usdc } from "../../../lib/chain";
import { applyAnnouncement, findAnnouncement, relayClaim } from "../../../lib/mint";
import {
  claimed,
  discardDeposit,
  fromAmount,
  notesOfDeposit,
  putDepositOnly,
  putNotes,
} from "../../../lib/notes";
import type { Deposit, Note } from "../../../lib/notes";
import { depositsOf } from "../../../lib/notes";
import { useVault } from "../../../lib/vault";

/** The mint answers a deposit in about a minute. */
const POLL_MS = 4000;

/**
 * Report whether a note needs nothing more.
 *
 * A claimed note holds its money. An unused note never held any, because the mint left its
 * point out of the announcement. A deposit is finished when every note is one or the other.
 * A test for `claimed` alone never passes, because every deposit carries unused points.
 */
function settled(note: Note): boolean {
  return note.status === "claimed" || note.status === "unused" || note.status === "spent";
}

export default function WaitScreen() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { userId } = useVault();
  const [deposit, setDeposit] = useState<Deposit>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [step, setStep] = useState("Reading the deposit.");
  const [error, setError] = useState<string>();
  /**
   * The last network failure.
   *
   * This is not `error`. A network that does not answer stops nothing, because the screen
   * asks again on the next tick. The message therefore goes away as soon as one tick
   * succeeds. An `error` is a fact about the deposit and it stays.
   */
  const [retrying, setRetrying] = useState<string>();
  // One claim run at a time. A second run would send a signature that is already spent.
  const running = useRef(false);

  const load = useCallback(async () => {
    if (!userId) return;
    const [found, all] = await Promise.all([notesOfDeposit(id), depositsOf(userId)]);
    setNotes(found);
    setDeposit(all.find((d) => d.id === id));
  }, [id, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Claim every note that holds a signature.
   *
   * The notes go one at a time. The relayer must never see the notes of one deposit as a
   * group, because that group is the link that blinding removes.
   *
   * A failed claim does not stop the others. A note that keeps its signature can be
   * claimed again later.
   */
  const claimAll = useCallback(async (ready: Note[]) => {
    for (const note of ready) {
      if (note.sig === undefined) continue;
      setStep(`Claiming ${usdc(fromAmount(note.denom ?? "0"))}.`);
      try {
        await relayClaim(note);
        await putNotes([claimed(note)]);
      } catch (err) {
        setError(explain(err, "The claim did not go through. This screen tries again."));
      }
      await load();
    }
  }, [load]);

  useEffect(() => {
    if (!deposit || !userId) return;
    if (deposit.status === "claimed" || deposit.status === "refunded") return;

    let stop = false;

    async function tick() {
      if (running.current || stop || !deposit) return;
      running.current = true;
      try {
        const stored = await notesOfDeposit(id);

        // The deposit screen stops as soon as the wallet signs, so this screen reads the
        // receipt itself. The step repeats on every tick until the network answers. A
        // deposit without a hash never reached a wallet, so it has no receipt to read.
        if (deposit.onChainId === undefined) {
          if (deposit.txHash === undefined) {
            setStep("This deposit never reached your wallet.");
            return;
          }
          setStep("Waiting for the deposit to confirm.");
          const receipt = await publicClient.getTransactionReceipt({
            hash: deposit.txHash as Hex,
          });
          if (receipt.status !== "success") {
            setError("The deposit transaction failed. The money did not leave your wallet.");
            return;
          }

          // The contract numbers the deposit. Every later log search uses that number, and
          // the search starts at this block because Arc prunes history.
          const logs = await publicClient.getContractEvents({
            address: contract(),
            abi: blindMintAbi,
            eventName: "Deposited",
            blockHash: receipt.blockHash,
          });
          const found = (logs[0]?.args as { id?: bigint } | undefined)?.id;
          if (found === undefined) {
            setError("deposit: the receipt holds no Deposited event");
            return;
          }
          await putDepositOnly({
            ...deposit,
            onChainId: found.toString(),
            block: receipt.blockNumber.toString(),
          });
          await load();
          return;
        }

        // Notes that already hold a signature are claimed first. A reload in the middle of
        // a claim run leaves them, and they must not wait for another announcement.
        const pending = stored.filter((n) => n.status === "ready" && n.sig !== undefined);
        if (pending.length > 0) {
          await claimAll(pending);
        } else if (stored.some((n) => n.status === "awaiting-mint")) {
          setStep("Waiting for the mint.");
          const announcement = await findAnnouncement(deposit.onChainId, BigInt(deposit.block));
          if (!announcement) return;

          setStep("Checking the signatures.");
          const { ready, unused, failed } = await applyAnnouncement(stored, announcement);
          if (failed.length > 0) setError(failed.join(". "));
          // The unused points go to the disk with the signed ones. Without that step the
          // deposit waits for a signature that the mint already decided not to make.
          if (ready.length > 0 || unused.length > 0) {
            await putNotes([...ready, ...unused]);
            await putDepositOnly({ ...deposit, status: "announced" });
            await claimAll(ready);
          }
        }

        const after = await notesOfDeposit(id);
        if (after.length > 0 && after.every((n) => settled(n))) {
          await putDepositOnly({ ...deposit, status: "claimed" });
          setStep("Done.");
        }
        await load();
        setRetrying(undefined);
      } catch (err) {
        setRetrying(explain(err, "The node did not answer."));
      } finally {
        running.current = false;
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [deposit, userId, id, claimAll, load]);

  if (!userId) return <main>Sign in first.</main>;
  if (!deposit) return <main>Reading the deposit.</main>;

  const done = notes.length > 0 && notes.every(settled);

  return (
    <main>
      <h1>{usdc(fromAmount(deposit.amount))}</h1>
      <p className="sub">
        Deposit {deposit.id}. {deposit.status}.
      </p>

      {!done && (
        <div className="card">
          <strong>{step}</strong>
          <p className="sub">
            Keep this screen open. The claims need this browser, and nothing else can make
            them.
          </p>
        </div>
      )}

      <div className="card">
        <strong>Notes</strong>
        {notes.map((note) => (
          <div key={note.address} className="line">
            <span className="mono">{note.address.slice(0, 12)}…</span>
            <span>{note.denom ? usdc(fromAmount(note.denom)) : "—"}</span>
            <span className={note.status === "claimed" ? "pass dim" : "dim"}>{note.status}</span>
          </div>
        ))}
      </div>

      {deposit.txHash === undefined && (
        <p className="sub">
          This deposit never reached your wallet, so it holds no money and it cannot
          continue.{" "}
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

      {error && <p className="fail">{error}</p>}
      {retrying && !done && (
        <p className="sub">The node did not answer. This screen asks again every few seconds.</p>
      )}

      {done && <Link href="/">Back to the balance</Link>}
    </main>
  );
}
