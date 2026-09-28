//! Chiron: verify one real Phala legacy `GET /v1/attestation/report?nonce=...`
//! bundle's Intel TDX quote chain of trust in a Stylus contract, one transaction.
//! The canonical `/v1/aci/attestation` endpoint is NOT what this verifies: its
//! report_data commits to a nonce+keyset-digest hash with no raw address in it,
//! so it cannot key a payee registry the way `register()` needs. The legacy
//! endpoint's report_data instead carries `signing_address(20) || zero(12) ||
//! nonce(32)` verbatim (confirmed against `Dstack-TEE/private-ai-gateway`'s own
//! source and a live fetch, byte for byte; see `verify()` below), which is what
//! `signer` below is read from.
//!
//! Real bundle structure (fetched 2026-09-26, see ../attestation_raw_*.json): TDX
//! quote v4, ECDSA-P256 attestation key type, PCK cert chain (leaf, intermediate,
//! root) embedded in the quote as cert_type 5. There is NO NVIDIA GPU evidence in
//! this endpoint's response (see FINDINGS.md) so this verifies the TDX side only:
//!   1. PCK leaf cert signature verifies under the intermediate CA's pubkey (P-256)
//!   2. Intermediate CA cert signature verifies under Intel's SGX Root CA pubkey,
//!      hardcoded below from Phala-Network/dcap-qvl's TrustedRootCA.der (public,
//!      well-known Intel collateral, not a secret)
//!   3. qe_report signature verifies under the PCK leaf's pubkey (P-256)
//!   4. qe_report.report_data[0..32] == SHA256(attestation_key || qe_auth_data)
//!   5. ISV/quote signature (header||body, 632 bytes) verifies under the
//!      attestation key (P-256)
//! Byte layout and signed scopes match Phala-Network/dcap-qvl src/quote.rs and
//! src/verify.rs, confirmed against a real bundle in ../reference_verify.py.
//! TCB info / QE identity policy checks (need live Intel PCCS collateral) are out
//! of scope, per assay.md's fallback for collateral that does not fit.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::vec::Vec;
use p256::ecdsa::{signature::Verifier as SigVerifier, Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use stylus_sdk::{
    alloy_primitives::{keccak256, Address, Bytes, FixedBytes},
    prelude::*,
};

/// Reused verbatim from `receipt-verifier/src/json.rs` (same file, two
/// crates): a minimal, allocation-free structural JSON scanner. Here it
/// reads named fields out of a caller-supplied `workload_keyset` byte string
/// only after `verify_keyset` has already checked those exact bytes hash to
/// the digest the TEE itself committed into `report_data` (see
/// `verify_keyset` below), so a malicious byte string can never reach it
/// unless it also happens to be the real, attested keyset.
mod json;

/// TDReport10 body field offsets within `signed_scope` (48-byte header + 584-byte
/// body), per dcap-qvl's `TDReport10` struct (src/quote.rs): tee_tcb_svn(16) +
/// mr_seam(48) + mr_signer_seam(48) + seam_attributes(8) + td_attributes(8) +
/// xfam(8) = 136 bytes before mr_td.
const MRTD_OFFSET: usize = 48 + 136;
const RTMR0_OFFSET: usize = MRTD_OFFSET + 48 + 48 + 48 + 48; // skip mr_td, mr_config_id, mr_owner, mr_owner_config
const MR_LEN: usize = 48;
/// mr_seam(48) starts right after the 16-byte tee_tcb_svn, per the same field
/// order cited above.
const MR_SEAM_OFFSET: usize = 48 + 16;
/// td_attributes(8) sits after mr_seam(48) + mr_signer_seam(48) + seam_attributes(8).
const TD_ATTRIBUTES_OFFSET: usize = MR_SEAM_OFFSET + 48 + 48 + 8;
const XFAM_OFFSET: usize = TD_ATTRIBUTES_OFFSET + 8;
/// mr_config_id(48) immediately follows mr_td(48) in the field order the doc
/// comment above cites (mr_td, mr_config_id, mr_owner, mr_owner_config).
const MR_CONFIG_ID_OFFSET: usize = MRTD_OFFSET + MR_LEN;
/// M-1's expanded measurement folds mr_seam, td_attributes, xfam, mr_td,
/// mr_config_id and the 4 RTMRs: any change to the SEAM module, the TD's own
/// attribute/feature bitmask, or its config id now shifts the pinned image
/// hash, not just its RTMRs.
const MEASUREMENT_LEN: usize = 48 + 8 + 8 + 48 + 48 + 48 * 4;

const ENCLAVE_REPORT_LEN: usize = 384;
const TD_REPORT10_LEN: usize = 584;
const HEADER_LEN: usize = 48;
const SIG_LEN: usize = 64;
const PUBKEY_LEN: usize = 64;

/// Intel SGX Root CA public key (raw X||Y, 64 bytes), extracted from the
/// well-known, publicly published `TrustedRootCA.der`
/// (Phala-Network/dcap-qvl src/TrustedRootCA.der; same cert Intel itself
/// publishes at certificates.trustedservices.intel.com). Not a secret: this is
/// the trust anchor every DCAP verifier (Intel's own, Automata's, dcap-qvl) hardcodes.
const INTEL_ROOT_PUBKEY: [u8; 64] = hex_literal_64(
    "0ba9c4c0c0c86193a3fe23d6b02cda10a8bbd4e88e48b4458561a36e705525f5",
    "6791 8e2edc88e40d860bd0cc4ee26aacc988e505a953558c453f6b0904ae7394",
);

// Concatenate two hex-string halves at const-eval time into a 64-byte array.
// (The Intel root pubkey is 65 bytes 04||X||Y in the cert; X and Y below,
// whitespace in the literals is ignored.)
const fn hex_val(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0,
    }
}

const fn hex_literal_64(x_hex: &str, y_hex: &str) -> [u8; 64] {
    let xb = x_hex.as_bytes();
    let yb = y_hex.as_bytes();
    let mut out = [0u8; 64];
    let mut oi = 0usize;
    let mut i = 0usize;
    while i + 1 < xb.len() {
        if xb[i] == b' ' {
            i += 1;
            continue;
        }
        out[oi] = (hex_val(xb[i]) << 4) | hex_val(xb[i + 1]);
        oi += 1;
        i += 2;
    }
    let mut i = 0usize;
    while i + 1 < yb.len() {
        if yb[i] == b' ' {
            i += 1;
            continue;
        }
        out[oi] = (hex_val(yb[i]) << 4) | hex_val(yb[i + 1]);
        oi += 1;
        i += 2;
    }
    out
}

// ---------------------------------------------------------------------------
// Minimal DER TLV walker (just enough to pull tbsCertificate / signature /
// subjectPublicKeyInfo out of a real X.509 cert; no ASN.1 schema library).
// ---------------------------------------------------------------------------

struct Tlv<'a> {
    content: &'a [u8],
    total_len: usize,
}

/// `usize` is 32 bits on wasm32; a length field taken straight off attacker
/// bytes (up to 4 bytes, so up to 0xFFFFFFFF) can wrap `start + len` on that
/// target even though it never wraps in a `cargo test` host build. Every place
/// that turns an attacker-controlled length into a slice bound goes through
/// this instead of `+`.
fn checked_end(start: usize, len: usize) -> Result<usize, Vec<u8>> {
    start.checked_add(len).ok_or_else(|| b"LengthOverflow".to_vec())
}

fn read_tlv(data: &[u8]) -> Result<Tlv<'_>, Vec<u8>> {
    if data.len() < 2 {
        return Err(b"DerTooShort".to_vec());
    }
    let len_byte = data[1];
    let (content_len, header_len) = if len_byte & 0x80 == 0 {
        (len_byte as usize, 2usize)
    } else {
        let n = (len_byte & 0x7f) as usize;
        if n == 0 || n > 4 || data.len() < 2 + n {
            return Err(b"DerBadLen".to_vec());
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | data[2 + i] as usize;
        }
        (len, 2 + n)
    };
    let end = checked_end(header_len, content_len)?;
    if data.len() < end {
        return Err(b"DerTruncated".to_vec());
    }
    Ok(Tlv {
        content: &data[header_len..end],
        total_len: end,
    })
}

/// Returns the n-th top-level TLV (0-indexed) inside `content`, by walking
/// sequentially from the start (every DER element, including context tags
/// like the certificate `[0] version`, is a well-formed TLV).
fn nth_element(content: &[u8], n: usize) -> Result<Tlv<'_>, Vec<u8>> {
    let mut pos = 0usize;
    let mut idx = 0usize;
    loop {
        let tlv = read_tlv(&content[pos..])?;
        if idx == n {
            return Ok(tlv);
        }
        pos += tlv.total_len;
        idx += 1;
        if pos > content.len() {
            return Err(b"DerOutOfRange".to_vec());
        }
    }
}

fn int_to_32(bytes: &[u8]) -> Result<[u8; 32], Vec<u8>> {
    let mut out = [0u8; 32];
    if bytes.len() == 32 {
        out.copy_from_slice(bytes);
    } else if bytes.len() == 33 && bytes[0] == 0 {
        out.copy_from_slice(&bytes[1..]);
    } else if bytes.len() < 32 {
        out[32 - bytes.len()..].copy_from_slice(bytes);
    } else {
        return Err(b"BadDerInteger".to_vec());
    }
    Ok(out)
}

/// Parse a DER `SEQUENCE { r INTEGER, s INTEGER }` (the content of an ECDSA
/// signature BIT STRING, after the leading unused-bits byte) into raw r||s.
fn parse_ecdsa_der_sig(der_seq: &[u8]) -> Result<[u8; 64], Vec<u8>> {
    let top = read_tlv(der_seq)?;
    let r_tlv = nth_element(top.content, 0)?;
    let s_tlv = nth_element(top.content, 1)?;
    let r = int_to_32(r_tlv.content)?;
    let s = int_to_32(s_tlv.content)?;
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&r);
    out[32..].copy_from_slice(&s);
    Ok(out)
}

/// One parsed X.509 cert: the exact tbsCertificate bytes (what the issuer
/// signed), the raw r||s signature over them, this cert's own raw P-256 public
/// key (X||Y, 64 bytes) so it can verify its own subject's signatures, and its
/// validity window as unix seconds (H-2: an expired or not-yet-valid PCK leaf
/// or intermediate must not verify).
struct ParsedCert<'a> {
    tbs_bytes: &'a [u8],
    signature: [u8; 64],
    pubkey_xy: [u8; 64],
    not_before: u64,
    not_after: u64,
}

/// Returns (tag, Tlv) for the n-th top-level element inside `content`, same
/// walk as `nth_element` but also surfaces the tag byte, needed to tell
/// UTCTime (0x17) from GeneralizedTime (0x18) in a `Validity` SEQUENCE.
fn nth_element_tagged(content: &[u8], n: usize) -> Result<(u8, Tlv<'_>), Vec<u8>> {
    let mut pos = 0usize;
    let mut idx = 0usize;
    loop {
        if pos >= content.len() {
            return Err(b"DerOutOfRange".to_vec());
        }
        let tag = content[pos];
        let tlv = read_tlv(&content[pos..])?;
        if idx == n {
            return Ok((tag, tlv));
        }
        pos = checked_end(pos, tlv.total_len)?;
        idx += 1;
    }
}

fn ascii_digit(b: u8) -> Result<u64, Vec<u8>> {
    if b.is_ascii_digit() {
        Ok((b - b'0') as u64)
    } else {
        Err(b"BadTimeDigit".to_vec())
    }
}

fn parse_digits(s: &[u8], off: usize, n: usize) -> Result<u64, Vec<u8>> {
    if s.len() < off + n {
        return Err(b"TimeTooShort".to_vec());
    }
    let mut v = 0u64;
    for i in 0..n {
        v = v * 10 + ascii_digit(s[off + i])?;
    }
    Ok(v)
}

/// Days since the Unix epoch for a civil (Y-M-D) date, Howard Hinnant's
/// `days_from_civil` algorithm (proleptic Gregorian, valid for any date this
/// certificate chain could plausibly carry).
fn days_from_civil(y: i64, m: u64, d: u64) -> Result<i64, Vec<u8>> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(b"BadDate".to_vec());
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m as i64 + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Ok(era * 146097 + doe - 719468)
}

/// ASN.1 `Time` (UTCTime tag 0x17, `YYMMDDHHMMSSZ`, or GeneralizedTime tag
/// 0x18, `YYYYMMDDHHMMSSZ`) to unix seconds. Both Intel's PCK certs and CAs
/// use one of these two forms with a bare `Z` (UTC, no fractional seconds,
/// no explicit offset), confirmed against the fixture chain.
fn asn1_time_to_unix(tag: u8, content: &[u8]) -> Result<u64, Vec<u8>> {
    if content.last() != Some(&b'Z') {
        return Err(b"UnsupportedTimeFormat".to_vec());
    }
    let digits = &content[..content.len() - 1];
    let (year, rest_off) = match tag {
        0x17 => {
            if digits.len() != 12 {
                return Err(b"BadUtcTimeLen".to_vec());
            }
            let yy = parse_digits(digits, 0, 2)?;
            (if yy < 50 { 2000 + yy as i64 } else { 1900 + yy as i64 }, 2)
        }
        0x18 => {
            if digits.len() != 14 {
                return Err(b"BadGeneralizedTimeLen".to_vec());
            }
            (parse_digits(digits, 0, 4)? as i64, 4)
        }
        _ => return Err(b"UnsupportedTimeTag".to_vec()),
    };
    let month = parse_digits(digits, rest_off, 2)?;
    let day = parse_digits(digits, rest_off + 2, 2)?;
    let hour = parse_digits(digits, rest_off + 4, 2)?;
    let minute = parse_digits(digits, rest_off + 6, 2)?;
    let second = parse_digits(digits, rest_off + 8, 2)?;
    let days = days_from_civil(year, month, day)?;
    if days < 0 {
        return Err(b"BadDate".to_vec());
    }
    Ok(days as u64 * 86400 + hour * 3600 + minute * 60 + second)
}

fn parse_x509_cert(der: &[u8]) -> Result<ParsedCert<'_>, Vec<u8>> {
    let top = read_tlv(der)?; // outer SEQUENCE { tbsCertificate, sigAlg, sigValue }
    let seq_content = top.content;

    let tbs_tlv = nth_element(seq_content, 0)?;
    let tbs_total_len = tbs_tlv.total_len;
    let tbs_bytes = &seq_content[..tbs_total_len];

    let sigval_tlv = nth_element(seq_content, 2)?; // BIT STRING
    if sigval_tlv.content.is_empty() {
        return Err(b"EmptySignature".to_vec());
    }
    let signature = parse_ecdsa_der_sig(&sigval_tlv.content[1..])?; // skip unused-bits byte

    // tbsCertificate content, [0] version present (always true for Intel
    // PCK/CA certs, which are all v3): 0 version, 1 serialNumber, 2
    // signatureAlgorithm, 3 issuer, 4 validity, 5 subject, 6 subjectPublicKeyInfo.
    let tbs_content = tbs_tlv.content;

    let validity_tlv = nth_element(tbs_content, 4)?;
    let (nb_tag, nb_tlv) = nth_element_tagged(validity_tlv.content, 0)?;
    let (na_tag, na_tlv) = nth_element_tagged(validity_tlv.content, 1)?;
    let not_before = asn1_time_to_unix(nb_tag, nb_tlv.content)?;
    let not_after = asn1_time_to_unix(na_tag, na_tlv.content)?;

    let spki_tlv = nth_element(tbs_content, 6)?;
    let alg_id_tlv = nth_element(spki_tlv.content, 0)?;
    let pubkey_bitstring = nth_element(spki_tlv.content, 1)?;
    let _ = alg_id_tlv;
    if pubkey_bitstring.content.len() != 66 {
        // 1 unused-bits byte + 0x04 prefix + 32 + 32
        return Err(b"BadPubkeyLen".to_vec());
    }
    let mut pubkey_xy = [0u8; 64];
    pubkey_xy.copy_from_slice(&pubkey_bitstring.content[2..66]);

    Ok(ParsedCert {
        tbs_bytes,
        signature,
        pubkey_xy,
        not_before,
        not_after,
    })
}

// ---------------------------------------------------------------------------
// Minimal base64 (for PEM cert extraction) and PEM cert splitting.
// ---------------------------------------------------------------------------

fn b64_val(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn b64_decode(s: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &c in s {
        if c == b'=' {
            break;
        }
        if let Some(v) = b64_val(c) {
            buf = (buf << 6) | v as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buf >> bits) as u8);
            }
        }
    }
    out
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    for i in 0..=(haystack.len() - needle.len()) {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
    }
    None
}

/// Extract every `-----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----`
/// block from a PEM chain, base64-decoded to DER, in order (leaf first, per
/// the quote's cert_type 5 body).
fn extract_pem_certs(pem: &[u8]) -> Result<Vec<Vec<u8>>, Vec<u8>> {
    const BEGIN: &[u8] = b"-----BEGIN CERTIFICATE-----";
    const END: &[u8] = b"-----END CERTIFICATE-----";
    let mut certs = Vec::new();
    let mut pos = 0usize;
    while let Some(b_off) = find_subslice(&pem[pos..], BEGIN) {
        let body_start = pos + b_off + BEGIN.len();
        let e_off = find_subslice(&pem[body_start..], END).ok_or(b"UnterminatedPem".to_vec())?;
        let body = &pem[body_start..body_start + e_off];
        certs.push(b64_decode(body));
        pos = body_start + e_off + END.len();
    }
    if certs.is_empty() {
        return Err(b"NoCertsFound".to_vec());
    }
    Ok(certs)
}

// ---------------------------------------------------------------------------
// P-256 ECDSA verify (message hashed with SHA-256 internally by the `ecdsa`
// crate's default P-256 digest).
// ---------------------------------------------------------------------------

fn verify_p256(pubkey_xy: &[u8; 64], msg: &[u8], sig_rs: &[u8; 64]) -> Result<(), Vec<u8>> {
    let mut sec1 = [0u8; 65];
    sec1[0] = 0x04;
    sec1[1..].copy_from_slice(pubkey_xy);
    let vk = VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| b"BadPubkey".to_vec())?;
    let sig = Signature::from_slice(sig_rs).map_err(|_| b"BadSigEncoding".to_vec())?;
    vk.verify(msg, &sig).map_err(|_| b"SignatureInvalid".to_vec())
}

// ---------------------------------------------------------------------------
// Quote parsing (dcap-qvl AuthDataV4 / QEReportCertificationData layout).
// ---------------------------------------------------------------------------

struct QuoteParts<'a> {
    signed_scope: &'a [u8], // header || TD report body (632 bytes for TDX v4)
    ecdsa_signature: [u8; 64],
    ecdsa_attestation_key: [u8; 64],
    qe_report: &'a [u8],           // 384 bytes, EnclaveReport
    qe_report_signature: [u8; 64],
    qe_auth_data: &'a [u8],
    pck_chain_pem: &'a [u8],
}

fn read_u16_le(d: &[u8]) -> usize {
    (d[0] as usize) | ((d[1] as usize) << 8)
}
fn read_u32_le(d: &[u8]) -> usize {
    (d[0] as usize) | ((d[1] as usize) << 8) | ((d[2] as usize) << 16) | ((d[3] as usize) << 24)
}

fn parse_quote(raw: &[u8]) -> Result<QuoteParts<'_>, Vec<u8>> {
    if raw.len() < HEADER_LEN + TD_REPORT10_LEN + 4 {
        return Err(b"QuoteTooShort".to_vec());
    }
    let version = read_u16_le(&raw[0..2]);
    let att_key_type = read_u16_le(&raw[2..4]);
    let tee_type = read_u32_le(&raw[4..8]);
    if version != 4 {
        return Err(b"UnsupportedQuoteVersion".to_vec());
    }
    if tee_type != 0x81 {
        return Err(b"NotTdx".to_vec());
    }
    if att_key_type != 2 {
        return Err(b"NotEcdsaP256".to_vec());
    }

    let signed_len = HEADER_LEN + TD_REPORT10_LEN;
    let signed_scope = &raw[..signed_len];

    let mut off = signed_len;
    let auth_len = read_u32_le(&raw[off..off + 4]);
    off += 4;
    let auth_end = checked_end(off, auth_len)?;
    if raw.len() < auth_end {
        return Err(b"AuthDataTruncated".to_vec());
    }
    let auth = &raw[off..auth_end];

    let mut a = 0usize;
    if auth.len() < SIG_LEN + PUBKEY_LEN + 6 {
        return Err(b"AuthDataTooShort".to_vec());
    }
    let mut ecdsa_signature = [0u8; 64];
    ecdsa_signature.copy_from_slice(&auth[a..a + SIG_LEN]);
    a += SIG_LEN;
    let mut ecdsa_attestation_key = [0u8; 64];
    ecdsa_attestation_key.copy_from_slice(&auth[a..a + PUBKEY_LEN]);
    a += PUBKEY_LEN;

    let outer_cert_type = read_u16_le(&auth[a..a + 2]);
    let outer_len = read_u32_le(&auth[a + 2..a + 6]);
    a += 6;
    // cert_type 6 == "QE Report Certification Data" (DCAP spec): the body IS
    // the QEReportCertificationData struct we parse below, which itself
    // nests a cert_type-5 (concatenated PCK cert chain) blob. Confirmed
    // against the real fetched bundle (outer type 6, inner type 5).
    if outer_cert_type != 6 {
        return Err(b"UnsupportedOuterCertType".to_vec());
    }
    let outer_end = checked_end(a, outer_len)?;
    if auth.len() < outer_end {
        return Err(b"OuterCertBodyTruncated".to_vec());
    }
    let cert_body = &auth[a..outer_end]; // this IS QEReportCertificationData, per dcap-qvl AuthDataV4::decode

    let mut b = 0usize;
    if cert_body.len() < ENCLAVE_REPORT_LEN + SIG_LEN + 2 {
        return Err(b"CertBodyTooShort".to_vec());
    }
    let qe_report = &cert_body[b..b + ENCLAVE_REPORT_LEN];
    b += ENCLAVE_REPORT_LEN;
    let mut qe_report_signature = [0u8; 64];
    qe_report_signature.copy_from_slice(&cert_body[b..b + SIG_LEN]);
    b += SIG_LEN;
    let qe_auth_len = read_u16_le(&cert_body[b..b + 2]);
    b += 2;
    let qe_auth_end = checked_end(b, qe_auth_len)?;
    if cert_body.len() < checked_end(qe_auth_end, 6)? {
        return Err(b"QeAuthDataTruncated".to_vec());
    }
    let qe_auth_data = &cert_body[b..qe_auth_end];
    b = qe_auth_end;
    let inner_cert_type = read_u16_le(&cert_body[b..b + 2]);
    let inner_len = read_u32_le(&cert_body[b + 2..b + 6]);
    b += 6;
    if inner_cert_type != 5 {
        return Err(b"UnsupportedInnerCertType".to_vec());
    }
    let inner_end = checked_end(b, inner_len)?;
    if cert_body.len() < inner_end {
        return Err(b"PckChainTruncated".to_vec());
    }
    let pck_chain_pem = &cert_body[b..inner_end];

    Ok(QuoteParts {
        signed_scope,
        ecdsa_signature,
        ecdsa_attestation_key,
        qe_report,
        qe_report_signature,
        qe_auth_data,
        pck_chain_pem,
    })
}

/// Shared DCAP quote-chain verification: PCK chain to Intel's hardcoded
/// root, qe_report signature, ISV/quote signature, M-1's DEBUG-attribute
/// rejection, H-2's cert validity-window check, and the nine-field M-1
/// measurement. Used by both `verify()` (legacy endpoint) and
/// `verify_keyset()` (canonical `/v1/aci/attestation` endpoint) below: the
/// DCAP crypto is identical either way, only the *interpretation* of the TD
/// report's own `report_data` field differs per endpoint (raw address vs. a
/// digest commitment), so it lives once here instead of being duplicated
/// into a second Stylus binary (receipt-verifier is already at 19.2KB of
/// the 24KB Stylus limit; growing this crate in place instead of adding a
/// third one keeps both under budget).
///
/// Returns the TD report's own raw 64-byte `report_data` field verbatim
/// (last 64 bytes of the 584-byte TDReport10 body) plus the measurement.
/// Reverts (returns `Err`) on any structural or cryptographic failure.
fn verify_dcap_chain(quote: &[u8], now: u64) -> Result<([u8; 64], FixedBytes<32>), Vec<u8>> {
    let q = parse_quote(quote)?;

    // M-1: TDATTRIBUTES bit 0 is DEBUG (Intel TDX Module Base Architecture
    // Specification, section "TDATTRIBUTES", field is little-endian so bit 0
    // is the low bit of byte 0). A debug TD lets the host inspect/alter its
    // memory at will, so every measurement it could produce is unverifiable
    // and must be rejected outright, not merely flagged.
    if q.signed_scope.len() < XFAM_OFFSET + 8 {
        return Err(b"SignedScopeTooShort".to_vec());
    }
    let td_attributes = &q.signed_scope[TD_ATTRIBUTES_OFFSET..TD_ATTRIBUTES_OFFSET + 8];
    if td_attributes[0] & 0x01 != 0 {
        return Err(b"DebugAttributeSet".to_vec());
    }

    let certs_der = extract_pem_certs(q.pck_chain_pem)?;
    if certs_der.len() < 2 {
        return Err(b"ChainTooShort".to_vec());
    }
    let leaf = parse_x509_cert(&certs_der[0])?;
    let intermediate = parse_x509_cert(&certs_der[1])?;

    // H-2: reject an expired or not-yet-valid PCK leaf/intermediate. TCB
    // status, QE identity and PCK CRL checks still need live Intel PCCS
    // collateral this contract does not fetch; see README's security table
    // for exactly what that leaves unchecked.
    if now < leaf.not_before || now > leaf.not_after {
        return Err(b"LeafCertNotValid".to_vec());
    }
    if now < intermediate.not_before || now > intermediate.not_after {
        return Err(b"IntermediateCertNotValid".to_vec());
    }

    // 1. leaf signed by intermediate
    verify_p256(&intermediate.pubkey_xy, leaf.tbs_bytes, &leaf.signature)?;

    // 2. intermediate signed by Intel's hardcoded SGX Root CA pubkey
    verify_p256(&INTEL_ROOT_PUBKEY, intermediate.tbs_bytes, &intermediate.signature)?;

    // 3. qe_report signed by the PCK leaf's pubkey
    verify_p256(&leaf.pubkey_xy, q.qe_report, &q.qe_report_signature)?;

    // 4. qe_report.report_data[0..32] == SHA256(attestation_key || qe_auth_data)
    let mut hasher = Sha256::new();
    hasher.update(q.ecdsa_attestation_key);
    hasher.update(q.qe_auth_data);
    let expect: [u8; 32] = hasher.finalize().into();
    if q.qe_report.len() < 32 || &q.qe_report[q.qe_report.len() - 64..q.qe_report.len() - 32] != expect {
        return Err(b"QeReportDataMismatch".to_vec());
    }

    // 5. ISV/quote signature: attestation key signs header||body
    verify_p256(&q.ecdsa_attestation_key, q.signed_scope, &q.ecdsa_signature)?;

    if q.signed_scope.len() < RTMR0_OFFSET + 3 * MR_LEN + MR_LEN + 64 {
        return Err(b"SignedScopeTooShort".to_vec());
    }
    // M-1: measurement = keccak256(mr_seam || td_attributes || xfam || mr_td
    // || mr_config_id || rtmr0 || rtmr1 || rtmr2 || rtmr3). Folding in
    // mr_seam/td_attributes/xfam/mr_config_id means a swapped SEAM module or
    // a changed TD feature/config bitmask now changes the pinned image hash
    // too, not just a docker-compose RTMR3 change.
    let mut measurement_input = [0u8; MEASUREMENT_LEN];
    let mut off = 0usize;
    measurement_input[off..off + MR_LEN].copy_from_slice(&q.signed_scope[MR_SEAM_OFFSET..MR_SEAM_OFFSET + MR_LEN]);
    off += MR_LEN;
    measurement_input[off..off + 8].copy_from_slice(td_attributes);
    off += 8;
    measurement_input[off..off + 8].copy_from_slice(&q.signed_scope[XFAM_OFFSET..XFAM_OFFSET + 8]);
    off += 8;
    measurement_input[off..off + MR_LEN].copy_from_slice(&q.signed_scope[MRTD_OFFSET..MRTD_OFFSET + MR_LEN]);
    off += MR_LEN;
    measurement_input[off..off + MR_LEN]
        .copy_from_slice(&q.signed_scope[MR_CONFIG_ID_OFFSET..MR_CONFIG_ID_OFFSET + MR_LEN]);
    off += MR_LEN;
    for i in 0..4 {
        let src = RTMR0_OFFSET + i * MR_LEN;
        measurement_input[off + i * MR_LEN..off + (i + 1) * MR_LEN]
            .copy_from_slice(&q.signed_scope[src..src + MR_LEN]);
    }
    let measurement = keccak256(measurement_input);

    let mut report_data = [0u8; 64];
    report_data.copy_from_slice(&q.signed_scope[RTMR0_OFFSET + 4 * MR_LEN..RTMR0_OFFSET + 4 * MR_LEN + 64]);
    Ok((report_data, FixedBytes::from(measurement)))
}

/// `bytes` as lowercase ASCII hex, no `0x` prefix, matching both Rust's
/// `hex::encode` and Solidity's `Strings.toHexString`/`_hex64` conventions
/// used throughout this repo (e.g. `Assay.sol`'s own `_hex64`).
fn hex64(bytes: &[u8]) -> Vec<u8> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize]);
        out.push(HEX[(b & 0x0f) as usize]);
    }
    out
}

/// Read a top-level JSON integer member (ASCII digits only, per the ACI
/// spec's Appendix A integer-only number constraint) as `u64`.
fn find_u64_member(b: &[u8], obj_start: usize, key: &str) -> Result<Option<u64>, json::JsonError> {
    match json::find_member(b, obj_start, key)? {
        None => Ok(None),
        Some((s, e)) => {
            let mut v: u64 = 0;
            for &c in &b[s..e] {
                if !c.is_ascii_digit() {
                    return Err(json::JsonError);
                }
                v = v.saturating_mul(10).saturating_add((c - b'0') as u64);
            }
            Ok(Some(v))
        }
    }
}

sol_storage! {
    #[entrypoint]
    pub struct Verifier {}
}

#[public]
impl Verifier {
    /// Verify one real Phala legacy `GET /v1/attestation/report?nonce=...` TDX
    /// quote end to end (PCK chain to Intel's hardcoded root, qe_report,
    /// ISV/quote signature) and return (a) `signer`, the TD report's own
    /// `report_data[0..20]` read as a raw 20-byte Ethereum address, the real
    /// secp256k1 key Phala's gateway signs per-response receipts with, not a
    /// fingerprint of the Quoting Enclave's ephemeral attestation key, and (b)
    /// `measurement`: keccak256(mr_seam || td_attributes || xfam || MRTD ||
    /// mr_config_id || RTMR0 || RTMR1 || RTMR2 || RTMR3), nine TD report
    /// fields, so a caller can pin payment to a specific image (RTMR3 carries
    /// the compose-hash of the deployed docker-compose.yaml, per
    /// docs.phala.com/phala-cloud/attestation/verify-your-application; the
    /// other eight fields mean a swapped SEAM module or a changed TD
    /// feature/config bitmask also changes the pinned hash, not just a
    /// docker-compose edit).
    /// Reverts (returns Err) on any structural or cryptographic failure.
    ///
    /// `nonce` (H-2) is the caller-supplied freshness value: Assay.sol computes
    /// `nextRegisterNonce(provider)` from an on-chain, per-provider monotonic
    /// counter, the provider fetches a quote from Phala's legacy endpoint with
    /// that exact value as `?nonce=`, and this function checks it was actually
    /// bound into the quote's own signed report_data (not just passed as a
    /// calldata argument nobody checked), closing the stale-quote replay this
    /// review's H-2 finding described.
    pub fn verify(&self, quote: Bytes, nonce: FixedBytes<32>) -> Result<(Address, FixedBytes<32>), Vec<u8>> {
        let now = self.vm().block_timestamp();
        let (report_data, measurement) = verify_dcap_chain(quote.as_ref(), now)?;

        // signer = report_data[0..20], read as a raw 20-byte Ethereum address.
        //
        // The QE's ephemeral attestation key (checked above, chained to Intel's root)
        // proves the quote is genuine; it is not the payee key, since nobody outside
        // Intel's Quoting Enclave holds its private half. The actual application key
        // is the one Phala's gateway commits to in the TD report's own `report_data`
        // field (last 64 bytes of the 584-byte body, distinct from the QE report-data
        // binding checked above): confirmed against Phala's own gateway source
        // (github.com/Dstack-TEE/private-ai-gateway, src/aci/keys.rs, `get_quote_raw`
        // doc comment: "the legacy dstack-vllm-proxy compatibility report uses this to
        // bind `signing_address ‖ zeros ‖ nonce` exactly"), and reproduced live against
        // `GET /v1/attestation/report?nonce=...` (2026-09-26, no API key required for
        // this endpoint): report_data == signing_address (20 bytes) || zero (12 bytes)
        // || nonce (32 bytes), byte-for-byte equal to the JSON's own top-level
        // `signing_address` field (see fixtures/legacy_report1.json).
        // That address is the E2EE/legacy secp256k1 key the gateway actually signs
        // per-response receipts with (dstack.rs `sign_legacy_message`), so it is a real
        // payee identity, not a fingerprint. The canonical `/v1/aci/attestation`
        // endpoint's report_data instead commits to a nonce+keyset-digest hash and does
        // NOT carry a raw address; see `verify_keyset` below for that path.
        // H-2: report_data == signing_address(20) || zero(12) || nonce(32), per
        // Phala's legacy endpoint layout cited above. The zero padding must
        // actually be zero (M-1's report_data structural check) and the last 32
        // bytes must equal the exact nonce Assay.sol minted for this register()
        // call, not merely "some 32 bytes the caller also happened to pass in" -
        // otherwise a quote fetched for a stale/foreign nonce could be replayed.
        if report_data[20..32].iter().any(|&b| b != 0) {
            return Err(b"ReportDataPaddingNotZero".to_vec());
        }
        if &report_data[32..64] != nonce.as_slice() {
            return Err(b"NonceMismatch".to_vec());
        }

        Ok((Address::from_slice(&report_data[0..20]), measurement))
    }

    /// Verify one real Phala CANONICAL `GET /v1/aci/attestation?nonce=...` TDX
    /// quote end to end (the same DCAP chain as `verify()` above, via
    /// `verify_dcap_chain`) and additionally check the TD report's
    /// `report_data` commits to the caller-supplied `keyset_bytes` via
    /// Phala's own binding mechanism, then that `pubkey` is one of that
    /// keyset's live receipt-signing keys.
    ///
    /// Binding mechanism (cited, not invented; `Dstack-TEE/private-ai-gateway`
    /// commit `fea9d0ed37b1807edb418f2a8c2b4151c6d1fdb0`):
    /// `crates/aci-protocol/src/identity.rs` `REPORT_DATA_PURPOSE` (="aci.report_data.v1"),
    /// `attestation_statement` (builds the ASCII JSON
    /// `{"keyset_digest":"sha256:<hex>","nonce":"<nonce>","purpose":"aci.report_data.v1"}`,
    /// keys already in the sorted order JCS would produce since the ACI spec
    /// (Appendix A) restricts every field to ASCII strings/integers), and
    /// `report_data`/`report_data_slot` (= `sha256(statement) || zero(32)`,
    /// placed verbatim in the TD report's `report_data` field). Independently
    /// confirmed as the real wire shape via `crates/aci-verify/src/report.rs`'s
    /// `verify_report_binding` (recomputes this exact digest and compares it
    /// to the reported `report_data`) and `src/aggregator/service/e2ee.rs`'s
    /// `assemble_report`/`attestation_report_for_domain` (builds this exact
    /// statement before calling the quoter) -- and reproduced live against a
    /// real `GET /v1/aci/attestation?nonce=<chosen>` fetch (see
    /// `fixtures/aci_attestation1.json`/`aci_attestation1_nonce.txt`): this
    /// crate's own test `test_real_aci_bundle_verifies_keyset` recomputes the
    /// identical digest in Rust and it matches the live response's
    /// `attestation.report_data` field byte for byte.
    ///
    /// No JCS canonicalization is implemented on-chain: `keyset_bytes` is
    /// hashed exactly as supplied. If a caller's local canonicalization of
    /// `workload_keyset` is wrong, the digest simply will not match what the
    /// TEE actually signed and this call reverts -- correctness is enforced
    /// by the equality check, not by re-deriving JCS on-chain.
    ///
    /// `pubkey` (a raw 32-byte Ed25519 public key) must appear in
    /// `keyset_bytes`'s `receipt_signing_keys` array with `"algo":"ed25519"`
    /// and a lowercase-hex `public_key` equal to `pubkey`
    /// (`crates/aci-protocol/src/types.rs` `WorkloadKeyset`/`KeyedPublicKey`),
    /// and the keyset's own top-level `not_after` (unix seconds) must not
    /// have passed (`WorkloadKeyset::is_expired_at`), so a caller cannot
    /// register a stale or swapped-in key the TEE never actually attested to.
    ///
    /// This is the binding step for `Assay.registerReceiptKey`: it proves
    /// `pubkey` was produced by the SAME class of TDX-attested enclave Assay
    /// already trusts (same DCAP chain, same nine-field measurement, same
    /// allowlist gate as `verify()`/`register()` above), via Phala's own
    /// report_data-commitment mechanism -- not a separate ECDSA-signs-Ed25519
    /// scheme invented for this task, because Phala's source does not
    /// implement one; see the chiron repo's top-level README, "Model-swap
    /// refusal" section, "How the Ed25519 key is bound" for the full writeup.
    pub fn verify_keyset(
        &self,
        quote: Bytes,
        keyset_bytes: Bytes,
        nonce: FixedBytes<32>,
        pubkey: FixedBytes<32>,
    ) -> Result<FixedBytes<32>, Vec<u8>> {
        let now = self.vm().block_timestamp();
        let (report_data, measurement) = verify_dcap_chain(quote.as_ref(), now)?;

        // report_data_slot(digest) = digest(32) || zero(32) (identity.rs
        // `report_data_slot`); the zero half must actually be zero.
        if report_data[32..64].iter().any(|&b| b != 0) {
            return Err(b"ReportDataPaddingNotZero".to_vec());
        }

        // statement = {"keyset_digest":"sha256:<hex64(sha256(keyset_bytes))>","nonce":"<hex64(nonce)>","purpose":"aci.report_data.v1"}
        let keyset_digest_hex = hex64(&Sha256::digest(keyset_bytes.as_ref()));
        let nonce_hex = hex64(nonce.as_slice());
        let mut statement = Vec::with_capacity(64 + keyset_digest_hex.len() + nonce_hex.len());
        statement.extend_from_slice(br#"{"keyset_digest":"sha256:"#);
        statement.extend_from_slice(&keyset_digest_hex);
        statement.extend_from_slice(br#"","nonce":""#);
        statement.extend_from_slice(&nonce_hex);
        statement.extend_from_slice(br#"","purpose":"aci.report_data.v1"}"#);
        let statement_digest: [u8; 32] = Sha256::digest(&statement).into();
        if statement_digest != report_data[0..32] {
            return Err(b"KeysetDigestMismatch".to_vec());
        }

        let kb = keyset_bytes.as_ref();

        // Keyset freshness: WorkloadKeyset.not_after (unix seconds) must not
        // have passed. Read straight off the caller-supplied bytes, which by
        // this point have already been proven to hash to what the TEE itself
        // committed into report_data, so this is reading attested data.
        let not_after = find_u64_member(kb, 0, "not_after")
            .map_err(|_| b"BadKeysetJson".to_vec())?
            .ok_or_else(|| b"KeysetMissingNotAfter".to_vec())?;
        if now >= not_after {
            return Err(b"KeysetExpired".to_vec());
        }

        // pubkey must appear in receipt_signing_keys with algo == "ed25519".
        let (arr_start, _) = json::find_member(kb, 0, "receipt_signing_keys")
            .map_err(|_| b"BadKeysetJson".to_vec())?
            .ok_or_else(|| b"KeysetMissingReceiptSigningKeys".to_vec())?;
        let pubkey_hex = hex64(pubkey.as_slice());
        let found = json::find_array_element(kb, arr_start, |b, es, _ee| {
            let algo = json::find_string_member(b, es, "algo")?;
            if algo != Some(b"ed25519".as_slice()) {
                return Ok(None);
            }
            let pk = json::find_string_member(b, es, "public_key")?;
            if pk == Some(pubkey_hex.as_slice()) {
                Ok(Some(()))
            } else {
                Ok(None)
            }
        })
        .map_err(|_| b"BadKeysetJson".to_vec())?;
        if found.is_none() {
            return Err(b"PubkeyNotInKeyset".to_vec());
        }

        Ok(measurement)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use stylus_sdk::testing::*;

    /// The exact nonce Phala's legacy endpoint bound into quote_legacy1.hex's
    /// report_data[32:64] (cross-checked two independent ways: sliced straight
    /// out of the raw quote hex at that offset, and out of
    /// fixtures/legacy_report1.json's own `report_data` field; both agree).
    const FIXTURE_NONCE: [u8; 32] =
        hex_literal_32("cbee07cdeb24f8cbb813ba99e40d8b14ed8de9ef64cf803f47e2d567b6c66d00");

    /// 2026-09-26T00:00:00Z, comfortably inside quote_legacy1.hex's PCK
    /// leaf/intermediate validity windows (leaf: 2026-03-21..2033-03-21;
    /// intermediate: 2018-05-21..2033-05-21; confirmed against the fixture's
    /// own DER via `openssl x509 -noout -dates`), so tests exercise the real
    /// cert chain rather than a synthetic always-valid one.
    const TEST_TIMESTAMP: u64 = 1_790_380_800;

    const fn hex_literal_32(s: &str) -> [u8; 32] {
        let b = s.as_bytes();
        let mut out = [0u8; 32];
        let mut i = 0;
        while i < 32 {
            out[i] = hex_val(b[i * 2]) * 16 + hex_val(b[i * 2 + 1]);
            i += 1;
        }
        out
    }

    fn vm_at_test_time() -> TestVM {
        let vm = TestVM::default();
        vm.set_block_timestamp(TEST_TIMESTAMP);
        vm
    }

    fn load_quote() -> Vec<u8> {
        let hex_str = include_str!("../../fixtures/quote_legacy1.hex");
        hex::decode(hex_str.trim()).unwrap()
    }

    /// Pulls `signing_address` straight out of the saved real fetch (no JSON crate
    /// needed for one field): fixtures/legacy_report1.json, a real, freshly-fetched
    /// `GET /v1/attestation/report` response, so the test is checked against the
    /// actual system-of-record bytes, not a hand-copied literal.
    fn expected_signing_address_from_saved_json() -> [u8; 20] {
        let json = include_str!("../../fixtures/legacy_report1.json");
        let key = "\"signing_address\":\"0x";
        let start = json.find(key).expect("signing_address field must be present") + key.len();
        let hex_str = &json[start..start + 40];
        let mut out = [0u8; 20];
        out.copy_from_slice(&hex::decode(hex_str).unwrap());
        out
    }

    #[test]
    fn test_real_bundle_verifies() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let raw = load_quote();
        let (addr, measurement) = contract
            .verify(raw.into(), FixedBytes::from(FIXTURE_NONCE))
            .expect("real bundle must verify");
        assert_ne!(addr, Address::ZERO);
        assert_ne!(measurement, FixedBytes::<32>::ZERO);
        // The registered signer must be the real signing_address the same live fetch
        // reported, not merely non-zero: this is the exact bug the fix addresses.
        assert_eq!(addr, Address::from_slice(&expected_signing_address_from_saved_json()));
    }

    #[test]
    fn test_flipped_signature_bit_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let mut raw = load_quote();
        // ecdsa_signature starts right after header(48)+body(584)+len(4)
        let off = 48 + 584 + 4 + 5;
        raw[off] ^= 0x01;
        assert!(contract.verify(raw.into(), FixedBytes::from(FIXTURE_NONCE)).is_err());
    }

    #[test]
    fn test_flipped_cert_byte_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let mut raw = load_quote();
        let marker = b"-----BEGIN CERTIFICATE-----";
        let pos = raw
            .windows(marker.len())
            .position(|w| w == marker)
            .unwrap();
        raw[pos + 200] ^= 0x01;
        assert!(contract.verify(raw.into(), FixedBytes::from(FIXTURE_NONCE)).is_err());
    }

    #[test]
    fn test_flipped_report_data_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let mut raw = load_quote();
        let off = 48 + 584 - 64 + 10; // inside TD report's report_data field
        raw[off] ^= 0x01;
        assert!(contract.verify(raw.into(), FixedBytes::from(FIXTURE_NONCE)).is_err());
    }

    /// H-2 red: a quote presented with the wrong nonce (e.g. a stale one from a
    /// previous register() call) must not verify, even though every other field
    /// (signatures, cert chain, zero padding) is untouched and genuinely valid.
    #[test]
    fn test_wrong_nonce_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let raw = load_quote();
        let mut wrong_nonce = FIXTURE_NONCE;
        wrong_nonce[0] ^= 0x01;
        assert!(contract.verify(raw.into(), FixedBytes::from(wrong_nonce)).is_err());
    }

    /// H-2 red: an expired PCK leaf must not verify even with everything else
    /// (signatures, nonce, zero padding) genuinely valid; block_timestamp is set
    /// past the fixture leaf's real notAfter (2033-03-21T07:45:52Z, confirmed via
    /// `openssl x509 -noout -dates` on the fixture's own embedded PCK chain).
    #[test]
    fn test_expired_leaf_cert_reverts() {
        let vm = TestVM::default();
        vm.set_block_timestamp(1_995_003_953); // one second past the leaf's notAfter
        let contract = Verifier::from(&vm);
        let raw = load_quote();
        assert!(contract.verify(raw.into(), FixedBytes::from(FIXTURE_NONCE)).is_err());
    }

    /// M-1 red: flipping TDATTRIBUTES' DEBUG bit (bit 0 of byte 0, little-endian,
    /// per the Intel TDX Module Base Architecture Specification's TDATTRIBUTES
    /// field) on an otherwise-untouched, genuinely-signed real quote must be
    /// rejected. Since td_attributes sits inside signed_scope (covered by the
    /// ISV/quote ECDSA signature), a real enclave can never actually produce a
    /// quote with this bit flipped and a valid signature; flipping it here
    /// exercises the explicit attribute check itself, which must fire before
    /// (independent of) the signature ever gets checked against the mutated
    /// bytes still being able to fail closed either way.
    #[test]
    fn test_debug_attribute_set_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let mut raw = load_quote();
        raw[TD_ATTRIBUTES_OFFSET] |= 0x01;
        let err = contract
            .verify(raw.into(), FixedBytes::from(FIXTURE_NONCE))
            .expect_err("debug-attribute quote must be rejected");
        assert_eq!(err, b"DebugAttributeSet".to_vec());
    }

    // -----------------------------------------------------------------
    // verify_keyset (canonical `/v1/aci/attestation` endpoint) tests.
    //
    // fixtures/quote_aci1.hex, fixtures/keyset_bytes_aci1.json and
    // fixtures/aci_attestation1_nonce.txt are one real, freshly-fetched
    // `GET https://inference.phala.com/v1/aci/attestation?nonce=<chosen>`
    // response (no API key required for this endpoint, confirmed live), with
    // a caller-chosen nonce so it (unlike the legacy fixture, where the
    // nonce is embedded raw in report_data) can be reconstructed and
    // checked offline. `keyset_bytes_aci1.json` is the exact JCS
    // canonicalization of that response's `attestation.workload_keyset`
    // object (sorted keys, compact separators -- the ACI spec's ASCII/
    // integer-only constraint means JCS reduces to exactly that); verified
    // independently in Python before writing this Rust: sha256(these exact
    // bytes) == the response's own `workload_keyset_digest` field, and
    // sha256(the statement built from that digest + the chosen nonce) ==
    // the response's own `attestation.report_data` field, byte for byte.
    // -----------------------------------------------------------------

    const ACI_NONCE: [u8; 32] =
        hex_literal_32("2445e2b20b47c224fc77af00e742d54f8147acca66abcd118269a7c3603bad85");

    /// `receipt_signing_keys[0].public_key` from `keyset_bytes_aci1.json`,
    /// the one live Ed25519 receipt-signing key this real keyset attests to.
    const ACI_PUBKEY: [u8; 32] =
        hex_literal_32("110f3824daeeef29dbeba9677a5794ffed257b1082d9fd4599b3c0819953aa0a");

    fn load_aci_quote() -> Vec<u8> {
        let hex_str = include_str!("../../fixtures/quote_aci1.hex");
        hex::decode(hex_str.trim()).unwrap()
    }

    fn load_aci_keyset_bytes() -> Vec<u8> {
        include_bytes!("../../fixtures/keyset_bytes_aci1.json").to_vec()
    }

    #[test]
    fn test_real_aci_bundle_verifies_keyset() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let measurement = contract
            .verify_keyset(
                load_aci_quote().into(),
                load_aci_keyset_bytes().into(),
                FixedBytes::from(ACI_NONCE),
                FixedBytes::from(ACI_PUBKEY),
            )
            .expect("real ACI bundle must verify and bind the receipt pubkey");
        assert_ne!(measurement, FixedBytes::<32>::ZERO);
        // Same DCAP chain as the legacy endpoint's quote, so the same
        // nine-field measurement formula applies; both quotes come from
        // the same class of Phala gateway image, so their measurements
        // should agree -- an independent cross-check that verify_keyset
        // isn't computing something different from verify().
        let (_, legacy_measurement) = contract
            .verify(load_quote().into(), FixedBytes::from(FIXTURE_NONCE))
            .expect("legacy bundle must also verify");
        assert_eq!(measurement, legacy_measurement);
    }

    /// Red: a nonce the caller did not actually use to fetch the quote (so
    /// the statement it builds hashes to something the TEE never signed)
    /// must not verify, even though the quote itself and keyset_bytes are
    /// both genuine and untouched.
    #[test]
    fn test_aci_wrong_nonce_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let mut wrong_nonce = ACI_NONCE;
        wrong_nonce[0] ^= 0x01;
        let err = contract
            .verify_keyset(
                load_aci_quote().into(),
                load_aci_keyset_bytes().into(),
                FixedBytes::from(wrong_nonce),
                FixedBytes::from(ACI_PUBKEY),
            )
            .expect_err("wrong nonce must be rejected");
        assert_eq!(err, b"KeysetDigestMismatch".to_vec());
    }

    /// Red, mutation-proof for the digest-binding check itself: a single
    /// flipped byte anywhere in the caller-supplied keyset bytes changes
    /// their sha256, so it can no longer match what the TEE actually
    /// committed into report_data, even though the quote is genuine and the
    /// nonce is correct. This is the same shape as `Assay.redeemWithReceipt`
    /// rejecting a tampered/substituted model claim: a value the contract
    /// itself hashes and compares, not one it trusts unchecked.
    #[test]
    fn test_aci_tampered_keyset_bytes_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let mut kb = load_aci_keyset_bytes();
        // Flip a byte inside the "ed25519" algo string value -- still
        // syntactically valid JSON bytes-wise for this scanner (this test
        // only exercises the digest check, before any JSON is parsed).
        let pos = kb.iter().position(|&b| b == b'e').unwrap();
        kb[pos] ^= 0x01;
        let err = contract
            .verify_keyset(
                load_aci_quote().into(),
                kb.into(),
                FixedBytes::from(ACI_NONCE),
                FixedBytes::from(ACI_PUBKEY),
            )
            .expect_err("tampered keyset bytes must be rejected");
        assert_eq!(err, b"KeysetDigestMismatch".to_vec());
    }

    /// Red: a pubkey that is not in the attested keyset's
    /// `receipt_signing_keys` must not bind, even with a genuine quote,
    /// genuine keyset bytes and the correct nonce -- otherwise anyone could
    /// register an unattested key by reusing someone else's real bundle.
    #[test]
    fn test_aci_pubkey_not_in_keyset_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let wrong_pubkey = [0xABu8; 32];
        let err = contract
            .verify_keyset(
                load_aci_quote().into(),
                load_aci_keyset_bytes().into(),
                FixedBytes::from(ACI_NONCE),
                FixedBytes::from(wrong_pubkey),
            )
            .expect_err("unregistered pubkey must be rejected");
        assert_eq!(err, b"PubkeyNotInKeyset".to_vec());
    }

    /// Red: once `block.timestamp >= keyset.not_after`, registration must
    /// fail even for an otherwise fully genuine, correctly-bound bundle --
    /// a provider cannot register a stale keyset's receipt key forever.
    #[test]
    fn test_aci_expired_keyset_reverts() {
        let vm = TestVM::default();
        vm.set_block_timestamp(1_792_250_755); // exactly keyset_bytes_aci1.json's not_after
        let contract = Verifier::from(&vm);
        let err = contract
            .verify_keyset(
                load_aci_quote().into(),
                load_aci_keyset_bytes().into(),
                FixedBytes::from(ACI_NONCE),
                FixedBytes::from(ACI_PUBKEY),
            )
            .expect_err("expired keyset must be rejected");
        assert_eq!(err, b"KeysetExpired".to_vec());
    }

    /// Red: `verify_keyset` shares `verify_dcap_chain` with `verify()`, so a
    /// corrupted quote signature must fail there too, not just for the
    /// legacy entrypoint -- proves the refactor didn't silently drop a
    /// check for one of the two callers.
    #[test]
    fn test_aci_flipped_quote_signature_reverts() {
        let vm = vm_at_test_time();
        let contract = Verifier::from(&vm);
        let mut raw = load_aci_quote();
        let off = 48 + 584 + 4 + 5; // inside the ISV/quote ecdsa_signature field
        raw[off] ^= 0x01;
        assert!(contract
            .verify_keyset(
                raw.into(),
                load_aci_keyset_bytes().into(),
                FixedBytes::from(ACI_NONCE),
                FixedBytes::from(ACI_PUBKEY),
            )
            .is_err());
    }
}
