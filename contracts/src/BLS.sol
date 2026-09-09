// SPDX-License-Identifier: CC0-1.0 OR Apache-2.0 OR WTFPL
pragma solidity ^0.8.28;

/**
 * @title BLS
 * @notice This library checks signatures on BLS12-381. It uses the EIP-2537 precompiles.
 * @dev Public keys are in G1. Signatures are in G2. Points use the EIP-2537 layout. Each
 *      coordinate takes one 64-byte word with 16 leading zero bytes. A G1 point takes 128
 *      bytes. A G2 point takes 256 bytes and puts c0 before c1.
 *
 *      `lib-blind` holds the TypeScript version of this code. Both must accept the values
 *      in `vectors.json`.
 */
library BLS {
    address internal constant MODEXP = address(0x05);
    address internal constant G2ADD = address(0x0d);
    address internal constant PAIRING = address(0x0f);
    address internal constant MAP_FP2_TO_G2 = address(0x11);

    uint256 internal constant G1_BYTES = 128;
    uint256 internal constant G2_BYTES = 256;

    /// @dev The base field modulus p, 48 bytes.
    bytes internal constant P =
        hex"1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";

    /// @dev The G1 generator with a negated y coordinate. The second pair uses this point.
    bytes internal constant NEG_G1 = hex"00000000000000000000000000000000"
        hex"17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb"
        hex"00000000000000000000000000000000"
        hex"114d1d6855d545a8aa7d76c8cf2e21f267816aef1db507c96655b9d5caac42364e6f38ba0ecb751bad54dcd6b939c2ca";

    error PrecompileFailed(address which);
    error BadLength(uint256 got, uint256 want);
    error DstTooLong(uint256 length);

    /**
     * @notice Check a mint signature for one address.
     * @param pubkey The mint public key in G1, 128 bytes.
     * @param addr The wallet address that the note pays.
     * @param sig The unblinded signature in G2, 256 bytes.
     * @param dst The domain separation tag.
     * @return True when the signature is valid.
     */
    function verify(bytes memory pubkey, address addr, bytes memory sig, bytes memory dst)
        internal
        view
        returns (bool)
    {
        if (pubkey.length != G1_BYTES) revert BadLength(pubkey.length, G1_BYTES);
        if (sig.length != G2_BYTES) revert BadLength(sig.length, G2_BYTES);

        bytes memory y = hashToG2(abi.encodePacked(addr), dst);
        // e(pk, Y) * e(-G1, S) == 1 holds exactly when e(pk, Y) == e(G1, S).
        return pairingCheck(abi.encodePacked(pubkey, y, NEG_G1, sig));
    }

    /// @notice Run the pairing precompile. The input holds (G1, G2) pairs of 384 bytes.
    function pairingCheck(bytes memory pairs) internal view returns (bool) {
        if (pairs.length == 0 || pairs.length % 384 != 0) revert BadLength(pairs.length, 384);
        (bool ok, bytes memory out) = PAIRING.staticcall(pairs);
        if (!ok || out.length != 32) revert PrecompileFailed(PAIRING);
        return abi.decode(out, (uint256)) == 1;
    }

    /**
     * @notice Map a message to a G2 point with RFC 9380 hash-to-curve.
     * @dev The steps are:
     *      1. Expand the message to 256 uniform bytes.
     *      2. Read two Fp2 elements from those bytes.
     *      3. Map each element with MAP_FP2_TO_G2.
     *      4. Add the two points.
     *
     *      The precompile clears the cofactor for each point. Cofactor clearing is a
     *      scalar multiplication. Scalar multiplication distributes over addition. The
     *      order of the two steps therefore does not change the result.
     */
    function hashToG2(bytes memory message, bytes memory dst) internal view returns (bytes memory) {
        bytes memory uniform = expandMessageXmd(message, dst);

        bytes memory q0 = mapToG2(fp2FromUniform(uniform, 0));
        bytes memory q1 = mapToG2(fp2FromUniform(uniform, 128));

        (bool ok, bytes memory out) = G2ADD.staticcall(abi.encodePacked(q0, q1));
        if (!ok || out.length != G2_BYTES) revert PrecompileFailed(G2ADD);
        return out;
    }

    /// @dev Build one 128-byte Fp2 input from 128 bytes of the uniform string.
    function fp2FromUniform(bytes memory uniform, uint256 offset) private view returns (bytes memory) {
        return abi.encodePacked(modP(slice64(uniform, offset)), modP(slice64(uniform, offset + 64)));
    }

    /// @dev Call MAP_FP2_TO_G2 on a 128-byte Fp2 element.
    function mapToG2(bytes memory fp2) private view returns (bytes memory) {
        (bool ok, bytes memory out) = MAP_FP2_TO_G2.staticcall(fp2);
        if (!ok || out.length != G2_BYTES) revert PrecompileFailed(MAP_FP2_TO_G2);
        return out;
    }

    /// @dev Reduce a 64-byte big-endian value modulo p. The result is padded to 64 bytes.
    function modP(bytes memory value) private view returns (bytes memory) {
        bytes memory input = abi.encodePacked(uint256(64), uint256(1), uint256(48), value, hex"01", P);
        (bool ok, bytes memory out) = MODEXP.staticcall(input);
        if (!ok || out.length != 48) revert PrecompileFailed(MODEXP);
        return abi.encodePacked(bytes16(0), out);
    }

    function slice64(bytes memory src, uint256 offset) private pure returns (bytes memory out) {
        out = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            out[i] = src[offset + i];
        }
    }

    /**
     * @notice Expand a message to 256 uniform bytes, per RFC 9380 expand_message_xmd.
     * @dev The hash is SHA-256. b_in_bytes is 32 and s_in_bytes is 64. The output needs
     *      8 blocks.
     */
    function expandMessageXmd(bytes memory message, bytes memory dst) internal pure returns (bytes memory) {
        if (dst.length > 255) revert DstTooLong(dst.length);
        bytes memory dstPrime = abi.encodePacked(dst, uint8(dst.length));

        // Z_pad is one input block of zeroes. l_i_b_str is the output length in two bytes.
        bytes32 b0 = sha256(abi.encodePacked(new bytes(64), message, uint16(256), uint8(0), dstPrime));

        bytes32[8] memory b;
        b[0] = sha256(abi.encodePacked(b0, uint8(1), dstPrime));
        for (uint8 i = 1; i < 8; i++) {
            b[i] = sha256(abi.encodePacked(b0 ^ b[i - 1], i + 1, dstPrime));
        }
        return abi.encodePacked(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]);
    }
}
