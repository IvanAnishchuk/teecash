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
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
