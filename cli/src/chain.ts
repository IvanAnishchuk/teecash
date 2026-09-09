/**
 * Chain access and build artifacts.
 *
 * The CLI reads the compiled contracts from `contracts/out`. Run `forge build` before
 * the first deploy.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const repoRoot = new URL("../../", import.meta.url);

/**
 * Load the local environment files.
 *
 * `cli/.env` holds the node, the deployer key and the Privy credentials. `workflow/.env`
 * holds the mint keys that the CRE workflow reads. The deployment must use the same mint
 * keys as the workflow. The CLI therefore reads that file too.
 *
 * A variable already in the environment wins over both files.
 */
function loadEnvFiles(): void {
  for (const relative of ["cli/.env", "workflow/.env"]) {
    const path = fileURLToPath(new URL(relative, repoRoot));
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

loadEnvFiles();

export const RPC_URL = process.env.TEECASH_RPC ?? "http://127.0.0.1:8545";

/** The first anvil account. It funds the deposits in a local run. */
export const DEPLOYER_KEY =
  (process.env.TEECASH_DEPLOYER_KEY as Hex) ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export interface Artifact {
  abi: unknown[];
  bytecode: Hex;
}

/** Read one Foundry artifact. */
export function artifact(name: string): Artifact {
  const path = fileURLToPath(new URL(`contracts/out/${name}.sol/${name}.json`, repoRoot));
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

/** Build the viem chain from whatever the node reports. */
export async function connect() {
  const probe = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await probe.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `teecash-${chainId}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

  const account = privateKeyToAccount(DEPLOYER_KEY);
  return {
    chainId,
    chain,
    account,
    publicClient: createPublicClient({ chain, transport: http(RPC_URL) }),
    walletClient: createWalletClient({ account, chain, transport: http(RPC_URL) }),
  };
}

export type Chain = Awaited<ReturnType<typeof connect>>;

/** One USDC in native base units. The native token of Arc uses 18 decimals. */
export const ONE_USDC = 10n ** 18n;

/**
 * Format a native amount as USDC.
 *
 * The output keeps 6 decimal places. The ERC-20 interface of Arc shows the same 6.
 */
export function usdc(amount: bigint): string {
  const whole = amount / ONE_USDC;
  const micro = ((amount % ONE_USDC) / 10n ** 12n).toString().padStart(6, "0").replace(/0+$/, "");
  return micro.length > 0 ? `${whole}.${micro} USDC` : `${whole} USDC`;
}

export type { Address, Hex };
