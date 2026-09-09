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
  secretId,
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
  concat,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  fromHex,
  getContractAddress,
  http,
  parseAbiParameters,
  parseUnits,
  recoverTransactionAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ONE_USDC, type Address, type Hex, artifact, connect, usdc } from "./chain.ts";
import { type Note, type State, findDeposit, load, reset, save, statePath } from "./state.ts";
import { providerOf, walletProvider } from "./wallets.ts";

const blindMintAbi = artifact("BlindMint").abi;

function domainOf(state: State): Domain {
  if (state.chainId === undefined || state.blindMint === undefined) {
    throw new Error("run `deploy` first");
  }
  return { chainId: state.chainId, contract: state.blindMint };
}

function keysOf(state: State) {
  return Object.entries(state.mintKeys).map(([denom, sk]) => mintKey(BigInt(denom), BigInt(sk)));
}

/**
 * The canonical CREATE2 deployer.
 *
 * It answers at the same address on every chain that carries it. A deployment through it
 * lands on an address that depends on the salt and the init code only. The address is
 * therefore stable across deployments, and no configuration file has to follow it.
 */
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as Address;

/** The salt of every teecash deployment. */
const SALT = "0x0000000000000000000000000000000000000000000000000000000074656563" as Hex;

export async function deploy(): Promise<void> {
  const { chainId, account, publicClient, walletClient } = await connect();
  reset();
  const state = load();
  state.chainId = chainId;

  // One secret for each denomination of the ladder.
  //
  // The CRE workflow reads the same keys from `workflow/.env`. Both sides must hold the
  // same keys. A signature from the simulation is otherwise invalid for this
  // deployment. An environment variable therefore wins over a fresh random scalar.
  for (const denom of LADDER) {
    const fromEnv = process.env[`SECRET_${secretId(denom)}`];
    state.mintKeys[denom.toString()] = fromEnv
      ? (`0x${fromEnv.replace(/^0x/, "")}` as Hex)
      : `0x${randomScalar().toString(16).padStart(64, "0")}`;
  }
  const keys = keysOf(state);

  // Only the CRE forwarder can deliver a report. A CRE simulation writes through the mock
  // forwarder of the chain. TEECASH_CRE_FORWARDER carries that address. The deployer takes
  // the role when the variable is absent. The `mint` command needs that default.
  const creForwarder = (process.env.TEECASH_CRE_FORWARDER ?? account.address) as Address;

  // The init code carries the constructor arguments, so the address covers the forwarder,
  // the ladder and every public key. The same inputs give the same address on every run
  // and on every chain. A different mint key set is a different deployment.
  const initCode = encodeDeployData({
    abi: blindMintAbi,
    bytecode: artifact("BlindMint").bytecode,
    args: [creForwarder, 3600n, keys.map((k) => k.denom), keys.map((k) => toHex(k.pk))],
  });
  const blindMint = getContractAddress({
    opcode: "CREATE2",
    from: CREATE2_DEPLOYER,
    salt: SALT,
    bytecode: initCode,
  });

  if ((await publicClient.getCode({ address: CREATE2_DEPLOYER })) === undefined) {
    throw new Error(`deploy: chain ${chainId} carries no CREATE2 deployer at ${CREATE2_DEPLOYER}`);
  }

  // A second deployment of the same inputs would revert. The address already holds the
  // contract that this run wants, so the run keeps it.
  const existing = await publicClient.getCode({ address: blindMint });
  if (existing === undefined) {
    const hash = await walletClient.sendTransaction({
      to: CREATE2_DEPLOYER,
      data: concat([SALT, initCode]),
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  state.blindMint = blindMint;
  save(state);

  console.log(`chain      ${chainId}`);
  console.log(`BlindMint  ${blindMint}${existing === undefined ? "" : " (already deployed)"}`);
  console.log(`forwarder  ${creForwarder}`);
  console.log(`ladder     ${LADDER.map((d) => usdc(d)).join(", ")}`);
  console.log(`state      ${statePath}`);
}

export async function deposit(amountUsdc: string): Promise<void> {
  const { publicClient, walletClient } = await connect();
  const state = load();
  const domain = domainOf(state);
  // parseUnits keeps the full precision of 18 decimals. A float would lose it.
  const amount = parseUnits(amountUsdc, 18);

  // The mint may pick any split. The deposit therefore carries the smallest split plus
  // slack.
  const count = pointCount(amount);
  const provider = walletProvider();
  const wallets = await provider.create(count);

  const notes: Note[] = wallets.map((wallet, i) => {
    const { blinded, r } = blind(wallet.address, domain);
    return {
      address: wallet.address,
      provider: wallet.provider,
      ref: wallet.ref,
      r: toHex(r) as Hex,
      blinded: toHex(blinded) as Hex,
      pointIndex: i,
      status: "awaiting-mint" as const,
    };
  });

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

  state.deposits.push({
    id: id.toString(),
    amount: amount.toString(),
    block: receipt.blockNumber.toString(),
    notes,
  });
  save(state);

  console.log(`deposit ${id} of ${usdc(amount)} against ${count} points`);
  console.log(`the smallest split needs ${splitGreedy(amount).length} notes`);
  console.log(`tx ${hash}`);
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
    address: state.blindMint as Address,
    abi: blindMintAbi,
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

/**
 * Read an announcement from the chain and unblind it.
 *
 * The client learns the split here. The mint chooses it, so the client cannot predict
 * which point carries which denomination. The event carries that assignment.
 *
 * This is the step that follows a CRE mint. The local `mint` command does the same work
 * and skips the chain read.
 */
export async function sync(id?: string): Promise<void> {
  const { publicClient } = await connect();
  const state = load();
  const domain = domainOf(state);
  const record = findDeposit(state, id);
  const keys = keysOf(state);

  // Arc prunes history, so a search from block zero fails. The deposit block bounds it.
  // An older state file has no block, so the search falls back to a recent window.
  const head = await publicClient.getBlockNumber();
  const window = BigInt(process.env.TEECASH_LOG_WINDOW ?? "50000");
  const fromBlock = record.block !== undefined ? BigInt(record.block) : head > window ? head - window : 0n;

  const logs = await publicClient.getContractEvents({
    address: state.blindMint as Address,
    abi: blindMintAbi,
    eventName: "Announced",
    fromBlock,
    args: { id: BigInt(record.id) },
  });
  if (logs.length === 0) throw new Error(`sync: deposit ${record.id} has no announcement`);

  const { pointIndexes, denoms, blindSigs } = (
    logs[0] as unknown as {
      args: { pointIndexes: bigint[]; denoms: bigint[]; blindSigs: Hex[] };
    }
  ).args;

  pointIndexes.forEach((pointIndex, i) => {
    const note = record.notes.find((n) => n.pointIndex === Number(pointIndex));
    if (!note) throw new Error(`sync: the deposit holds no point ${pointIndex}`);
    const denom = denoms[i];
    const key = keys.find((k) => k.denom === denom);
    if (!key) throw new Error(`sync: there is no key for ${denom}`);

    const sig = unblind(fromHex(blindSigs[i], "bytes"), fromHex(note.r, "bytes"));
    if (!verify(key.pk, note.address, sig, domain)) {
      throw new Error(`sync: the signature for ${note.address} does not verify`);
    }
    note.denom = denom.toString();
    note.sig = toHex(sig) as Hex;
    note.status = "ready";
    console.log(`point ${pointIndex} -> ${note.address} ${usdc(denom)}`);
  });
  save(state);
  console.log(`${pointIndexes.length} notes are ready to claim`);
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
 * Claim through the relayer.
 *
 * `claim` sends the transaction from the deployer. That account also made the deposit.
 * The deposit and the note therefore share one transaction history. Blinding then buys
 * nothing. The relayer is the third party that breaks that link. It pays the gas. It
 * holds no note after it answers.
 *
 * The notes go one at a time. The relayer must not see the notes of one deposit as a
 * group, because that group is the link that blinding removes.
 */
export async function relay(id?: string): Promise<void> {
  const { account, publicClient } = await connect();
  const state = load();
  const record = findDeposit(state, id);
  const url = process.env.TEECASH_RELAYER ?? "http://127.0.0.1:8787";

  for (const note of record.notes) {
    if (note.status !== "ready" || note.sig === undefined) continue;

    // The request carries the wallet and the signature only. It names no denomination.
    // The relayer derives that from the key that verifies.
    const response = await fetch(`${url}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: note.address, sig: note.sig }),
    });
    const body = (await response.json()) as { txHash?: string; gasUsed?: number; denom?: string; error?: string };
    if (!response.ok) {
      throw new Error(`relay: ${note.address} was refused with ${response.status}: ${body.error}`);
    }

    // The relayer derived the denomination. If it disagrees with the announcement, the
    // client and the relayer read different keys.
    if (note.denom !== undefined && body.denom !== note.denom) {
      throw new Error(`relay: the relayer paid ${body.denom} and the announcement said ${note.denom}`);
    }
    note.status = "claimed";
    const balance = await publicClient.getBalance({ address: note.address });
    console.log(`${note.address} holds ${usdc(balance)} (relayer gas ${body.gasUsed})`);
  }
  save(state);
  console.log(`the relayer paid for every claim. No note came from ${account.address}`);
}

/**
 * Spend from a funded wallet.
 *
 * Arc makes this step possible. The note is the gas token. The wallet therefore pays its
 * own transaction and it needs no extra funding.
 */
export async function spend(id?: string): Promise<void> {
  const { account, chain, publicClient } = await connect();
  const state = load();
  const record = findDeposit(state, id);

  // The payment goes to the deployer. Testnet funds are limited, and the point of this
  // step is the sender, not the recipient.
  const target = (process.env.TEECASH_SPEND_TO ?? account.address) as Address;

  // Spend the largest note. It covers its own fee most easily.
  const claimed = record.notes.filter((n) => n.status === "claimed" && n.denom !== undefined);
  claimed.sort((a, b) => (BigInt(b.denom as string) > BigInt(a.denom as string) ? 1 : -1));
  const note = claimed[0];
  if (!note) throw new Error("spend: no wallet holds a note");

  // The signer comes from whichever provider made this wallet.
  const signer = await providerOf(note).account(note);
  const wallet = createWalletClient({ account: signer, chain, transport: http() });

  const before = await publicClient.getBalance({ address: note.address });

  // Set the fee fields. The suggestion of the node carries a priority fee that a local
  // node does not need.
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

/**
 * Check that Privy can serve as the wallet provider.
 *
 * The check makes one wallet, signs a transaction for the target chain and recovers the
 * signer from the signature. It broadcasts nothing.
 *
 * The chain identifier defaults to Arc testnet. `signTransaction` carries no CAIP-2
 * network, so a successful signature shows that Privy does not gate the chain.
 */
export async function privyCheck(): Promise<void> {
  const chainId = Number(process.env.TEECASH_CHECK_CHAIN_ID ?? "5042002");
  const provider = walletProvider();
  if (provider.name !== "privy") {
    console.log("set TEECASH_WALLETS=privy to run this check");
    return;
  }

  const [wallet] = await provider.create(1);
  console.log(`wallet   ${wallet.address}`);
  console.log(`id       ${wallet.ref}`);

  const account = await provider.account(wallet);
  const signed = await account.signTransaction({
    to: wallet.address,
    value: 1n,
    nonce: 0,
    gas: 21_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 0n,
    chainId,
    type: "eip1559",
  });
  const signer = await recoverTransactionAddress({
    serializedTransaction: signed as `0x02${string}`,
  });

  console.log(`chain    ${chainId}`);
  console.log(`signer   ${signer}`);
  if (signer.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("privy: the signature does not recover to the wallet address");
  }
  console.log(`Privy signed for chain ${chainId} and the signature recovers correctly`);
}

/**
 * Return the value of every claimed note to the deployer.
 *
 * Testnet funds are limited. A sweep makes a second run cheap.
 *
 * Each wallet keeps one base unit. Arc reverts a transfer that leaves an account with a
 * zero balance, a zero nonce and no code.
 */
export async function sweep(id?: string): Promise<void> {
  const { account, chain, publicClient } = await connect();
  const state = load();
  const record = findDeposit(state, id);

  const block = await publicClient.getBlock();
  const priority = BigInt(process.env.TEECASH_PRIORITY_FEE ?? "0");
  const maxFee = (block.baseFeePerGas ?? 0n) + priority;
  const fee = maxFee * 21_000n;

  let total = 0n;
  for (const note of record.notes) {
    const balance = await publicClient.getBalance({ address: note.address });
    const value = balance - fee - 1n;
    if (value <= 0n) continue;

    const wallet = createWalletClient({
      account: await providerOf(note).account(note),
      chain,
      transport: http(),
    });
    const hash = await wallet.sendTransaction({
      to: account.address,
      value,
      gas: 21_000n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priority,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    total += value;
    console.log(`${note.address} returned ${usdc(value)}`);
  }
  console.log(`${usdc(total)} returned to ${account.address}`);
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
