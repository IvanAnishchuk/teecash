"use client";

/**
 * The risk screen.
 *
 * `docs/frontend-spec.md` lists two risks. Both must pass before the note model is safe.
 * This screen tests them against the live Privy application and the live chain. Delete
 * this route when the wallet screens replace it.
 *
 * Risk 1. The client SDK must make more than one embedded wallet for one user. A note is
 * one wallet per point. A user with a three point deposit needs three wallets. If Privy
 * gives one wallet per user, the design must use server side wallets. The backend then
 * holds the deposit to note link that blinding removes.
 *
 * Risk 2. Privy must sign for chain 5042002. The command line client proved that the
 * server API signs for Arc. The client SDK is a different path. It needs its own proof.
 *
 * The proof of risk 2 is a recovered address. The chain accepts a signature that recovers
 * to the note address. A returned hex string alone proves nothing.
 */

import { useCreateWallet, usePrivy, useSignTransaction, useWallets } from "@privy-io/react-auth";
import { useState } from "react";
import {
  type Address,
  type TransactionSerialized,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { CHAIN_ID, chain, publicClient } from "../../lib/chain";

const WANTED = 3;

type Line = { text: string; state: "pass" | "fail" | "info" };

export default function Debug() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signTransaction } = useSignTransaction();
  const { wallets } = useWallets();
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);

  const say = (text: string, state: Line["state"] = "info") =>
    setLines((prev) => [...prev, { text, state }]);

  /** The embedded wallets of this user. Privy names its own `privy`. */
  const embedded = wallets.filter((w) => w.walletClientType === "privy");

  async function riskOne() {
    setLines([]);
    setBusy(true);
    try {
      say(`This user starts with ${embedded.length} embedded wallet(s).`);
      const made: Address[] = [];
      for (let i = 0; i < WANTED; i++) {
        // The first wallet of a user must not carry `createAdditional`. Privy throws when
        // the flag is true and the user holds no Ethereum embedded wallet. Every later
        // wallet must carry it, because the default of false returns the first wallet.
        const first = embedded.length === 0 && i === 0;
        const wallet = await createWallet(first ? {} : { createAdditional: true });
        made.push(wallet.address as Address);
        say(`wallet ${i + 1}: ${wallet.address}`);
      }
      const distinct = new Set(made.map((a) => a.toLowerCase()));
      if (distinct.size === WANTED) {
        say(`${WANTED} distinct addresses. The note model holds.`, "pass");
      } else {
        say(
          `Only ${distinct.size} distinct address(es) of ${WANTED}. ` +
            "The client SDK does not give one wallet per point.",
          "fail",
        );
      }
    } catch (err) {
      say(`createWallet failed: ${String(err)}`, "fail");
    } finally {
      setBusy(false);
    }
  }

  async function riskTwo() {
    setBusy(true);
    try {
      const note = embedded.at(-1);
      if (!note) {
        say("There is no embedded wallet to sign with. Run risk 1 first.", "fail");
        return;
      }
      const from = note.address as Address;
      // A real transaction shape. The value is one base unit. The client never sends it.
      const nonce = await publicClient.getTransactionCount({ address: from });
      const fees = await publicClient.estimateFeesPerGas();
      // Privy names the gas cap `gasLimit`, not `gas`.
      const request = {
        to: from,
        value: 1n,
        nonce,
        gasLimit: 21000n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        chainId: CHAIN_ID,
      };
      say(`Signing for chain ${CHAIN_ID} as ${from}`);

      const { signature } = await signTransaction(request, { address: from });
      // Privy types the return as plain hex. viem needs the narrower serialized type.
      // A value that is not a serialized transaction makes `parseTransaction` throw, and
      // the catch below reports that. The cast therefore hides nothing.
      const signed = signature as TransactionSerialized;
      say(`returned: ${signed.slice(0, 42)}...`);

      // A serialized signed transaction recovers to its sender. Anything else is not one.
      const parsed = parseTransaction(signed);
      const signer = await recoverTransactionAddress({ serializedTransaction: signed });
      if (signer.toLowerCase() === from.toLowerCase() && parsed.chainId === CHAIN_ID) {
        say(`Recovered ${signer} on chain ${parsed.chainId}. Privy signs for Arc.`, "pass");
      } else {
        say(`Recovered ${signer} on chain ${parsed.chainId}. That is the wrong signer.`, "fail");
      }
    } catch (err) {
      say(`signTransaction failed: ${String(err)}`, "fail");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <main>Loading.</main>;

  return (
    <main>
      <h1>Risks</h1>
      <p className="sub">
        {chain.name} at {chain.rpcUrls.default.http[0]}
      </p>

      {!authenticated ? (
        <button onClick={login}>Sign in with Privy</button>
      ) : (
        <>
          <div className="card">
            <div className="mono">{user?.id}</div>
            <div className="mono">
              {embedded.length} embedded wallet(s):{" "}
              {embedded.map((w) => w.address.slice(0, 10)).join(" ") || "none"}
            </div>
          </div>

          <div className="card">
            <strong>Risk 1. More than one embedded wallet per user.</strong>
            <p className="sub">Make {WANTED} wallets and check that they differ.</p>
            <button onClick={riskOne} disabled={busy}>
              Run
            </button>
          </div>

          <div className="card">
            <strong>Risk 2. A browser signature for chain {CHAIN_ID}.</strong>
            <p className="sub">Sign one transaction and recover the signer from it.</p>
            <button onClick={riskTwo} disabled={busy}>
              Run
            </button>
          </div>

          {lines.length > 0 && (
            <div className="card">
              {lines.map((line, i) => (
                <div
                  key={i}
                  className={`mono ${line.state === "info" ? "" : line.state}`}
                >
                  {line.text}
                </div>
              ))}
            </div>
          )}

          <button className="ghost" onClick={logout}>
            Sign out
          </button>
        </>
      )}
    </main>
  );
}
