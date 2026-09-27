//! Red and robustness tests for SECURITY-REVIEW.md.
use assay_verify::Verifier;
use stylus_sdk::alloy_primitives::FixedBytes;
use stylus_sdk::testing::*;

fn quote(name: &str) -> Vec<u8> {
    let path = format!("{}/../fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
    hex::decode(std::fs::read_to_string(path).unwrap().trim()).unwrap()
}

/// The exact nonce Phala's legacy endpoint bound into quote_legacy1.hex's
/// report_data[32:64] (sliced directly from the fixture's raw bytes at that
/// offset; cross-checked against fixtures/legacy_report1.json's own fields).
/// H-3/structural tests below use a dummy/zero nonce deliberately: they must
/// fail on cert/signature/padding grounds regardless of nonce, before or
/// independent of any nonce comparison, so the nonce value they pass is not
/// load-bearing for what each test asserts.
const FIXTURE_NONCE: [u8; 32] =
    hex_literal_32(b"cbee07cdeb24f8cbb813ba99e40d8b14ed8de9ef64cf803f47e2d567b6c66d00");

const fn hex_val(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("bad hex digit"),
    }
}

const fn hex_literal_32(s: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = hex_val(s[i * 2]) * 16 + hex_val(s[i * 2 + 1]);
        i += 1;
    }
    out
}

/// 2026-09-26T00:00:00Z, inside quote_legacy1.hex's real PCK chain validity
/// window (confirmed via `openssl x509 -noout -dates` on the fixture's own
/// embedded certs: leaf 2026-03-21..2033-03-21).
const TEST_TIMESTAMP: u64 = 1_790_380_800;

fn vm_at_test_time() -> TestVM {
    let vm = TestVM::default();
    vm.set_block_timestamp(TEST_TIMESTAMP);
    vm
}

/// H-3 red: quote1.hex is a real, Intel-rooted quote from the SAME allowlisted image
/// but from the /v1/aci/attestation endpoint, whose report_data[0:20] is a hash, not
/// a key, and report_data[20:32] is non-zero. The verifier must reject a report_data
/// that is not `address || 12 zero bytes || nonce`. Today it returns a signer.
#[test]
fn red_h3_rejects_report_data_without_zero_padding() {
    let vm = vm_at_test_time();
    let v = Verifier::from(&vm);
    let raw = quote("quote1.hex");
    let rd = &raw[48 + 584 - 64..48 + 584];
    assert!(rd[20..32].iter().any(|b| *b != 0), "fixture precondition");
    assert!(
        v.verify(raw.into(), FixedBytes::ZERO).is_err(),
        "verifier accepted a non-legacy report_data layout"
    );
}

/// Green robustness: no truncation of a real quote panics. Every cut inside the
/// declared auth data errs; bytes after it are ignored (see Info-1), so those cuts
/// still verify.
#[test]
fn every_truncation_errs_without_panic() {
    let raw = quote("quote_legacy1.hex");
    let end = 636 + u32::from_le_bytes(raw[632..636].try_into().unwrap()) as usize;
    for n in 0..raw.len() {
        let vm = vm_at_test_time();
        let v = Verifier::from(&vm);
        let nonce = FixedBytes::from(FIXTURE_NONCE);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            v.verify(raw[..n].to_vec().into(), nonce)
        }));
        let r = r.unwrap_or_else(|_| panic!("len {n}: panic"));
        assert_eq!(r.is_ok(), n >= end, "len {n}");
    }
}

/// Green robustness: maximal u32 length fields error cleanly (on 64-bit hosts; on
/// wasm32 `off + len` wraps, see SECURITY-REVIEW.md L-2).
#[test]
fn max_length_fields_err_without_panic() {
    let base = quote("quote_legacy1.hex");
    for off in [632usize, 636 + 128 + 2] {
        let mut raw = base.clone();
        raw[off..off + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        let vm = vm_at_test_time();
        let v = Verifier::from(&vm);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            v.verify(raw.into(), FixedBytes::ZERO)
        }));
        assert!(matches!(r, Ok(Err(_))), "offset {off}");
    }
}
