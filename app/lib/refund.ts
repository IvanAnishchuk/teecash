"use client";

/**
 * The reclaim of a deposit that the mint never answered.
 *
 * The contract holds the money of a pending deposit and gives it back after a delay.
 * `refundByDepositor` is that way out, and it is the only one the depositor controls. It
 * takes no signature from the mint, so a mint that never runs cannot keep the money.
 *
 * The contract sets two conditions. The caller must be the account that paid, and the
 * deadline must have passed. It also refuses a deposit that is no longer pending, so a
 * late announcement and a reclaim cannot both win. Whichever reaches the chain first takes
 * it and the other one reverts.
 *
 * The client offers this and does not do it. A reclaim moves money and it asks the wallet
 * of the user to sign, so it belongs to a button and not to the settler. It also ends the
 * deposit: after a refund no note of it can ever be claimed.
 */

import { createWalletClient, custom } from "viem";
import type { Address, Hex } from "viem";
import type { useWallets } from "@privy-io/react-auth";
import { blindMintAbi } from "./abi";
import { CHAIN_ID, chain, contract, publicClient } from "./chain";
import { putDepositOnly } from "./notes";
import type { Deposit, Note } from "./notes";

// The type comes from Privy and not from a copy here, for the reason `lib/privy.ts` gives.
type ConnectedWallet = ReturnType<typeof useWallets>["wallets"][number];

/**
 * Report whether the user can reclaim this deposit now.
 *
 * A deposit qualifies when the mint has not answered it, the contract has numbered it and
 * the deadline has passed.
 *
 * A deposit that carries no note is left out. That record is a melt of a wallet below two
 * rungs, and it mints nothing by design. Its depositor is the change wallet, which the
 * melt emptied on purpose, so it holds no gas to pay for a reclaim of its own dust.
 *
 * `now` is in milliseconds and the deadline of the contract is in seconds.
 */
export function reclaimable(deposit: Deposit, notes: Note[], now: number): boolean {
  return (
    deposit.status === "pending" &&
    deposit.onChainId !== undefined &&
    deposit.deadline !== undefined &&
    notes.length > 0 &&
    now >= Number(deposit.deadline) * 1000
  );
}

/**
 * Report whether this wallet is the one that the contract accepts.
 *
 * `refundByDepositor` takes the depositor and nobody else. A user with more than one
 * wallet can hold the right one on another device, so a screen has to name the address
 * instead of failing at the wallet.
 */
export function paidBy(deposit: Deposit, wallet: ConnectedWallet | undefined): boolean {
  if (!wallet || deposit.depositor === undefined) return false;
  return wallet.address.toLowerCase() === deposit.depositor.toLowerCase();
}

/**
 * Ask the contract to return a pending deposit to the account that paid it.
 *
 * The function waits for the receipt and then writes the status. The settler reads the
 * same answer from the chain on its next pass, so this write only saves the screen a wait.
 */
export async function reclaimDeposit(
  wallet: ConnectedWallet,
  deposit: Deposit,
): Promise<Hex> {
  if (deposit.onChainId === undefined) {
    throw new Error("reclaim: the contract has not numbered this deposit");
  }
  const address = (deposit.contract ?? contract()) as Address;

  const provider = await wallet.getEthereumProvider();
  const walletClient = createWalletClient({
    account: wallet.address as Address,
    chain,
    transport: custom(provider),
  });

  // The wallet of the user must carry this chain, the same as it must for the deposit.
  await walletClient.switchChain({ id: CHAIN_ID }).catch(async () => {
    await walletClient.addChain({ chain });
    await walletClient.switchChain({ id: CHAIN_ID });
  });

  const hash = await walletClient.writeContract({
    address,
    abi: blindMintAbi,
    functionName: "refundByDepositor",
    args: [BigInt(deposit.onChainId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  await putDepositOnly({ ...deposit, status: "refunded" });
  return hash;
}
