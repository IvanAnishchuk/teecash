/**
 * The commands of the CLI.
 *
 * They follow the protocol in order: deploy, deposit, mint, claim, spend.
 *
 * The `mint` command is a local replacement for the CRE workflow. It runs the same steps
 * as the Go handler. It builds the same report bytes. It runs on this machine and it
 * holds the keys in the state file. The Go workflow is the real mint.
 */

import {
  LADDER,
  type Domain,
  blind,
  blindSign,
  mintKey,
  pointCount,
  randomScalar,
  splitGreedy,
  toHex,
  unblind,
  verify,
} from "@teecash/lib-blind";
import {
  createWalletClient,
  encodeAbiParameters,
  fromHex,
  getContractAddress,
  http,
  parseAbiParameters,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type Address, type Hex, artifact, connect, usdc } from "./chain.ts";
import { type Note, type State, findDeposit, load, reset, save, statePath } from "./state.ts";

const blindMintAbi = artifact("BlindMint").abi;
const consumerAbi = artifact("MintConsumer").abi;

function domainOf(state: State): Domain {
  if (state.chainId === undefined || state.blindMint === undefined) {
    throw new Error("run `deploy` first");
  }
  return { chainId: state.chainId, contract: state.blindMint };
}

function keysOf(state: State) {
  return Object.entries(state.mintKeys).map(([denom, sk]) => mintKey(BigInt(denom), BigInt(sk)));
}

export async function deploy(): Promise<void> {
  const { chainId, account, publicClient, walletClient } = await connect();
  reset();
  const state = load();
  state.chainId = chainId;

  // One secret for each denomination of the ladder.
  for (const denom of LADDER) {
    state.mintKeys[denom.toString()] = `0x${randomScalar().toString(16).padStart(64, "0")}`;
  }
  const keys = keysOf(state);

  // BlindMint takes the consumer as its forwarder. The consumer address comes first.
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  const consumerAt = getContractAddress({ from: account.address, nonce: BigInt(nonce) + 1n });

  const mintHash = await walletClient.deployContract({
    abi: blindMintAbi,
    bytecode: artifact("BlindMint").bytecode,
    args: [consumerAt, 3600n, keys.map((k) => k.denom), keys.map((k) => toHex(k.pk))],
  });
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  state.blindMint = mintReceipt.contractAddress as Address;

  // The deployer replaces the CRE forwarder in a local run.
  const consumerHash = await walletClient.deployContract({
    abi: consumerAbi,
    bytecode: artifact("MintConsumer").bytecode,
    args: [account.address, state.blindMint],
  });
  const consumerReceipt = await publicClient.waitForTransactionReceipt({ hash: consumerHash });
  state.consumer = consumerReceipt.contractAddress as Address;

  if (state.consumer.toLowerCase() !== consumerAt.toLowerCase()) {
    throw new Error("deploy: the consumer did not land on the predicted address");
  }
  save(state);

  console.log(`chain      ${chainId}`);
  console.log(`BlindMint  ${state.blindMint}`);
  console.log(`consumer   ${state.consumer}`);
  console.log(`ladder     ${LADDER.map((d) => usdc(d)).join(", ")}`);
  console.log(`state      ${statePath}`);
}

export async function deposit(amountUsdc: string): Promise<void> {
  const { publicClient, walletClient } = await connect();
  const state = load();
  const domain = domainOf(state);
  const amount = BigInt(Math.round(Number(amountUsdc) * 1e6));

  // The mint may pick any split. The deposit therefore carries the smallest split plus
  // slack.
  const count = pointCount(amount);
  const notes: Note[] = [];
  for (let i = 0; i < count; i++) {
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    const { blinded, r } = blind(address, domain);
    notes.push({
      address,
      privateKey,
      r: toHex(r) as Hex,
      blinded: toHex(blinded) as Hex,
      pointIndex: i,
      status: "awaiting-mint",
    });
  }

  const hash = await walletClient.writeContract({
    address: state.blindMint as Address,
    abi: blindMintAbi,
    functionName: "deposit",
    args: [notes.map((n) => n.blinded)],
    value: amount,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  const logs = await publicClient.getContractEvents({
    address: state.blindMint as Address,
    abi: blindMintAbi,
    eventName: "Deposited",
    blockHash: receipt.blockHash,
  });
  const id = (logs[0] as unknown as { args: { id: bigint } }).args.id;

  state.deposits.push({ id: id.toString(), amount: amount.toString(), notes });
  save(state);

  console.log(`deposit ${id} of ${usdc(amount)} against ${count} points`);
  console.log(`the smallest split needs ${splitGreedy(amount).length} notes`);
  console.log(`gas ${receipt.gasUsed}`);
}

/**
 * Replace the CRE workflow for a local run.
 *
 * The Go handler does this work inside an enclave. Here the keys come from the state
 * file.
 */
export async function mint(id?: string): Promise<void> {
  const { account, publicClient, walletClient } = await connect();
  const state = load();
  const record = findDeposit(state, id);
  const keys = keysOf(state);
  const amount = BigInt(record.amount);

  const split = splitGreedy(amount);
  if (split.length > record.notes.length) throw new Error("mint: the deposit holds too few points");

  const pointIndexes: bigint[] = [];
  const denoms: bigint[] = [];
  const blindSigs: Hex[] = [];
  split.forEach((denom, i) => {
    const key = keys.find((k) => k.denom === denom);
    if (!key) throw new Error(`mint: there is no key for ${denom}`);
    const note = record.notes[i];
    const blindSig = blindSign(key, fromHex(note.blinded, "bytes"));
    pointIndexes.push(BigInt(i));
    denoms.push(denom);
    blindSigs.push(toHex(blindSig) as Hex);
    note.denom = denom.toString();
    note.status = "ready";
    // The client unblinds the signature from the announcement.
    note.sig = toHex(unblind(blindSig, fromHex(note.r, "bytes"))) as Hex;
  });

  const report = encodeAbiParameters(parseAbiParameters("uint256, uint256[], uint256[], bytes[]"), [
    BigInt(record.id),
    pointIndexes,
    denoms,
    blindSigs,
  ]);

  const hash = await walletClient.writeContract({
    address: state.consumer as Address,
    abi: consumerAbi,
    functionName: "onReport",
    args: ["0x", report],
    account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  save(state);

  console.log(`announced ${split.length} notes for deposit ${record.id}`);
  console.log(`denominations ${split.map((d) => usdc(d)).join(", ")}`);
  console.log(`gas ${receipt.gasUsed}`);
}

export async function claim(id?: string): Promise<void> {
  const { publicClient, walletClient } = await connect();
  const state = load();
  const domain = domainOf(state);
  const record = findDeposit(state, id);
  const keys = keysOf(state);

  for (const note of record.notes) {
    const { denom, sig } = note;
    if (note.status !== "ready" || denom === undefined || sig === undefined) continue;
    const key = keys.find((k) => k.denom === BigInt(denom));
    if (!key) throw new Error(`claim: there is no key for ${denom}`);

    // Check before the call. A bad signature would waste the gas of a revert.
    if (!verify(key.pk, note.address, fromHex(sig, "bytes"), domain)) {
      throw new Error(`claim: the signature for ${note.address} does not verify`);
    }

    const hash = await walletClient.writeContract({
      address: state.blindMint as Address,
      abi: blindMintAbi,
      functionName: "claim",
      args: [BigInt(denom), note.address, sig],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const balance = await publicClient.getBalance({ address: note.address });
    note.status = "claimed";
    console.log(`${note.address} holds ${usdc(balance)} (gas ${receipt.gasUsed})`);
  }
  save(state);
}

/**
 * Spend from a funded wallet.
 *
 * Arc makes this step possible. The note is the gas token. The wallet therefore pays its
 * own transaction and it needs no extra funding.
 */
export async function spend(id?: string): Promise<void> {
  const { chain, publicClient } = await connect();
  const state = load();
  const record = findDeposit(state, id);
  const target = privateKeyToAccount(generatePrivateKey()).address;

  // Spend the largest note. It covers its own fee most easily.
  const claimed = record.notes.filter((n) => n.status === "claimed" && n.denom !== undefined);
  claimed.sort((a, b) => (BigInt(b.denom as string) > BigInt(a.denom as string) ? 1 : -1));
  const note = claimed[0];
  if (!note) throw new Error("spend: no wallet holds a note");

  const wallet = createWalletClient({
    account: privateKeyToAccount(note.privateKey),
    chain,
    transport: http(),
  });

  const before = await publicClient.getBalance({ address: note.address });

  // Set the fee fields. The suggestion of the node carries a priority fee, and a local
  // node prices gas in 18 decimals while a note holds 6.
  const block = await publicClient.getBlock();
  const priority = BigInt(process.env.TEECASH_PRIORITY_FEE ?? "0");
  const maxFee = (block.baseFeePerGas ?? 0n) + priority;

  // Leave dust in the account. Arc reverts a transfer that empties a fresh account.
  const fee = maxFee * 21_000n;
  const value = before - fee - 1n;
  if (value <= 0n) {
    throw new Error(
      `spend: the note holds ${usdc(before)} and the fee is ${usdc(fee)}. The note does not cover its own fee.`,
    );
  }

  const hash = await wallet.sendTransaction({
    to: target,
    value,
    gas: 21_000n,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: priority,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log(`${note.address} paid ${usdc(value)} to ${target}`);
  console.log("the wallet paid its own fee and needed no funding transaction");
  console.log(`fee ${usdc(receipt.gasUsed * receipt.effectiveGasPrice)}`);
}

export async function status(): Promise<void> {
  const { publicClient } = await connect();
  const state = load();
  if (state.blindMint === undefined) {
    console.log("nothing is deployed");
    return;
  }
  const balance = await publicClient.getBalance({ address: state.blindMint });
  console.log(`BlindMint ${state.blindMint} holds ${usdc(balance)}`);

  for (const record of state.deposits) {
    console.log(`\ndeposit ${record.id}: ${usdc(BigInt(record.amount))}, ${record.notes.length} points`);
    for (const note of record.notes) {
      const held = await publicClient.getBalance({ address: note.address });
      const denom = note.denom === undefined ? "-" : usdc(BigInt(note.denom));
      console.log(`  ${note.address}  ${note.status.padEnd(13)} ${denom.padStart(10)}  holds ${usdc(held)}`);
    }
  }
}
