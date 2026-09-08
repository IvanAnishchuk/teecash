import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Domain, blind, blindSign, dst, fromHex, mintKey, toHex, unblind, verify } from "../src/index.ts";

interface Vectors {
  domain: { chainId: number; contract: string; dst: string };
  keys: { denom: string; sk: string; pk: string }[];
  notes: { address: string; denom: string; keyIndex: number; r: string; blinded: string; blindSig: string; sig: string }[];
}

const v: Vectors = JSON.parse(readFileSync(new URL("../vectors.json", import.meta.url), "utf8"));
const domain: Domain = { chainId: v.domain.chainId, contract: v.domain.contract };

describe("vectors.json", () => {
  it("reproduces the domain separation tag", () => {
    expect(toHex(dst(domain))).toBe(v.domain.dst);
  });

  it("reproduces every mint public key", () => {
    for (const k of v.keys) {
      expect(toHex(mintKey(BigInt(k.denom), BigInt(k.sk)).pk)).toBe(k.pk);
    }
  });

  it.each(v.notes.map((n, i) => [i, n.address] as const))("reproduces note %i (%s)", (i) => {
    const n = v.notes[i];
    const key = mintKey(BigInt(v.keys[n.keyIndex].denom), BigInt(v.keys[n.keyIndex].sk));

    const { blinded, r } = blind(n.address, domain, BigInt(n.r));
    expect(toHex(blinded)).toBe(n.blinded);
    expect(toHex(r)).toBe(n.r);

    const blindSig = blindSign(key, blinded);
    expect(toHex(blindSig)).toBe(n.blindSig);

    const sig = unblind(blindSig, r);
    expect(toHex(sig)).toBe(n.sig);
    expect(verify(key.pk, n.address, sig, domain)).toBe(true);
  });

  it("verifies every stored signature straight from the file", () => {
    for (const n of v.notes) {
      expect(verify(fromHex(v.keys[n.keyIndex].pk), n.address, fromHex(n.sig), domain)).toBe(true);
    }
  });
});
