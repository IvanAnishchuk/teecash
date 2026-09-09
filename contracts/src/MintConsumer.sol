// SPDX-License-Identifier: CC0-1.0 OR Apache-2.0 OR WTFPL
pragma solidity ^0.8.28;

import {BlindMint} from "./BlindMint.sol";

/// @notice The receiver interface of the CRE forwarder.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/**
 * @title MintConsumer
 * @notice The receiver of the CRE report. It calls `announce` on BlindMint.
 * @dev The CRE forwarder calls `onReport`. This contract is the `forwarder` of BlindMint.
 *      The chain of trust runs from the CRE forwarder to this consumer to the mint.
 *
 *      The report holds the values that `announce` takes. The Go workflow packs them in
 *      `workflow/announce`. Both sides must use the same field order.
 */
contract MintConsumer {
    /// @notice The CRE forwarder. Only this address can deliver a report.
    address public immutable creForwarder;

    /// @notice The mint that receives the announcement.
    BlindMint public immutable blindMint;

    error NotCreForwarder();

    /**
     * @notice Report support for an interface, per ERC-165.
     * @dev The forwarder calls this function before it delivers a report. A receiver
     *      that does not answer receives no report. The forwarder still reports success
     *      in that case. This function is therefore necessary.
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == type(IReceiver).interfaceId;
    }

    constructor(address creForwarder_, BlindMint blindMint_) {
        creForwarder = creForwarder_;
        blindMint = blindMint_;
    }

    /**
     * @notice Receive one report. Pass its values to `announce`.
     * @param report The packed announcement.
     */
    function onReport(bytes calldata, bytes calldata report) external {
        if (msg.sender != creForwarder) revert NotCreForwarder();
        (uint256 id, uint256[] memory pointIndexes, uint256[] memory denoms, bytes[] memory blindSigs) =
            abi.decode(report, (uint256, uint256[], uint256[], bytes[]));
        blindMint.announce(id, pointIndexes, denoms, blindSigs);
    }
}
