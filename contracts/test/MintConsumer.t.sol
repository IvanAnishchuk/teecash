// SPDX-License-Identifier: CC0-1.0 OR Apache-2.0 OR WTFPL
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BlindMint} from "../src/BlindMint.sol";
import {IReceiver, MintConsumer} from "../src/MintConsumer.sol";

/**
 * @notice These tests run the path from a CRE report to a paid wallet.
 * @dev The report bytes here use the same field order as `workflow/announce` in Go. A
 *      change on one side needs the same change on the other.
 */
contract MintConsumerTest is Test {
    uint256 internal constant CHAIN_ID = 5042002;
    address internal constant DEPLOYED_AT = 0x00000000000000000000000000000000000000C0;
    uint64 internal constant REFUND_DELAY = 1 days;

    BlindMint internal mint;
    MintConsumer internal consumer;
    address internal creForwarder = makeAddr("creForwarder");
    address internal depositor = makeAddr("depositor");
    address internal stranger = makeAddr("stranger");

    string internal json;
    uint256 internal noteCount;
    address[] internal walletOf;
    uint256[] internal denomOf;
    bytes[] internal blindedOf;
    bytes[] internal blindSigOf;
    bytes[] internal sigOf;
    uint256 internal totalValue;

    function setUp() public {
        json = vm.readFile("../lib-blind/vectors.json");
        noteCount = vm.parseJsonUint(json, ".counts.notes");

        uint256 keyCount = vm.parseJsonUint(json, ".counts.keys");
        uint256[] memory denoms = new uint256[](keyCount);
        bytes[] memory pubkeys = new bytes[](keyCount);
        for (uint256 i = 0; i < keyCount; i++) {
            string memory at = string.concat(".keys[", vm.toString(i), "]");
            denoms[i] = vm.parseJsonUint(json, string.concat(at, ".denom"));
            pubkeys[i] = vm.parseJsonBytes(json, string.concat(at, ".pk"));
        }
        for (uint256 i = 0; i < noteCount; i++) {
            string memory at = string.concat(".notes[", vm.toString(i), "]");
            walletOf.push(vm.parseJsonAddress(json, string.concat(at, ".address")));
            denomOf.push(vm.parseJsonUint(json, string.concat(at, ".denom")));
            blindedOf.push(vm.parseJsonBytes(json, string.concat(at, ".blinded")));
            blindSigOf.push(vm.parseJsonBytes(json, string.concat(at, ".blindSig")));
            sigOf.push(vm.parseJsonBytes(json, string.concat(at, ".sig")));
            totalValue += denomOf[i];
        }

        vm.chainId(CHAIN_ID);
        // The consumer is the forwarder of the mint. The test computes its address first.
        address consumerAt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        deployCodeTo("BlindMint.sol:BlindMint", abi.encode(consumerAt, REFUND_DELAY, denoms, pubkeys), DEPLOYED_AT);
        mint = BlindMint(DEPLOYED_AT);
        consumer = new MintConsumer(creForwarder, mint);
        assertEq(address(consumer), mint.forwarder(), "the consumer is not the forwarder");

        vm.deal(depositor, 1000e18);
    }

    function _report(uint256 id) internal view returns (bytes memory) {
        uint256[] memory idx = new uint256[](noteCount);
        uint256[] memory denoms = new uint256[](noteCount);
        bytes[] memory sigs = new bytes[](noteCount);
        for (uint256 i = 0; i < noteCount; i++) {
            idx[i] = i;
            denoms[i] = denomOf[i];
            sigs[i] = blindSigOf[i];
        }
        return abi.encode(id, idx, denoms, sigs);
    }

    function _deposit() internal returns (uint256 id) {
        bytes[] memory points = new bytes[](noteCount + 2);
        for (uint256 i = 0; i < noteCount; i++) {
            points[i] = blindedOf[i];
        }
        points[noteCount] = blindedOf[0];
        points[noteCount + 1] = blindedOf[1];
        vm.prank(depositor);
        id = mint.deposit{value: totalValue}(points);
    }

    function test_report_reachesAPaidWallet() public {
        uint256 id = _deposit();

        vm.prank(creForwarder);
        consumer.onReport("", _report(id));
        assertEq(mint.totalAnnounced(), totalValue);

        for (uint256 i = 0; i < noteCount; i++) {
            mint.claim(denomOf[i], walletOf[i], sigOf[i]);
            assertEq(walletOf[i].balance, denomOf[i], "the wallet did not receive its note");
        }
        assertEq(address(mint).balance, 0);
    }

    /**
     * @notice The forwarder checks ERC-165 before it delivers a report.
     * @dev A receiver that fails this check receives no report. The forwarder swallows
     *      the failure and its own transaction still succeeds, so the report disappears
     *      without a revert.
     */
    function test_supportsInterface_answersTheForwarder() public view {
        assertTrue(consumer.supportsInterface(0x01ffc9a7), "ERC-165 is not supported");
        assertTrue(consumer.supportsInterface(IReceiver.onReport.selector), "IReceiver is not supported");
        assertFalse(consumer.supportsInterface(0xffffffff));
    }

    function test_onReport_rejectsAnotherSender() public {
        uint256 id = _deposit();
        vm.prank(stranger);
        vm.expectRevert(MintConsumer.NotCreForwarder.selector);
        consumer.onReport("", _report(id));
    }

    function test_announce_rejectsACallThatSkipsTheConsumer() public {
        uint256 id = _deposit();
        uint256[] memory idx = new uint256[](1);
        uint256[] memory denoms = new uint256[](1);
        bytes[] memory sigs = new bytes[](1);
        idx[0] = 0;
        denoms[0] = totalValue;
        sigs[0] = blindSigOf[0];

        vm.prank(creForwarder);
        vm.expectRevert(BlindMint.NotForwarder.selector);
        mint.announce(id, idx, denoms, sigs);
    }
}
