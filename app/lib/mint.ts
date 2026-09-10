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
import { ANNOUNCE_WINDOW, CHAIN_ID, RELAYER_URL, contract, publicClient } from "./chain";
import type { Note } from "./notes";

/**
 * The domain tag of one deployment. It covers the chain and the contract, not the amount.
 *
 * The address is a parameter, because a record can name a deployment that this build no
 * longer names. The tag of that record must stay the tag of its own deployment. Every
 * signature it holds fails to verify otherwise.
 */
export function domain(address: Address = contract()): Domain {
  return { chainId: CHAIN_ID, contract: address };
}

/**
 * Read one public key for each denomination of one deployment.
 *
 * The contract holds them, so a wrong key here becomes a failed check and never a bad
 * claim. This function caches the result for the life of the page. The keys never change,
 * because a new key needs a new deployment.
 *
 * The cache holds one map for each address. A single map would answer for the wrong
 * deployment after the first read.
 */
const pubkeys = new Map<string, Map<string, Uint8Array>>();

export async function mintPubkeys(address: Address = contract()): Promise<Map<string, Uint8Array>> {
  const cached = pubkeys.get(address.toLowerCase());
  if (cached) return cached;
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
  pubkeys.set(address.toLowerCase(), found);
  return found;
}

/** The on-chain state of one deposit. The order matches the `Status` enum of the contract. */
export const ON_CHAIN_STATUS = ["none", "pending", "announced", "refunded"] as const;
export type OnChainStatus = (typeof ON_CHAIN_STATUS)[number];

/**
 * Read the state of one deposit from its own deployment.
 *
 * This is one view call. It answers what a log search cannot. `none` means that the
 * deployment does not hold this number at all. `refunded` means that the money is already
 * back with the depositor.
 *
 * The settler asks this before it searches for an announcement. A search costs far more
 * than a view call. Most passes need no search.
 */
export async function onChainDeposit(
  depositId: string,
  address: Address = contract(),
): Promise<{ status: OnChainStatus; amount: bigint; deadline: bigint; depositor: Address }> {
  const [depositor, amount, , deadline, status] = await publicClient.readContract({
    address,
    abi: blindMintAbi,
    functionName: "deposits",
    args: [BigInt(depositId)],
  });
  return {
    status: ON_CHAIN_STATUS[Number(status)] ?? "none",
    amount,
    deadline,
    depositor,
  };
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
  address: Address = contract(),
): Note[] {
  const d = domain(address);
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
 *
 * The search also stops at `ANNOUNCE_WINDOW` blocks after the deposit. An open upper bound
 * grows with the head. The settler repeats this call every few seconds. The mint answers
 * in about a minute, so an announcement outside this window does not exist.
 *
 * The head bounds that end as well. Arc refuses a range that reaches past the head, and it
 * answers "requested data not available". A deposit of this minute is thousands of blocks
 * below `fromBlock + ANNOUNCE_WINDOW`. The node caches the head, so this call is cheap.
 */
export async function findAnnouncement(
  depositId: string,
  fromBlock: bigint,
  address: Address = contract(),
): Promise<Announcement | undefined> {
  const head = await publicClient.getBlockNumber();
  const last = fromBlock + ANNOUNCE_WINDOW;
  const logs = await publicClient.getContractEvents({
    address,
    abi: blindMintAbi,
    eventName: "Announced",
    fromBlock,
    toBlock: last < head ? last : head,
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
 *
 * `foreign` says that the announcement belongs to another deposit. It is true when this
 * deposit held a signature to check and not one of them verified. The caller must then
 * write nothing.
 *
 * That case must never mark a point unused. A note loses its blinding factor at that
 * moment. The blinding factor exists in this browser and nowhere else. A note without it
 * can never be unblinded, so a wrong announcement would take the money of every point that
 * the stranger did not sign.
 *
 * An announcement of no points is not foreign. The contract accepts an empty announcement,
 * and only for a deposit that mints nothing. Every point of such a deposit is unused, which
 * is what the mint decided. There is no signature to check, so there is nothing to fail.
 */
export async function applyAnnouncement(
  notes: Note[],
  announcement: Announcement,
  address: Address = contract(),
): Promise<{ ready: Note[]; unused: Note[]; failed: string[]; foreign: boolean }> {
  const keys = await mintPubkeys(address);
  const d = domain(address);
  const ready: Note[] = [];
  const failed: string[] = [];
  // `checked` counts the points that this pass could test. A point is testable when this
  // deposit holds it and the note still carries its blinding factor. `verified` counts the
  // points that passed.
  //
  // A note whose blinding factor is already gone counts as neither. Its absence says that
  // some earlier pass unblinded it. It does not say which deployment signed it, so it is no
  // evidence that this announcement belongs here.
  let checked = 0;
  let verified = 0;

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

    checked++;
    const sig = unblind(fromHex(announcement.blindSigs[i]), fromHex(note.r));
    if (!verify(key, note.address, sig, d)) {
      failed.push(`the signature for ${note.address} does not verify`);
      return;
    }

    verified++;
    const { r: _r, ...rest } = note;
    ready.push({ ...rest, denom: denom.toString(), sig: toHex(sig) as Hex, status: "ready" });
  });

  // This deposit held signatures to check and not one of them verified. The announcement
  // belongs to another deposit. Return before the unused set is built, because that set
  // removes a blinding factor that nothing can rebuild.
  if (checked > 0 && verified === 0) {
    return { ready: [], unused: [], failed, foreign: true };
  }

  // Every deposit carries more points than the split needs, and the mint signs only the
  // points it uses. A point that the announcement leaves out therefore holds no value and
  // it never will. The announcement happens one time for one deposit.
  const signed = new Set(announcement.pointIndexes.map((index) => Number(index)));
  const unused = notes
    .filter((note) => !signed.has(note.pointIndex) && note.status === "awaiting-mint")
    .map((note) => {
      const { r: _r, ...rest } = note;
      return { ...rest, status: "unused" as const };
    });

  return { ready, unused, failed, foreign: false };
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

/**
 * The contract already paid this wallet.
 *
 * The note holds its money, so the caller marks the note claimed and continues. A claim
 * that lands after the relayer stops waiting gives this answer on the next try.
 */
export class AlreadyClaimed extends Error {
  constructor(readonly wallet: string) {
    super(`relay: the wallet ${wallet} already claimed`);
  }
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
    // The contract keeps a claimed set and it refuses a second claim on one wallet. That
    // answer is not a failure. It says the note holds its money already, which happens when
    // an earlier claim landed on the chain after the relayer stopped waiting for it.
    if (response.status === 409) throw new AlreadyClaimed(note.address);
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
