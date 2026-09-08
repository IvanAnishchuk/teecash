/**
 * Mint side of the blind signature.
 *
 * The enclave runs these functions. Each denomination has one key. The key selects the
 * denomination of the note. The mint sees the blinded point. The mint does not see the
 * address.
 */

import { bls12_381 as bls } from "@noble/curves/bls12-381.js";
import { G1_BYTES, G2_BYTES, g1ToBytes, g2FromBytes, g2ToBytes } from "./eip2537.ts";

const Fr = bls.fields.Fr;

export interface MintKey {
  denom: bigint;
  /** This is the secret scalar. The value stays in the enclave. */
  sk: bigint;
  /** This is the public key in G1. The length is 128 bytes. The contract stores it. */
  pk: Uint8Array;
}

/** Make a mint key for one denomination. The caller supplies the secret scalar. */
export function mintKey(denom: bigint, sk: bigint): MintKey {
  if (sk <= 0n || sk >= Fr.ORDER) throw new Error("mint: sk is outside the range 1 to order-1");
  if (denom <= 0n) throw new Error("mint: denom must be more than zero");
  const pk = g1ToBytes(bls.G1.Point.BASE.multiply(sk));
  if (pk.length !== G1_BYTES) throw new Error("mint: bad public key length");
  return { denom, sk, pk };
}

/**
 * Sign one blinded point.
 *
 * The result is S' = sk*B. The client removes its blinding factor from S'. The client
 * then has the note signature.
 */
export function blindSign(key: MintKey, blinded: Uint8Array): Uint8Array {
  if (blinded.length !== G2_BYTES) throw new Error(`mint: blinded point needs ${G2_BYTES} bytes`);
  const B = g2FromBytes(blinded);
  if (B.is0()) throw new Error("mint: blinded point is the point at infinity");
  return g2ToBytes(B.multiply(key.sk));
}
