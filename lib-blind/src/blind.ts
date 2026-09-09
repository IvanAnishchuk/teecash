/**
 * Client side of the blind signature.
 *
 * The client blinds a wallet address. The client sends the blinded point to the mint.
 * The client unblinds the reply. The mint does not see the address.
 */

import { bls12_381 as bls } from "@noble/curves/bls12-381.js";
import type { Domain } from "./domain.ts";
import { dst } from "./domain.ts";
import { G2_BYTES, fromHex, g2FromBytes, g2ToBytes } from "./eip2537.ts";

const Fr = bls.fields.Fr;
const SCALAR_BYTES = 32;

export interface Blinded {
  /** The blinded point B = r*Y in 256 bytes. Send this point to the mint. */
  blinded: Uint8Array;
  /** The blinding factor r in 32 big-endian bytes. Keep this value secret. */
  r: Uint8Array;
}

function scalarToBytes(s: bigint): Uint8Array {
  const out = new Uint8Array(SCALAR_BYTES);
  for (let i = SCALAR_BYTES - 1; i >= 0; i--) {
    out[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  if (s !== 0n) throw new Error("blind: scalar exceeds 32 bytes");
  return out;
}

function scalarFromBytes(b: Uint8Array): bigint {
  if (b.length !== SCALAR_BYTES) throw new Error(`blind: scalar needs ${SCALAR_BYTES} bytes, got ${b.length}`);
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  if (v === 0n || v >= Fr.ORDER) throw new Error("blind: scalar is outside the range 1 to order-1");
  return v;
}

function addressBytes(address: string): Uint8Array {
  const a = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`blind: bad address ${address}`);
  return fromHex(a);
}

/** Make a uniform random scalar in the range 1 to order-1. */
export function randomScalar(): bigint {
  for (;;) {
    const buf = crypto.getRandomValues(new Uint8Array(48));
    let v = 0n;
    for (const byte of buf) v = (v << 8n) | BigInt(byte);
    v %= Fr.ORDER;
    if (v !== 0n) return v;
  }
}

/**
 * Map an address to a G2 point.
 *
 * The contract runs the same map at claim time. Both sides must give the same point.
 */
export function hashToG2(address: string, domain: Domain): InstanceType<typeof bls.G2.Point> {
  const p = bls.G2.hashToCurve(addressBytes(address), { DST: dst(domain) });
  return p as InstanceType<typeof bls.G2.Point>;
}

/**
 * Blind an address.
 *
 * Pass `fixedR` only in tests and in vector generation. Production code does not pass
 * `fixedR`. The function then makes a fresh random scalar.
 */
export function blind(address: string, domain: Domain, fixedR?: bigint): Blinded {
  const r = fixedR ?? randomScalar();
  if (r <= 0n || r >= Fr.ORDER) throw new Error("blind: r is outside the range 1 to order-1");
  const Y = hashToG2(address, domain);
  return { blinded: g2ToBytes(Y.multiply(r)), r: scalarToBytes(r) };
}

/**
 * Remove the blinding factor from a mint signature.
 *
 * The result is a plain BLS signature over the address. The result does not depend on the
 * denomination. The caller can therefore unblind the signature before it reads the
 * announce event.
 */
export function unblind(blindSig: Uint8Array, r: Uint8Array): Uint8Array {
  if (blindSig.length !== G2_BYTES) throw new Error(`unblind: signature needs ${G2_BYTES} bytes`);
  const rInv = Fr.inv(scalarFromBytes(r));
  return g2ToBytes(g2FromBytes(blindSig).multiply(rInv));
}
