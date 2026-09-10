// SPDX-License-Identifier: CC0-1.0 OR Apache-2.0 OR WTFPL
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {BLS} from "../src/BLS.sol";
import {BlindMint} from "../src/BlindMint.sol";

/**
 * @notice These tests run the full path from deposit to claim.
 * @dev The tag contains the chain ID and the contract address. The test therefore sets the
 *      chain ID. The test also deploys to the address that the vectors use. The signatures
 *      in the file then apply without any change.
 */
contract BlindMintTest is Test {
    uint256 internal constant CHAIN_ID = 5042002;
    address internal constant DEPLOYED_AT = 0x00000000000000000000000000000000000000C0;
    uint64 internal constant REFUND_DELAY = 1 days;
    /// @dev The native token of Arc uses 18 decimals. One USDC is 10^18 base units.
    uint256 internal constant USDC = 1e18;

    BlindMint internal mint;
    address internal forwarder = makeAddr("forwarder");
    address internal depositor = makeAddr("depositor");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");

    string internal json;
    uint256 internal noteCount;

    // The three notes of the vectors, in order.
    address[] internal walletOf;
    uint256[] internal denomOf;
    bytes[] internal blindedOf;
    bytes[] internal blindSigOf;
    bytes[] internal sigOf;
    uint256 internal totalValue;

    /// @dev The smallest denomination of the ladder. The tax is one of these plus the rest.
    uint256 internal rung;
    /// @dev The deposit that mints `totalValue`. The tax is extra and not part of the notes.
    uint256 internal grossValue;

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
        deployCodeTo(
            "BlindMint.sol:BlindMint", abi.encode(forwarder, treasury, REFUND_DELAY, denoms, pubkeys), DEPLOYED_AT
        );
        mint = BlindMint(DEPLOYED_AT);
        rung = mint.rung();
        grossValue = totalValue + rung;
        vm.deal(depositor, 1000 * USDC);
    }

    /// @dev The deposit carries the three signed points plus two spare points.
    function _points() internal view returns (bytes[] memory points) {
        points = new bytes[](noteCount + 2);
        for (uint256 i = 0; i < noteCount; i++) {
            points[i] = blindedOf[i];
        }
        points[noteCount] = blindedOf[0];
        points[noteCount + 1] = blindedOf[1];
    }

    function _announcement()
        internal
        view
        returns (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs)
    {
        idx = new uint256[](noteCount);
        denoms = new uint256[](noteCount);
        sigs = new bytes[](noteCount);
        for (uint256 i = 0; i < noteCount; i++) {
            idx[i] = i;
            denoms[i] = denomOf[i];
            sigs[i] = blindSigOf[i];
        }
    }

    function _deposit() internal returns (uint256 id) {
        vm.prank(depositor);
        id = mint.deposit{value: grossValue}(_points());
    }

    /// @dev A deposit that carries points but mints nothing. It is all tax.
    function _dustDeposit(uint256 value) internal returns (uint256 id) {
        bytes[] memory points = new bytes[](1);
        points[0] = blindedOf[0];
        vm.prank(depositor);
        id = mint.deposit{value: value}(points);
    }

    function _empty() internal pure returns (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) {
        idx = new uint256[](0);
        denoms = new uint256[](0);
        sigs = new bytes[](0);
    }

    function _announce(uint256 id) internal {
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _announcement();
        vm.prank(forwarder);
        mint.announce(id, idx, denoms, sigs);
    }

    function test_dst_matchesTheTypeScriptTag() public view {
        assertEq(mint.dst(), vm.parseJsonBytes(json, ".domain.dst"));
    }

    function test_fullPath_depositAnnounceClaim() public {
        uint256 id = _deposit();
        assertEq(address(mint).balance, grossValue);
        _announce(id);
        assertEq(mint.totalAnnounced(), totalValue);
        assertEq(treasury.balance, rung, "the treasury did not receive the tax");
        assertEq(address(mint).balance, totalValue, "the tax stayed in the contract");

        for (uint256 i = 0; i < noteCount; i++) {
            assertEq(walletOf[i].balance, 0);
            vm.prank(stranger);
            mint.claim(denomOf[i], walletOf[i], sigOf[i]);
            assertEq(walletOf[i].balance, denomOf[i], "the wallet did not receive its note");
        }
        assertEq(address(mint).balance, 0);
        assertEq(mint.totalClaimed(), totalValue);
    }

    function test_claim_rejectsARepeat() public {
        uint256 id = _deposit();
        _announce(id);
        mint.claim(denomOf[0], walletOf[0], sigOf[0]);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.AlreadyClaimed.selector, walletOf[0]));
        mint.claim(denomOf[0], walletOf[0], sigOf[0]);
    }

    function test_claim_rejectsAnotherDenomination() public {
        uint256 id = _deposit();
        _announce(id);
        vm.expectRevert(BlindMint.BadSignature.selector);
        mint.claim(denomOf[1], walletOf[0], sigOf[0]);
    }

    function test_claim_rejectsAnUnknownDenomination() public {
        uint256 id = _deposit();
        _announce(id);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.UnknownDenomination.selector, 7 * USDC));
        mint.claim(7 * USDC, walletOf[0], sigOf[0]);
    }

    function test_claim_rejectsBeforeAnyAnnounce() public {
        _deposit();
        vm.expectRevert(BlindMint.MoreThanAnnounced.selector);
        mint.claim(denomOf[0], walletOf[0], sigOf[0]);
    }

    function test_announce_rejectsASumThatDiffers() public {
        uint256 id = _deposit();
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _announcement();
        // The change is the new denomination less the old one. Reading the old one keeps
        // this test correct when the ladder gains a rung.
        uint256 replaced = denoms[0];
        denoms[0] = 10 * USDC;
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(BlindMint.SumMismatch.selector, totalValue + 10 * USDC - replaced, totalValue)
        );
        mint.announce(id, idx, denoms, sigs);
    }

    function test_announce_rejectsARepeatedIndex() public {
        uint256 id = _deposit();
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _announcement();
        idx[1] = 0;
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.PointIndexRepeated.selector, 0));
        mint.announce(id, idx, denoms, sigs);
    }

    function test_announce_rejectsAnIndexOutOfRange() public {
        uint256 id = _deposit();
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _announcement();
        idx[0] = 99;
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.PointIndexOutOfRange.selector, 99));
        mint.announce(id, idx, denoms, sigs);
    }

    function test_announce_rejectsAnotherSender() public {
        uint256 id = _deposit();
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _announcement();
        vm.prank(stranger);
        vm.expectRevert(BlindMint.NotForwarder.selector);
        mint.announce(id, idx, denoms, sigs);
    }

    function test_announce_rejectsASecondAnnounce() public {
        uint256 id = _deposit();
        _announce(id);
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _announcement();
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.BadDeposit.selector, id));
        mint.announce(id, idx, denoms, sigs);
    }

    function test_refundByDepositor_waitsForTheDeadline() public {
        uint256 id = _deposit();
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.TooEarly.selector, uint64(block.timestamp) + REFUND_DELAY));
        mint.refundByDepositor(id);

        vm.warp(block.timestamp + REFUND_DELAY);
        uint256 before = depositor.balance;
        vm.prank(depositor);
        mint.refundByDepositor(id);
        assertEq(depositor.balance, before + grossValue);
        assertEq(treasury.balance, 0, "a refund paid the tax");
    }

    function test_refundByMint_returnsThePendingDeposit() public {
        uint256 id = _deposit();
        uint256 before = depositor.balance;
        vm.prank(forwarder);
        mint.refundByMint(id);
        assertEq(depositor.balance, before + grossValue);
        assertEq(treasury.balance, 0, "a refund paid the tax");
    }

    function test_refund_rejectsAnAnnouncedDeposit() public {
        uint256 id = _deposit();
        _announce(id);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.BadDeposit.selector, id));
        mint.refundByMint(id);
    }

    function test_deposit_rejectsAPointOfTheWrongSize() public {
        bytes[] memory points = new bytes[](1);
        points[0] = hex"0102";
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(BLS.BadLength.selector, 2, BLS.G2_BYTES));
        mint.deposit{value: 1 * USDC}(points);
    }

    function test_mintable_keepsOneRungAndTheRemainder() public view {
        assertEq(mint.mintable(3 * USDC + rung), 3 * USDC);
        assertEq(mint.mintable(3 * USDC + rung + 7), 3 * USDC);
        assertEq(mint.mintable(2 * rung), rung);
        assertEq(mint.mintable(rung), 0);
        assertEq(mint.mintable(rung - 1), 0);
        assertEq(mint.mintable(0), 0);
    }

    /// @dev A melt of dust uses this. A point would only cost the depositor a wallet.
    function test_deposit_acceptsNoPointsWhenItMintsNothing() public {
        bytes[] memory none = new bytes[](0);
        vm.prank(depositor);
        uint256 id = mint.deposit{value: rung - 1}(none);

        (, uint96 amount, uint32 points,, BlindMint.Status status) = mint.deposits(id);
        assertEq(amount, rung - 1);
        assertEq(points, 0);
        assertTrue(status == BlindMint.Status.Pending, "the deposit is not pending");

        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _empty();
        vm.prank(forwarder);
        mint.announce(id, idx, denoms, sigs);
        assertEq(treasury.balance, rung - 1, "the treasury did not take the deposit");
    }

    function test_deposit_rejectsNoPointsWhenItMints() public {
        bytes[] memory none = new bytes[](0);
        vm.prank(depositor);
        vm.expectRevert(BlindMint.NoPoints.selector);
        mint.deposit{value: grossValue}(none);
    }

    function test_announce_acceptsNoNotesWhenTheDepositMintsNothing() public {
        uint256 id = _dustDeposit(rung - 1);
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _empty();
        vm.prank(forwarder);
        mint.announce(id, idx, denoms, sigs);

        assertEq(mint.totalAnnounced(), 0);
        assertEq(treasury.balance, rung - 1, "the treasury did not take the whole deposit");
        assertEq(address(mint).balance, 0);
    }

    function test_announce_rejectsNoNotesWhenTheDepositMints() public {
        uint256 id = _deposit();
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _empty();
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.SumMismatch.selector, 0, totalValue));
        mint.announce(id, idx, denoms, sigs);
    }

    function test_announce_takesTheRemainderBelowTheRung() public {
        uint256 extra = rung / 3;
        vm.prank(depositor);
        uint256 id = mint.deposit{value: grossValue + extra}(_points());
        _announce(id);
        assertEq(treasury.balance, rung + extra, "the tax missed the remainder");
        assertEq(mint.totalAnnounced(), totalValue);
    }

    function test_announce_emitsTheTax() public {
        uint256 id = _deposit();
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _announcement();
        vm.expectEmit(true, false, false, true, address(mint));
        emit BlindMint.Taxed(id, rung);
        vm.prank(forwarder);
        mint.announce(id, idx, denoms, sigs);
    }

    function test_announce_rejectsADepositThatIsShortByOneRung() public {
        // The old contract accepted this. The sum must now equal the deposit less the tax.
        vm.prank(depositor);
        uint256 id = mint.deposit{value: totalValue}(_points());
        (uint256[] memory idx, uint256[] memory denoms, bytes[] memory sigs) = _announcement();
        // Read the view before the prank. A prank covers the next call, and that call
        // would be this one.
        uint256 want = mint.mintable(totalValue);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(BlindMint.SumMismatch.selector, totalValue, want));
        mint.announce(id, idx, denoms, sigs);
    }

    function test_gas_claim() public {
        uint256 id = _deposit();
        _announce(id);
        uint256 before = gasleft();
        mint.claim(denomOf[0], walletOf[0], sigOf[0]);
        emit log_named_uint("claim gas", before - gasleft());
    }
}
