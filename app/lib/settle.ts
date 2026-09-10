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

import type { Address, Hex } from "viem";
import { blindMintAbi } from "./abi";
import { contract, publicClient } from "./chain";
import {
  AlreadyClaimed,
  applyAnnouncement,
  findAnnouncement,
  onChainDeposit,
  relayClaim,
} from "./mint";
import { claimed, discardDeposit, notesOfDeposit, putDepositOnly, putNotes } from "./notes";
import type { Deposit, Note } from "./notes";

/** Report whether a note needs nothing more. */
export function settled(note: Note): boolean {
  return (
    note.status === "claimed" ||
    note.status === "unused" ||
    note.status === "spent" ||
    note.status === "dust"
  );
}

/**
 * Report whether a deposit needs nothing more.
 *
 * `stranded` counts as finished. The settler would otherwise ask the chain about the same
 * dead deposit every few seconds, for as long as the application stays open.
 */
export function finished(deposit: Deposit): boolean {
  return (
    deposit.status === "claimed" || deposit.status === "refunded" || deposit.status === "stranded"
  );
}

/**
 * The deployment that holds one deposit, or undefined for a record that names none.
 *
 * A deposit number counts from one inside one deployment. A guess is therefore never safe:
 * the current deployment holds a different deposit under the same number, and every step
 * that follows would read that stranger. `settleDeposit` strands such a record and touches
 * none of its notes.
 */
export function deploymentOf(deposit: Deposit): Address | undefined {
  return deposit.contract as Address | undefined;
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
  //
  // A melt writes its record before it sends, and the send can still fail. A melt that
  // carries no point leaves such a record behind, and nothing can ever move it. The balance
  // screen counts it as money on the way, so a queue of them reads as a wallet full of
  // pending deposits of nothing. It holds no note and no blinding factor, so it goes.
  //
  // A record that carries points stays. A send whose answer was lost can still mine, and
  // the blinding factors of those notes exist in this browser and nowhere else.
  if (deposit.txHash === undefined) {
    if ((await notesOfDeposit(deposit.id)).length === 0) await discardDeposit(deposit);
    return;
  }

  // A record from a build before the `contract` field cannot say which deployment numbers
  // it. Reading any other deployment under that number reads a stranger, so this stops
  // before the first read. Every note keeps its blinding factor.
  const address = deploymentOf(deposit) ?? contract();
  if (deposit.contract === undefined && deposit.onChainId !== undefined) {
    await putDepositOnly({ ...deposit, status: "stranded" });
    return;
  }

  if (deposit.onChainId === undefined) {
    const receipt = await publicClient.getTransactionReceipt({ hash: deposit.txHash as Hex });
    if (receipt.status !== "success") return;

    // The contract numbers the deposit. Every later log search uses that number, and the
    // search starts at this block because Arc prunes history.
    const logs = await publicClient.getContractEvents({
      address,
      abi: blindMintAbi,
      eventName: "Deposited",
      blockHash: receipt.blockHash,
    });
    // One block holds the deposits of every user, so the search must name the transaction
    // of this deposit. `logs[0]` would take the number of whoever shares the block, and
    // every later step would then read a stranger.
    const mine = logs.find((log) => log.transactionHash === deposit.txHash);
    const found = (mine?.args as { id?: bigint } | undefined)?.id;
    if (found === undefined) return;
    await putDepositOnly({
      ...deposit,
      onChainId: found.toString(),
      block: receipt.blockNumber.toString(),
      contract: address,
    });
    return;
  }

  // Ask the deployment before searching its logs.
  //
  // One view call answers what a log search cannot. `none` says that this deployment never
  // held this number. A record from another deployment gives that answer. `refunded` says
  // that the money is already back with the depositor. Both answers end the work. A deposit
  // that never ends is a deposit that this settler asks about every few seconds, for as
  // long as the application stays open.
  const chain = await onChainDeposit(deposit.onChainId, address);
  if (chain.status === "refunded") {
    await putDepositOnly({ ...deposit, status: "refunded" });
    return;
  }
  if (chain.status === "none") {
    // The deployment that this record names does not hold this number. The record is wrong
    // and no later pass makes it right. The notes stay on the disk with their blinding
    // factors, and the money stays where it is.
    await putDepositOnly({ ...deposit, status: "stranded" });
    return;
  }

  const stored = await notesOfDeposit(deposit.id);

  // A melt of a wallet below two rungs mints nothing, so it carries no point and this
  // record holds no note. The whole deposit becomes mint tax.
  //
  // The test at the end of this function needs a note, so it can never finish such a
  // deposit. Without this branch the record stays `pending` for ever and the balance screen
  // counts a gift to the treasury as money on the way. The chain has to say `announced`
  // first, because until then the mint may still answer.
  if (stored.length === 0) {
    if (chain.status === "announced") {
      await putDepositOnly({ ...deposit, status: "claimed" });
    }
    return;
  }

  // Notes that already hold a signature are claimed first. A reload in the middle of a
  // claim run leaves them, and they must not wait for another announcement.
  const ready = stored.filter((n) => n.status === "ready" && n.sig !== undefined);
  if (ready.length > 0) {
    await claimAll(ready);
  } else if (stored.some((n) => n.status === "awaiting-mint")) {
    // The contract says pending, so the mint has not answered. A search would find nothing.
    if (chain.status === "pending") return;

    const announcement = await findAnnouncement(deposit.onChainId, BigInt(deposit.block), address);
    // The contract says announced and this window holds no such event. Try again on the
    // next pass. A terminal status here would be wrong twice: a mint that answers late
    // announces outside the window, and a node that serves the view call and the log search
    // from different heights answers this way for one pass. Both recover by themselves.
    if (!announcement) return;

    const applied = await applyAnnouncement(stored, announcement, address);
    if (applied.foreign) {
      // The announcement carries this number and it belongs to another deposit. The record
      // names no deployment, so this client cannot say which one holds it. Stop here. Every
      // note keeps its blinding factor. A later build that knows the deployment can
      // therefore still unblind and claim.
      await putDepositOnly({ ...deposit, status: "stranded" });
      return;
    }
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
