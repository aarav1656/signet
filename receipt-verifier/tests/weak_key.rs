//! Re-review RR-6: verify_receipt_core uses ed25519-dalek's permissive `verify`,
//! which accepts the identity (small-order) public key with signature R=identity,
//! s=0 over ANY message. Safe behaviour: a forged receipt must not verify.
use receipt_verify::verify_receipt_core;

#[test]
fn identity_pubkey_forged_receipt_must_not_verify() {
    let mut identity = [0u8; 32];
    identity[0] = 1; // compressed Edwards identity point
    let mut sig = [0u8; 64];
    sig[0] = 1; // R = identity, s = 0
    let forged = br#"{"api_version":"aci/1","event_log":[{"body_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","type":"request.received"},{"model_id":"premium-model","result":"verified","type":"upstream.verified"},{"body_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","type":"response.returned"}],"model":"premium-model"}"#;
    assert!(
        verify_receipt_core(&identity, forged, &sig).is_none(),
        "attacker-authored receipt verified under a small-order key"
    );
}
