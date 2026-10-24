use super::*;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use stylus_sdk::testing::*;

/// 2026-10-24T12:00:00Z: inside the validity window of every fixture under
/// fixtures/collateral (fetched from Intel PCS that morning) and of the quote's PCK chain.
const NOW: u64 = 1_792_843_200;
/// 2026-11-24T00:00:00Z, past every nextUpdate in the fixtures.
const AFTER: u64 = 1_795_478_400;
/// 2026-09-26T00:00:00Z, before any of the fixtures was issued.
const BEFORE: u64 = 1_790_380_800;
/// report_data[32..64] of fixtures/quote_legacy1.hex.
const NONCE: [u8; 32] = [
    0xcb, 0xee, 0x07, 0xcd, 0xeb, 0x24, 0xf8, 0xcb, 0xb8, 0x13, 0xba, 0x99, 0xe4, 0x0d, 0x8b, 0x14, 0xed, 0x8d, 0xe9,
    0xef, 0x64, 0xcf, 0x80, 0x3f, 0x47, 0xe2, 0xd5, 0x67, 0xb6, 0xc6, 0x6d, 0x00,
];
/// A serial on Intel's live PCK Platform CA CRL.
const REVOKED_SERIAL: [u8; 20] = [
    0x6F, 0xC3, 0x4E, 0x50, 0x23, 0xE7, 0x28, 0x92, 0x34, 0x35, 0xD6, 0x1A, 0xA4, 0xB8, 0x3C, 0x61, 0x81, 0x66, 0xAD,
    0x35,
];
/// Another listed serial, high bit set, so its DER INTEGER carries a leading 0x00.
const REVOKED_SERIAL_HIGH: [u8; 21] = [
    0x00, 0xEF, 0xAE, 0x6E, 0x97, 0x15, 0xFC, 0xA1, 0x3B, 0x87, 0xE3, 0x33, 0xE8, 0x26, 0x1E, 0xD6, 0xD9, 0x90, 0xA9,
    0x26, 0xAD,
];

fn quote() -> Vec<u8> {
    hex::decode(include_str!("../../fixtures/quote_legacy1.hex").trim()).unwrap()
}

fn quote_pem(i: usize) -> Vec<u8> {
    let q = quote();
    let mut pos = 0;
    let mut n = 0;
    loop {
        let b = pos + find_subslice(&q[pos..], b"-----BEGIN CERTIFICATE-----").unwrap();
        let e = b + find_subslice(&q[b..], b"-----END CERTIFICATE-----").unwrap() + 25;
        if n == i {
            return q[b..e].to_vec();
        }
        pos = e;
        n += 1;
    }
}

#[derive(Clone)]
struct Real {
    tcb_info: Vec<u8>,
    tcb_sig: Vec<u8>,
    tcb_chain: Vec<u8>,
    qe_identity: Vec<u8>,
    qe_sig: Vec<u8>,
    qe_chain: Vec<u8>,
    pck_crl: Vec<u8>,
    root_crl: Vec<u8>,
}

fn real() -> Real {
    Real {
        tcb_info: include_bytes!("../../fixtures/collateral/tcb_info.json").to_vec(),
        tcb_sig: hex::decode(include_str!("../../fixtures/collateral/tcb_info.sig.hex").trim()).unwrap(),
        tcb_chain: include_bytes!("../../fixtures/collateral/tcb_info_issuer_chain.pem").to_vec(),
        qe_identity: include_bytes!("../../fixtures/collateral/qe_identity.json").to_vec(),
        qe_sig: hex::decode(include_str!("../../fixtures/collateral/qe_identity.sig.hex").trim()).unwrap(),
        qe_chain: include_bytes!("../../fixtures/collateral/qe_identity_issuer_chain.pem").to_vec(),
        pck_crl: include_bytes!("../../fixtures/collateral/pck_crl_platform.der").to_vec(),
        root_crl: include_bytes!("../../fixtures/collateral/root_crl.der").to_vec(),
    }
}

impl Real {
    fn view(&self) -> Collateral<'_> {
        Collateral {
            tcb_info: &self.tcb_info,
            tcb_signature: &self.tcb_sig,
            tcb_chain_pem: &self.tcb_chain,
            qe_identity: &self.qe_identity,
            qe_signature: &self.qe_sig,
            qe_chain_pem: &self.qe_chain,
            pck_crl: &self.pck_crl,
            root_crl: &self.root_crl,
        }
    }

    fn abi(&self) -> Vec<u8> {
        use stylus_sdk::alloy_sol_types::SolValue;
        let b = |v: &Vec<u8>| Bytes::from(v.clone());
        (
            b(&self.tcb_info),
            b(&self.tcb_sig),
            b(&self.tcb_chain),
            b(&self.qe_identity),
            b(&self.qe_sig),
            b(&self.qe_chain),
            b(&self.pck_crl),
            b(&self.root_crl),
        )
            .abi_encode_params()
    }
}

fn replace(doc: &[u8], from: &str, to: &str) -> Vec<u8> {
    let s = String::from_utf8(doc.to_vec()).unwrap();
    assert!(s.contains(from), "fixture no longer contains {from}");
    s.replacen(from, to, 1).into_bytes()
}

fn replace_all(doc: &[u8], from: &str, to: &str) -> Vec<u8> {
    let s = String::from_utf8(doc.to_vec()).unwrap();
    assert!(s.contains(from), "fixture no longer contains {from}");
    s.replace(from, to).into_bytes()
}

/// Rewrites the status of the host's platform TCB level. In Intel's TCB Info the platform
/// `tcbLevels` follow the TDX module identities, which carry their own `UpToDate` strings.
fn set_platform_status(doc: &[u8], to: &str) -> Vec<u8> {
    let s = String::from_utf8(doc.to_vec()).unwrap();
    let at = s.find("\"tcbLevels\":[{\"tcb\":{\"sgxtcbcomponents\"").expect("platform levels");
    let tail = s[at..].replacen("\"tcbStatus\":\"UpToDate\"", &format!("\"tcbStatus\":\"{to}\""), 1);
    assert_ne!(tail, s[at..], "platform level was not UpToDate");
    format!("{}{}", &s[..at], tail).into_bytes()
}

fn call(c: &Real, now: u64, max_status: u8) -> Result<(Address, FixedBytes<32>, u8), Vec<u8>> {
    let vm = TestVM::default();
    vm.set_block_timestamp(now);
    Verifier::from(&vm).verify_with_collateral(quote().into(), FixedBytes::from(NONCE), c.abi().into(), max_status, 0)
}

fn reason<T: core::fmt::Debug>(r: Result<T, Vec<u8>>) -> String {
    String::from_utf8(r.expect_err("must be rejected")).unwrap()
}

fn e(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

struct Facts {
    pck: PckExt,
    svn: Vec<u8>,
    mr: Vec<u8>,
    attr: Vec<u8>,
    qe_report: Vec<u8>,
}

fn facts() -> Facts {
    let q = quote();
    let parts = parse_quote(&q).unwrap();
    let certs = extract_pem_certs(parts.pck_chain_pem).unwrap();
    let s = parts.signed_scope;
    Facts {
        pck: parse_pck_ext(&certs[0]).unwrap(),
        svn: s[TEE_TCB_SVN_OFFSET..TEE_TCB_SVN_OFFSET + 16].to_vec(),
        mr: s[MR_SIGNER_SEAM_OFFSET..MR_SIGNER_SEAM_OFFSET + 48].to_vec(),
        attr: s[SEAM_ATTRIBUTES_OFFSET..SEAM_ATTRIBUTES_OFFSET + 8].to_vec(),
        qe_report: parts.qe_report.to_vec(),
    }
}

fn eval_tcb(doc: &[u8], now: u64, tee_svn: Option<[u8; 16]>, signer: Option<[u8; 48]>) -> Result<u8, Vec<u8>> {
    let f = facts();
    let svn = tee_svn.map(|s| s.to_vec()).unwrap_or(f.svn);
    let mr = signer.map(|s| s.to_vec()).unwrap_or(f.mr);
    evaluate_tcb_info(doc, now, 0, &Platform { pck: f.pck, tee_tcb_svn: &svn, mr_signer_seam: &mr, seam_attributes: &f.attr })
}

fn eval_qe(doc: &[u8], now: u64) -> Result<u8, Vec<u8>> {
    evaluate_qe_identity(doc, now, 0, &facts().qe_report)
}

// ---------------------------------------------------------------------- real Intel data

/// The fixture platform (Phala host, FMSPC 20A06F000000) is UpToDate against the collateral
/// Intel published on 2026-10-24, every document authenticated by Intel's real root key.
#[test]
fn real_collateral_reports_up_to_date() {
    let (signer, measurement, status) = call(&real(), NOW, UP_TO_DATE).expect("live Intel collateral must verify");
    assert_eq!(status, UP_TO_DATE);
    assert_ne!(signer, Address::ZERO);
    assert_ne!(measurement, FixedBytes::<32>::ZERO);
}

/// The values the platform evaluation rests on, compared with `openssl x509 -text` and the raw
/// quote, so a parser that returned zeros would fail here.
#[test]
fn platform_facts_match_the_pck_certificate_and_td_report() {
    let f = facts();
    assert_eq!(f.pck.fmspc, [0x20, 0xA0, 0x6F, 0x00, 0x00, 0x00]);
    assert_eq!(f.pck.pce_svn, 13);
    assert_eq!(hex::encode(f.pck.cpu_svn), "0505020205ff00020000000000000000");
    assert_eq!(hex::encode(&f.svn), "0b010500000000000000000000000000");
    assert_eq!(f.mr, vec![0u8; 48]);
    assert_eq!(f.attr, vec![0u8; 8]);
    assert_eq!(read_u16_le(&f.qe_report[QE_ISV_SVN..]), 6);
    assert_eq!(read_u16_le(&f.qe_report[QE_ISV_PROD_ID..]), 2);
}

#[test]
fn editing_the_tcb_info_breaks_intels_signature() {
    let mut c = real();
    c.tcb_info = set_platform_status(&c.tcb_info, "Revoked ");
    assert_eq!(reason(call(&c, NOW, 255)), "SignatureInvalid");
    let mut c = real();
    c.tcb_info = replace(&c.tcb_info, "\"svn\":5", "\"svn\":1");
    assert_eq!(reason(call(&c, NOW, 255)), "SignatureInvalid");
}

#[test]
fn lowering_the_qe_minimum_breaks_intels_signature() {
    let mut c = real();
    c.qe_identity = replace(&c.qe_identity, "\"isvsvn\":4", "\"isvsvn\":0");
    assert_eq!(reason(call(&c, NOW, 255)), "SignatureInvalid");
}

#[test]
fn a_signature_does_not_transfer_between_documents() {
    let mut c = real();
    c.tcb_sig = c.qe_sig.clone();
    assert_eq!(reason(call(&c, NOW, 255)), "SignatureInvalid");
}

#[test]
fn a_short_signature_is_rejected() {
    let mut c = real();
    c.tcb_sig.truncate(63);
    assert_eq!(reason(call(&c, NOW, 255)), "BadSigEncoding");
}

/// The PCK Platform CA certificate is signed by Intel's root too, but it is not a TCB signer.
#[test]
fn a_pck_ca_certificate_cannot_stand_in_for_the_tcb_signer() {
    let mut c = real();
    c.tcb_chain = quote_pem(1);
    assert_eq!(reason(call(&c, NOW, 255)), "NotTcbSigningCert");
}

#[test]
fn a_corrupted_signer_certificate_is_rejected() {
    let mut c = real();
    let at = find_subslice(&c.tcb_chain, b"MIICjTCC").unwrap() + 400;
    c.tcb_chain[at] = if c.tcb_chain[at] == b'A' { b'B' } else { b'A' };
    assert!(call(&c, NOW, 255).is_err());
}

/// A CRL from the Processor CA does not speak for the Platform CA that issued this PCK.
#[test]
fn the_wrong_cas_pck_crl_is_rejected() {
    let mut c = real();
    c.pck_crl = include_bytes!("../../fixtures/collateral/pck_crl_processor.der").to_vec();
    assert_eq!(reason(call(&c, NOW, 255)), "SignatureInvalid");
}

#[test]
fn a_pck_crl_in_the_root_crl_slot_is_rejected() {
    let mut c = real();
    c.root_crl = c.pck_crl.clone();
    assert_eq!(reason(call(&c, NOW, 255)), "SignatureInvalid");
}

#[test]
fn collateral_outside_its_validity_window_is_rejected() {
    let c = real();
    assert_eq!(reason(call(&c, AFTER, 255)), "CrlExpired");
    assert_eq!(reason(call(&c, BEFORE, 255)), "CrlNotYetValid");
}

#[test]
fn a_malformed_collateral_blob_is_rejected() {
    let vm = TestVM::default();
    vm.set_block_timestamp(NOW);
    let r = Verifier::from(&vm).verify_with_collateral(quote().into(), FixedBytes::from(NONCE), vec![1u8; 40].into(), 0, 0);
    assert_eq!(reason(r), "BadCollateralAbi");
}

/// The nonce binding of verify() still applies: collateral does not relax it.
#[test]
fn the_quote_nonce_binding_still_applies() {
    let vm = TestVM::default();
    vm.set_block_timestamp(NOW);
    let r = Verifier::from(&vm).verify_with_collateral(quote().into(), FixedBytes::from([7u8; 32]), real().abi().into(), 0, 0);
    assert_eq!(reason(r), "NonceMismatch");
}

#[test]
fn serials_on_intels_live_pck_crl_are_reported_revoked() {
    let q = quote();
    let parts = parse_quote(&q).unwrap();
    let certs = extract_pem_certs(parts.pck_chain_pem).unwrap();
    let ca = parse_x509_cert(&certs[1]).unwrap();
    let crl = real().pck_crl;
    assert_eq!(check_crl(&crl, &ca.pubkey_xy, NOW, &[&REVOKED_SERIAL]), Err(e("CertRevoked")));
    assert_eq!(check_crl(&crl, &ca.pubkey_xy, NOW, &[&REVOKED_SERIAL_HIGH]), Err(e("CertRevoked")));
    // the quote's own PCK leaf is not on the list
    assert_eq!(check_crl(&crl, &ca.pubkey_xy, NOW, &[cert_serial(&certs[0]).unwrap()]), Ok(()));
}

// ---------------------------------------------------------------------- policy on Intel's documents

#[test]
fn tcb_info_policy_follows_the_matched_level() {
    let real = real();
    assert_eq!(eval_tcb(&real.tcb_info, NOW, None, None), Ok(UP_TO_DATE));
    // top level now needs SGX component 0 == 6, the platform has 5: falls to the OutOfDate level
    let out = replace(&real.tcb_info, "\"sgxtcbcomponents\":[{\"svn\":5,", "\"sgxtcbcomponents\":[{\"svn\":6,");
    assert_eq!(eval_tcb(&out, NOW, None, None), Ok(OUT_OF_DATE));
    let revoked = set_platform_status(&real.tcb_info, "Revoked");
    assert_eq!(eval_tcb(&revoked, NOW, None, None), Ok(REVOKED));
    let sw = set_platform_status(&real.tcb_info, "SWHardeningNeeded");
    assert_eq!(eval_tcb(&sw, NOW, None, None), Ok(SW_HARDENING_NEEDED));
    let odd = set_platform_status(&real.tcb_info, "Fine");
    assert_eq!(eval_tcb(&odd, NOW, None, None), Err(e("BadCollateralJson")));
}

#[test]
fn a_platform_below_every_listed_level_matches_nothing() {
    let doc = replace_all(&real().tcb_info, "\"pcesvn\":13", "\"pcesvn\":14");
    let doc = replace_all(&doc, "\"pcesvn\":5,", "\"pcesvn\":14,");
    assert_eq!(eval_tcb(&doc, NOW, None, None), Err(e("NoMatchingTcbLevel")));
}

#[test]
fn tcb_info_for_another_platform_or_kind_is_rejected() {
    let real = real();
    let other = replace(&real.tcb_info, "\"fmspc\":\"20A06F000000\"", "\"fmspc\":\"30A06F000000\"");
    assert_eq!(eval_tcb(&other, NOW, None, None), Err(e("FmspcMismatch")));
    let sgx = replace(&real.tcb_info, "\"id\":\"TDX\"", "\"id\":\"SGX\"");
    assert_eq!(eval_tcb(&sgx, NOW, None, None), Err(e("NotTdxTcbInfoV3")));
    let v2 = replace(&real.tcb_info, "\"version\":3", "\"version\":2");
    assert_eq!(eval_tcb(&v2, NOW, None, None), Err(e("NotTdxTcbInfoV3")));
}

#[test]
fn tcb_info_freshness_is_enforced_at_both_ends() {
    let doc = real().tcb_info;
    assert_eq!(eval_tcb(&doc, AFTER, None, None), Err(e("CollateralExpired")));
    assert_eq!(eval_tcb(&doc, 1_792_803_000, None, None), Err(e("CollateralNotYetValid")));
}

#[test]
fn tdx_module_identity_decides_the_module_level() {
    let doc = real().tcb_info;
    let mut svn = [0u8; 16];
    svn[0] = 2; // module ISVSVN 2 in TDX_01: the OutOfDate level
    svn[1] = 1;
    svn[2] = 5;
    assert_eq!(eval_tcb(&doc, NOW, Some(svn), None), Ok(OUT_OF_DATE));
    svn[0] = 1; // below every listed module level
    assert_eq!(eval_tcb(&doc, NOW, Some(svn), None), Err(e("TdxModuleBelowMinimum")));
    svn[0] = 11;
    svn[1] = 9; // no TDX_09 identity
    assert_eq!(eval_tcb(&doc, NOW, Some(svn), None), Err(e("TdxModuleIdentityMissing")));
}

/// The TD's TEE_TCB_SVN components 2.. are compared against the matched level; components 0 and 1
/// are the module's and are judged by its identity instead, unless the module version is 0.
#[test]
fn the_td_tcb_svn_components_select_the_level() {
    let doc = real().tcb_info;
    let mut svn = [0u8; 16];
    svn[0] = 11;
    svn[1] = 1;
    svn[2] = 5;
    assert_eq!(eval_tcb(&doc, NOW, Some(svn), None), Ok(UP_TO_DATE));
    svn[2] = 4; // below the top level's 5, meets the second level's 4: OutOfDate
    assert_eq!(eval_tcb(&doc, NOW, Some(svn), None), Ok(OUT_OF_DATE));
    svn[2] = 1; // below every level
    assert_eq!(eval_tcb(&doc, NOW, Some(svn), None), Err(e("NoMatchingTcbLevel")));
    // module version 0: component 0 counts too (levels need 5)
    let mut v0 = [0u8; 16];
    v0[0] = 4;
    v0[2] = 5;
    assert_eq!(eval_tcb(&doc, NOW, Some(v0), None), Err(e("NoMatchingTcbLevel")));
    v0[0] = 5;
    assert_eq!(eval_tcb(&doc, NOW, Some(v0), None), Ok(UP_TO_DATE));
}

#[test]
fn a_foreign_tdx_module_signer_is_rejected() {
    let mut signer = [0u8; 48];
    signer[0] = 1;
    assert_eq!(eval_tcb(&real().tcb_info, NOW, None, Some(signer)), Err(e("TdxModuleSignerMismatch")));
}

#[test]
fn qe_identity_policy_follows_the_report() {
    let real = real();
    assert_eq!(eval_qe(&real.qe_identity, NOW), Ok(UP_TO_DATE));
    let newer = replace(&real.qe_identity, "\"isvsvn\":4", "\"isvsvn\":7");
    assert_eq!(eval_qe(&newer, NOW), Err(e("QeBelowMinimum")));
    let signer = replace(&real.qe_identity, "\"mrsigner\":\"DC9E", "\"mrsigner\":\"CC9E");
    assert_eq!(eval_qe(&signer, NOW), Err(e("QeMrSignerMismatch")));
    let prod = replace(&real.qe_identity, "\"isvprodid\":2", "\"isvprodid\":3");
    assert_eq!(eval_qe(&prod, NOW), Err(e("QeProdIdMismatch")));
    let attrs = replace(&real.qe_identity, "\"attributes\":\"11", "\"attributes\":\"01");
    assert_eq!(eval_qe(&attrs, NOW), Err(e("QeAttributesMismatch")));
    let revoked = replace(&real.qe_identity, "\"tcbStatus\":\"UpToDate\"", "\"tcbStatus\":\"Revoked\"");
    assert_eq!(eval_qe(&revoked, NOW), Ok(REVOKED));
    let sgx = replace(&real.qe_identity, "\"id\":\"TD_QE\"", "\"id\":\"QE\"");
    assert_eq!(eval_qe(&sgx, NOW), Err(e("NotTdQeIdentity")));
    assert_eq!(eval_qe(&real.qe_identity, AFTER), Err(e("CollateralExpired")));
}

// ---------------------------------------------------------------------- the whole check, test root

fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    match content.len() {
        n if n < 128 => out.push(n as u8),
        n if n < 256 => out.extend_from_slice(&[0x81, n as u8]),
        n => out.extend_from_slice(&[0x82, (n >> 8) as u8, n as u8]),
    }
    out.extend_from_slice(content);
    out
}

fn cat(parts: &[&[u8]]) -> Vec<u8> {
    parts.concat()
}

fn der_int(be: &[u8]) -> Vec<u8> {
    let mut v: Vec<u8> = be.iter().copied().skip_while(|b| *b == 0).collect();
    if v.is_empty() || v[0] & 0x80 != 0 {
        v.insert(0, 0);
    }
    der(0x02, &v)
}

fn sig_alg() -> Vec<u8> {
    der(0x30, &[0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02])
}

fn name(cn: &str) -> Vec<u8> {
    der(0x30, &der(0x31, &der(0x30, &cat(&[&[0x06, 0x03, 0x55, 0x04, 0x03], &der(0x0C, cn.as_bytes())]))))
}

fn utc(s: &str) -> Vec<u8> {
    der(0x17, s.as_bytes())
}

fn sign_der(sk: &SigningKey, msg: &[u8]) -> Vec<u8> {
    let sig: Signature = sk.sign(msg);
    let raw = sig.to_bytes();
    let body = cat(&[&der_int(&raw[..32]), &der_int(&raw[32..])]);
    der(0x03, &cat(&[&[0u8], &der(0x30, &body)]))
}

fn pubkey_xy(sk: &SigningKey) -> [u8; 64] {
    let p = sk.verifying_key().to_sec1_point(false);
    let mut out = [0u8; 64];
    out.copy_from_slice(&p.as_bytes()[1..]);
    out
}

fn cert(cn: &str, issuer: &SigningKey, subject: &SigningKey, serial: u8) -> Vec<u8> {
    cert_with(cn, issuer, subject, serial, ("200101000000Z", "400101000000Z"), &[])
}

/// `ext` is appended to the TBS as a trailing element, where an X.509 extensions block sits.
fn cert_with(
    cn: &str,
    issuer: &SigningKey,
    subject: &SigningKey,
    serial: u8,
    validity: (&str, &str),
    ext: &[u8],
) -> Vec<u8> {
    let spki = der(
        0x30,
        &cat(&[
            &der(
                0x30,
                &cat(&[
                    &[0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01],
                    &[0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07],
                ]),
            ),
            &der(0x03, &cat(&[&[0u8, 4u8], &pubkey_xy(subject)])),
        ]),
    );
    let tbs = der(
        0x30,
        &cat(&[
            &[0xA0, 0x03, 0x02, 0x01, 0x02],
            &der_int(&[serial]),
            &sig_alg(),
            &name("Test Root"),
            &der(0x30, &cat(&[&utc(validity.0), &utc(validity.1)])),
            &name(cn),
            &spki,
            ext,
        ]),
    );
    let sig = sign_der(issuer, &tbs);
    der(0x30, &cat(&[&tbs, &sig_alg(), &sig]))
}

fn crl(issuer: &SigningKey, revoked: &[&[u8]], this: &str, next: &str) -> Vec<u8> {
    let entries: Vec<u8> =
        revoked.iter().flat_map(|s| der(0x30, &cat(&[&der_int(s), &utc("261024000000Z")]))).collect();
    let list = if revoked.is_empty() { vec![] } else { der(0x30, &entries) };
    let tbs = der(0x30, &cat(&[&[0x02, 0x01, 0x01], &sig_alg(), &name("Test Root"), &utc(this), &utc(next), &list]));
    let sig = sign_der(issuer, &tbs);
    der(0x30, &cat(&[&tbs, &sig_alg(), &sig]))
}

fn pem(der: &[u8]) -> Vec<u8> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::from("-----BEGIN CERTIFICATE-----\n");
    for ch in der.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= ch.len() {
                s.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s.push_str("\n-----END CERTIFICATE-----\n");
    s.into_bytes()
}

/// A stand-in for Intel's root with two TCB signing certificates, one per document, so a test can
/// revoke or expire either on its own.
struct Pki {
    root_pub: [u8; 64],
    root: SigningKey,
    signer: SigningKey,
    signer_pem: Vec<u8>,
    qe_signer: SigningKey,
    qe_signer_pem: Vec<u8>,
}

const SIGNER_SERIAL: u8 = 0x11;
const QE_SIGNER_SERIAL: u8 = 0x12;

fn pki() -> Pki {
    let root = SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
    let signer = SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
    let qe_signer = SigningKey::from_bytes(&[10u8; 32].into()).unwrap();
    Pki {
        root_pub: pubkey_xy(&root),
        signer_pem: pem(&cert("Intel SGX TCB Signing", &root, &signer, SIGNER_SERIAL)),
        qe_signer_pem: pem(&cert("Intel SGX TCB Signing", &root, &qe_signer, QE_SIGNER_SERIAL)),
        root,
        signer,
        qe_signer,
    }
}

fn sign_raw(sk: &SigningKey, doc: &[u8]) -> Vec<u8> {
    let sig: Signature = sk.sign(doc);
    sig.to_bytes().to_vec()
}

/// Real quote and real PCK CRL; TCB documents and root CRL re-issued by a test root.
fn issue(p: &Pki, tcb: &[u8], qe: &[u8], root_revokes: &[&[u8]]) -> Real {
    let mut c = real();
    c.tcb_info = tcb.to_vec();
    c.tcb_sig = sign_raw(&p.signer, tcb);
    c.tcb_chain = p.signer_pem.clone();
    c.qe_identity = qe.to_vec();
    c.qe_sig = sign_raw(&p.qe_signer, qe);
    c.qe_chain = p.qe_signer_pem.clone();
    c.root_crl = crl(&p.root, root_revokes, "261024000000Z", "261123000000Z");
    c
}

fn run(p: &Pki, c: &Real, max_status: u8) -> Result<u8, Vec<u8>> {
    check(&quote(), NOW, &c.view(), max_status, 0, &p.root_pub)
}

#[test]
fn test_root_reissue_of_the_real_documents_passes() {
    let p = pki();
    let r = real();
    let c = issue(&p, &r.tcb_info, &r.qe_identity, &[]);
    assert_eq!(run(&p, &c, UP_TO_DATE), Ok(UP_TO_DATE));
}

#[test]
fn an_out_of_date_platform_is_refused_until_the_owner_accepts_that_status() {
    let p = pki();
    let r = real();
    let out = replace(&r.tcb_info, "\"sgxtcbcomponents\":[{\"svn\":5,", "\"sgxtcbcomponents\":[{\"svn\":6,");
    let c = issue(&p, &out, &r.qe_identity, &[]);
    assert_eq!(run(&p, &c, UP_TO_DATE), Err(e("TcbStatusNotAccepted")));
    assert_eq!(run(&p, &c, SW_HARDENING_NEEDED), Err(e("TcbStatusNotAccepted")));
    assert_eq!(run(&p, &c, OUT_OF_DATE), Ok(OUT_OF_DATE));
}

#[test]
fn sw_hardening_needed_passes_only_at_or_above_its_rank() {
    let p = pki();
    let r = real();
    let sw = set_platform_status(&r.tcb_info, "SWHardeningNeeded");
    let c = issue(&p, &sw, &r.qe_identity, &[]);
    assert_eq!(run(&p, &c, UP_TO_DATE), Err(e("TcbStatusNotAccepted")));
    assert_eq!(run(&p, &c, SW_HARDENING_NEEDED), Ok(SW_HARDENING_NEEDED));
}

#[test]
fn a_revoked_platform_never_passes_whatever_the_ceiling() {
    let p = pki();
    let r = real();
    let rev = set_platform_status(&r.tcb_info, "Revoked");
    let c = issue(&p, &rev, &r.qe_identity, &[]);
    assert_eq!(run(&p, &c, 255), Err(e("TcbStatusNotAccepted")));
    let rev_qe = replace(&r.qe_identity, "\"tcbStatus\":\"UpToDate\"", "\"tcbStatus\":\"Revoked\"");
    let c = issue(&p, &r.tcb_info, &rev_qe, &[]);
    assert_eq!(run(&p, &c, 255), Err(e("TcbStatusNotAccepted")));
}

#[test]
fn the_quoting_enclave_status_counts_toward_the_worst_status() {
    let p = pki();
    let r = real();
    let old_qe = replace(&r.qe_identity, "\"tcbStatus\":\"UpToDate\"", "\"tcbStatus\":\"OutOfDate\"");
    let c = issue(&p, &r.tcb_info, &old_qe, &[]);
    assert_eq!(run(&p, &c, UP_TO_DATE), Err(e("TcbStatusNotAccepted")));
    assert_eq!(run(&p, &c, OUT_OF_DATE), Ok(OUT_OF_DATE));
}

#[test]
fn a_revoked_tcb_signer_is_refused() {
    let p = pki();
    let r = real();
    let c = issue(&p, &r.tcb_info, &r.qe_identity, &[&[SIGNER_SERIAL]]);
    assert_eq!(run(&p, &c, 255), Err(e("CertRevoked")));
}

#[test]
fn a_revoked_pck_ca_is_refused() {
    let p = pki();
    let r = real();
    let q = quote();
    let ca_serial = cert_serial(&extract_pem_certs(parse_quote(&q).unwrap().pck_chain_pem).unwrap()[1]).unwrap().to_vec();
    let c = issue(&p, &r.tcb_info, &r.qe_identity, &[&ca_serial]);
    assert_eq!(run(&p, &c, 255), Err(e("CertRevoked")));
}

#[test]
fn a_signer_not_issued_by_the_root_is_refused() {
    let p = pki();
    let r = real();
    let mut c = issue(&p, &r.tcb_info, &r.qe_identity, &[]);
    let stranger = SigningKey::from_bytes(&[5u8; 32].into()).unwrap();
    c.tcb_chain = pem(&cert("Intel SGX TCB Signing", &stranger, &p.signer, SIGNER_SERIAL));
    assert_eq!(run(&p, &c, 255), Err(e("SignatureInvalid")));
}

#[test]
fn the_root_crl_must_be_signed_by_the_root() {
    let p = pki();
    let r = real();
    let mut c = issue(&p, &r.tcb_info, &r.qe_identity, &[]);
    let stranger = SigningKey::from_bytes(&[5u8; 32].into()).unwrap();
    c.root_crl = crl(&stranger, &[], "261024000000Z", "261123000000Z");
    assert_eq!(run(&p, &c, 255), Err(e("SignatureInvalid")));
}

#[test]
fn crl_freshness_and_membership_on_a_test_issuer() {
    let ca = SigningKey::from_bytes(&[3u8; 32].into()).unwrap();
    let pk = pubkey_xy(&ca);
    let list = crl(&ca, &[&[0x01], &[0x80, 0x02]], "261024000000Z", "261123000000Z");
    assert_eq!(check_crl(&list, &pk, NOW, &[&[0x01]]), Err(e("CertRevoked")));
    assert_eq!(check_crl(&list, &pk, NOW, &[&[0x00, 0x80, 0x02]]), Err(e("CertRevoked")));
    assert_eq!(check_crl(&list, &pk, NOW, &[&[0x02], &[0x03]]), Ok(()));
    assert_eq!(check_crl(&list, &pk, AFTER, &[&[0x02]]), Err(e("CrlExpired")));
    assert_eq!(check_crl(&list, &pk, BEFORE, &[&[0x02]]), Err(e("CrlNotYetValid")));
    let empty = crl(&ca, &[], "261024000000Z", "261123000000Z");
    assert_eq!(check_crl(&empty, &pk, NOW, &[&[0x01]]), Ok(()));
}

#[test]
fn a_revoked_qe_identity_signer_is_refused_on_its_own() {
    let p = pki();
    let r = real();
    let c = issue(&p, &r.tcb_info, &r.qe_identity, &[&[QE_SIGNER_SERIAL]]);
    assert_eq!(run(&p, &c, 255), Err(e("CertRevoked")));
}

#[test]
fn an_expired_tcb_signer_certificate_is_refused() {
    let p = pki();
    let r = real();
    let mut c = issue(&p, &r.tcb_info, &r.qe_identity, &[]);
    c.tcb_chain = pem(&cert_with("Intel SGX TCB Signing", &p.root, &p.signer, SIGNER_SERIAL, ("200101000000Z", "250101000000Z"), &[]));
    assert_eq!(run(&p, &c, 255), Err(e("TcbSignerNotValid")));
    let mut c = issue(&p, &r.tcb_info, &r.qe_identity, &[]);
    c.tcb_chain = pem(&cert_with("Intel SGX TCB Signing", &p.root, &p.signer, SIGNER_SERIAL, ("270101000000Z", "300101000000Z"), &[]));
    assert_eq!(run(&p, &c, 255), Err(e("TcbSignerNotValid")));
}

/// Freshness is half-open: valid from issueDate, expired at nextUpdate (both to the second).
#[test]
fn document_freshness_boundaries_are_exact() {
    let r = real();
    let issued = 1_792_803_708; // 2026-10-24T01:01:48Z, tcb_info issueDate
    let next = 1_795_395_708; // 2026-11-23T01:01:48Z, tcb_info nextUpdate
    assert_eq!(eval_tcb(&r.tcb_info, issued, None, None), Ok(UP_TO_DATE));
    assert_eq!(eval_tcb(&r.tcb_info, issued - 1, None, None), Err(e("CollateralNotYetValid")));
    assert_eq!(eval_tcb(&r.tcb_info, next - 1, None, None), Ok(UP_TO_DATE));
    assert_eq!(eval_tcb(&r.tcb_info, next, None, None), Err(e("CollateralExpired")));
}

/// The fixtures are TCB evaluation data number 20. A caller who knows Intel has published a
/// recovery at 21 refuses both documents, so a still-valid older copy cannot be replayed.
#[test]
fn a_minimum_evaluation_number_refuses_older_documents() {
    let r = real();
    let f = facts();
    let tcb = |min| evaluate_tcb_info(&r.tcb_info, NOW, min, &Platform { pck: parse_pck_ext_copy(&f.pck), tee_tcb_svn: &f.svn, mr_signer_seam: &f.mr, seam_attributes: &f.attr });
    let qe = |min| evaluate_qe_identity(&r.qe_identity, NOW, min, &f.qe_report);
    assert_eq!((tcb(20), qe(20)), (Ok(UP_TO_DATE), Ok(UP_TO_DATE)));
    assert_eq!((tcb(21), qe(21)), (Err(e("CollateralEvalTooOld")), Err(e("CollateralEvalTooOld"))));

    let p = pki();
    let c = issue(&p, &r.tcb_info, &r.qe_identity, &[]);
    assert_eq!(check(&quote(), NOW, &c.view(), 255, 20, &p.root_pub), Ok(UP_TO_DATE));
    assert_eq!(check(&quote(), NOW, &c.view(), 255, 21, &p.root_pub), Err(e("CollateralEvalTooOld")));
}

/// Through the contract method: the ceilings reach `check`, and the quote's own nonce binding
/// and DCAP chain run first. The collateral root is the test root; the quote's root is Intel's.
#[test]
fn the_entry_forwards_both_ceilings_and_the_signer() {
    let p = pki();
    let r = real();
    let out = replace(&r.tcb_info, "\"sgxtcbcomponents\":[{\"svn\":5,", "\"sgxtcbcomponents\":[{\"svn\":6,");
    let c = issue(&p, &out, &r.qe_identity, &[]);
    let vm = TestVM::default();
    vm.set_block_timestamp(NOW);
    let v = Verifier::from(&vm);
    let go = |max, min| v.verify_with_collateral_under(quote().into(), FixedBytes::from(NONCE), c.abi().into(), max, min, &p.root_pub);
    assert_eq!(reason(go(UP_TO_DATE, 0)), "TcbStatusNotAccepted");
    let (signer, _, status) = go(OUT_OF_DATE, 20).expect("OutOfDate accepted at ceiling 4");
    assert_eq!(status, OUT_OF_DATE);
    assert_eq!(signer, v.verify(quote().into(), FixedBytes::from(NONCE)).unwrap().0);
    assert_eq!(reason(go(OUT_OF_DATE, 21)), "CollateralEvalTooOld");
}

#[test]
fn the_public_entry_enforces_the_evaluation_floor_on_real_collateral() {
    let vm = TestVM::default();
    vm.set_block_timestamp(NOW);
    let go = |min| Verifier::from(&vm).verify_with_collateral(quote().into(), FixedBytes::from(NONCE), real().abi().into(), UP_TO_DATE, min);
    assert!(go(20).is_ok());
    assert_eq!(reason(go(21)), "CollateralEvalTooOld");
}

#[test]
fn bits_outside_the_module_attribute_mask_must_be_clear() {
    let f = facts();
    let doc = replace_all(&real().tcb_info, "\"attributesMask\":\"FFFFFFFFFFFFFFFF\"", "\"attributesMask\":\"FFFFFFFFFFFFFFFE\"");
    let mut attr = f.attr.clone();
    attr[7] = 1; // the mask's last byte is FE: this bit is outside it
    for svn in [f.svn.clone(), { let mut v = f.svn.clone(); v[1] = 0; v }] {
        let out = evaluate_tcb_info(&doc, NOW, 0, &Platform { pck: parse_pck_ext_copy(&f.pck), tee_tcb_svn: &svn, mr_signer_seam: &f.mr, seam_attributes: &attr });
        assert_eq!(out, Err(e("TdxModuleAttributesMismatch")));
    }
}

#[test]
fn the_tdx_module_signer_and_attributes_are_pinned() {
    let f = facts();
    let doc = real().tcb_info;
    let run = |mr: &[u8], attr: &[u8], svn: &[u8]| {
        evaluate_tcb_info(&doc, NOW, 0, &Platform { pck: parse_pck_ext_copy(&f.pck), tee_tcb_svn: svn, mr_signer_seam: mr, seam_attributes: attr })
    };
    // module version 1 (identity TDX_01) and version 0 (base tdxModule) both pin both fields
    let v1 = f.svn.clone();
    let mut v0 = f.svn.clone();
    v0[1] = 0;
    for svn in [&v1, &v0] {
        assert_eq!(run(&f.mr, &f.attr, svn), Ok(UP_TO_DATE));
        let mut attr = f.attr.clone();
        attr[0] = 1;
        assert_eq!(run(&f.mr, &attr, svn), Err(e("TdxModuleAttributesMismatch")));
        let mut mr = f.mr.clone();
        mr[47] = 1;
        assert_eq!(run(&mr, &f.attr, svn), Err(e("TdxModuleSignerMismatch")));
    }
}

fn parse_pck_ext_copy(p: &PckExt) -> PckExt {
    PckExt { fmspc: p.fmspc, cpu_svn: p.cpu_svn, pce_svn: p.pce_svn }
}

#[test]
fn qe_miscselect_is_pinned_under_its_mask() {
    let doc = real().qe_identity;
    let bad = replace(&doc, "\"miscselect\":\"00000000\"", "\"miscselect\":\"00000001\"");
    assert_eq!(eval_qe(&bad, NOW), Err(e("QeMiscSelectMismatch")));
    // a bit outside the mask is ignored
    let masked = replace(&bad, "\"miscselectMask\":\"FFFFFFFF\"", "\"miscselectMask\":\"FFFFFFFE\"");
    assert_eq!(eval_qe(&masked, NOW), Ok(UP_TO_DATE));
}

// ---------------------------------------------------------------------- a quote whose PCK chain is a test chain

/// The real quote with its PCK chain swapped for [leaf, CA] issued by the test root, so a test can
/// publish a PCK CRL that lists the leaf. The leaf carries the real platform's FMSPC, CPUSVN and
/// PCESVN. Only the three length fields that cover the chain are rewritten; `check` reads the
/// chain and the TD report, and the DCAP signatures are `verify_dcap_chain`'s job.
struct Rig {
    pki: Pki,
    pck_ca: SigningKey,
    leaf_serial: u8,
    ca_serial: u8,
    quote: Vec<u8>,
}

fn rig() -> Rig {
    let pki = pki();
    let pck_ca = SigningKey::from_bytes(&[11u8; 32].into()).unwrap();
    let leaf_key = SigningKey::from_bytes(&[12u8; 32].into()).unwrap();
    let f = facts();
    let ext = cat(&[
        OID_FMSPC, &der(0x04, &f.pck.fmspc),
        OID_CPUSVN, &der(0x04, &f.pck.cpu_svn),
        OID_PCESVN, &der_int(&f.pck.pce_svn.to_be_bytes()),
    ]);
    let (leaf_serial, ca_serial) = (0x21, 0x22);
    let leaf = cert_with("Intel SGX PCK Certificate", &pck_ca, &leaf_key, leaf_serial, ("200101000000Z", "400101000000Z"), &ext);
    let ca = cert("Intel SGX PCK Platform CA", &pki.root, &pck_ca, ca_serial);
    let new_pem = cat(&[&pem(&leaf), &pem(&ca)]);

    let mut q = quote();
    let old = parse_quote(&q).unwrap().pck_chain_pem;
    let at = old.as_ptr() as usize - q.as_ptr() as usize;
    let old_len = old.len();
    let delta = new_pem.len() as i64 - old_len as i64;
    let bump = |q: &mut Vec<u8>, pos: usize| {
        let v = u32::from_le_bytes(q[pos..pos + 4].try_into().unwrap()) as i64 + delta;
        q[pos..pos + 4].copy_from_slice(&(v as u32).to_le_bytes());
    };
    bump(&mut q, 632); // auth data length
    bump(&mut q, 636 + 64 + 64 + 2); // outer certification data length
    bump(&mut q, at - 4); // inner certification data length (the PEM chain)
    q.splice(at..at + old_len, new_pem);
    Rig { pki, pck_ca, leaf_serial, ca_serial, quote: q }
}

impl Rig {
    fn issue(&self, tcb: &[u8], qe: &[u8], pck_revokes: &[&[u8]], root_revokes: &[&[u8]]) -> Real {
        let mut c = issue(&self.pki, tcb, qe, root_revokes);
        c.pck_crl = crl(&self.pck_ca, pck_revokes, "261024000000Z", "261123000000Z");
        c
    }

    fn run(&self, c: &Real, max_status: u8) -> Result<u8, Vec<u8>> {
        check(&self.quote, NOW, &c.view(), max_status, 0, &self.pki.root_pub)
    }
}

#[test]
fn the_test_chain_quote_parses_back_to_the_real_platform() {
    let r = rig();
    let parts = parse_quote(&r.quote).unwrap();
    let certs = extract_pem_certs(parts.pck_chain_pem).unwrap();
    assert_eq!(certs.len(), 2);
    let ext = parse_pck_ext(&certs[0]).unwrap();
    let f = facts();
    assert_eq!((ext.fmspc, ext.cpu_svn, ext.pce_svn), (f.pck.fmspc, f.pck.cpu_svn, f.pck.pce_svn));
    assert_eq!(cert_serial(&certs[0]).unwrap(), &[r.leaf_serial]);
    assert_eq!(cert_serial(&certs[1]).unwrap(), &[r.ca_serial]);
    // the TD report and QE report are untouched
    assert_eq!(parts.signed_scope, parse_quote(&quote()).unwrap().signed_scope);
}

#[test]
fn a_clean_chain_passes_and_a_revoked_pck_leaf_is_refused() {
    let r = rig();
    let real = real();
    let ok = r.issue(&real.tcb_info, &real.qe_identity, &[&[0x77]], &[]);
    assert_eq!(r.run(&ok, UP_TO_DATE), Ok(UP_TO_DATE));
    let revoked = r.issue(&real.tcb_info, &real.qe_identity, &[&[r.leaf_serial]], &[]);
    assert_eq!(r.run(&revoked, 255), Err(e("CertRevoked")));
}

#[test]
fn a_pck_crl_not_signed_by_the_quotes_own_ca_is_refused() {
    let r = rig();
    let real = real();
    let mut c = r.issue(&real.tcb_info, &real.qe_identity, &[], &[]);
    let stranger = SigningKey::from_bytes(&[13u8; 32].into()).unwrap();
    c.pck_crl = crl(&stranger, &[], "261024000000Z", "261123000000Z");
    assert_eq!(r.run(&c, 255), Err(e("SignatureInvalid")));
}

#[test]
fn a_revoked_pck_ca_is_refused_through_the_root_crl() {
    let r = rig();
    let real = real();
    let c = r.issue(&real.tcb_info, &real.qe_identity, &[], &[&[r.ca_serial]]);
    assert_eq!(r.run(&c, 255), Err(e("CertRevoked")));
}
