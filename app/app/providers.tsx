"use client";

/**
 * The Privy provider.
 *
 * Privy gives identity. Privy also holds the note keys. The browser never holds a note
 * private key.
 *
 * `createOnLogin: "off"` is necessary. A note is one embedded wallet per point. The
 * client makes each wallet at the time of the deposit with `createAdditional`. An
 * automatic wallet at login is a wallet that belongs to no point.
 */

import { PrivyProvider } from "@privy-io/react-auth";
import type { PrivyClientConfig } from "@privy-io/react-auth";
import type { ReactNode } from "react";
import { chain } from "../lib/chain";
import { useSettler } from "../lib/settler";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

export function Providers({ children }: { children: ReactNode }) {
  if (!APP_ID) {
    return (
      <main>
        <h1>Configuration</h1>
        <p>Set NEXT_PUBLIC_PRIVY_APP_ID. Copy example.env to .env.local.</p>
      </main>
    );
  }

  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        /**
         * `showWalletUIs` stays unset, which leaves the default.
         *
         * Each call decides instead. A sweep and a melt pass false, because they move money
         * that stays with the user. The payment out passes true, because that is the step
         * that leaves the user and the step the user must approve.
         *
         * A value here would decide for every call, and the payment out would then sign
         * with no question at all.
         */
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          /**
           * The Privy screen shows the amount only when it simulates the transaction.
           *
           * `SendTransactionScreen` fills `tokensSent` from the simulation. It has a second
           * path that reads the value of the transaction, and that path runs only after a
           * scan fails. A scan that never starts therefore leaves the amount empty, and the
           * user approves a payment with no number on the screen.
           *
           * The default of `enabled` is false. The declared type of the configuration omits
           * this field, so it needs a cast.
           */
          transactionScanning: { enabled: true },
        },
        defaultChain: chain,
        supportedChains: [chain],
      } as PrivyClientConfig}
    >
      <Settler />
      {children}
    </PrivyProvider>
  );
}

/**
 * The settler runs for as long as the application is open.
 *
 * It sits here and not on a screen. A deposit needs this browser to claim its notes, and it
 * must not also need one screen. A user who opens the balance settles a deposit that a
 * different screen started.
 *
 * The component draws nothing.
 */
function Settler(): null {
  useSettler();
  return null;
}
