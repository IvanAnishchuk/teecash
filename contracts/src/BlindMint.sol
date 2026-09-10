// SPDX-License-Identifier: CC0-1.0 OR Apache-2.0 OR WTFPL
pragma solidity ^0.8.28;

import {BLS} from "./BLS.sol";

/// @notice The receiver interface of the CRE forwarder.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/**
 * @title BlindMint
 * @notice Chaumian eCash where the note is a wallet.
 * @dev A depositor sends value and a list of blinded points. The mint signs some of those
 *      points inside a TEE. The mint then announces the signatures. Anyone can present an
 *      unblinded signature. This contract pays the signed address.
 *
 *      The deposit records and the claim records never reference each other. `claim` reads
 *      `mintPubkeys` and `claimed` only. This contract never stores a blinded point.
 *      Blinding removes the link from a claim to a deposit.
 *
 *      The chain is Arc. The native token is USDC. A wallet that receives a note can spend
 *      it at once, because the note pays the gas token.
 */
contract BlindMint is IReceiver {
    enum Status {
        None,
        Pending,
        Announced,
        Refunded
    }

    struct Deposit {
        address depositor;
        uint96 amount;
        uint32 points;
        uint64 deadline;
        Status status;
    }

    /// @dev The duplicate check in `announce` uses a 256-bit map, so a deposit stops here.
    uint256 public constant MAX_POINTS = 256;

    /// @notice One public key for each denomination.
    mapping(uint256 => bytes) public mintPubkeys;

    /// @notice The addresses that already claimed a note.
    mapping(address => bool) public claimed;

    mapping(uint256 => Deposit) public deposits;

    /// @notice The CRE forwarder. Only this address can deliver a report or announce.
    /// @dev The forwarder calls `onReport`. This contract receives the report itself. The
    ///      chain of trust runs from the CRE forwarder to the mint, with nothing between.
    address public immutable forwarder;

    /// @notice A depositor can reclaim a pending deposit after this delay.
    uint64 public immutable refundDelay;

    /// @notice The account that receives the mint tax.
    /// @dev It pays for the mint transaction and the claim transaction. It holds no other
    ///      role here. It cannot announce. It cannot refund. It cannot claim.
    address public immutable treasury;

    /// @notice The smallest denomination of the ladder. Every mint is a multiple of it.
    uint256 public immutable rung;

    /// @notice The domain separation tag. It contains the chain ID and this address.
    bytes public dst;

    uint256 public nextId = 1;

    /// @notice The value of every announced note. `totalClaimed` must stay at or below it.
    uint256 public totalAnnounced;

    /// @notice The value of every note that this contract has paid.
    uint256 public totalClaimed;

    event Deposited(uint256 indexed id, address indexed depositor, uint256 amount, bytes[] blindedPoints);
    event Announced(uint256 indexed id, uint256[] pointIndexes, uint256[] denoms, bytes[] blindSigs);
    event Claimed(address indexed wallet, uint256 denom);
    event Refunded(uint256 indexed id, address indexed depositor, uint256 amount);
    event Taxed(uint256 indexed id, uint256 amount);

    error NotForwarder();
    error NoPoints();
    error NoValue();
    error NoTreasury();
    error AmountTooLarge();
    error TooManyPoints(uint256 got, uint256 max);
    error BadDeposit(uint256 id);
    error LengthMismatch();
    error SumMismatch(uint256 got, uint256 want);
    error PointIndexOutOfRange(uint256 index);
    error PointIndexRepeated(uint256 index);
    error UnknownDenomination(uint256 denom);
    error AlreadyClaimed(address wallet);
    error MoreThanAnnounced();
    error BadSignature();
    error TooEarly(uint64 deadline);
    error TransferFailed(address to);

    modifier onlyForwarder() {
        if (msg.sender != forwarder) revert NotForwarder();
        _;
    }

    /**
     * @param forwarder_ The address that the CRE workflow writes through.
     * @param treasury_ The address that receives the mint tax.
     * @param refundDelay_ The wait before a depositor can reclaim a pending deposit.
     * @param denoms The denomination ladder.
     * @param pubkeys One G1 public key for each denomination, in the same order.
     */
    constructor(
        address forwarder_,
        address treasury_,
        uint64 refundDelay_,
        uint256[] memory denoms,
        bytes[] memory pubkeys
    ) {
        if (denoms.length != pubkeys.length) revert LengthMismatch();
        if (denoms.length == 0) revert LengthMismatch();
        if (treasury_ == address(0)) revert NoTreasury();
        forwarder = forwarder_;
        treasury = treasury_;
        refundDelay = refundDelay_;
        uint256 smallest = type(uint256).max;
        for (uint256 i = 0; i < denoms.length; i++) {
            if (denoms[i] == 0) revert UnknownDenomination(0);
            if (pubkeys[i].length != BLS.G1_BYTES) revert BLS.BadLength(pubkeys[i].length, BLS.G1_BYTES);
            mintPubkeys[denoms[i]] = pubkeys[i];
            if (denoms[i] < smallest) smallest = denoms[i];
        }
        rung = smallest;
        dst = _buildDst();
    }

    /**
     * @notice The value that a deposit of `amount` mints.
     * @dev The rest is the mint tax. It is one rung plus every base unit below the rung.
     *      The result is a multiple of the rung, so the ladder can express it.
     *
     *      The result is zero for a deposit below two rungs. That deposit mints nothing.
     *      The treasury takes all of it.
     *
     *      `lib-blind` and the Go mint must agree with this function.
     */
    function mintable(uint256 amount) public view returns (uint256) {
        if (amount < rung) return 0;
        return (amount / rung - 1) * rung;
    }

    /**
     * @notice Lock value against a list of blinded points.
     * @dev Send more points than the smallest split needs. The mint can only sign points
     *      that this deposit holds. The count is therefore the ceiling on the split.
     *
     *      A deposit that mints nothing takes no point. The mint signs none of them, so a
     *      point would only cost the depositor a wallet. Such a deposit gives all of its
     *      value to the treasury, and a melt uses it to empty a wallet of dust.
     * @param blindedPoints The blinded G2 points, 256 bytes each.
     * @return id The deposit identifier.
     */
    function deposit(bytes[] calldata blindedPoints) external payable returns (uint256 id) {
        if (blindedPoints.length == 0 && mintable(msg.value) != 0) revert NoPoints();
        if (blindedPoints.length > MAX_POINTS) revert TooManyPoints(blindedPoints.length, MAX_POINTS);
        if (msg.value == 0) revert NoValue();
        if (msg.value > type(uint96).max) revert AmountTooLarge();
        for (uint256 i = 0; i < blindedPoints.length; i++) {
            if (blindedPoints[i].length != BLS.G2_BYTES) {
                revert BLS.BadLength(blindedPoints[i].length, BLS.G2_BYTES);
            }
        }

        id = nextId++;
        deposits[id] = Deposit({
            depositor: msg.sender,
            amount: uint96(msg.value),
            points: uint32(blindedPoints.length),
            deadline: uint64(block.timestamp) + refundDelay,
            status: Status.Pending
        });
        emit Deposited(id, msg.sender, msg.value, blindedPoints);
    }

    /**
     * @notice Publish the blind signatures for one deposit.
     * @dev The denominations are public. This contract can therefore add them. Their sum
     *      must equal `mintable(amount)`. Blinding hides the address of a note. Blinding
     *      does not hide the key that signed it.
     * @param id The deposit identifier.
     * @param pointIndexes The points that the mint signed, in the order of the deposit.
     * @param denoms The denomination for each signed point.
     * @param blindSigs The blind signatures. A client reads them from this event.
     */
    function announce(
        uint256 id,
        uint256[] calldata pointIndexes,
        uint256[] calldata denoms,
        bytes[] calldata blindSigs
    ) external onlyForwarder {
        _announce(id, pointIndexes, denoms, blindSigs);
    }

    /**
     * @notice Report support for an interface, per ERC-165.
     * @dev The forwarder calls this function before it delivers a report. A receiver that
     *      does not answer receives no report, and the forwarder still reports success.
     *      This function is therefore necessary.
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == type(IReceiver).interfaceId;
    }

    /**
     * @notice Receive one report from the CRE forwarder and announce it.
     * @dev The report holds the values that `announce` takes. The Go workflow packs them
     *      in `workflow/announce`. Both sides must use the same field order.
     * @param report The packed announcement.
     */
    function onReport(bytes calldata, bytes calldata report) external onlyForwarder {
        (uint256 id, uint256[] memory pointIndexes, uint256[] memory denoms, bytes[] memory blindSigs) =
            abi.decode(report, (uint256, uint256[], uint256[], bytes[]));
        _announce(id, pointIndexes, denoms, blindSigs);
    }

    function _announce(uint256 id, uint256[] memory pointIndexes, uint256[] memory denoms, bytes[] memory blindSigs)
        private
    {
        Deposit storage d = deposits[id];
        if (d.status != Status.Pending) revert BadDeposit(id);
        if (pointIndexes.length != denoms.length || denoms.length != blindSigs.length) revert LengthMismatch();

        uint256 sum;
        uint256 seen;
        for (uint256 i = 0; i < pointIndexes.length; i++) {
            uint256 idx = pointIndexes[i];
            if (idx >= d.points) revert PointIndexOutOfRange(idx);
            uint256 bit = 1 << idx;
            if (seen & bit != 0) revert PointIndexRepeated(idx);
            seen |= bit;
            if (mintPubkeys[denoms[i]].length == 0) revert UnknownDenomination(denoms[i]);
            if (blindSigs[i].length != BLS.G2_BYTES) revert BLS.BadLength(blindSigs[i].length, BLS.G2_BYTES);
            sum += denoms[i];
        }
        // The deposit keeps one rung and the remainder below it. An empty note list is a
        // legal announcement. It is legal only for a deposit that mints nothing, because
        // the sum must still agree. No separate count check is necessary.
        uint256 want = mintable(d.amount);
        if (sum != want) revert SumMismatch(sum, want);

        uint256 taken = d.amount - sum;
        d.status = Status.Announced;
        totalAnnounced += sum;
        emit Announced(id, pointIndexes, denoms, blindSigs);

        // This is the last statement and it runs after every write. The forwarder
        // delivers the report. A treasury that refused the value would revert that
        // delivery.
        if (taken != 0) {
            emit Taxed(id, taken);
            _send(treasury, taken);
        }
    }

    /**
     * @notice Pay a wallet its note.
     * @dev Any account can send this call. The value goes to the signed address. A stolen
     *      call therefore funds a wallet that the thief does not hold.
     * @param denom The denomination of the note.
     * @param wallet The address that the mint signed.
     * @param sig The unblinded signature, 256 bytes.
     */
    function claim(uint256 denom, address wallet, bytes calldata sig) external {
        bytes memory pubkey = mintPubkeys[denom];
        if (pubkey.length == 0) revert UnknownDenomination(denom);
        if (claimed[wallet]) revert AlreadyClaimed(wallet);
        if (totalClaimed + denom > totalAnnounced) revert MoreThanAnnounced();
        if (!BLS.verify(pubkey, wallet, sig, dst)) revert BadSignature();

        claimed[wallet] = true;
        totalClaimed += denom;
        emit Claimed(wallet, denom);
        _send(wallet, denom);
    }

    /// @notice Return a pending deposit. The mint calls this when it refuses to sign.
    /// @dev A refund returns the whole deposit. The mint signed nothing, so it takes no tax.
    function refundByMint(uint256 id) external onlyForwarder {
        _refund(id);
    }

    /// @notice Return a pending deposit after the delay. A dead mint cannot keep the money.
    function refundByDepositor(uint256 id) external {
        Deposit storage d = deposits[id];
        if (d.depositor != msg.sender) revert BadDeposit(id);
        if (block.timestamp < d.deadline) revert TooEarly(d.deadline);
        _refund(id);
    }

    function _refund(uint256 id) private {
        Deposit storage d = deposits[id];
        if (d.status != Status.Pending) revert BadDeposit(id);
        d.status = Status.Refunded;
        uint256 amount = d.amount;
        address to = d.depositor;
        emit Refunded(id, to, amount);
        _send(to, amount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to);
    }

    /**
     * @dev Build the domain separation tag. The result must equal the tag that
     *      `lib-blind/src/domain.ts` builds for the same chain and address.
     */
    function _buildDst() private view returns (bytes memory) {
        return abi.encodePacked(
            "TEECASH_V1_",
            _toString(block.chainid),
            "_",
            _toHexAddress(address(this)),
            "_BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_"
        );
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            digits++;
        }
        bytes memory out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) {
            out[--digits] = bytes1(uint8(48 + (v % 10)));
        }
        return string(out);
    }

    /// @dev Lowercase hex with an "0x" prefix. The TypeScript side uses the same format.
    function _toHexAddress(address a) private pure returns (string memory) {
        bytes memory hexDigits = "0123456789abcdef";
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        uint160 v = uint160(a);
        for (uint256 i = 0; i < 20; i++) {
            uint8 b = uint8(v >> (8 * (19 - i)));
            out[2 + i * 2] = hexDigits[b >> 4];
            out[3 + i * 2] = hexDigits[b & 0x0f];
        }
        return string(out);
    }
}
