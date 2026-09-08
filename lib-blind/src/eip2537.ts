/**
 * EIP-2537 point encodings.
 *
 * Each Fp coordinate uses one 64-byte big-endian word. The encoder writes 16 zero bytes
 * in front of the 48-byte value. A G1 point holds (x, y) in 128 bytes. A G2 point holds
 * (x.c0, x.c1, y.c0, y.c1) in 256 bytes. The point at infinity is all zero bytes.
 */

import { bls12_381 as bls } from "@noble/curves/bls12-381.js";

export const G1_BYTES = 128;
export const G2_BYTES = 256;

const FP_BYTES = 64;
const FP_PAD = 16; // 64 - 48

type G1Point = InstanceType<typeof bls.G1.Point>;
type G2Point = InstanceType<typeof bls.G2.Point>;

function fpToBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(FP_BYTES);
  for (let i = FP_BYTES - 1; i >= FP_PAD; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("eip2537: field element exceeds 48 bytes");
  return out;
}

function fpFromBytes(b: Uint8Array, offset: number): bigint {
  for (let i = 0; i < FP_PAD; i++) {
    if (b[offset + i] !== 0) throw new Error("eip2537: non-zero padding in field element");
  }
  let v = 0n;
  for (let i = offset + FP_PAD; i < offset + FP_BYTES; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}

/** Encode a G1 point as 128 bytes. */
export function g1ToBytes(p: G1Point): Uint8Array {
  const out = new Uint8Array(G1_BYTES);
  if (p.is0()) return out;
  const { x, y } = p.toAffine();
  out.set(fpToBytes(x), 0);
  out.set(fpToBytes(y), FP_BYTES);
  return out;
}

/** Encode a G2 point as 256 bytes. Each Fp2 coordinate writes c0 before c1. */
export function g2ToBytes(p: G2Point): Uint8Array {
  const out = new Uint8Array(G2_BYTES);
  if (p.is0()) return out;
  const { x, y } = p.toAffine();
  out.set(fpToBytes(x.c0), 0);
  out.set(fpToBytes(x.c1), FP_BYTES);
  out.set(fpToBytes(y.c0), FP_BYTES * 2);
  out.set(fpToBytes(y.c1), FP_BYTES * 3);
  return out;
}

export function g1FromBytes(b: Uint8Array): G1Point {
  if (b.length !== G1_BYTES) throw new Error(`eip2537: G1 needs ${G1_BYTES} bytes, got ${b.length}`);
  if (b.every((v) => v === 0)) return bls.G1.Point.ZERO;
  const p = bls.G1.Point.fromAffine({ x: fpFromBytes(b, 0), y: fpFromBytes(b, FP_BYTES) });
  p.assertValidity();
  return p;
}

export function g2FromBytes(b: Uint8Array): G2Point {
  if (b.length !== G2_BYTES) throw new Error(`eip2537: G2 needs ${G2_BYTES} bytes, got ${b.length}`);
  if (b.every((v) => v === 0)) return bls.G2.Point.ZERO;
  const Fp2 = bls.fields.Fp2;
  const p = bls.G2.Point.fromAffine({
    x: Fp2.create({ c0: fpFromBytes(b, 0), c1: fpFromBytes(b, FP_BYTES) }),
    y: Fp2.create({ c0: fpFromBytes(b, FP_BYTES * 2), c1: fpFromBytes(b, FP_BYTES * 3) }),
  });
  p.assertValidity();
  return p;
}

export function toHex(b: Uint8Array): string {
  return `0x${Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function fromHex(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  if (h.length % 2 !== 0) throw new Error("fromHex: odd length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
