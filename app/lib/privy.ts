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

export interface Transfer {
  /** What the recipient receives. */
  sent: bigint;
  /** What the note pays the chain. */
  fee: bigint;
  hash: Hex;
}

/**
 * Move money from one note.
 *
 * The note pays its own fee, because the note is the only account that holds its money.
 * The fee therefore reduces `wanted`. A caller that needs an exact amount at the recipient
 * must add the fee to `wanted` itself.
 *
 * The function sends less than `wanted` when the note cannot cover both `wanted` and the
 * fee. It never sends the whole balance, because Arc reverts a transfer that empties a
 * fresh account.
 */
export async function sendFromNote(
  signTransaction: SignTransaction,
  note: Note,
  to: Address,
  wanted: bigint,
): Promise<Transfer> {
  const from = note.address;
  const balance = await publicClient.getBalance({ address: from });
  const fees = await publicClient.estimateFeesPerGas();
  const gas = 21000n;
  const fee = gas * fees.maxFeePerGas;

  const spendable = balance > fee + DUST ? balance - fee - DUST : 0n;
  if (spendable === 0n) throw new Error(`spend: the note ${from} cannot cover its own fee`);
  const sent = wanted < spendable ? wanted : spendable;

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
    { address: from },
  );

  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: signature as TransactionSerialized,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { sent, fee, hash };
}
