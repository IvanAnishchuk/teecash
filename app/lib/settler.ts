"use client";

/**
 * The settler timer.
 *
 * One component mounts this hook, and it then runs for as long as the application is open.
 * It walks every deposit of the signed in user that is not finished and it moves each one
 * forward. `lib/settle.ts` holds the steps.
 *
 * The hook holds no state that a screen reads. Screens read IndexedDB through `useVault`,
 * and this hook writes there, so a screen shows the result on its next read.
 */

import { useCreateWallet, usePrivy, useSignTransaction, useWallets } from "@privy-io/react-auth";
import { isDenom } from "@teecash/lib-blind";
import { useEffect, useRef } from "react";
import { meltWallet } from "./melt";
import { depositsOf, notesOf, putNotes } from "./notes";
import { finished, settleDeposit } from "./settle";
import { valueOf } from "./spend";

/**
 * The mint answers a deposit in about a minute.
 *
 * Each pass asks the node about every deposit that is not finished and melts one change
 * wallet. A pass every four seconds asked fifteen times inside one answer of the mint and
 * the public node replied 429. Ten seconds still shows a claim quickly and it takes a sixth
 * of the requests.
 */
const PASS_MS = 10_000;

/** How many times a melt may throw before the settler takes the next wallet instead. */
const MELT_TRIES = 3;

export function useSettler(): void {
  const { authenticated, user } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signTransaction } = useSignTransaction();
  const { wallets } = useWallets();
  const userId = authenticated ? user?.id : undefined;
  // One pass at a time. A second pass would send a signature that the first one already
  // sent, and the second claim then fails on a note that is already claimed.
  const running = useRef(false);
  // How many times the melt of one wallet threw. A pass melts one wallet, so a wallet that
  // throws on every pass would hold every other change wallet behind it. After `MELT_TRIES`
  // the settler leaves it and takes the next one. A reload clears the count, because the
  // cause is often the node and not the wallet.
  const failures = useRef(new Map<string, number>());

  useEffect(() => {
    if (!userId) return;
    let stop = false;

    async function pass() {
      if (running.current || stop || !userId) return;
      running.current = true;
      try {
        for (const deposit of await depositsOf(userId)) {
          if (stop) break;
          if (finished(deposit)) continue;
          try {
            await settleDeposit(deposit);
          } catch (err) {
            // One deposit that fails must not stop the others. The next pass tries again.
            console.error(err);
          }
        }

        // A send leaves change in one wallet, and that change is not a ladder value. The
        // melt turns it into notes. It happens here, so the user never sees it and never
        // asks for it. A melt that fails leaves the change, and a later pass tries again.
        //
        // One wallet per pass. A melt costs four calls to the node and one wallet from the
        // provider. Melting every wallet on every pass made a queue of change wallets ask
        // the node hundreds of times a minute, and the node replied 429. The next pass takes
        // the next wallet.
        if (stop) return;
        const embedded = wallets.filter((w) => w.connectorType === "embedded").length;
        const change = (await notesOf(userId)).find(
          (note) =>
            note.status === "claimed" &&
            valueOf(note) > 0n &&
            !isDenom(valueOf(note)) &&
            (failures.current.get(note.address) ?? 0) < MELT_TRIES,
        );
        if (!change || stop) return;
        try {
          const melted = await meltWallet(createWallet, signTransaction, userId, embedded, change);
          failures.current.delete(change.address);
          // `meltWallet` answers undefined when the gas costs more than the wallet holds.
          // No later pass changes that, so the note leaves the queue. Without this the
          // settler asks the node about the same dead wallet for ever.
          if (melted === undefined) {
            await putNotes([{ ...change, status: "dust" as const }]);
          }
        } catch (err) {
          failures.current.set(change.address, (failures.current.get(change.address) ?? 0) + 1);
          console.error(err);
        }
      } finally {
        running.current = false;
      }
    }

    void pass();
    const timer = setInterval(() => void pass(), PASS_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [userId, createWallet, signTransaction, wallets]);
}
