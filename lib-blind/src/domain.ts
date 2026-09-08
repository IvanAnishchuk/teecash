/**
 * Domain separation tag for hash-to-curve.
 *
 * The tag contains the chain ID and the contract address. Hash-to-curve maps one address
 * to a different point for each tag. A signature made for one deployment fails the
 * pairing check at every other deployment.
 */

export interface Domain {
  chainId: number;
  contract: string; // 20-byte hex address with an "0x" prefix
}

const SUITE = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_";

/** Build the RFC 9380 domain separation tag for one deployment. */
export function dst(d: Domain): Uint8Array {
  const addr = d.contract.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error(`domain: bad contract address ${d.contract}`);
  if (!Number.isSafeInteger(d.chainId) || d.chainId <= 0) throw new Error(`domain: bad chainId ${d.chainId}`);
  const tag = `TEECASH_V1_${d.chainId}_${addr}_${SUITE}`;
  const bytes = new TextEncoder().encode(tag);
  if (bytes.length > 255) throw new Error("domain: tag is longer than 255 bytes");
  return bytes;
}
