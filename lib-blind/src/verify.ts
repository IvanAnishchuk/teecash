/**
 * This module checks a mint signature.
 *
 * The contract makes the same check in Solidity. The contract uses the EIP-2537 pairing
 * precompile. Both implementations must give the same result for every test vector.
 */

import { bls12_381 as bls } from "@noble/curves/bls12-381.js";
import { hashToG2 } from "./blind.ts";
import type { Domain } from "./domain.ts";
import { G1_BYTES, G2_BYTES, g1FromBytes, g2FromBytes } from "./eip2537.ts";

/**
 * Check the mint signature `sig` for the address `address`. The check uses the public
 * key `pubkey`.
 *
 * The condition is e(pk, H(address)) == e(G1, sig). The code computes the same condition
 * as one batch: e(-pk, H(address)) * e(G1, sig) == 1.
 */
export function verify(pubkey: Uint8Array, address: string, sig: Uint8Array, domain: Domain): boolean {
  if (pubkey.length !== G1_BYTES) throw new Error(`verify: public key needs ${G1_BYTES} bytes`);
  if (sig.length !== G2_BYTES) throw new Error(`verify: signature needs ${G2_BYTES} bytes`);

  let pk: ReturnType<typeof g1FromBytes>;
  let S: ReturnType<typeof g2FromBytes>;
  try {
    pk = g1FromBytes(pubkey);
    S = g2FromBytes(sig);
  } catch {
    return false;
  }
  if (pk.is0() || S.is0()) return false;

  const Y = hashToG2(address, domain);
  const res = bls.pairingBatch([
    { g1: pk.negate(), g2: Y },
    { g1: bls.G1.Point.BASE, g2: S },
  ]);
  return bls.fields.Fp12.eql(res, bls.fields.Fp12.ONE);
}
