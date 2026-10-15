// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The ERC-7597 form of permit, which USDC v2.2 implements on Base: a bytes signature, so it accepts a
///      65-byte ECDSA signature from an EOA and an EIP-1271 signature from a smart wallet alike.
interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature) external;
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
