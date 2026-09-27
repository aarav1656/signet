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
}
