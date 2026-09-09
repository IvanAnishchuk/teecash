"use client";

/**
 * The deposit screen.
 *
 * The user types an amount. The screen shows the smallest split and the number of points
 * the deposit will carry. The mint may choose a different split, so the point count is a
 * cap and not a prediction.
 *
 * On confirm the client makes one wallet for each point, blinds each address, and asks the
 * external wallet of the user to sign `deposit`. The money enters the contract from a
 * wallet that the user already funds. No wallet sits between the user and `deposit`.
 *
 * The screen then moves to the wait screen of that deposit.
 */

import { useCreateWallet, useWallets } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createWalletClient, custom, parseUnits } from "viem";
import type { Address } from "viem";
import { LADDER, pointCount, splitGreedy } from "@teecash/lib-blind";
import { blindMintAbi } from "../../lib/abi";
import { CHAIN_ID, chain, contract, publicClient, usdc } from "../../lib/chain";
import { blindWallets } from "../../lib/mint";
import { putDeposit, putDepositOnly, toAmount } from "../../lib/notes";
import { createNoteWallets } from "../../lib/privy";
import { useVault } from "../../lib/vault";

export default function DepositScreen() {
  const router = useRouter();
  const { userId } = useVault();
  const { createWallet } = useCreateWallet();
  const { wallets } = useWallets();
  const [amountText, setAmountText] = useState("3");
  const [step, setStep] = useState<string>();
  const [error, setError] = useState<string>();

  // `connectorType` names how a wallet connects and `walletClientType` names the product.
  // The connector is the safer test. A wallet that Privy has just made can appear before
  // its `walletClientType` does, and a test by exclusion then reads it as an external
  // wallet and offers it the deposit.
  const embedded = wallets.filter((w) => w.connectorType === "embedded");
  const external = wallets.find((w) => w.connectorType !== "embedded");

  let amount: bigint | undefined;
  let split: bigint[] = [];
  let points = 0;
  let parseError: string | undefined;
  try {
    amount = parseUnits(amountText, 18);
    split = splitGreedy(amount);
    points = pointCount(amount);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  async function start() {
    if (!userId || amount === undefined || !external) return;
    setError(undefined);
    try {
      setStep(`Making ${points} wallets.`);
      const made = await createNoteWallets(createWallet, embedded.length, points);

      // The blinding factor of a note exists only here. The contract pays a note against a
      // signature that the client unblinds with that factor, and nothing on the chain holds
      // it. A deposit that confirms before the record reaches the disk is therefore lost:
      // the money is in the contract, `refundByDepositor` refuses after the announcement,
      // and no claim can succeed. The record goes to the disk before the transaction goes
      // to the chain.
      const depositId = crypto.randomUUID();
      const draft = blindWallets(made, userId, depositId);
      await putDeposit(
        {
          id: depositId,
          userId,
          amount: toAmount(amount),
          block: "0",
          status: "pending",
          createdAt: Date.now(),
        },
        draft,
      );

      setStep("Asking your wallet to sign the deposit.");
      const provider = await external.getEthereumProvider();
      const walletClient = createWalletClient({
        account: external.address as Address,
        chain,
        transport: custom(provider),
      });

      // The wallet of the user must carry this chain. A wallet on another chain cannot
      // pay a deposit that the contract will accept.
      await walletClient.switchChain({ id: CHAIN_ID }).catch(async () => {
        await walletClient.addChain({ chain });
        await walletClient.switchChain({ id: CHAIN_ID });
      });

      const hash = await walletClient.writeContract({
        address: contract(),
        abi: blindMintAbi,
        functionName: "deposit",
        args: [draft.map((note) => note.blinded)],
        value: amount,
      });

      // The money is on the chain now. The hash is the only way back to that transaction,
      // so it reaches the disk before the client waits for anything at all.
      await putDepositOnly({
        id: depositId,
        txHash: hash,
        userId,
        amount: toAmount(amount),
        block: "0",
        status: "pending",
        createdAt: Date.now(),
      });

      // The wait screen owns every step after this one. It reads the receipt, it takes the
      // deposit number from the log, and it claims. That screen repeats each step until it
      // succeeds, so a network that fails costs time and nothing else. This screen must not
      // wait here, because a wait that never ends hides a deposit that already exists.
      router.push(`/deposit/${depositId}`);
    } catch (err) {
      setStep(undefined);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!userId) return <main>Sign in first.</main>;

  return (
    <main>
      <h1>Deposit</h1>
      <p className="sub">The ladder is {LADDER.map((d) => usdc(d)).join(", ")}.</p>

      <label>
        <span>Amount in USDC</span>
        <input
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          disabled={step !== undefined}
          inputMode="decimal"
        />
      </label>

      {parseError ? (
        <p className="fail">{parseError}</p>
      ) : (
        <div className="card">
          <div className="line">
            <span>Smallest split</span>
            <span className="dim">{split.map((d) => usdc(d)).join(" + ")}</span>
          </div>
          <div className="line">
            <span>Points in the deposit</span>
            <span className="dim">{points}</span>
          </div>
        </div>
      )}

      {external ? (
        <div className="card">
          <div className="line">
            <span>Paying from</span>
            <span className="mono dim">{external.address}</span>
          </div>
          <div className="line">
            <span>Wallet</span>
            <span className="dim">
              {external.walletClientType ?? "unknown"} / {external.connectorType}
            </span>
          </div>
        </div>
      ) : (
        <p className="fail">
          Connect the wallet that will pay the deposit. It must carry chain {CHAIN_ID}. The
          user holds {embedded.length} note wallet(s), and none of them can pay.
        </p>
      )}

      <button onClick={start} disabled={step !== undefined || !external || amount === undefined}>
        {step ?? "Deposit"}
      </button>

      {error && <p className="fail">{error}</p>}
    </main>
  );
}
