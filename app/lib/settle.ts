/**
 * The settler.
 *
 * A deposit needs several steps after the transaction lands. The client reads the receipt,
 * it waits for the announcement, it unblinds each signature, and it sends each claim to the
 * relayer. Every one of those steps needs this browser, because the blinding factors live
 * here and nowhere else.
 *
 * None of them needs the user. A claim goes to the relayer and the relayer pays the gas, so
 * no wallet signs and no screen has to ask anything. The work therefore runs here, on a
 * timer, for every deposit that is not finished. A user who opens the application settles
 * whatever is waiting, and a user who opens one screen and not another settles the same set.
 *
 * The screens read the records that this file writes. They show progress and they do not
 * drive it.
 */

import type { Hex } from "viem";
import { blindMintAbi } from "./abi";
import { contract, publicClient } from "./chain";
import { AlreadyClaimed, applyAnnouncement, findAnnouncement, relayClaim } from "./mint";
import { claimed, notesOfDeposit, putDepositOnly, putNotes } from "./notes";
import type { Deposit, Note } from "./notes";

/** Report whether a note needs nothing more. */
export function settled(note: Note): boolean {
  return note.status === "claimed" || note.status === "unused" || note.status === "spent";
}

/** Report whether a deposit needs nothing more. */
export function finished(deposit: Deposit): boolean {
  return deposit.status === "claimed" || deposit.status === "refunded";
}

/**
 * Claim every note that holds a signature.
 *
 * The notes go one at a time. The relayer must never see the notes of one deposit as a
 * group, because that group is the link that blinding removes.
 *
 * A failed claim does not stop the others. A note that keeps its signature is claimed on a
 * later pass.
 */
async function claimAll(ready: Note[]): Promise<void> {
  for (const note of ready) {
    if (note.sig === undefined) continue;
    try {
      await relayClaim(note);
    } catch (err) {
      // The wallet holds its money already. Without this the note stays ready for ever,
      // and every pass asks the relayer again for a claim that the contract refuses.
      if (!(err instanceof AlreadyClaimed)) throw err;
    }
    await putNotes([claimed(note)]);
  }
}

/**
 * Move one deposit forward by as much as it can go.
 *
 * The function does one step for each call and it is safe to call again. A step that fails
 * throws, and the caller tries the same deposit on the next pass.
 */
export async function settleDeposit(deposit: Deposit): Promise<void> {
  // A deposit without a hash never reached a wallet, so it has no receipt to read.
  if (deposit.txHash === undefined) return;

  if (deposit.onChainId === undefined) {
    const receipt = await publicClient.getTransactionReceipt({ hash: deposit.txHash as Hex });
    if (receipt.status !== "success") return;

    // The contract numbers the deposit. Every later log search uses that number, and the
    // search starts at this block because Arc prunes history.
    const logs = await publicClient.getContractEvents({
      address: contract(),
      abi: blindMintAbi,
      eventName: "Deposited",
      blockHash: receipt.blockHash,
    });
    const found = (logs[0]?.args as { id?: bigint } | undefined)?.id;
    if (found === undefined) return;
    await putDepositOnly({
      ...deposit,
      onChainId: found.toString(),
      block: receipt.blockNumber.toString(),
    });
    return;
  }

  const stored = await notesOfDeposit(deposit.id);

  // Notes that already hold a signature are claimed first. A reload in the middle of a
  // claim run leaves them, and they must not wait for another announcement.
  const ready = stored.filter((n) => n.status === "ready" && n.sig !== undefined);
  if (ready.length > 0) {
    await claimAll(ready);
  } else if (stored.some((n) => n.status === "awaiting-mint")) {
    const announcement = await findAnnouncement(deposit.onChainId, BigInt(deposit.block));
    if (!announcement) return;

    const applied = await applyAnnouncement(stored, announcement);
    // The unused points go to the disk with the signed ones. Without that step the deposit
    // waits for a signature that the mint already decided not to make.
    if (applied.ready.length > 0 || applied.unused.length > 0) {
      await putNotes([...applied.ready, ...applied.unused]);
      await putDepositOnly({ ...deposit, status: "announced" });
      await claimAll(applied.ready);
    }
  }

  const after = await notesOfDeposit(deposit.id);
  if (after.length > 0 && after.every(settled)) {
    await putDepositOnly({ ...deposit, status: "claimed" });
  }
}
