// SPDX-License-Identifier: CC0-1.0 OR Apache-2.0 OR WTFPL
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BLS} from "../src/BLS.sol";

/**
 * @notice These tests read the vectors that `lib-blind` generates.
 * @dev A failure here means that the Solidity code and the TypeScript code disagree.
 *      Regenerate the file with `npm run vectors` after every change to the crypto code.
 */
/// @notice An external wrapper. `vm.expectRevert` needs a call at a lower depth.
contract BLSHarness {
    function verify(bytes memory pubkey, address addr, bytes memory sig, bytes memory dst)
        external
        view
        returns (bool)
    {
        return BLS.verify(pubkey, addr, sig, dst);
    }
}

contract BLSTest is Test {
    string internal json;
    bytes internal dst;
    uint256 internal noteCount;
    BLSHarness internal harness;

    function setUp() public {
        harness = new BLSHarness();
        json = vm.readFile("../lib-blind/vectors.json");
        dst = vm.parseJsonBytes(json, ".domain.dst");
        noteCount = vm.parseJsonUint(json, ".counts.notes");
        assertGt(noteCount, 0, "vectors hold no notes");
    }

    function _note(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".notes[", vm.toString(i), "].", field);
    }

    function test_hashToG2_matchesVectors() public view {
        for (uint256 i = 0; i < noteCount; i++) {
            address addr = vm.parseJsonAddress(json, _note(i, "address"));
            bytes memory want = vm.parseJsonBytes(json, _note(i, "hashToG2"));
            bytes memory got = BLS.hashToG2(abi.encodePacked(addr), dst);
            assertEq(got, want, "hashToG2 disagrees with lib-blind");
        }
    }

    function test_verify_acceptsEveryVector() public view {
        for (uint256 i = 0; i < noteCount; i++) {
            address addr = vm.parseJsonAddress(json, _note(i, "address"));
            uint256 keyIndex = vm.parseJsonUint(json, _note(i, "keyIndex"));
            bytes memory pk = vm.parseJsonBytes(json, string.concat(".keys[", vm.toString(keyIndex), "].pk"));
            bytes memory sig = vm.parseJsonBytes(json, _note(i, "sig"));
            assertTrue(BLS.verify(pk, addr, sig, dst), "the check rejected a valid signature");
        }
    }

    function test_verify_rejectsAnotherAddress() public view {
        bytes memory pk = vm.parseJsonBytes(json, ".keys[0].pk");
        bytes memory sig = vm.parseJsonBytes(json, _note(0, "sig"));
        assertFalse(BLS.verify(pk, address(0xdead), sig, dst));
    }

    function test_verify_rejectsAnotherDenominationKey() public view {
        bytes memory pk = vm.parseJsonBytes(json, ".keys[1].pk");
        address addr = vm.parseJsonAddress(json, _note(0, "address"));
        bytes memory sig = vm.parseJsonBytes(json, _note(0, "sig"));
        assertFalse(BLS.verify(pk, addr, sig, dst));
    }

    function test_verify_rejectsAnotherDomain() public view {
        bytes memory pk = vm.parseJsonBytes(json, ".keys[0].pk");
        address addr = vm.parseJsonAddress(json, _note(0, "address"));
        bytes memory sig = vm.parseJsonBytes(json, _note(0, "sig"));
        assertFalse(BLS.verify(pk, addr, sig, "TEECASH_V1_1_other_deployment_"));
    }

    function test_verify_rejectsTheBlindedSignature() public view {
        bytes memory pk = vm.parseJsonBytes(json, ".keys[0].pk");
        address addr = vm.parseJsonAddress(json, _note(0, "address"));
        bytes memory blindSig = vm.parseJsonBytes(json, _note(0, "blindSig"));
        assertFalse(BLS.verify(pk, addr, blindSig, dst));
    }

    /**
     * @notice A flipped byte gives a point that is not on the curve.
     * @dev The pairing precompile rejects such a point with a revert. It does not return
     *      zero. A claim with a damaged signature therefore reverts.
     */
    function test_verify_revertsOnOneFlippedByte() public {
        bytes memory pk = vm.parseJsonBytes(json, ".keys[0].pk");
        address addr = vm.parseJsonAddress(json, _note(0, "address"));
        bytes memory sig = vm.parseJsonBytes(json, _note(0, "sig"));
        sig[200] = bytes1(uint8(sig[200]) ^ 0x01);
        vm.expectRevert(abi.encodeWithSelector(BLS.PrecompileFailed.selector, address(0x0f)));
        harness.verify(pk, addr, sig, dst);
    }

    function test_verify_revertsOnBadPubkeyLength() public {
        bytes memory sig = vm.parseJsonBytes(json, _note(0, "sig"));
        vm.expectRevert(abi.encodeWithSelector(BLS.BadLength.selector, 3, BLS.G1_BYTES));
        harness.verify(hex"010203", address(1), sig, dst);
    }

    function test_verify_revertsOnBadSignatureLength() public {
        bytes memory pk = vm.parseJsonBytes(json, ".keys[0].pk");
        vm.expectRevert(abi.encodeWithSelector(BLS.BadLength.selector, 3, BLS.G2_BYTES));
        harness.verify(pk, address(1), hex"010203", dst);
    }

    /// @notice Measure one verify call on its own. A claim pays this gas.
    function test_gas_verify() public {
        bytes memory pk = vm.parseJsonBytes(json, ".keys[0].pk");
        address addr = vm.parseJsonAddress(json, _note(0, "address"));
        bytes memory sig = vm.parseJsonBytes(json, _note(0, "sig"));
        uint256 before = gasleft();
        bool ok = harness.verify(pk, addr, sig, dst);
        emit log_named_uint("verify gas", before - gasleft());
        assertTrue(ok);
    }
}
