/**
 * The state file.
 *
 * The CLI keeps the deployment addresses, the mint keys and the notes in one JSON file
 * under `.tmp`. A note holds its blinding factor until the claim removes it.
 *
 * This file holds secrets. It is for a local run and a testnet demo only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "./chain.ts";

const statePath = fileURLToPath(new URL("../../.tmp/cli-state.json", import.meta.url));

export type NoteStatus = "awaiting-mint" | "ready" | "claimed";

export interface Note {
  address: Address;
  privateKey: Hex;
  /** The blinding factor, 32 bytes of hex. */
  r: Hex;
  blinded: Hex;
  pointIndex: number;
  status: NoteStatus;
  /** The mint sets these two when it signs the point. */
  denom?: string;
  sig?: Hex;
}

export interface DepositRecord {
  id: string;
  amount: string;
  notes: Note[];
}

export interface State {
  chainId?: number;
  blindMint?: Address;
  consumer?: Address;
  /** The ladder, as decimal base units mapped to a secret scalar. */
  mintKeys: Record<string, Hex>;
  deposits: DepositRecord[];
}

const empty: State = { mintKeys: {}, deposits: [] };

export function load(): State {
  if (!existsSync(statePath)) return structuredClone(empty);
  return JSON.parse(readFileSync(statePath, "utf8")) as State;
}

export function save(state: State): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function reset(): void {
  save(structuredClone(empty));
}

/** Find one deposit by its identifier. The last deposit is the default. */
export function findDeposit(state: State, id?: string): DepositRecord {
  if (state.deposits.length === 0) throw new Error("state: there are no deposits");
  if (id === undefined) return state.deposits[state.deposits.length - 1];
  const found = state.deposits.find((d) => d.id === id);
  if (!found) throw new Error(`state: there is no deposit ${id}`);
  return found;
}

export { statePath };
