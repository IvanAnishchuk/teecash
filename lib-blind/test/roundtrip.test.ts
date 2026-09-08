import { describe, expect, it } from "vitest";
import {
  type Domain,
  G1_BYTES,
  G2_BYTES,
  blind,
  blindSign,
  g2FromBytes,
  g2ToBytes,
  hashToG2,
  mintKey,
  unblind,
  verify,
} from "../src/index.ts";

const DOMAIN: Domain = { chainId: 5042002, contract: "0x00000000000000000000000000000000000000c0" };
const OTHER_DOMAIN: Domain = { chainId: 1, contract: "0x00000000000000000000000000000000000000c0" };

const A = "0x1111111111111111111111111111111111111111";
const B_ADDR = "0x2222222222222222222222222222222222222222";

const SK_1 = 0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2an;
const SK_10 = 0x3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3bn;
const R = 0x4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4cn;

const USDC = 1_000_000n;
const key1 = mintKey(1n * USDC, SK_1);
const key10 = mintKey(10n * USDC, SK_10);

describe("blind signature round trip", () => {
  it("accepts a signature that went through blind, sign and unblind", () => {
    const { blinded, r } = blind(A, DOMAIN, R);
    expect(blinded.length).toBe(G2_BYTES);
    expect(key1.pk.length).toBe(G1_BYTES);

    const sig = unblind(blindSign(key1, blinded), r);
    expect(verify(key1.pk, A, sig, DOMAIN)).toBe(true);
  });

  it("gives the same signature as a direct sign of the address", () => {
    const { blinded, r } = blind(A, DOMAIN, R);
    const viaBlind = unblind(blindSign(key1, blinded), r);
    const direct = g2ToBytes(hashToG2(A, DOMAIN).multiply(SK_1));
    expect(viaBlind).toEqual(direct);
  });

  it("works for a fresh random blinding factor", () => {
    for (let i = 0; i < 8; i++) {
      const { blinded, r } = blind(A, DOMAIN);
      expect(verify(key1.pk, A, unblind(blindSign(key1, blinded), r), DOMAIN)).toBe(true);
    }
  });

  it("hides the address from the mint", () => {
    const b1 = blind(A, DOMAIN).blinded;
    const b2 = blind(A, DOMAIN).blinded;
    expect(b1).not.toEqual(b2);
  });
});

describe("rejection", () => {
  const { blinded, r } = blind(A, DOMAIN, R);
  const sig = unblind(blindSign(key1, blinded), r);

  it("rejects the signature for a different address", () => {
    expect(verify(key1.pk, B_ADDR, sig, DOMAIN)).toBe(false);
  });

  it("rejects the signature under the key of another denomination", () => {
    expect(verify(key10.pk, A, sig, DOMAIN)).toBe(false);
  });

  it("rejects the signature under another domain", () => {
    expect(verify(key1.pk, A, sig, OTHER_DOMAIN)).toBe(false);
  });

  it("rejects a signature that keeps the blinding factor", () => {
    expect(verify(key1.pk, A, blindSign(key1, blinded), DOMAIN)).toBe(false);
  });

  it("rejects the point at infinity", () => {
    expect(verify(key1.pk, A, new Uint8Array(G2_BYTES), DOMAIN)).toBe(false);
  });

  it("rejects a signature with one flipped byte", () => {
    const bad = Uint8Array.from(sig);
    bad[200] ^= 0x01;
    expect(verify(key1.pk, A, bad, DOMAIN)).toBe(false);
  });
});

describe("eip-2537 encoding", () => {
  it("survives a decode and encode cycle", () => {
    const p = hashToG2(A, DOMAIN);
    expect(g2ToBytes(g2FromBytes(g2ToBytes(p)))).toEqual(g2ToBytes(p));
  });

  it("pads each field element to 64 bytes", () => {
    const bytes = g2ToBytes(hashToG2(A, DOMAIN));
    for (const start of [0, 64, 128, 192]) {
      expect(Array.from(bytes.slice(start, start + 16))).toEqual(new Array(16).fill(0));
    }
  });
});
