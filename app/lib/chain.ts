/**
 * Chain access for the browser.
 *
 * This file repeats what `cli/src/chain.ts` does. The two stay separate. The command line
 * client reads files and process variables that a browser does not have. It also holds a
 * deployer key that a browser must never hold.
 *
 * Every value comes from a `NEXT_PUBLIC_` variable, so the bundle carries it. No value is
 * a secret. The relayer holds the only funded key in this system.
 */

import { type Address, type Chain, createPublicClient, defineChain, http } from "viem";

export const RPC_URL = process.env.NEXT_PUBLIC_TEECASH_RPC ?? "http://127.0.0.1:8545";

/** The chain identifier. The domain tag of the contract covers it, so it must be exact. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_TEECASH_CHAIN_ID ?? "5042002");

/**
 * The BlindMint deployment.
 *
 * This is a function and not a constant. A constant that throws stops the build in any
 * environment without `.env.local`. A screen that needs the address calls this, and only
 * that screen fails when the address is absent.
 */
export function contract(): Address {
  const value = process.env.NEXT_PUBLIC_TEECASH_CONTRACT;
  if (!value) {
    throw new Error("chain: set NEXT_PUBLIC_TEECASH_CONTRACT. Copy example.env to .env.local.");
  }
  return value as Address;
}

/** The claim relayer. It is the Go service in `workflow/relayer`, not a route of this app. */
export const RELAYER_URL =
  process.env.NEXT_PUBLIC_TEECASH_RELAYER ?? "http://127.0.0.1:8787";

/**
 * The chain.
 *
 * The native token of Arc uses 18 decimals. The ERC-20 interface at `0x3600...0000`
 * reports 6. It shows the same balance divided by 10^12. Everything here uses native
 * units, so the chain declares 18.
 */
export const chain: Chain = defineChain({
  id: CHAIN_ID,
  name: `teecash-${CHAIN_ID}`,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

/** One USDC in native base units. */
export const ONE_USDC = 10n ** 18n;

/** Format a native amount as USDC. The output keeps 6 decimal places. Arc shows the same 6. */
export function usdc(amount: bigint): string {
  const whole = amount / ONE_USDC;
  const micro = ((amount % ONE_USDC) / 10n ** 12n).toString().padStart(6, "0").replace(/0+$/, "");
  return micro.length > 0 ? `${whole}.${micro} USDC` : `${whole} USDC`;
}
