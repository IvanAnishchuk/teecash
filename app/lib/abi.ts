/**
 * The part of BlindMint that the browser uses.
 *
 * The command line client reads the whole ABI from `contracts/out`. A browser has no file
 * system, so this file names the members the frontend calls. It is a hand written copy and
 * it can become different from the contract. `contracts/src/BlindMint.sol` is the source.
 * Check this file against it after any change to a signature there.
 *
 * The frontend never calls `announce`, `onReport` or `refundByMint`. The mint owns those.
 */

import { parseAbi } from "viem";

export const blindMintAbi = parseAbi([
  "function deposit(bytes[] calldata blindedPoints) external payable returns (uint256 id)",
  "function claim(uint256 denom, address wallet, bytes calldata sig) external",
  "function refundByDepositor(uint256 id) external",
  "function mintPubkeys(uint256 denom) external view returns (bytes)",
  "function claimed(address wallet) external view returns (bool)",
  "function deposits(uint256 id) external view returns (address depositor, uint96 amount, uint32 points, uint64 deadline, uint8 status)",
  "event Deposited(uint256 indexed id, address indexed depositor, uint256 amount, bytes[] blindedPoints)",
  "event Announced(uint256 indexed id, uint256[] pointIndexes, uint256[] denoms, bytes[] blindSigs)",
  "event Claimed(address indexed wallet, uint256 denom)",
  "event Refunded(uint256 indexed id, address indexed depositor, uint256 amount)",
]);

/** The `status` field of a deposit, as the contract orders it. */
export const DEPOSIT_STATUS = ["None", "Pending", "Announced", "Refunded"] as const;
