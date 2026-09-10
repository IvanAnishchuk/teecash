"use client";

/**
 * The deposit screen.
 *
 * The user types the amount to mint. The transaction carries one rung more, because the
 * mint tax is extra and not part of the notes. The screen shows the tax, the smallest
 * split and the number of points the deposit will carry. The mint may choose a different
 * split, so the point count is a cap and not a prediction.
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
import { LADDER, MIN_DENOM, grossFor, mintable, pointCount, splitGreedy, tax } from "@teecash/lib-blind";
import { blindMintAbi } from "../../lib/abi";
import { explain } from "../../lib/errors";
import { CHAIN_ID, chain, contract, publicClient, usdc } from "../../lib/chain";
import { blindWallets } from "../../lib/mint";
import { discardDeposit, putDeposit, putDepositOnly, toAmount } from "../../lib/notes";
import type { Deposit } from "../../lib/notes";
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
  /** The address of the wallet that pays. The browser remembers the last choice. */
  const [payer, setPayer] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("teecash.payer") ?? "";
  });

  function choose(address: string): void {
    setPayer(address);
    window.localStorage.setItem("teecash.payer", address);
  }

  // `connectorType` names how a wallet connects and `walletClientType` names the product.
  // The connector is the safer test. A wallet that Privy has just made can appear before
  // its `walletClientType` does, and a test by exclusion then reads it as an external
  // wallet and offers it the deposit.
  const embedded = wallets.filter((w) => w.connectorType === "embedded");
  const payers = wallets.filter((w) => w.connectorType !== "embedded");

  // The user picks the wallet that pays. An earlier version took the first wallet of the
  // list, and the order of that list is not fixed. A user with a wallet on this computer
  // and a wallet on a telephone then paid from whichever one Privy named first, and the
  // request went to the wrong device.
  const external = payers.find((w) => w.address === payer) ?? payers[0];

  // The field holds "", "0" and "3." on the way to "3.25". None of those is a mistake, so
  // none of them makes a message. `splitGreedy` throws on an amount of zero.
  //
  // `amount` is what the transaction carries. `minted` is what the user receives in notes.
  // The difference is the tax.
  let amount: bigint | undefined;
  let minted = 0n;
  let fee = 0n;
  let split: bigint[] = [];
  let points = 0;
  let parseError: string | undefined;
  try {
    const typed = amountText.trim();
    const net = typed.length > 0 ? parseUnits(typed, 18) : undefined;
    if (net === undefined || net <= 0n) {
      amount = undefined;
    } else {
      amount = grossFor(net);
      minted = mintable(amount);
      fee = tax(amount);
      split = minted > 0n ? splitGreedy(minted) : [];
      points = pointCount(amount);
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  async function start() {
    if (!userId || amount === undefined || !external) return;
    setError(undefined);
    // The record of a deposit that has no transaction yet. A failure before the wallet
    // signs must remove it, because it names money that never moved.
    let draftRecord: Deposit | undefined;
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
      // The record holds what the deposit mints. The tax leaves the contract when the
      // mint announces. Every balance on the screens reads this field.
      const record: Deposit = {
        id: depositId,
        userId,
        amount: toAmount(minted),
        block: "0",
        status: "pending",
        createdAt: Date.now(),
        // The deployment that numbers this deposit. `onChainId` counts from one inside one
        // deployment, so a record without this address cannot find its own announcement
        // after the build points at another one.
        contract: contract(),
      };
      await putDeposit(record, draft);
      draftRecord = record;

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
      // so it reaches the disk before the client waits for anything at all. The record is
      // real from here, so a later failure must keep it.
      await putDepositOnly({ ...record, txHash: hash });
      draftRecord = undefined;

      // The wait screen owns every step after this one. It reads the receipt, it takes the
      // deposit number from the log, and it claims. That screen repeats each step until it
      // succeeds, so a network that fails costs time and nothing else. This screen must not
      // wait here, because a wait that never ends hides a deposit that already exists.
      router.push(`/deposit/${depositId}`);
    } catch (err) {
      // No transaction exists, so the records name money that never moved. They would sit
      // on the balance screen as a deposit that can never finish.
      if (draftRecord) await discardDeposit(draftRecord);
      setStep(undefined);
      setError(explain(err, "The deposit did not start. Try again."));
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
            <span>You receive</span>
            <span className="dim">{usdc(minted)}</span>
          </div>
          <div className="line">
            <span>Mint tax</span>
            <span className="dim">{usdc(fee)}</span>
          </div>
          <div className="line">
            <span>Your wallet pays</span>
            <span className="dim">{amount === undefined ? "-" : usdc(amount)}</span>
          </div>
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
        <label>
          <span>Paying from</span>
          <select value={external.address} onChange={(e) => choose(e.target.value)}>
            {payers.map((wallet) => (
              <option key={wallet.address} value={wallet.address}>
                {wallet.walletClientType ?? "unknown"} / {wallet.connectorType} —{" "}
                {wallet.address.slice(0, 10)}…{wallet.address.slice(-6)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="fail">
          Connect the wallet that will pay the deposit. It must carry chain {CHAIN_ID}. The
          user holds {embedded.length} note wallet(s), and none of them can pay.
        </p>
      )}

      {amount !== undefined && minted === 0n && (
        <p className="fail">
          This amount mints nothing. The tax takes one rung and everything below it, so a
          deposit has to ask for at least {usdc(MIN_DENOM)}.
        </p>
      )}

      {/* `minted === 0n` closes the button. The contract accepts such a deposit and the
          treasury takes all of it, so nothing on the chain refuses a user who pays for no
          note at all. */}
      <button
        onClick={start}
        disabled={step !== undefined || !external || amount === undefined || minted === 0n}
      >
        {step ?? "Deposit"}
      </button>

      {error && <p className="fail">{error}</p>}
    </main>
  );
}
