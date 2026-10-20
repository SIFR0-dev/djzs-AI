// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Attestation, ISchemaResolver} from "../DJZSVerdictResolver.sol";

/// @dev Test stand-in for the EAS predeploy: forwards an attestation to a resolver the way EAS does,
/// as the caller the resolver trusts. Test only, never deployed.
contract MockEAS {
    function callAttest(ISchemaResolver resolver, Attestation calldata a) external payable returns (bool) {
        return resolver.attest{value: msg.value}(a);
    }

    function callMultiAttest(ISchemaResolver resolver, Attestation[] calldata a, uint256[] calldata values)
        external
        payable
        returns (bool)
    {
        return resolver.multiAttest{value: msg.value}(a, values);
    }

    function callRevoke(ISchemaResolver resolver, Attestation calldata a) external returns (bool) {
        return resolver.revoke(a);
    }
}
