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
import type { ReactNode } from "react";
import { chain } from "../lib/chain";

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
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          /**
           * Privy signs with a note wallet and it does not ask.
           *
           * A send empties many notes into one wallet, and a prompt for each note makes a
           * send of ten notes unusable. Every one of those transactions moves money that
           * stays with the user. The payment out is the step that leaves the user, and
           * `sendFromWallet` asks Privy to prompt for that one.
           *
           * The screen of this application therefore carries the confirmation. It shows
           * the amount, the gas and the notes it uses, which is more than the Privy modal
           * shows for the same transaction.
           */
          showWalletUIs: false,
        },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
