// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICreatorRegistry} from "./interfaces/ICreatorRegistry.sol";

/// @notice The simplest creator registry: a list fixed at deployment, no owner, no changes. The pilot's vault is
///         deployed with one entry, the Scan Room payee, so "principal-only" means what it says: the only address
///         a member can route yield to is the creator the vault exists for. A product that onboards creators over
///         time needs a managed registry behind the same one-function interface; the vault does not care which.
contract FixedCreators is ICreatorRegistry {
    mapping(address => bool) public override isCreator;
    address[] public creators;

    error ZeroAddress();
    error Duplicate();

    constructor(address[] memory list) {
        for (uint256 i = 0; i < list.length; i++) {
            address a = list[i];
            if (a == address(0)) revert ZeroAddress();
            if (isCreator[a]) revert Duplicate();
            isCreator[a] = true;
            creators.push(a);
        }
    }

    function count() external view returns (uint256) {
        return creators.length;
    }
}
