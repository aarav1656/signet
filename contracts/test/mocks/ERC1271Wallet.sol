// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// A minimal, real ERC-1271 smart-contract wallet, standing in for a Safe or
/// ZeroDev Kernel account acting as an Assay channel's `agent`. It validates a
/// signature the same way a 1-of-1 Safe would: the digest must recover to the
/// wallet's single owner key. This is a test fixture for Item 6 (contract-signed
/// vouchers), not a mock of Assay's own logic -- Assay never calls into this
/// contract except through the standard isValidSignature interface that a real
/// Safe/Kernel account also exposes.
contract ERC1271Wallet is IERC1271 {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 digest, bytes memory signature) external view override returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}
