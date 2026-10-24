// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAssayVerifier, ICollateralVerifier} from "../../src/IAssayVerifier.sol";

/// Test double for the Stylus TDX Verifier that keeps the one property AgentAccount relies on:
/// the nonce binding. The real verify() returns report_data[0..20] as the signer and reverts
/// unless report_data[32..64] equals the caller's nonce (verifier/src/lib.rs 762 to 769). Here a
/// "quote" is abi.encode(signer, measurement, reportNonce) and the same rule applies, so the
/// epoch, chain, account and refBlock binding of attestNonce() is exercised for real. The DCAP
/// cryptography is proven by `cargo test` in verifier/.
///
/// verifyWithCollateral keeps the rules verifier/src/collateral.rs applies to the documents it
/// has authenticated: a platform status of 6 (Revoked) or above the caller's ceiling reverts, as
/// does an evaluation number below the caller's floor. Here the "collateral" is
/// abi.encode(uint8 status, uint32 evaluation, bool authentic) and `authentic == false` stands for
/// a document that fails Intel's signature. The Rust suite proves the documents map to these three
/// values; the Solidity suite proves AgentAccount acts on them.
contract AgentQuoteVerifier is IAssayVerifier, ICollateralVerifier {
    error NonceMismatch(bytes32 bound, bytes32 expected);
    error CollateralNotAuthentic();
    error TcbStatusNotAccepted(uint8 status, uint8 maxStatus);
    error CollateralEvalTooOld(uint32 evaluation, uint32 minEvaluation);

    uint8 public lastMaxStatus;
    uint32 public lastMinEvaluation;

    bytes32 public keysetMeasurement;

    function setKeysetMeasurement(bytes32 m) external {
        keysetMeasurement = m;
    }

    function verify(bytes calldata quote, bytes32 nonce) external pure returns (address signer, bytes32 measurement) {
        bytes32 bound;
        (signer, measurement, bound) = abi.decode(quote, (address, bytes32, bytes32));
        if (bound != nonce) revert NonceMismatch(bound, nonce);
    }

    function verifyWithCollateral(
        bytes calldata quote,
        bytes32 nonce,
        bytes calldata collateral,
        uint8 maxStatus,
        uint32 minEvaluation
    ) external returns (address signer, bytes32 measurement, uint8 status) {
        bytes32 bound;
        (signer, measurement, bound) = abi.decode(quote, (address, bytes32, bytes32));
        if (bound != nonce) revert NonceMismatch(bound, nonce);
        uint32 evaluation;
        bool authentic;
        (status, evaluation, authentic) = abi.decode(collateral, (uint8, uint32, bool));
        lastMaxStatus = maxStatus;
        lastMinEvaluation = minEvaluation;
        if (!authentic) revert CollateralNotAuthentic();
        if (status >= 6 || status > maxStatus) revert TcbStatusNotAccepted(status, maxStatus);
        if (evaluation < minEvaluation) revert CollateralEvalTooOld(evaluation, minEvaluation);
    }

    function verifyKeyset(bytes calldata, bytes calldata, bytes32, bytes32) external view returns (bytes32) {
        return keysetMeasurement;
    }
}
