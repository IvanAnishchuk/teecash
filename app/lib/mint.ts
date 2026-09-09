/**
 * The mint flow.
 *
 * A deposit sends blinded points. The mint answers with an announcement. The client
 * unblinds each signature, checks it, and sends it to the relayer.
 *
 * This module repeats what `deposit`, `sync` and `relay` do in `cli/src/commands.ts`. The
 * cryptography is not repeated. `@teecash/lib-blind` is the one implementation of it.
 *
 * There is one difference from the command line client. The command line client holds the
 * mint keys in its state file and builds the public keys from them. A browser holds no
 * mint key. It reads `mintPubkeys` from the contract instead. The contract is the
 * authority on which key belongs to which denomination.
 */

import { LADDER, blind, fromHex, toHex, unblind, verify } from "@teecash/lib-blind";
import type { Domain } from "@teecash/lib-blind";
import type { Address, Hex } from "viem";
import { blindMintAbi } from "./abi";
import { CHAIN_ID, RELAYER_URL, contract, publicClient } from "./chain";
import type { Note } from "./notes";

/** The domain tag of this deployment. It covers the chain and the contract, not the amount. */
export function domain(): Domain {
  return { chainId: CHAIN_ID, contract: contract() };
}

/**
 * Read one public key for each denomination.
 *
 * The contract holds them, so a wrong key here becomes a failed check and never a bad
 * claim. This function caches the result for the life of the page. The keys never change,
 * because a new key needs a new deployment.
 */
let pubkeys: Map<string, Uint8Array> | undefined;

export async function mintPubkeys(): Promise<Map<string, Uint8Array>> {
  if (pubkeys) return pubkeys;
  const address = contract();
  const found = new Map<string, Uint8Array>();
  for (const denom of LADDER) {
    const key = await publicClient.readContract({
      address,
      abi: blindMintAbi,
      functionName: "mintPubkeys",
      args: [denom],
    });
    found.set(denom.toString(), fromHex(key));
  }
  pubkeys = found;
  return found;
}

/**
 * Blind one address for each wallet.
 *
 * The client blinds the address and nothing else. The denomination comes only from the key
 * that signs, so the client sends a cap and not a prediction.
 */
export function blindWallets(
  wallets: { address: Address; walletId: string }[],
  userId: string,
  depositId: string,
): Note[] {
  const d = domain();
  return wallets.map((wallet, pointIndex) => {
    const { blinded, r } = blind(wallet.address, d);
    return {
      address: wallet.address,
      userId,
      depositId,
      walletId: wallet.walletId,
      pointIndex,
      blinded: toHex(blinded) as Hex,
      r: toHex(r) as Hex,
      status: "awaiting-mint" as const,
    };
  });
}

export interface Announcement {
  pointIndexes: bigint[];
  denoms: bigint[];
  blindSigs: Hex[];
}

/**
 * Look for the announcement of one deposit.
 *
 * The search starts at the block of the deposit. Arc prunes history, so a search from
 * block zero fails. This function returns `undefined` until the mint answers.
 */
export async function findAnnouncement(
  depositId: string,
  fromBlock: bigint,
): Promise<Announcement | undefined> {
  const logs = await publicClient.getContractEvents({
    address: contract(),
    abi: blindMintAbi,
    eventName: "Announced",
    fromBlock,
    args: { id: BigInt(depositId) },
  });
  if (logs.length === 0) return undefined;
  return logs[0].args as unknown as Announcement;
}

/**
 * Unblind one announcement and check every signature.
 *
 * The mint chooses the split, so the client learns here which point carries which
 * denomination. The check uses the public key of the denomination that the event names.
 * The function drops a signature that fails the check.
 *
 * The function returns the notes it changed. It does not write them.
 */
export async function applyAnnouncement(
  notes: Note[],
  announcement: Announcement,
): Promise<{ ready: Note[]; failed: string[] }> {
  const keys = await mintPubkeys();
  const d = domain();
  const ready: Note[] = [];
  const failed: string[] = [];

  announcement.pointIndexes.forEach((pointIndex, i) => {
    const note = notes.find((n) => n.pointIndex === Number(pointIndex));
    if (!note) {
      failed.push(`the deposit holds no point ${pointIndex}`);
      return;
    }
    if (note.r === undefined) return; // The client already unblinded this note.

    const denom = announcement.denoms[i];
    const key = keys.get(denom.toString());
    if (!key) {
      failed.push(`there is no key for ${denom}`);
      return;
    }

    const sig = unblind(fromHex(announcement.blindSigs[i]), fromHex(note.r));
    if (!verify(key, note.address, sig, d)) {
      failed.push(`the signature for ${note.address} does not verify`);
      return;
    }

    const { r: _r, ...rest } = note;
    ready.push({ ...rest, denom: denom.toString(), sig: toHex(sig) as Hex, status: "ready" });
  });

  return { ready, failed };
}

/**
 * Send one claim to the relayer.
 *
 * The relayer is the third party that breaks the link between the deposit and the note. A
 * note wallet holds no money before its claim confirms, so it cannot pay its own gas. The
 * claim must also not come from the depositor.
 *
 * The caller sends the notes one at a time. The relayer must never see the notes of one
 * deposit as a group, because that group is the link that blinding removes.
 *
 * The relayer finds the denomination itself, so the body carries only the wallet and the
 * signature.
 */
export interface RelayResult {
  txHash: Hex;
  gasUsed: number;
  /** The rung the relayer found. It must equal the denomination the announcement named. */
  denom: string;
}

export async function relayClaim(note: Note): Promise<RelayResult> {
  if (note.sig === undefined) throw new Error(`relay: the note ${note.address} has no signature`);

  const response = await fetch(`${RELAYER_URL}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: note.address, sig: note.sig }),
  });
  const body = (await response.json()) as Partial<RelayResult> & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `relay: the relayer answered ${response.status}`);
  }
  if (!body.txHash) throw new Error("relay: the relayer returned no transaction hash");

  // The relayer finds the rung by trial. The announcement already named one. A difference
  // means the two disagree about this note.
  if (note.denom !== undefined && body.denom !== note.denom) {
    throw new Error(`relay: the relayer claimed ${body.denom} and the mint announced ${note.denom}`);
  }
  return { txHash: body.txHash, gasUsed: body.gasUsed ?? 0, denom: body.denom ?? "" };
}
