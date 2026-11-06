// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Who may be routed to. A vault deployed with a registry accepts routes only to addresses it lists;
///         a vault deployed without one accepts any address. Removal of a route never consults it.
interface ICreatorRegistry {
    function isCreator(address who) external view returns (bool);
}
