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
import { depositsOf, notesOf } from "./notes";
import { finished, settleDeposit } from "./settle";
import { valueOf } from "./spend";

/** The mint answers a deposit in about a minute. */
const PASS_MS = 4000;

export function useSettler(): void {
  const { authenticated, user } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signTransaction } = useSignTransaction();
  const { wallets } = useWallets();
  const userId = authenticated ? user?.id : undefined;
  // One pass at a time. A second pass would send a signature that the first one already
  // sent, and the second claim then fails on a note that is already claimed.
  const running = useRef(false);

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
        if (stop) return;
        const embedded = wallets.filter((w) => w.connectorType === "embedded").length;
        for (const note of await notesOf(userId)) {
          if (stop) break;
          if (note.status !== "claimed") continue;
          if (valueOf(note) <= 0n || isDenom(valueOf(note))) continue;
          try {
            await meltWallet(createWallet, signTransaction, userId, embedded, note);
          } catch (err) {
            console.error(err);
          }
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
