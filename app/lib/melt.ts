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
 *
 * A melt that mints nothing carries no point, so it costs no wallet. `pointCount` answers
 * zero for it and the contract accepts a deposit of no points. That melt is a gift of dust
 * to the treasury, and it is the cheapest way to empty a wallet that holds a value on no
 * rung.
 */

import { MIN_DENOM, mintable, pointCount } from "@teecash/lib-blind";
import type { useSignTransaction } from "@privy-io/react-auth";
import { encodeFunctionData } from "viem";
import type { Hex, TransactionSerialized } from "viem";
import { blindMintAbi } from "./abi";
import { CHAIN_ID, contract, publicClient } from "./chain";
import { blindWallets } from "./mint";
import { discardDeposit, putDeposit, putDepositOnly, putNotes, putSpare, toAmount } from "./notes";
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
 * The gas that a deposit of `points` points uses.
 *
 * The figures come from Arc. A deposit of four points measured 102,247 and a deposit of
 * seven measured 122,949, so each point costs about 7,000 and the rest is the base. The
 * numbers here round both up, because this is a reserve and not a price.
 *
 * `estimateContractGas` gives the real figure. This function only has to keep the first
 * guess of the amount close enough for that estimate to agree.
 */
export function depositGas(points: number): bigint {
  return 90_000n + 15_000n * BigInt(points);
}

/**
 * The gas limit that a deposit declares.
 *
 * The limit carries a quarter more than the estimate. A deposit that costs more than the
 * estimate then still completes.
 *
 * A node holds the funds of the declared limit and not the funds of the estimate. Every
 * reserve must therefore pad the same way. An earlier melt reserved the estimate and
 * declared the limit, and the node refused every melt for the difference.
 */
export function gasLimitFor(gas: bigint): bigint {
  return gas + gas / 4n;
}

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
    // Reserve the gas of the deposit that this melt sends, and not the gas of the largest
    // deposit. The point count sets that gas, and a wallet of dust sends a deposit of no
    // points. A flat reserve for many points is larger than the dust itself, and the melt
    // then gives up before it asks the chain anything.
    //
    // The count comes from the whole balance, which is at or above the amount that this
    // pass sends. The reserve is therefore never short. `estimateContractGas` below reads
    // the real figure, and the pass after this one lowers the amount when it disagrees.
    const reserve = fees.maxFeePerGas * gasLimitFor(depositGas(pointCount(balance - DUST)));
    const guess = meltable(balance, reserve) - BigInt(pass) * MIN_DENOM;
    if (guess <= 0n) return undefined;

    const points = pointCount(guess);
    // The record holds what the deposit mints. The tax leaves the contract when the mint
    // announces. Every balance on the screens reads this field.
    const minted = toAmount(mintable(guess));
    const wallets = await createNoteWallets(createWallet, existingEmbedded + pass, points, userId);
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
    const limit = gasLimitFor(gas);
    const cost = limit * fees.maxFeePerGas;
    // The next pass asks for a lower amount and takes its own wallets. These carried no
    // point to the chain, so they go back to the pool instead of ending here.
    if (balance < guess + cost + DUST) {
      await putSpare(wallets.map((w) => ({ ...w, userId })));
      continue;
    }

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
          gasLimit: limit,
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
