// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Interface to the Stylus (Rust) receipt verifier in `receipt-verifier/`. Verifies
/// one Phala canonical ACI inference receipt (`GET/POST` served by
/// `private-ai-gateway`'s aggregator, format cited in `receipt-verifier/src/lib.rs`)
/// end to end: `signature` is an Ed25519 signature over `receiptBytes` under
/// `pubkey`; `receiptBytes` must be exactly the receipt's JCS document bytes with
/// its `signature` member removed (i.e. `aci_protocol::receipt::receipt_signing_input`'s
/// output, not the served document). On a genuine signature `ok` is true and the
/// function returns keccak256 of the receipt's top-level `model` field (the model
/// requested), keccak256 of the verified `upstream.verified` event's `model_id`
/// field (the model actually served), and the raw 32 bytes of the
/// `response.returned` event's `body_hash` digest. On any signature, structural,
/// or missing-field failure `ok` is false and every other field is zero; the call
/// never reverts on a bad receipt so a caller can branch on `ok` in one call
/// instead of catching a revert.
///
/// `pubkey` is the receipt-signing key's raw 32-byte Ed25519 public key. Binding
/// that key to a live TDX attestation (the `report_data` template in Phala's
/// `crates/aci-protocol/src/identity.rs:44-78`, cited in the Chiron build-list item
/// this crate is item 1 of) is a separate registration step this interface does not
/// cover; see the design note below for how a caller is expected to obtain and pin
/// a `pubkey` it trusts before calling `verifyReceipt`.
interface IReceiptVerifier {
    function verifyReceipt(bytes32 pubkey, bytes calldata receiptBytes, bytes calldata signature)
        external
        returns (bool ok, bytes32 requestedModelHash, bytes32 servedModelHash, bytes32 requestHash, bytes32 responseHash);
}

/// Design note: how `Assay.redeem` would call this (not implemented here; `contracts/`
/// is owned by another workstream during this build).
///
/// Today `Assay.redeem` (`contracts/src/Assay.sol:234-275`) trusts an `enclaveSig`
/// over `(requestHash, responseHash)` alone (`Assay.sol:258-261`): it proves an
/// attested key vouched for a request/response pair, never which model produced
/// the response (judging note D/B1.3: "the model is never checked"). This
/// verifier closes that gap without touching the existing voucher shape:
///
/// 1. `Channel` gains a `requestedModelHash` (bytes32), set once at `openChannel`
///    from a caller-supplied model identifier the agent and provider agreed off
///    chain (e.g. `keccak256("deepseek-v3.1")`), the spend cap becomes "attested
///    inference of this exact model", closing README:30's currently-false claim.
/// 2. A new `receiptSigners` mapping (parallel to the existing `signers` mapping
///    `Assay.sol:73`, keyed on the Ed25519 `pubkey` instead of a secp256k1 address)
///    records which `pubkey`s are registered to a `measurement` on the allowlist,
///    populated by a registration flow analogous to `register()`
///    (`Assay.sol:156-234`) that additionally checks the pubkey is bound into the
///    TDX quote's `report_data` per the identity.rs template cited above, so a
///    caller cannot simply invent a keypair and register it unattested.
/// 3. `redeem` (or a new `redeemWithReceipt`) takes `receiptBytes` and `signature`
///    in place of (or alongside) `enclaveSig`, looks up the registered `pubkey` for
///    the channel's signer, and calls `IReceiptVerifier.verifyReceipt`:
///
///    ```solidity
///    (bool ok, bytes32 requestedHash, bytes32 servedHash, bytes32 responseHash) =
///        receiptVerifier.verifyReceipt(pubkey, receiptBytes, signature);
///    if (!ok) revert ReceiptInvalid();
///    if (servedHash != c.requestedModelHash) revert ModelMismatch();
///    if (requestedHash != c.requestedModelHash) revert ModelMismatch(); // defence in depth
///    if (responseHash != voucherResponseHash) revert ResponseHashMismatch();
///    ```
///
///    Payment proceeds exactly as today (delta transfer, `consumedReceipt`,
///    `lastResponseHash` bookkeeping) only past that gate. `ModelMismatch` is
///    the refusal path item 5 of the build list asks for: a provider that swaps
///    the served model can no longer get paid, because `servedHash` (read from
///    the receipt the TEE itself signed) will not equal the channel's pinned
///    `requestedModelHash`, regardless of what the provider claims off chain.
/// 4. This retires the legacy-endpoint dependency the current `verifier/` crate
///    has (README/D: "Phala's own source calls it legacy") for the payment path,
///    while `verifier/`'s TDX quote check remains the trust root for step 2's
///    pubkey-to-attestation binding: the two Stylus contracts compose rather
///    than duplicate each other's job, which is also why this is a second
///    contract instead of growing the existing `verifier/` past its own size
///    budget (this crate alone is already 19.2 KB of the 24 KiB Stylus limit).
