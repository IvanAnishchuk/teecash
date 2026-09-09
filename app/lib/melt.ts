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
 * A melt cannot return every base unit. The deposit must be a multiple of the smallest
 * denomination, and the transaction costs gas. What is left after both is smaller than one
 * rung and it stays in the wallet.
 */

import { MIN_DENOM, pointCount } from "@teecash/lib-blind";
import type { useSignTransaction } from "@privy-io/react-auth";
import { encodeFunctionData } from "viem";
import type { Hex, TransactionSerialized } from "viem";
import { blindMintAbi } from "./abi";
import { CHAIN_ID, contract, publicClient } from "./chain";
import { blindWallets } from "./mint";
import { putDeposit, putDepositOnly, putNotes, toAmount } from "./notes";
import type { Note } from "./notes";
import { DUST, createNoteWallets, walletUiOptions } from "./privy";

// The type comes from Privy and not from a copy here, for the reason `lib/privy.ts` gives.
type SignTransaction = ReturnType<typeof useSignTransaction>["signTransaction"];

/** Round an amount down to the smallest denomination. A deposit must be a multiple of it. */
export function roundToRung(amount: bigint): bigint {
  return amount <= 0n ? 0n : (amount / MIN_DENOM) * MIN_DENOM;
}

/**
 * How much of `balance` a melt can deposit.
 *
 * The result is zero when the balance cannot cover one rung and the gas. `gas` is what the
 * deposit transaction costs.
 */
export function meltable(balance: bigint, gas: bigint): bigint {
  return roundToRung(balance - gas - DUST);
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
    if (guess < MIN_DENOM) return undefined;

    const points = pointCount(guess);
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

    await putDeposit(
      {
        id: depositId,
        userId,
        amount: toAmount(guess),
        block: "0",
        status: "pending",
        createdAt: Date.now(),
      },
      draft,
    );

    const nonce = await publicClient.getTransactionCount({ address: from });
    const { signature } = await signTransaction(
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
    const hash = await publicClient.sendRawTransaction({
      serializedTransaction: signature as TransactionSerialized,
    });

    await putDepositOnly({
      id: depositId,
      txHash: hash,
      userId,
      amount: toAmount(guess),
      block: "0",
      status: "pending",
      createdAt: Date.now(),
    });

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
