/**
 * Wallet creation and note spending.
 *
 * Privy holds every note key. The browser never holds one. A React hook can only run
 * inside a component, so each function here takes the hook result as an argument.
 *
 * A note wallet signs only when the holder spends it. Nothing signs during the mint or the
 * claim.
 */

import type { useCreateWallet, usePrivy, useSignTransaction } from "@privy-io/react-auth";
import type { Address, Hex, TransactionSerialized } from "viem";
import { CHAIN_ID, publicClient } from "./chain";
import { takeSpare } from "./notes";
import type { Note } from "./notes";

// These come from Privy and not from a copy here. A copy would go out of date without a
// build error, and the first sign of that would be a failed transaction.
type CreateWallet = ReturnType<typeof useCreateWallet>["createWallet"];
type SignTransaction = ReturnType<typeof useSignTransaction>["signTransaction"];
type SendTransaction = ReturnType<typeof usePrivy>["sendTransaction"];

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
 * Take `count` embedded wallets for the signed in user.
 *
 * The spare pool answers first. Privy counts at most 150 wallets for one user and returns
 * none of them, so a wallet that an abandoned deposit made is worth more than a new one.
 * `notes.ts` says which wallets reach that pool and why they are safe.
 *
 * Privy makes the rest. `createAdditional` decides whether Privy makes a new wallet or
 * returns the one that exists. There is a rule on the first wallet of a user. Privy throws
 * when the flag is true and the user holds no Ethereum embedded wallet. The flag is
 * therefore false for that first wallet only.
 *
 * `existing` is how many embedded wallets the user already holds.
 */
export async function createNoteWallets(
  createWallet: CreateWallet,
  existing: number,
  count: number,
  userId?: string,
): Promise<NewWallet[]> {
  const made: NewWallet[] = userId
    ? (await takeSpare(userId, count)).map((spare) => ({
        address: spare.address,
        walletId: spare.walletId,
      }))
    : [];

  for (let i = made.length; i < count; i++) {
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

/**
 * Pay the recipient out of the pocket wallet.
 *
 * This is the one step that the user approves, so it uses `sendTransaction` and not
 * `sendFromWallet`. Privy then builds the gas, sends the transaction and shows the screen
 * that names the amount. That screen names the amount only when the configuration of the
 * application turns on `transactionScanning`, which `app/providers.tsx` explains.
 *
 * Privy chooses the gas. That is safe here and it is not safe for a sweep. A sweep sends
 * the balance of a note less an exact reserve, so `sendFromWallet` keeps that arithmetic.
 * This wallet holds more than it pays.
 *
 * Call this with the function on `usePrivy`. `useSendTransaction` gives a function of the
 * same name and the same declared options, and its code holds no reference to `uiOptions`.
 * That function drops them.
 */
export async function payFromWallet(
  sendTransaction: SendTransaction,
  from: Address,
  to: Address,
  wanted: bigint,
  /**
   * The amount as a person reads it.
   *
   * The Privy screen names the recipient, the chain and the gas, and the card it draws
   * reads `balanceOf` on the sending wallet. That card is the balance of the pocket and not
   * the payment. This sentence carries the amount, because the user approves an amount.
   */
  describe: (wanted: bigint, to: Address) => string,
): Promise<Transfer> {
  const balance = await publicClient.getBalance({ address: from });
  const fees = await publicClient.estimateFeesPerGas();
  const fee = TRANSFER_GAS * fees.maxFeePerGas;
  if (balance < wanted + fee + DUST) {
    throw new Error(
      `spend: the wallet ${from} holds ${balance} and this payment needs ${wanted + fee + DUST}.`,
    );
  }

  // The Ethereum path puts the whole options object into the modal as its `uiOptions`, so
  // every name below sits at the top and not under a `uiOptions` key. `walletUiOptions`
  // explains the same rule for `showWalletUIs`. The declared type carries the nested shape,
  // so this passes both and casts once.
  const options = {
    address: from,
    description: describe(wanted, to),
    buttonText: "Send",
    transactionInfo: { title: "Payment", action: "Send cash" },
    successHeader: "Sent.",
    uiOptions: {
      description: describe(wanted, to),
      buttonText: "Send",
      transactionInfo: { title: "Payment", action: "Send cash" },
      successHeader: "Sent.",
    },
  } as Parameters<SendTransaction>[1];

  const { hash } = await sendTransaction({ to, value: wanted, chainId: CHAIN_ID }, options);
  await publicClient.waitForTransactionReceipt({ hash });
  return { sent: wanted, fee, hash };
}

/**
 * The options that tell Privy whether to ask the user.
 *
 * `sendTransaction` and `signTransaction` give their options to one internal function, and
 * that function reads `uiOptions.showWalletUIs`. The value therefore belongs under
 * `uiOptions`. This function also writes it at the top, because a copy costs nothing and
 * the two shapes are easy to confuse.
 *
 * A value that lands in neither place leaves the choice to the configuration of the
 * application, which asks the user.
 */
export function walletUiOptions(
  address: Address,
  confirm: boolean,
): Parameters<SignTransaction>[1] {
  return {
    address,
    showWalletUIs: confirm,
    uiOptions: { showWalletUIs: confirm },
  } as Parameters<SignTransaction>[1];
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
 * Privy does not ask. A sweep and a melt move money that stays with the user, and those are
 * the only callers. `payFromWallet` carries the one step that the user approves.
 *
 * This function builds the gas and the nonce itself, because a sweep sends the balance of a
 * note less an exact reserve. A wallet that chose the gas would break that arithmetic.
 *
 * The function sends nothing when the wallet cannot cover `wanted`, the fee and the base
 * unit that Arc keeps. It throws instead.
 */
export async function sendFromWallet(
  signTransaction: SignTransaction,
  from: Address,
  to: Address,
  wanted: bigint,
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
    walletUiOptions(from, false),
  );

  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: signature as TransactionSerialized,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { sent, fee, hash };
}
