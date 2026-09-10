/**
 * The melt.
 *
 * A send empties whole notes into one new wallet and pays the recipient from it. The wallet
 * keeps the change, and that change is not a ladder value. A wallet that holds a value off
 * the ladder matches no other wallet in the system, so that value is a mark on the money.
 *
 * A melt removes the mark. It deposits the change into the contract again, and the mint
 * answers with notes on the ladder. The change wallet then holds nothing.
 *
 * The change wallet pays its own melt. It signs the deposit itself, and Privy does not
 * prompt, because the money stays with the user for the whole step.
 *
 * A melt deposits everything that it can. The contract accepts any amount. It keeps one
 * rung and the remainder below the rung as the mint tax. It mints the rest. A change
 * wallet that holds less than two rungs still empties, and all of it becomes tax. Only
 * the gas and one base unit of dust remain.
 */

import { MIN_DENOM, mintable, pointCount } from "@teecash/lib-blind";
import type { useSignTransaction } from "@privy-io/react-auth";
import { encodeFunctionData } from "viem";
import type { Hex, TransactionSerialized } from "viem";
import { blindMintAbi } from "./abi";
import { CHAIN_ID, contract, publicClient } from "./chain";
import { blindWallets } from "./mint";
import { discardDeposit, putDeposit, putDepositOnly, putNotes, toAmount } from "./notes";
import type { Note } from "./notes";
import { DUST, createNoteWallets, walletUiOptions } from "./privy";

// The type comes from Privy and not from a copy here, for the reason `lib/privy.ts` gives.
type SignTransaction = ReturnType<typeof useSignTransaction>["signTransaction"];

/**
 * How much of `balance` a melt can deposit.
 *
 * The whole balance goes, less the gas and the dust. No rounding happens here. The
 * contract takes any amount. A remainder below one rung is therefore no longer a reason
 * to keep money in the wallet. That remainder becomes mint tax.
 *
 * The result is zero when the gas and the dust take everything. `gas` is what the deposit
 * transaction costs.
 */
export function meltable(balance: bigint, gas: bigint): bigint {
  const rest = balance - gas - DUST;
  return rest > 0n ? rest : 0n;
}

/**
 * How many times the melt lowers the amount before it stops.
 *
 * The gas of a deposit depends on the point count, and the point count depends on the
 * amount. A lower amount can therefore need less gas. Each pass lowers the amount by one
 * rung and asks the node again.
 */
const PASSES = 8;

/**
 * Deposit the change of one wallet back into the contract.
 *
 * The function returns the local name of the new deposit. It returns undefined when the
 * wallet holds too little to melt, which is the normal end of a small change wallet.
 *
 * The records reach the disk before the transaction reaches the chain. `app/deposit` says
 * why: the blinding factor of a note exists only in this browser, and a deposit that
 * confirms without a record is money that no claim can reach.
 */
export async function meltWallet(
  createWallet: Parameters<typeof createNoteWallets>[0],
  signTransaction: SignTransaction,
  userId: string,
  existingEmbedded: number,
  change: Note,
): Promise<string | undefined> {
  const from = change.address;
  const balance = await publicClient.getBalance({ address: from });
  const fees = await publicClient.estimateFeesPerGas();

  for (let pass = 0; pass < PASSES; pass++) {
    // Start from a generous reserve and lower the amount when the estimate disagrees.
    const guess = meltable(balance, fees.maxFeePerGas * 400000n) - BigInt(pass) * MIN_DENOM;
    // The melt stops when the deposit would mint nothing.
    //
    // The contract accepts such a deposit and the treasury takes all of it, so the chain is
    // not the reason to stop. The wallets are. Every deposit carries `SLACK` points, and a
    // point is one embedded wallet from a provider that counts at most 150 for one user and
    // gives none of them back. Four wallets to hand a fraction of a cent to the treasury is
    // a bad trade, and the settler would repeat it on every pass.
    //
    // The dust therefore stays in the change wallet. It is below one cent and it marks
    // nothing that a cent would not mark.
    if (guess <= 0n || mintable(guess) === 0n) return undefined;

    const points = pointCount(guess);
    // The record holds what the deposit mints. The tax leaves the contract when the mint
    // announces. Every balance on the screens reads this field.
    const minted = toAmount(mintable(guess));
    const wallets = await createNoteWallets(createWallet, existingEmbedded + pass, points);
    const depositId = crypto.randomUUID();
    const draft = blindWallets(wallets, userId, depositId);
    const blinded = draft.map((note) => note.blinded);

    const gas = await publicClient.estimateContractGas({
      account: from,
      address: contract(),
      abi: blindMintAbi,
      functionName: "deposit",
      args: [blinded],
      value: guess,
    });
    const cost = gas * fees.maxFeePerGas;
    if (balance < guess + cost + DUST) continue;

    const record = {
      id: depositId,
      userId,
      amount: minted,
      block: "0",
      status: "pending" as const,
      createdAt: Date.now(),
      contract: contract(),
    };
    await putDeposit(record, draft);

    // Only the signature step may discard the record.
    //
    // A wallet that refuses to sign builds no transaction, so the record names money that
    // never moved. `settleDeposit` stops at a record with no hash, and that record then sits
    // on the balance screen for ever as a deposit that cannot continue. A melt asks for
    // nothing, so the user never learns why it is there. Discarding it is right.
    //
    // The send step is not the same. `sendRawTransaction` can reach the node, and the node
    // can accept the transaction, and the answer can still be lost. Discarding the record
    // there would delete the blinding factors of a deposit that then mines. Those factors
    // exist in this browser and nowhere else, so no claim could ever be made, and
    // `refundByDepositor` refuses a deposit that the mint already announced. The record
    // therefore stays, and the settler finds the deposit from its own transaction.
    let signature: Hex;
    try {
      const nonce = await publicClient.getTransactionCount({ address: from });
      const signed = await signTransaction(
        {
          to: contract(),
          value: guess,
          data: encodeDeposit(blinded),
          nonce,
          gasLimit: gas + gas / 4n,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          chainId: CHAIN_ID,
        },
        // A melt moves money that stays with the user, so Privy does not ask.
        walletUiOptions(from, false),
      );
      signature = signed.signature as Hex;
    } catch (err) {
      // No transaction exists, so the record and its notes name nothing. The change stays
      // in the wallet and a later pass melts it again.
      await discardDeposit(record);
      throw err;
    }

    const hash = await publicClient.sendRawTransaction({
      serializedTransaction: signature as TransactionSerialized,
    });

    await putDepositOnly({ ...record, txHash: hash });

    // The change wallet gave what it could. Whatever stays is below one rung.
    await putNotes([{ ...change, denom: "0", status: "spent" as const }]);
    return depositId;
  }
  return undefined;
}

/** Build the calldata of `deposit`. */
function encodeDeposit(blinded: Hex[]): Hex {
  return encodeFunctionData({ abi: blindMintAbi, functionName: "deposit", args: [blinded] });
}
