// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Interface to the Stylus (Rust) TDX verifier in verifier. `verify`
/// checks a TDX quote's PCK chain to Intel's root (including cert validity dates),
/// the QE report signature, the QE report-data binding and the top-level quote
/// signature, rejects a TD with the DEBUG attribute bit set, then returns the TD
/// report's own `report_data[0..20]` as `signer` and
/// keccak256(MRTD || RTMR0..3 || mr_seam || td_attributes || xfam || mr_config_id)
/// as `measurement`. The quote must be fetched from Phala's legacy `GET
/// /v1/attestation/report?nonce=...` endpoint, whose report_data is `signing_address
/// (20 bytes) || zero (12 bytes) || nonce (32 bytes)` verbatim (confirmed against
/// github.com/Dstack-TEE/private-ai-gateway and a live fetch, see verifier/src/lib.rs);
/// the canonical `/v1/aci/attestation` endpoint's report_data commits to a
/// nonce+keyset-digest hash instead and does not carry a raw address. `signing_address`
/// is the real secp256k1 key the gateway signs per-response receipts with, not the QE's
/// ephemeral attestation key (see README.md for what this means for
/// redeeming a live voucher). `nonce` must equal the quote's own report_data[32:64]
/// exactly and report_data[20:32] must be all zero, or the call reverts; the caller
/// (Assay.sol) issues this nonce so a captured quote can never be replayed to
/// re-register. Reverts on any structural or cryptographic failure; the call itself
/// is what a caller pays gas for.
interface IAssayVerifier {
    function verify(bytes calldata quote, bytes32 nonce) external returns (address signer, bytes32 measurement);

    /// Binds an Ed25519 receipt-signing pubkey to the same TDX-attested
    /// enclave `verify` trusts, via Phala's canonical `/v1/aci/attestation`
    /// endpoint (`verifier/src/lib.rs`'s `verify_keyset`, cited there against
    /// `crates/aci-protocol/src/identity.rs`'s `REPORT_DATA_PURPOSE` /
    /// `attestation_statement` and `crates/aci-verify/src/report.rs`'s
    /// `verify_report_binding`): that endpoint's `report_data[0..32]` is
    /// `sha256(JCS({"keyset_digest":"sha256:"+sha256(keysetBytes),"nonce":hex(nonce),
    /// "purpose":"aci.report_data.v1"}))`, so the pubkey is bound by hash
    /// equality, not a separate signature over the pubkey -- there is no
    /// on-chain JCS re-canonicalization; wrong or non-canonical
    /// `keysetBytes` simply fails the digest match and reverts, fail-closed
    /// by construction. `keysetBytes` must be the caller-supplied JCS bytes
    /// of the quote's `attestation.workload_keyset` object; `pubkey` must
    /// appear in its `receipt_signing_keys[]` with `algo == "ed25519"`.
    /// Reverts (does not return a boolean) on any structural or
    /// cryptographic failure, same shape as `verify`.
    function verifyKeyset(bytes calldata quote, bytes calldata keysetBytes, bytes32 nonce, bytes32 pubkey)
        external
        returns (bytes32 measurement);
}

/// The Stylus verifier's collateral entry point (`verify_with_collateral` in verifier/src/lib.rs).
/// It runs `verify` and then authenticates Intel's TCB Info, QE Identity, PCK CRL and root CRL
/// for the quote's platform against the hardcoded Intel root. `collateral` is
/// abi.encode(tcbInfo, tcbSignature, tcbChainPem, qeIdentity, qeSignature, qeChainPem, pckCrl,
/// rootCrl). `status` is the worst severity rank of the platform, TDX module and quoting enclave:
/// 0 UpToDate, 1 SWHardeningNeeded, 2 ConfigurationNeeded, 3 ConfigurationAndSWHardeningNeeded,
/// 4 OutOfDate, 5 OutOfDateConfigurationNeeded. The call reverts on Revoked (6), on a status above
/// `maxStatus`, and on a document whose tcbEvaluationDataNumber is below `minEvaluation`.
interface ICollateralVerifier {
    function verifyWithCollateral(
        bytes calldata quote,
        bytes32 nonce,
        bytes calldata collateral,
        uint8 maxStatus,
        uint32 minEvaluation
    ) external returns (address signer, bytes32 measurement, uint8 status);
}
