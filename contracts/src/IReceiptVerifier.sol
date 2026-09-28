// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Interface to the Stylus (Rust) Ed25519 receipt verifier in
/// `receipt-verifier/` (mirrors `receipt-verifier/solidity/IReceiptVerifier.sol`,
/// the design-note copy this repo shipped before Assay.sol wired it up; kept
/// in sync by hand since `contracts/` is a separate forge project with its
/// own `src/`). Verifies one Phala canonical ACI inference receipt end to
/// end: `signature` is an Ed25519 signature over `receiptBytes` under
/// `pubkey`; `receiptBytes` must be exactly the receipt's JCS document bytes
/// with its `signature` member removed. On a genuine signature `ok` is true
/// and the function returns keccak256 of the receipt's top-level `model`
/// field (the model requested), keccak256 of the verified
/// `upstream.verified` event's `model_id` field (the model actually
/// served), and the raw 32 bytes of the `response.returned` event's
/// `body_hash` digest. On any signature, structural, or missing-field
/// failure `ok` is false and every other field is zero; the call never
/// reverts on a bad receipt so `Assay.redeemWithReceipt` can branch on `ok`
/// in one call instead of catching a revert.
interface IReceiptVerifier {
    function verifyReceipt(bytes32 pubkey, bytes calldata receiptBytes, bytes calldata signature)
        external
        returns (bool ok, bytes32 requestedModelHash, bytes32 servedModelHash, bytes32 responseHash);
}
