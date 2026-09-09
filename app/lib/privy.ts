/**
 * Wallet creation and note spending.
 *
 * Privy holds every note key. The browser never holds one. A React hook can only run
 * inside a component, so each function here takes the hook result as an argument.
 *
 * A note wallet signs only when the holder spends it. Nothing signs during the mint or the
 * claim.
 */

import type { useCreateWallet, useSignTransaction } from "@privy-io/react-auth";
import type { Address, Hex, TransactionSerialized } from "viem";
import { CHAIN_ID, publicClient } from "./chain";
import type { Note } from "./notes";

// These come from Privy and not from a copy here. A copy would go out of date without a
// build error, and the first sign of that would be a failed transaction.
type CreateWallet = ReturnType<typeof useCreateWallet>["createWallet"];
type SignTransaction = ReturnType<typeof useSignTransaction>["signTransaction"];

export interface NewWallet {
  address: Address;
  /**
   * How this code names the wallet.
   *
   * The server API of Privy addresses a wallet by an identifier, and `cli/src/wallets.ts`
   * uses it. The client SDK addresses a wallet by its address instead. `Wallet.id` is null
   * for an embedded wallet that is not delegated, so the address is the name that always
   * works in a browser.
   */
  walletId: string;
}

/**
 * Make `count` embedded wallets for the signed in user.
 *
 * `createAdditional` decides whether Privy makes a new wallet or returns the one that
 * exists. There is a rule on the first wallet of a user. Privy throws when the flag is
 * true and the user holds no Ethereum embedded wallet. The flag is therefore false for
 * that first wallet only.
 *
 * `existing` is how many embedded wallets the user already holds.
 */
export async function createNoteWallets(
  createWallet: CreateWallet,
  existing: number,
  count: number,
): Promise<NewWallet[]> {
  const made: NewWallet[] = [];
  for (let i = 0; i < count; i++) {
    const first = existing === 0 && i === 0;
    const wallet = await createWallet(first ? {} : { createAdditional: true });
    made.push({ address: wallet.address as Address, walletId: wallet.id ?? wallet.address });
  }
  return made;
}

/**
 * A transfer that empties a fresh account reverts on Arc. Every send leaves this much
 * behind.
 */
export const DUST = 1n;

/** The gas a plain value transfer uses. */
const TRANSFER_GAS = 21000n;

/**
 * The margin on the fee estimate.
 *
 * The client plans a send before it signs. The gas price can increase between the two
 * steps, and a plan that reserves the exact fee then fails. The margin adds one half to the
 * estimate. The note keeps the part of the margin that the transaction does not use.
 */
const MARGIN_NUMERATOR = 3n;
const MARGIN_DENOMINATOR = 2n;

/**
 * What one transaction costs the wallet that sends it.
 *
 * This is the gas fee plus the base unit that Arc keeps. `planSweep` needs it, because a
 * send makes one transaction for each note and one more for the payment.
 */
export async function legCost(): Promise<bigint> {
  const fees = await publicClient.estimateFeesPerGas();
  const fee = (TRANSFER_GAS * fees.maxFeePerGas * MARGIN_NUMERATOR) / MARGIN_DENOMINATOR;
  return fee + DUST;
}

export interface Transfer {
  /** What the recipient receives. It equals `wanted`. */
  sent: bigint;
  /** What the note pays the chain. */
  fee: bigint;
  hash: Hex;
}

/**
 * Move money out of one wallet.
 *
 * The wallet pays its own fee, because the wallet is the only account that holds its money.
 * The recipient receives `wanted` and not less.
 *
 * `confirm` decides whether Privy asks the user. A sweep into the new wallet moves money
 * that stays with the user, so it passes false and Privy signs it without a prompt. The
 * payment out passes true, because that is the step the user must approve.
 *
 * The function sends nothing when the wallet cannot cover `wanted`, the fee and the base
 * unit that Arc keeps. It throws instead.
 */
export async function sendFromWallet(
  signTransaction: SignTransaction,
  from: Address,
  to: Address,
  wanted: bigint,
  confirm: boolean,
): Promise<Transfer> {
  const balance = await publicClient.getBalance({ address: from });
  const fees = await publicClient.estimateFeesPerGas();
  const gas = TRANSFER_GAS;
  const fee = gas * fees.maxFeePerGas;

  const needed = wanted + fee + DUST;
  if (balance < needed) {
    throw new Error(
      `spend: the wallet ${from} holds ${balance} and this step needs ${needed}. ` +
        "The gas price increased after the plan. Try the send again.",
    );
  }
  const sent = wanted;

  const nonce = await publicClient.getTransactionCount({ address: from });
  const { signature } = await signTransaction(
    {
      to,
      value: sent,
      nonce,
      gasLimit: gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chainId: CHAIN_ID,
    },
    { address: from, uiOptions: { showWalletUIs: confirm } },
  );

  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: signature as TransactionSerialized,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { sent, fee, hash };
}
