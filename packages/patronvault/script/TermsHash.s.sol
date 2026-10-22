// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Prints the termsHash the vault will be deployed with: keccak256 of the exact bytes of the terms
///         file, final newline included. The page that shows members the terms must serve that same file
///         byte for byte and hash the bytes the same way.
///
///         forge script script/TermsHash.s.sol                                   (terms/member-terms-v1.md, the pilot)
///         TERMS_FILE=terms/member-terms-v1.1.md forge script script/TermsHash.s.sol   (the product terms, with the fee)
contract TermsHash is Script {
    string public constant DEFAULT_TERMS_FILE = "terms/member-terms-v1.md";

    function run() external view {
        string memory file = vm.envOr("TERMS_FILE", DEFAULT_TERMS_FILE);
        bytes memory text = bytes(vm.readFile(file));
        console2.log("file:   ", file);
        console2.log("bytes:  ", text.length);
        console2.log("keccak256:");
        console2.logBytes32(keccak256(text));
    }
}
