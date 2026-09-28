//! Chiron item E5: verify one Phala canonical ACI inference receipt
//! (`GET/POST` served by `private-ai-gateway`'s aggregator, Ed25519-signed)
//! onchain, in a Stylus contract, so a caller (`Assay.redeem`) can refuse
//! payment when the model actually served differs from the model requested.
//!
//! Receipt format and signing scheme, cited against
//! `github.com/Dstack-TEE/private-ai-gateway` commit
//! `fea9d0ed37b1807edb418f2a8c2b4151c6d1fdb0` (fetched 2026-09-28):
//!
//! - The signed document is the receipt payload in JCS (RFC 8785) form,
//!   without its `signature` member (`src/aci/receipt.rs:152-166` doc
//!   comment on `SignedReceipt`, `crates/aci-protocol/src/receipt.rs:9-14`
//!   `receipt_signing_input`). Because every member name is ASCII and every
//!   number is an integer (`crates/aci-protocol/src/digest.rs:34-44`,
//!   Appendix A), JCS here is exactly "compact JSON with object keys sorted
//!   lexicographically" — no float formatting, no UTF-16 collation to
//!   reproduce.
//! - The signature algorithm is fixed to Ed25519: `finalize()` rejects any
//!   receipt key whose `algo != ALGO_ED25519`
//!   (`src/aci/receipt.rs:421-425`), and `ALGO_ED25519` /
//!   `ed25519_dalek::VerifyingKey` are the only key types the key-provider
//!   module exposes (`src/aci/keys.rs:17,24`, `Cargo.toml:34`
//!   `ed25519-dalek = { version = "2", ... }`).
//! - The payload carries both model fields required for a substitution
//!   check: top-level `model` is the model the client requested
//!   (`src/aci/receipt.rs:140-144,179-181`: "the model the client
//!   requested"), and the `upstream.verified` event's `model_id` is the
//!   model the upstream actually served, recorded from the live response
//!   (`src/aci/receipt.rs:361-364,367-379`
//!   `set_upstream_verified_model_id`: "Record the model the upstream
//!   actually served"). That event also carries `result` (`"verified"` /
//!   `"failed"`, fail-closed default at `:78-93`) and the
//!   `response.returned` event carries `body_hash` as `"sha256:"+hex`
//!   (`:319-331`, digest format at `crates/aci-protocol/src/digest.rs:10-13`).
//!
//! So: format is Ed25519 over JCS bytes, and it carries both the requested
//! and served model. The build proceeds as specced.
//!
//! Division of labour vs `verifier/` (the existing TDX quote verifier in
//! this repo): that crate proves *an* attested enclave produced a key and
//! measurement; this crate proves *that enclave's aggregator* actually
//! routed to the requested model on a specific call. Assay.redeem would
//! bind a channel's registered signer (via `verifier/`) to a public key
//! registered *here* for receipt verification — see `solidity/design-note.md`.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

mod json;

use alloc::vec::Vec;
use ed25519_dalek::{Signature, Verifier as Ed25519Verifier, VerifyingKey};
use stylus_sdk::{
    alloy_primitives::{keccak256, Bytes, FixedBytes},
    prelude::*,
};

/// The result of a receipt that verified: hashes a caller binds a channel
/// or voucher to.
pub struct VerifiedReceipt {
    /// `keccak256` of the top-level `model` string (the model requested).
    pub requested_model_hash: [u8; 32],
    /// `keccak256` of the verified `upstream.verified` event's `model_id`
    /// string (the model actually served).
    pub served_model_hash: [u8; 32],
    /// The raw 32 bytes decoded from `response.returned`'s
    /// `"sha256:"+hex` `body_hash` field — already a digest Phala computed
    /// over the exact wire response bytes, not rehashed here.
    pub response_hash: [u8; 32],
}

/// Decode the ACI digest-field format `"sha256:" || 64 lowercase hex`
/// (`crates/aci-protocol/src/digest.rs:10-13`) into raw 32 bytes.
fn decode_sha256_digest(field: &[u8]) -> Option<[u8; 32]> {
    let hex = field.strip_prefix(b"sha256:")?;
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (hex_val(hex[i * 2])? << 4) | hex_val(hex[i * 2 + 1])?;
    }
    Some(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// The first `upstream.verified` event (§7.4/7.5 vocabulary) whose `result`
/// is `"verified"` — the served-model claim the aggregator's own upstream
/// check attested, not merely a routing decision. Returns the event
/// object's raw byte range.
fn find_verified_upstream_event(doc: &[u8], event_log_start: usize) -> Option<(usize, usize)> {
    json::find_array_element(doc, event_log_start, |b, es, ee| {
        let is_verified_type = matches!(
            json::find_string_member(b, es, "type"),
            Ok(Some(t)) if t == b"upstream.verified"
        );
        if !is_verified_type {
            return Ok(None);
        }
        let is_result_verified = matches!(
            json::find_string_member(b, es, "result"),
            Ok(Some(r)) if r == b"verified"
        );
        Ok(if is_result_verified { Some((es, ee)) } else { None })
    })
    .ok()
    .flatten()
}

fn find_response_returned_hash(doc: &[u8], event_log_start: usize) -> Option<[u8; 32]> {
    let (es, _ee) = json::find_array_element(doc, event_log_start, |b, es, ee| {
        let is_type = matches!(
            json::find_string_member(b, es, "type"),
            Ok(Some(t)) if t == b"response.returned"
        );
        Ok(if is_type { Some((es, ee)) } else { None })
    })
    .ok()
    .flatten()?;
    let hash_field = json::find_string_member(doc, es, "body_hash").ok().flatten()?;
    decode_sha256_digest(hash_field)
}

/// Verify `receipt_bytes` (the JCS document-without-`signature` bytes,
/// i.e. `aci_protocol::receipt::receipt_signing_input`'s output) against
/// `signature` under `pubkey`, then extract the requested/served model
/// hashes and the response digest. Returns `None` on any signature,
/// structural, or missing-field failure; never panics on malformed input.
///
/// `signature` must be exactly 64 bytes (Ed25519 `R || s`); any other
/// length is treated as a verification failure, not a revert, so a caller
/// can branch on the boolean uniformly.
pub fn verify_receipt_core(
    pubkey: &[u8; 32],
    receipt_bytes: &[u8],
    signature: &[u8],
) -> Option<VerifiedReceipt> {
    let sig_bytes: [u8; 64] = signature.try_into().ok()?;
    let vk = VerifyingKey::from_bytes(pubkey).ok()?;
    let sig = Signature::from_bytes(&sig_bytes);
    vk.verify(receipt_bytes, &sig).ok()?;

    // From here on `receipt_bytes` is exactly what Phala's TEE signed (the
    // signature could not otherwise verify), so it is well-formed ACI JSON.
    let doc = receipt_bytes;
    let api_version = json::find_string_member(doc, 0, "api_version").ok().flatten()?;
    if api_version != b"aci/1" {
        return None;
    }

    let requested_model = json::find_string_member(doc, 0, "model").ok().flatten()?;
    let requested_model_hash = keccak256(requested_model).0;

    let (event_log_start, _) = json::find_member(doc, 0, "event_log").ok().flatten()?;
    let (verified_start, _) = find_verified_upstream_event(doc, event_log_start)?;
    let served_model = json::find_string_member(doc, verified_start, "model_id")
        .ok()
        .flatten()?;
    let served_model_hash = keccak256(served_model).0;

    let response_hash = find_response_returned_hash(doc, event_log_start)?;

    Some(VerifiedReceipt {
        requested_model_hash,
        served_model_hash,
        response_hash,
    })
}

sol_storage! {
    #[entrypoint]
    pub struct ReceiptVerifier {}
}

#[public]
impl ReceiptVerifier {
    /// See [`verify_receipt_core`]. `pubkey` is the receipt-signing key's
    /// raw 32-byte Ed25519 public key; binding that key to a live TDX
    /// attestation (the `report_data` template in
    /// `crates/aci-protocol/src/identity.rs:44-78`) is a separate
    /// registration step, not implemented in this item (see
    /// `solidity/design-note.md`). Never reverts on a failed verification;
    /// the leading `bool` carries that so a caller can branch on it in one
    /// call instead of catching a revert.
    pub fn verify_receipt(
        &self,
        pubkey: FixedBytes<32>,
        receipt_bytes: Bytes,
        signature: Bytes,
    ) -> Result<(bool, FixedBytes<32>, FixedBytes<32>, FixedBytes<32>), Vec<u8>> {
        match verify_receipt_core(&pubkey.0, receipt_bytes.as_ref(), signature.as_ref()) {
            Some(v) => Ok((
                true,
                FixedBytes::from(v.requested_model_hash),
                FixedBytes::from(v.served_model_hash),
                FixedBytes::from(v.response_hash),
            )),
            None => Ok((false, FixedBytes::ZERO, FixedBytes::ZERO, FixedBytes::ZERO)),
        }
    }
}

#[cfg(test)]
mod contract_test {
    use super::*;
    use ed25519_dalek::Signer;
    use stylus_sdk::testing::*;

    /// Exercises the actual `#[public]` ABI method (`FixedBytes`/`Bytes`
    /// argument decoding, tuple return) through `TestVM`, not just the
    /// no_std core function `tests/vectors.rs` covers. Uses a hand-built
    /// receipt in the same JCS shape `tests/vectors.rs` documents in full.
    #[test]
    fn public_method_round_trips_genuine_and_tampered_receipts() {
        let vm = TestVM::default();
        let contract = ReceiptVerifier::from(&vm);

        let key = ed25519_dalek::SigningKey::from_bytes(&[0x11; 32]);
        let doc = br#"{"api_version":"aci/1","chat_id":"c","endpoint":"/v1/chat/completions","event_log":[{"body_hash":"sha256:aa","type":"request.received"},{"model_id":"served-model","required":true,"result":"verified","session_id":"s","type":"upstream.verified"},{"body_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","type":"response.returned"}],"key_id":"k","method":"POST","model":"requested-model","receipt_id":"r","served_at":1,"workload_keyset_digest":"sha256:d"}"#;
        let sig = key.sign(doc);

        let (ok, requested_hash, served_hash, response_hash) = contract
            .verify_receipt(
                FixedBytes::from(*key.verifying_key().as_bytes()),
                Bytes::from(doc.to_vec()),
                Bytes::from(sig.to_bytes().to_vec()),
            )
            .expect("call must not revert");
        assert!(ok);
        assert_ne!(requested_hash, served_hash);
        assert_eq!(requested_hash, FixedBytes::from(keccak256(b"requested-model").0));
        assert_ne!(response_hash, FixedBytes::ZERO);

        // A tampered signature (bit flip) must come back as a clean
        // `(false, 0, 0, 0)`, never a revert and never a panic.
        let mut bad_sig = sig.to_bytes();
        bad_sig[0] ^= 0x01;
        let (ok2, r2, s2, h2) = contract
            .verify_receipt(
                FixedBytes::from(*key.verifying_key().as_bytes()),
                Bytes::from(doc.to_vec()),
                Bytes::from(bad_sig.to_vec()),
            )
            .expect("call must not revert even on bad signature");
        assert!(!ok2);
        assert_eq!(r2, FixedBytes::ZERO);
        assert_eq!(s2, FixedBytes::ZERO);
        assert_eq!(h2, FixedBytes::ZERO);
    }
}
