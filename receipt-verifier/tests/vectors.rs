//! Real-vector tests for `verify_receipt_core`: an Ed25519 keypair is
//! generated in-process, a receipt document byte-for-byte matching Phala's
//! ACI JCS output (`aci-protocol/src/digest.rs`'s `sorted()`: object keys
//! lexicographically sorted, compact, ASCII-only) is signed, then verified.
//! Field values (hashes, session ids) are structurally valid placeholders;
//! the receipt-signing TEE, not this contract, is what vouches for their
//! provenance — this crate only proves the signature and pulls named
//! fields, so the test targets exactly that.

use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use receipt_verify::verify_receipt_core;

fn event_request_received(body_hash: &str) -> String {
    format!(r#"{{"body_hash":"{body_hash}","type":"request.received"}}"#)
}

fn event_request_forwarded(body_hash: &str) -> String {
    format!(r#"{{"body_hash":"{body_hash}","type":"request.forwarded"}}"#)
}

fn event_upstream_verified(model_id: &str, session_id: &str) -> String {
    format!(
        r#"{{"model_id":"{model_id}","required":true,"result":"verified","session_id":"{session_id}","type":"upstream.verified"}}"#
    )
}

fn event_upstream_verification_failed(model_id: &str, reason: &str) -> String {
    format!(
        r#"{{"model_id":"{model_id}","reason":"{reason}","required":true,"result":"failed","type":"upstream.verified"}}"#
    )
}

fn event_response_returned(body_hash: &str) -> String {
    format!(r#"{{"body_hash":"{body_hash}","type":"response.returned"}}"#)
}

const REQUEST_HASH: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESPONSE_HASH: &str = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SESSION_ID: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

/// Build the exact JCS canonical bytes (§7.2/§7.3) of an ACI receipt
/// document *without* its `signature` member — i.e. exactly what
/// `aci_protocol::receipt::receipt_signing_input` returns and what the TEE
/// signs (`src/aci/receipt.rs:443-444`).
fn build_receipt_document(requested_model: &str, verified_event: &str) -> Vec<u8> {
    let events = format!(
        "[{},{},{},{}]",
        event_request_received(REQUEST_HASH),
        event_request_forwarded(REQUEST_HASH),
        verified_event,
        event_response_returned(RESPONSE_HASH),
    );
    format!(
        r#"{{"api_version":"aci/1","chat_id":"chatcmpl-1","endpoint":"/v1/chat/completions","event_log":{events},"key_id":"phala-ed25519-1","method":"POST","model":"{requested_model}","receipt_id":"rcpt-1","served_at":1790000000,"workload_keyset_digest":"sha256:{}"}}"#,
        "ab".repeat(32)
    )
    .into_bytes()
}

fn genuine_receipt(requested_model: &str, served_model: &str) -> Vec<u8> {
    build_receipt_document(requested_model, &event_upstream_verified(served_model, SESSION_ID))
}

fn keccak256(bytes: &[u8]) -> [u8; 32] {
    stylus_sdk::alloy_primitives::keccak256(bytes).0
}

#[test]
fn genuine_receipt_verifies_and_extracts_matching_model_hashes() {
    let key = SigningKey::generate(&mut OsRng);
    let doc = genuine_receipt("deepseek-v3.1", "deepseek-v3.1");
    let sig = key.sign(&doc);

    let out = verify_receipt_core(key.verifying_key().as_bytes(), &doc, &sig.to_bytes())
        .expect("genuine receipt must verify");

    assert_eq!(out.requested_model_hash, keccak256(b"deepseek-v3.1"));
    assert_eq!(out.served_model_hash, keccak256(b"deepseek-v3.1"));
    assert_eq!(
        out.response_hash,
        hex_to_32(&RESPONSE_HASH["sha256:".len()..])
    );
}

#[test]
fn model_substitution_is_visible_as_differing_hashes() {
    // The exact failure mode item E5 targets: the router served a different
    // model than the client requested, and both survive as distinct fields
    // on a receipt whose signature still verifies (the TEE signs whatever
    // it actually did).
    let key = SigningKey::generate(&mut OsRng);
    let doc = genuine_receipt("requested-model-A", "actually-served-model-B");
    let sig = key.sign(&doc);

    let out = verify_receipt_core(key.verifying_key().as_bytes(), &doc, &sig.to_bytes())
        .expect("receipt must still verify; the substitution is a field mismatch, not a signature failure");

    assert_ne!(out.requested_model_hash, out.served_model_hash);
    assert_eq!(out.requested_model_hash, keccak256(b"requested-model-A"));
    assert_eq!(out.served_model_hash, keccak256(b"actually-served-model-B"));
}

#[test]
fn wrong_pubkey_fails_verification() {
    let signer_key = SigningKey::generate(&mut OsRng);
    let attacker_key = SigningKey::generate(&mut OsRng);
    let doc = genuine_receipt("m", "m");
    let sig = signer_key.sign(&doc);

    assert!(verify_receipt_core(attacker_key.verifying_key().as_bytes(), &doc, &sig.to_bytes()).is_none());
}

#[test]
fn tampered_model_field_fails_verification() {
    let key = SigningKey::generate(&mut OsRng);
    let doc = genuine_receipt("m", "m");
    let sig = key.sign(&doc);

    // Flip one byte inside the signed `model` value after signing: the
    // signature no longer covers these bytes.
    let mut tampered = doc.clone();
    let pos = tampered
        .windows(b"\"model\":\"m\"".len())
        .position(|w| w == b"\"model\":\"m\"")
        .unwrap();
    tampered[pos + 9] = b'x'; // the model value byte itself
    assert_ne!(tampered, doc);

    assert!(verify_receipt_core(key.verifying_key().as_bytes(), &tampered, &sig.to_bytes()).is_none());
}

#[test]
fn tampered_body_hash_fails_verification() {
    let key = SigningKey::generate(&mut OsRng);
    let doc = genuine_receipt("m", "m");
    let sig = key.sign(&doc);

    let mut tampered = doc.clone();
    let pos = tampered.windows(RESPONSE_HASH.len()).position(|w| w == RESPONSE_HASH.as_bytes()).unwrap();
    tampered[pos + 10] = b'0'; // inside the hex digest, not the "sha256:" prefix
    assert_ne!(tampered, doc);

    assert!(verify_receipt_core(key.verifying_key().as_bytes(), &tampered, &sig.to_bytes()).is_none());
}

#[test]
fn swapped_signature_from_a_different_receipt_fails() {
    let key = SigningKey::generate(&mut OsRng);
    let doc_a = genuine_receipt("model-a", "model-a");
    let doc_b = genuine_receipt("model-b", "model-b");
    let sig_a = key.sign(&doc_a);

    // sig_a is a genuine Ed25519 signature under this exact key; it simply
    // does not cover doc_b's bytes.
    assert!(verify_receipt_core(key.verifying_key().as_bytes(), &doc_b, &sig_a.to_bytes()).is_none());
}

#[test]
fn failed_upstream_verification_yields_no_served_model() {
    // §7.5: a required verification that failed carries `result: "failed"`
    // and no session; a relying party has no attested "what was served"
    // claim to check the requested model against, so extraction must fail
    // closed rather than silently return an unverified model_id.
    let key = SigningKey::generate(&mut OsRng);
    let doc = build_receipt_document(
        "requested-model",
        &event_upstream_verification_failed("requested-model", "quote verification failed"),
    );
    let sig = key.sign(&doc);

    assert!(verify_receipt_core(key.verifying_key().as_bytes(), &doc, &sig.to_bytes()).is_none());
}

#[test]
fn malformed_json_never_panics() {
    let key = SigningKey::generate(&mut OsRng);
    let doc = b"{not json".to_vec();
    let sig = key.sign(&doc);
    assert!(verify_receipt_core(key.verifying_key().as_bytes(), &doc, &sig.to_bytes()).is_none());
}

#[test]
fn wrong_length_signature_fails_without_panicking() {
    let key = SigningKey::generate(&mut OsRng);
    let doc = genuine_receipt("m", "m");
    assert!(verify_receipt_core(key.verifying_key().as_bytes(), &doc, &[0u8; 10]).is_none());
}

fn hex_to_32(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}
