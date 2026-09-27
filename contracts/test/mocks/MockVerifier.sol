// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAssayVerifier} from "../../src/IAssayVerifier.sol";

/// Test double for the Stylus TDX verifier. The real verifier's cryptography is
/// proven by `cargo test --lib` in verifier (4/4, real bundle plus 3
/// bit-flip negatives) and by the live registration in the deployment cycle
/// (contracts/deployments/421614.json). This mock lets Assay.sol's
/// own logic (allowlist, expiry, monotonic vouchers, pull payouts) be tested against
/// controlled (signer, measurement) pairs without needing a WASM-executing EVM.
contract MockVerifier is IAssayVerifier {
    address public nextSigner;
    bytes32 public nextMeasurement;
    bool public shouldRevert;

    function setNext(address signer_, bytes32 measurement_) external {
        nextSigner = signer_;
        nextMeasurement = measurement_;
        shouldRevert = false;
    }

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function verify(bytes calldata, bytes32) external view returns (address, bytes32) {
        if (shouldRevert) revert("MockVerifierReject");
        return (nextSigner, nextMeasurement);
    }
}
