/**
 * Where the note wallets come from.
 *
 * The protocol treats a wallet as a passive recipient. Nothing signs during the mint or
 * the claim. A wallet signs only when the holder spends it. The provider therefore has
 * to do two things: make an address, and sign one transaction later.
 *
 * `local` keeps the private key in the state file. `privy` asks Privy for a wallet and
 * lets Privy hold the key.
 *
 * Privy does not need to support the chain. `signTransaction` carries a plain `chainId`
 * and no CAIP-2 network, so Privy signs and this CLI broadcasts over its own RPC. Gas
 * sponsorship is the one feature that would need Privy to know the chain.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import type { LocalAccount } from "viem/accounts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export type ProviderName = "local" | "privy";

export interface WalletRef {
  address: Address;
  /** The private key for `local`. The wallet identifier for `privy`. */
  ref: string;
  provider: ProviderName;
}

export interface WalletProvider {
  name: ProviderName;
  /** Make `count` fresh wallets. */
  create(count: number): Promise<WalletRef[]>;
  /** Return a viem account that signs for this wallet. */
  account(wallet: WalletRef): Promise<LocalAccount>;
}

const local: WalletProvider = {
  name: "local",
  async create(count) {
    const out: WalletRef[] = [];
    for (let i = 0; i < count; i++) {
      const key = generatePrivateKey();
      out.push({ address: privateKeyToAccount(key).address, ref: key, provider: "local" });
    }
    return out;
  },
  async account(wallet) {
    return privateKeyToAccount(wallet.ref as Hex);
  },
};

/**
 * Read the Privy credentials.
 *
 * The values come from the environment. `cli/.env` fills in anything the environment
 * does not set. That file is outside git, so the app secret stays local. Copy
 * `cli/example.env` to start it.
 */
function privyCredentials() {
  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId) throw new Error(`privy: set PRIVY_APP_ID, or put it in ${envFile}`);
  if (!appSecret) throw new Error(`privy: set PRIVY_APP_SECRET, or put it in ${envFile}`);
  return { appId, appSecret };
}

async function makeClient() {
  const { appId, appSecret } = privyCredentials();
  const { PrivyClient } = await import("@privy-io/server-auth");
  return new PrivyClient(appId, appSecret);
}

// One dynamic import gives one type. A second import path would give a second type with
// the same name, and the two would not match.
let privyClient: Awaited<ReturnType<typeof makeClient>> | undefined;

async function privyOf() {
  privyClient ??= await makeClient();
  return privyClient;
}

const privy: WalletProvider = {
  name: "privy",
  async create(count) {
    const client = await privyOf();
    const out: WalletRef[] = [];
    for (let i = 0; i < count; i++) {
      const wallet = await client.walletApi.createWallet({ chainType: "ethereum" });
      out.push({ address: wallet.address as Address, ref: wallet.id, provider: "privy" });
    }
    return out;
  },
  async account(wallet) {
    const client = await privyOf();
    const { createViemAccount } = await import("@privy-io/server-auth/viem");
    // The package ships two declarations of PrivyClient, one for ESM and one for CJS.
    // The viem entry point refers to the CJS one. Both name the same runtime class, so
    // the cast crosses a packaging seam and not a real type difference.
    return createViemAccount({
      walletId: wallet.ref,
      address: wallet.address,
      privy: client as unknown as Parameters<typeof createViemAccount>[0]["privy"],
    });
  },
};

const providers: Record<ProviderName, WalletProvider> = { local, privy };

/** Pick the provider. TEECASH_WALLETS chooses it and `local` is the default. */
export function walletProvider(): WalletProvider {
  const name = (process.env.TEECASH_WALLETS ?? "local") as ProviderName;
  const provider = providers[name];
  if (!provider) throw new Error(`wallets: there is no provider ${name}`);
  return provider;
}

/** Return the provider that made one wallet. A state file can hold both kinds. */
export function providerOf(wallet: WalletRef): WalletProvider {
  const provider = providers[wallet.provider];
  if (!provider) throw new Error(`wallets: there is no provider ${wallet.provider}`);
  return provider;
}
