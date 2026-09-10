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
 *
 * Risk 3. A note is one wallet, and Privy counts at most 150 wallets for one user. A
 * balance of many small notes reaches that count, and the user can then send nothing. This
 * screen unlinks the wallets that hold nothing and it then asks for one more wallet. The
 * answer says whether an unlink returns the wallet to the count.
 */

import {
  useCreateWallet,
  usePrivy,
  useSignTransaction,
  useUnlinkWallet,
  useWallets,
} from "@privy-io/react-auth";
import { useState } from "react";
import {
  type Address,
  type TransactionSerialized,
  parseTransaction,
  recoverTransactionAddress,
} from "viem";
import { CHAIN_ID, chain, publicClient, usdc } from "../../lib/chain";
import { DUST, sendFromWallet } from "../../lib/privy";

const WANTED = 3;

type Line = { text: string; state: "pass" | "fail" | "info" };

export default function Debug() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signTransaction } = useSignTransaction();
  const { unlink } = useUnlinkWallet();
  const { wallets } = useWallets();
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  /** The address that a sweep pays. */
  const [target, setTarget] = useState("");

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

  /**
   * Ask whether an unlink returns a wallet to the count of 150.
   *
   * The answer is no. Privy sends `unlinkWallet` to the sign-in-with-Ethereum endpoint,
   * which knows external wallets only, and an embedded wallet answers
   * `linked_account_not_found`. The server API offers no delete for one wallet. A user that
   * reaches the count can therefore only be deleted whole.
   *
   * This function proves that on one wallet and it stops. It never walks the whole set.
   *
   * A zero balance does not mean that a wallet is finished. Every point of a pending
   * deposit reads zero while its money waits inside the contract, and `claim` pays the
   * signed address whoever sends it. An unlink of those addresses would put the money of
   * that deposit out of reach of this user. The one wallet below is the last one, which
   * holds no note.
   */
  async function riskThree() {
    setLines([]);
    setBusy(true);
    try {
      say(`This user holds ${embedded.length} embedded wallet(s).`);
      const last = embedded.at(-1);
      if (!last) {
        say("There is no embedded wallet.", "fail");
        return;
      }

      const address = last.address as Address;
      const balance = await publicClient.getBalance({ address });
      if (balance > DUST) {
        say(`${address.slice(0, 10)} holds ${usdc(balance)}. Empty it first.`, "fail");
        return;
      }

      try {
        await unlink({ address });
        say(`unlink answered for ${address.slice(0, 10)}.`);
      } catch (err) {
        say(`unlink refused: ${String(err)}`, "fail");
        say("An embedded wallet cannot be unlinked. Only the whole user can be deleted.");
        return;
      }

      // A wallet that Privy still counts gives the same refusal as before the unlink.
      try {
        const made = await createWallet({ createAdditional: true });
        say(`createWallet answered ${made.address}. An unlink returns the wallet.`, "pass");
      } catch (err) {
        say(`createWallet still refuses: ${String(err)}`, "fail");
      }
    } catch (err) {
      say(`the run failed: ${String(err)}`, "fail");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Move the money of every embedded wallet to one address.
   *
   * A wallet pays its own fee, so a wallet that holds less than one fee cannot send. Those
   * hold dust and the run reports them and continues.
   *
   * This is the step before the user is deleted. Privy counts at most 150 wallets for one
   * user and it gives no way to return one, so a user that reaches the count can only start
   * again. The money must leave first.
   */
  async function sweepAll() {
    setLines([]);
    setBusy(true);
    try {
      const to = target.trim() as Address;
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
        say("Give the address that receives the money.", "fail");
        return;
      }
      say(`Reading ${embedded.length} wallet(s).`);

      let moved = 0n;
      let sent = 0;
      let tooSmall = 0;
      let failed = 0;
      for (const wallet of embedded) {
        const from = wallet.address as Address;
        const balance = await publicClient.getBalance({ address: from });
        if (balance <= DUST) continue;
        try {
          // `sendFromWallet` takes what the recipient receives, so the fee and the base
          // unit that Arc keeps come off here.
          const fees = await publicClient.estimateFeesPerGas();
          const fee = 21000n * fees.maxFeePerGas;
          const wanted = balance - fee - DUST;
          if (wanted <= 0n) {
            tooSmall++;
            continue;
          }
          await sendFromWallet(signTransaction, from, to, wanted);
          moved += wanted;
          sent++;
          say(`${from.slice(0, 10)} sent ${usdc(wanted)}`);
        } catch (err) {
          failed++;
          say(`${from.slice(0, 10)} failed: ${String(err)}`, "fail");
        }
      }
      say(
        `${usdc(moved)} moved from ${sent} wallet(s). ` +
          `${tooSmall} held less than one fee. ${failed} failed.`,
        failed === 0 ? "pass" : "fail",
      );
    } catch (err) {
      say(`the sweep failed: ${String(err)}`, "fail");
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

          <div className="card">
            <strong>Empty every wallet.</strong>
            <p className="sub">
              Send the money of every embedded wallet to one address. Do this before the user
              is deleted, because a deleted user takes its wallets with it.
            </p>
            <label>
              <span>Pay to</span>
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="0x..."
                disabled={busy}
              />
            </label>
            <button onClick={sweepAll} disabled={busy}>
              Sweep
            </button>
          </div>

          <div className="card">
            <strong>Risk 3. The wallet count of one user.</strong>
            <p className="sub">
              Unlink the last embedded wallet and then ask for one more. The answer says whether
              an unlink returns the wallet to the count of 150. It does not: Privy knows no
              unlink for an embedded wallet.
            </p>
            <button onClick={riskThree} disabled={busy}>
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
