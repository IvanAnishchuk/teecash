/**
 * The note records and the deposit records.
 *
 * These records hold the link between a deposit and the notes it produced. That link is
 * the thing blinding removes, so the records never reach a server. They live in IndexedDB
 * in the browser of the user, under the Privy user identifier.
 *
 * A record has two secrets. Each one has its own lifetime.
 *
 * `r` is the blinding factor. The client needs it to unblind the signature of the mint.
 * `unblinded` removes it at that moment.
 *
 * `sig` is the unblinded signature. It is a bearer token. Anybody who holds it can claim
 * the note. `claimed` removes it after the claim confirms.
 *
 * A lost record has two different costs, and the announcement divides them. Before the
 * announcement the deposit is `pending`, and `refundByDepositor` returns the money after
 * the deadline. After the announcement there is no way back. `docs/frontend-spec.md`
 * explains why.
 */

import type { Address, Hex } from "viem";

const DB_NAME = "teecash";
const DB_VERSION = 1;
const NOTES = "notes";
const DEPOSITS = "deposits";

/**
 * The state of one note.
 *
 * `awaiting-mint` the deposit is on chain and the mint has not answered.
 * `ready` the client holds an unblinded signature and the claim has not landed.
 * `claimed` the money is in the wallet of the note.
 * `spent` the wallet is empty. The record stays, because a wallet can receive again.
 */
export type NoteStatus = "awaiting-mint" | "ready" | "claimed" | "spent";

/** The state of one deposit. */
export type DepositStatus = "pending" | "announced" | "claimed" | "refunded";

export interface Note {
  /** The address of the note wallet. The contract keys the claimed set on it. */
  address: Address;
  /** The Privy user that owns the wallet. Every query filters on it. */
  userId: string;
  /** The deposit that made this note. */
  depositId: string;
  /** Privy addresses the wallet by this identifier. */
  walletId: string;
  /** The position of the blinded point in the deposit. `announce` names it. */
  pointIndex: number;
  /** The blinded point, as sent in the deposit. */
  blinded: Hex;
  /** The blinding factor. Absent after the client unblinds. */
  r?: Hex;
  /** The denomination in native base units, as a decimal string. */
  denom?: string;
  /** The unblinded signature. A bearer token. Absent after the claim confirms. */
  sig?: Hex;
  status: NoteStatus;
}

export interface Deposit {
  /**
   * The local name of the deposit.
   *
   * The client makes this name before it sends the transaction, because the contract gives
   * a number only after the transaction confirms. The notes carry this name.
   */
  id: string;
  /**
   * The hash of the deposit transaction. Absent until the wallet signs.
   *
   * The client writes this hash as soon as the wallet returns it. The hash is the only way
   * back to a transaction that is already on the chain, so the wait screen can always find
   * the deposit again. A failed network call therefore delays the client and loses nothing.
   */
  txHash?: string;
  /**
   * The number the contract gave the deposit. Absent until the client reads the receipt.
   *
   * `findAnnouncement` needs this number. The wait screen reads it from the receipt of
   * `txHash`, and it repeats that step until the read succeeds.
   */
  onChainId?: string;
  userId: string;
  /** The amount in native base units, as a decimal string. */
  amount: string;
  /**
   * The block that holds the deposit. Every log search starts here, because Arc prunes.
   * The value is "0" until the transaction confirms.
   */
  block: string;
  status: DepositStatus;
  /** The time of the deposit, in milliseconds. The balance screen shows the age. */
  createdAt: number;
}

/**
 * A bigint does not survive IndexedDB in every browser. A mistake there is silent. Every
 * amount is therefore a decimal string in a record. These two functions convert it.
 */
export const toAmount = (value: bigint): string => value.toString();
export const fromAmount = (value: string): bigint => BigInt(value);

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NOTES)) {
        const notes = db.createObjectStore(NOTES, { keyPath: "address" });
        notes.createIndex("userId", "userId");
        notes.createIndex("depositId", "depositId");
      }
      if (!db.objectStoreNames.contains(DEPOSITS)) {
        const deposits = db.createObjectStore(DEPOSITS, { keyPath: "id" });
        deposits.createIndex("userId", "userId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Run one transaction and return what `body` asks for. */
async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const request = body(tx);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Write many records in one transaction. A partial write leaves an unclaimable note. */
async function writeAll(store: string, records: object[]): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([store], "readwrite");
      const target = tx.objectStore(store);
      for (const record of records) target.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Store one deposit and all of its notes. The transaction writes both or neither. */
export async function putDeposit(deposit: Deposit, notes: Note[]): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DEPOSITS, NOTES], "readwrite");
      tx.objectStore(DEPOSITS).put(deposit);
      const store = tx.objectStore(NOTES);
      for (const note of notes) store.put(note);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Remove one deposit and every note of it.
 *
 * Only a deposit that never reached a wallet is safe to remove. Such a deposit holds no
 * money, because no transaction exists. A deposit with a transaction hash keeps the only
 * copy of the blinding factors, and those factors are the only way to claim the notes.
 */
export async function discardDeposit(deposit: Deposit): Promise<void> {
  if (deposit.txHash !== undefined) {
    throw new Error("notes: this deposit reached the chain and the client must keep it");
  }
  const notes = await notesOfDeposit(deposit.id);
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([DEPOSITS, NOTES], "readwrite");
      tx.objectStore(DEPOSITS).delete(deposit.id);
      const store = tx.objectStore(NOTES);
      for (const note of notes) store.delete(note.address);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function notesOf(userId: string): Promise<Note[]> {
  return run([NOTES], "readonly", (tx) =>
    tx.objectStore(NOTES).index("userId").getAll(userId),
  ) as Promise<Note[]>;
}

export function notesOfDeposit(depositId: string): Promise<Note[]> {
  return run([NOTES], "readonly", (tx) =>
    tx.objectStore(NOTES).index("depositId").getAll(depositId),
  ) as Promise<Note[]>;
}

export function depositsOf(userId: string): Promise<Deposit[]> {
  return run([DEPOSITS], "readonly", (tx) =>
    tx.objectStore(DEPOSITS).index("userId").getAll(userId),
  ) as Promise<Deposit[]>;
}

export async function putNotes(notes: Note[]): Promise<void> {
  await writeAll(NOTES, notes);
}

export async function putDepositOnly(deposit: Deposit): Promise<void> {
  await writeAll(DEPOSITS, [deposit]);
}

/**
 * Record the answer of the mint for one note.
 *
 * This is the moment the client unblinds, so `r` goes. The factor has no further use, and
 * a stolen record that holds it shows more than one that does not.
 */
export function unblinded(note: Note, denom: bigint, sig: Hex): Note {
  const { r: _r, ...rest } = note;
  return { ...rest, denom: toAmount(denom), sig, status: "ready" };
}

/**
 * Record a confirmed claim.
 *
 * The signature goes. The money is in the wallet. The contract refuses a second claim on
 * the same address. A signature that stays is a bearer token with no further use.
 */
export function claimed(note: Note): Note {
  const { sig: _sig, ...rest } = note;
  return { ...rest, status: "claimed" };
}

/** The sum of every note the user can spend. */
export function balanceOf(notes: Note[]): bigint {
  return notes
    .filter((n) => n.status === "claimed")
    .reduce((total, n) => total + (n.denom ? fromAmount(n.denom) : 0n), 0n);
}
