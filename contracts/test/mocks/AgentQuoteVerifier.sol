// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAssayVerifier} from "../../src/IAssayVerifier.sol";

/// Test double for the Stylus TDX Verifier that keeps the one property AgentAccount relies on:
/// the nonce binding. The real verify() returns report_data[0..20] as the signer and reverts
/// unless report_data[32..64] equals the caller's nonce (verifier/src/lib.rs 762 to 769). Here a
/// "quote" is abi.encode(signer, measurement, reportNonce) and the same rule applies, so the
/// epoch, chain, account and refBlock binding of attestNonce() is exercised for real. The DCAP
/// cryptography is proven by `cargo test` in verifier/.
contract AgentQuoteVerifier is IAssayVerifier {
    error NonceMismatch(bytes32 bound, bytes32 expected);

    bytes32 public keysetMeasurement;

    function setKeysetMeasurement(bytes32 m) external {
        keysetMeasurement = m;
    }

    function verify(bytes calldata quote, bytes32 nonce) external pure returns (address signer, bytes32 measurement) {
        bytes32 bound;
        (signer, measurement, bound) = abi.decode(quote, (address, bytes32, bytes32));
        if (bound != nonce) revert NonceMismatch(bound, nonce);
    }

    function verifyKeyset(bytes calldata, bytes calldata, bytes32, bytes32) external view returns (bytes32) {
        return keysetMeasurement;
    }
}
