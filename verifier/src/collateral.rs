//! Intel collateral checks for a TDX quote: TCB status, QE identity and revocation.
//!
//! `verify_dcap_chain` proves a quote was signed by hardware that holds an Intel-issued PCK
//! certificate. This module proves that hardware is still in good standing. The caller passes
//! the Intel PCS collateral for the quote's platform; every byte of it is authenticated here
//! against Intel's SGX Root CA key hardcoded in `lib.rs`, so a hostile relayer can withhold
//! collateral but cannot forge it.
//!
//!   1. PCK CRL: signed by the quote's own PCK CA; the PCK leaf serial must not be listed.
//!   2. Root CA CRL: signed by Intel's root; neither the PCK CA nor the TCB signing certificate
//!      may be listed.
//!   3. TCB Info (TDX, v3): signed by an Intel TCB Signing certificate that chains to the root.
//!      FMSPC must equal the PCK certificate's, the document must be current, the TDX module
//!      signer and attributes must match, and the platform's CPUSVN, PCESVN and TEE_TCB_SVN
//!      select a TCB level whose status is returned.
//!   4. QE Identity (TD_QE): signed the same way. The quoting enclave's MRSIGNER, ISVPRODID,
//!      MISCSELECT and ATTRIBUTES must match and its ISVSVN selects a status.
//!
//! The worst status of the three levels (platform, TDX module, quoting enclave) is the quote's
//! status. `Revoked` never passes; any other status passes only if it is at or below the
//! caller's `max_status`. Matching follows Intel's quote verification library as implemented in
//! Phala-Network/dcap-qvl `src/verify.rs`: first level whose components are all met, module
//! SVNs handled by the module identity when the module version is non-zero.
use super::*;

/// Status ranks, ordered by severity. The contract returns the rank; Solidity stores the
/// highest rank it accepts.
pub const UP_TO_DATE: u8 = 0;
pub const SW_HARDENING_NEEDED: u8 = 1;
pub const CONFIGURATION_NEEDED: u8 = 2;
pub const CONFIGURATION_AND_SW_HARDENING_NEEDED: u8 = 3;
pub const OUT_OF_DATE: u8 = 4;
pub const OUT_OF_DATE_CONFIGURATION_NEEDED: u8 = 5;
pub const REVOKED: u8 = 6;

const TEE_TCB_SVN_OFFSET: usize = 48;
const MR_SIGNER_SEAM_OFFSET: usize = MR_SEAM_OFFSET + 48;
const SEAM_ATTRIBUTES_OFFSET: usize = MR_SIGNER_SEAM_OFFSET + 48;

const QE_MISC_SELECT: usize = 16;
const QE_ATTRIBUTES: usize = 48;
const QE_MR_SIGNER: usize = 128;
const QE_ISV_PROD_ID: usize = 256;
const QE_ISV_SVN: usize = 258;

/// The eight Intel PCS documents for one quote, in the order they appear in the ABI blob.
pub struct Collateral<'a> {
    pub tcb_info: &'a [u8],
    pub tcb_signature: &'a [u8],
    pub tcb_chain_pem: &'a [u8],
    pub qe_identity: &'a [u8],
    pub qe_signature: &'a [u8],
    pub qe_chain_pem: &'a [u8],
    pub pck_crl: &'a [u8],
    pub root_crl: &'a [u8],
}

fn err<T>(msg: &[u8]) -> Result<T, Vec<u8>> {
    Err(msg.to_vec())
}

fn status_rank(s: &[u8]) -> Result<u8, json::JsonError> {
    Ok(match s {
        b"UpToDate" => UP_TO_DATE,
        b"SWHardeningNeeded" => SW_HARDENING_NEEDED,
        b"ConfigurationNeeded" => CONFIGURATION_NEEDED,
        b"ConfigurationAndSWHardeningNeeded" => CONFIGURATION_AND_SW_HARDENING_NEEDED,
        b"OutOfDate" => OUT_OF_DATE,
        b"OutOfDateConfigurationNeeded" => OUT_OF_DATE_CONFIGURATION_NEEDED,
        b"Revoked" => REVOKED,
        _ => return Err(json::JsonError),
    })
}

fn hex_digit(c: u8) -> Result<u8, Vec<u8>> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => err(b"BadHex"),
    }
}

fn hex_decode_into(s: &[u8], out: &mut [u8]) -> Result<(), Vec<u8>> {
    if s.len() != out.len() * 2 {
        return err(b"BadHexLen");
    }
    for i in 0..out.len() {
        out[i] = (hex_digit(s[2 * i])? << 4) | hex_digit(s[2 * i + 1])?;
    }
    Ok(())
}

/// `YYYY-MM-DDTHH:MM:SSZ` to unix seconds, the only form Intel PCS emits.
fn parse_iso8601(s: &[u8]) -> Result<u64, Vec<u8>> {
    if s.len() != 20
        || s[4] != b'-'
        || s[7] != b'-'
        || s[10] != b'T'
        || s[13] != b':'
        || s[16] != b':'
        || s[19] != b'Z'
    {
        return err(b"BadIsoTime");
    }
    let days = days_from_civil(parse_digits(s, 0, 4)? as i64, parse_digits(s, 5, 2)?, parse_digits(s, 8, 2)?)?;
    if days < 0 {
        return err(b"BadDate");
    }
    Ok(days as u64 * 86400 + parse_digits(s, 11, 2)? * 3600 + parse_digits(s, 14, 2)? * 60 + parse_digits(s, 17, 2)?)
}

fn bad_json(_: json::JsonError) -> Vec<u8> {
    b"BadCollateralJson".to_vec()
}

fn str_member<'a>(b: &'a [u8], obj: usize, key: &str) -> Result<&'a [u8], Vec<u8>> {
    json::find_string_member(b, obj, key).map_err(bad_json)?.ok_or_else(|| b"CollateralFieldMissing".to_vec())
}

fn u64_member(b: &[u8], obj: usize, key: &str) -> Result<u64, Vec<u8>> {
    find_u64_member(b, obj, key).map_err(bad_json)?.ok_or_else(|| b"CollateralFieldMissing".to_vec())
}

fn obj_member(b: &[u8], obj: usize, key: &str) -> Result<usize, Vec<u8>> {
    Ok(json::find_member(b, obj, key).map_err(bad_json)?.ok_or_else(|| b"CollateralFieldMissing".to_vec())?.0)
}

/// Freshness shared by TCB Info and QE Identity: issued in the past, not past nextUpdate, and
/// published at or after the caller's minimum `tcbEvaluationDataNumber`. The number is what stops
/// an old document that is still inside its validity window from outliving a TCB recovery.
fn check_fresh(b: &[u8], now: u64, min_eval: u64) -> Result<(), Vec<u8>> {
    let issued = parse_iso8601(str_member(b, 0, "issueDate")?)?;
    let next = parse_iso8601(str_member(b, 0, "nextUpdate")?)?;
    if now < issued {
        return err(b"CollateralNotYetValid");
    }
    if now >= next {
        return err(b"CollateralExpired");
    }
    if u64_member(b, 0, "tcbEvaluationDataNumber")? < min_eval {
        return err(b"CollateralEvalTooOld");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// PCK certificate: serial and the Intel SGX extension (FMSPC, CPUSVN, PCESVN).
// ---------------------------------------------------------------------------

/// DER of OID 1.2.840.113741.1.13.1.4 (FMSPC), .2.18 (CPUSVN), .2.17 (PCESVN).
const OID_FMSPC: &[u8] = &[0x06, 0x0A, 0x2A, 0x86, 0x48, 0x86, 0xF8, 0x4D, 0x01, 0x0D, 0x01, 0x04];
const OID_CPUSVN: &[u8] = &[0x06, 0x0B, 0x2A, 0x86, 0x48, 0x86, 0xF8, 0x4D, 0x01, 0x0D, 0x01, 0x02, 0x12];
const OID_PCESVN: &[u8] = &[0x06, 0x0B, 0x2A, 0x86, 0x48, 0x86, 0xF8, 0x4D, 0x01, 0x0D, 0x01, 0x02, 0x11];

pub struct PckExt {
    pub fmspc: [u8; 6],
    pub cpu_svn: [u8; 16],
    pub pce_svn: u16,
}

/// The value TLV that follows `oid` in the certificate. The certificate is Intel-signed, so the
/// extension bytes are authentic; this locates fields inside it, it does not authenticate them.
fn pck_value<'a>(der: &'a [u8], oid: &[u8]) -> Result<&'a [u8], Vec<u8>> {
    let at = find_subslice(der, oid).ok_or_else(|| b"PckExtensionMissing".to_vec())?;
    Ok(read_tlv(&der[at + oid.len()..])?.content)
}

pub fn parse_pck_ext(leaf_der: &[u8]) -> Result<PckExt, Vec<u8>> {
    let fmspc_raw = pck_value(leaf_der, OID_FMSPC)?;
    let cpu_raw = pck_value(leaf_der, OID_CPUSVN)?;
    let pce_raw = pck_value(leaf_der, OID_PCESVN)?;
    if fmspc_raw.len() != 6 || cpu_raw.len() != 16 || pce_raw.is_empty() || pce_raw.len() > 3 {
        return err(b"PckExtensionMalformed");
    }
    let mut fmspc = [0u8; 6];
    fmspc.copy_from_slice(fmspc_raw);
    let mut cpu_svn = [0u8; 16];
    cpu_svn.copy_from_slice(cpu_raw);
    let pce_svn = pce_raw.iter().fold(0u32, |a, &b| (a << 8) | b as u32);
    if pce_svn > u16::MAX as u32 {
        return err(b"PckExtensionMalformed");
    }
    Ok(PckExt { fmspc, cpu_svn, pce_svn: pce_svn as u16 })
}

/// DER INTEGER content of a certificate's serialNumber (tbsCertificate element 1).
fn cert_serial(der: &[u8]) -> Result<&[u8], Vec<u8>> {
    let top = read_tlv(der)?;
    let tbs = nth_element(top.content, 0)?;
    Ok(nth_element(tbs.content, 1)?.content)
}

// ---------------------------------------------------------------------------
// CRL: signature, freshness, and membership of one serial.
// ---------------------------------------------------------------------------

/// Verifies `crl_der` (X.509 CertificateList, ECDSA-P256) under `issuer_pubkey`, requires it to
/// be current at `now`, and fails with `CertRevoked` if any serial in `serials` is listed.
pub fn check_crl(crl_der: &[u8], issuer_pubkey: &[u8; 64], now: u64, serials: &[&[u8]]) -> Result<(), Vec<u8>> {
    let top = read_tlv(crl_der)?;
    let tbs = nth_element(top.content, 0)?;
    let tbs_bytes = &top.content[..tbs.total_len];
    let sig_bit = nth_element(top.content, 2)?;
    if sig_bit.content.is_empty() {
        return err(b"EmptySignature");
    }
    let sig = parse_ecdsa_der_sig(&sig_bit.content[1..])?;
    verify_p256(issuer_pubkey, tbs_bytes, &sig)?;

    // version INTEGER (optional, present in Intel's v2 CRLs), sigAlg, issuer, thisUpdate,
    // nextUpdate, then an optional SEQUENCE of revoked entries.
    let (first_tag, _) = nth_element_tagged(tbs.content, 0)?;
    let base = if first_tag == 0x02 { 1 } else { 0 };
    let (tt, this_tlv) = nth_element_tagged(tbs.content, base + 2)?;
    let (nt, next_tlv) = nth_element_tagged(tbs.content, base + 3)?;
    if now < asn1_time_to_unix(tt, this_tlv.content)? {
        return err(b"CrlNotYetValid");
    }
    if now >= asn1_time_to_unix(nt, next_tlv.content)? {
        return err(b"CrlExpired");
    }
    if let Ok((0x30, list)) = nth_element_tagged(tbs.content, base + 4) {
        let mut pos = 0usize;
        while pos < list.content.len() {
            let entry = read_tlv(&list.content[pos..])?;
            let listed = nth_element(entry.content, 0)?.content;
            if serials.contains(&listed) {
                return err(b"CertRevoked");
            }
            pos = checked_end(pos, entry.total_len)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Intel TCB signing certificate and the signed JSON documents.
// ---------------------------------------------------------------------------

/// `doc` was signed (P-256, raw r||s) by the first certificate of `chain_pem`, which Intel's root
/// signed, which is in validity and is named "Intel SGX TCB Signing". Returns that certificate's
/// serial so the caller can check it against the root CRL.
fn verify_signed_document(
    doc: &[u8],
    signature: &[u8],
    chain_pem: &[u8],
    now: u64,
    root: &[u8; 64],
) -> Result<Vec<u8>, Vec<u8>> {
    let certs = extract_pem_certs(chain_pem)?;
    let signer = parse_x509_cert(&certs[0])?;
    if now < signer.not_before || now > signer.not_after {
        return err(b"TcbSignerNotValid");
    }
    if find_subslice(signer.tbs_bytes, b"Intel SGX TCB Signing").is_none() {
        return err(b"NotTcbSigningCert");
    }
    verify_p256(root, signer.tbs_bytes, &signer.signature)?;
    let sig: [u8; 64] = signature.try_into().map_err(|_| b"BadSigEncoding".to_vec())?;
    verify_p256(&signer.pubkey_xy, doc, &sig)?;
    Ok(cert_serial(&certs[0])?.to_vec())
}

// ---------------------------------------------------------------------------
// TCB Info evaluation.
// ---------------------------------------------------------------------------

/// What the quote says about the platform, already authenticated by `verify_dcap_chain`.
pub struct Platform<'a> {
    pub pck: PckExt,
    pub tee_tcb_svn: &'a [u8],
    pub mr_signer_seam: &'a [u8],
    pub seam_attributes: &'a [u8],
}

fn read_svns(b: &[u8], tcb: usize, key: &str) -> Result<[u8; 16], Vec<u8>> {
    let arr = obj_member(b, tcb, key)?;
    let mut out = [0u8; 16];
    let mut n = 0usize;
    json::find_array_element::<()>(b, arr, |b, es, _| {
        let svn = find_u64_member(b, es, "svn")?.ok_or(json::JsonError)?;
        if n >= 16 || svn > 255 {
            return Err(json::JsonError);
        }
        out[n] = svn as u8;
        n += 1;
        Ok(None)
    })
    .map_err(bad_json)?;
    if n != 16 {
        return err(b"BadTcbComponents");
    }
    Ok(out)
}

/// Module signer and attributes the TD report must carry, from `holder` (the `tdxModule` object
/// or the selected `tdxModuleIdentities` element).
fn check_module(b: &[u8], holder: usize, p: &Platform) -> Result<(), Vec<u8>> {
    let mut signer = [0u8; 48];
    hex_decode_into(str_member(b, holder, "mrsigner")?, &mut signer)?;
    let mut attrs = [0u8; 8];
    hex_decode_into(str_member(b, holder, "attributes")?, &mut attrs)?;
    let mut mask = [0u8; 8];
    hex_decode_into(str_member(b, holder, "attributesMask")?, &mut mask)?;
    if p.mr_signer_seam != signer {
        return err(b"TdxModuleSignerMismatch");
    }
    for i in 0..8 {
        if p.seam_attributes[i] & mask[i] != attrs[i] & mask[i] || p.seam_attributes[i] & !mask[i] != 0 {
            return err(b"TdxModuleAttributesMismatch");
        }
    }
    Ok(())
}

/// Status rank of a signed TDX TCB Info document for this platform at `now`.
pub fn evaluate_tcb_info(b: &[u8], now: u64, min_eval: u64, p: &Platform) -> Result<u8, Vec<u8>> {
    if str_member(b, 0, "id")? != b"TDX" || u64_member(b, 0, "version")? != 3 {
        return err(b"NotTdxTcbInfoV3");
    }
    check_fresh(b, now, min_eval)?;
    let mut fmspc = [0u8; 6];
    hex_decode_into(str_member(b, 0, "fmspc")?, &mut fmspc)?;
    if fmspc != p.pck.fmspc {
        return err(b"FmspcMismatch");
    }

    let module_version = p.tee_tcb_svn[1];
    let mut module_status = UP_TO_DATE;
    if module_version == 0 {
        check_module(b, obj_member(b, 0, "tdxModule")?, p)?;
    } else {
        // TDX module identity "TDX_<version, two upper-case hex digits>".
        let want = [b'T', b'D', b'X', b'_', b"0123456789ABCDEF"[(module_version >> 4) as usize], b"0123456789ABCDEF"[(module_version & 15) as usize]];
        let ids = obj_member(b, 0, "tdxModuleIdentities")?;
        let found = json::find_array_element(b, ids, |b, es, _| {
            Ok(if json::find_string_member(b, es, "id")? == Some(&want[..]) { Some(es) } else { None })
        })
        .map_err(bad_json)?
        .ok_or_else(|| b"TdxModuleIdentityMissing".to_vec())?;
        check_module(b, found, p)?;
        let levels = obj_member(b, found, "tcbLevels")?;
        let isv = p.tee_tcb_svn[0] as u64;
        module_status = json::find_array_element(b, levels, |b, es, _| {
            let tcb = json::find_member(b, es, "tcb")?.ok_or(json::JsonError)?.0;
            if isv < find_u64_member(b, tcb, "isvsvn")?.ok_or(json::JsonError)? {
                return Ok(None);
            }
            let s = json::find_string_member(b, es, "tcbStatus")?.ok_or(json::JsonError)?;
            status_rank(s).map(Some)
        })
        .map_err(bad_json)?
        .ok_or_else(|| b"TdxModuleBelowMinimum".to_vec())?;
    }

    let skip = if module_version > 0 { 2 } else { 0 };
    let levels = obj_member(b, 0, "tcbLevels")?;
    let platform_status = json::find_array_element(b, levels, |b, es, _| {
        let tcb = json::find_member(b, es, "tcb")?.ok_or(json::JsonError)?.0;
        if (p.pck.pce_svn as u64) < find_u64_member(b, tcb, "pcesvn")?.ok_or(json::JsonError)? {
            return Ok(None);
        }
        let sgx = read_svns(b, tcb, "sgxtcbcomponents").map_err(|_| json::JsonError)?;
        let tdx = read_svns(b, tcb, "tdxtcbcomponents").map_err(|_| json::JsonError)?;
        for i in 0..16 {
            if p.pck.cpu_svn[i] < sgx[i] || (i >= skip && p.tee_tcb_svn[i] < tdx[i]) {
                return Ok(None);
            }
        }
        let s = json::find_string_member(b, es, "tcbStatus")?.ok_or(json::JsonError)?;
        status_rank(s).map(Some)
    })
    .map_err(bad_json)?
    .ok_or_else(|| b"NoMatchingTcbLevel".to_vec())?;
    Ok(platform_status.max(module_status))
}

/// Status rank of a signed TD_QE identity for this quoting-enclave report at `now`.
pub fn evaluate_qe_identity(b: &[u8], now: u64, min_eval: u64, qe_report: &[u8]) -> Result<u8, Vec<u8>> {
    let version = u64_member(b, 0, "version")?;
    if str_member(b, 0, "id")? != b"TD_QE" || (version != 2 && version != 3) {
        return err(b"NotTdQeIdentity");
    }
    check_fresh(b, now, min_eval)?;
    let mut mrsigner = [0u8; 32];
    hex_decode_into(str_member(b, 0, "mrsigner")?, &mut mrsigner)?;
    if qe_report[QE_MR_SIGNER..QE_MR_SIGNER + 32] != mrsigner {
        return err(b"QeMrSignerMismatch");
    }
    if read_u16_le(&qe_report[QE_ISV_PROD_ID..]) as u64 != u64_member(b, 0, "isvprodid")? {
        return err(b"QeProdIdMismatch");
    }
    let mut misc = [0u8; 4];
    let mut misc_mask = [0u8; 4];
    hex_decode_into(str_member(b, 0, "miscselect")?, &mut misc)?;
    hex_decode_into(str_member(b, 0, "miscselectMask")?, &mut misc_mask)?;
    for i in 0..4 {
        if qe_report[QE_MISC_SELECT + i] & misc_mask[i] != misc[i] & misc_mask[i] {
            return err(b"QeMiscSelectMismatch");
        }
    }
    let mut attrs = [0u8; 16];
    let mut attrs_mask = [0u8; 16];
    hex_decode_into(str_member(b, 0, "attributes")?, &mut attrs)?;
    hex_decode_into(str_member(b, 0, "attributesMask")?, &mut attrs_mask)?;
    for i in 0..16 {
        if qe_report[QE_ATTRIBUTES + i] & attrs_mask[i] != attrs[i] & attrs_mask[i] {
            return err(b"QeAttributesMismatch");
        }
    }
    let isv_svn = read_u16_le(&qe_report[QE_ISV_SVN..]) as u64;
    let levels = obj_member(b, 0, "tcbLevels")?;
    json::find_array_element(b, levels, |b, es, _| {
        let tcb = json::find_member(b, es, "tcb")?.ok_or(json::JsonError)?.0;
        if isv_svn < find_u64_member(b, tcb, "isvsvn")?.ok_or(json::JsonError)? {
            return Ok(None);
        }
        let s = json::find_string_member(b, es, "tcbStatus")?.ok_or(json::JsonError)?;
        status_rank(s).map(Some)
    })
    .map_err(bad_json)?
    .ok_or_else(|| b"QeBelowMinimum".to_vec())
}

/// Full collateral check for `quote` (already DCAP-verified). Returns the worst status rank, or
/// an error if it is `Revoked`, above `max_status`, older than `min_eval`, or any document fails
/// to authenticate.
/// `root` is Intel's SGX Root CA key in production; tests pass their own.
pub fn check(
    quote: &[u8],
    now: u64,
    c: &Collateral,
    max_status: u8,
    min_eval: u64,
    root: &[u8; 64],
) -> Result<u8, Vec<u8>> {
    let q = parse_quote(quote)?;
    let certs = extract_pem_certs(q.pck_chain_pem)?;
    if certs.len() < 2 {
        return err(b"ChainTooShort");
    }
    let intermediate = parse_x509_cert(&certs[1])?;

    let tcb_signer = verify_signed_document(c.tcb_info, c.tcb_signature, c.tcb_chain_pem, now, root)?;
    let qe_signer = verify_signed_document(c.qe_identity, c.qe_signature, c.qe_chain_pem, now, root)?;
    check_crl(c.root_crl, root, now, &[cert_serial(&certs[1])?, &tcb_signer, &qe_signer])?;
    check_crl(c.pck_crl, &intermediate.pubkey_xy, now, &[cert_serial(&certs[0])?])?;

    let s = q.signed_scope;
    let platform = Platform {
        pck: parse_pck_ext(&certs[0])?,
        tee_tcb_svn: &s[TEE_TCB_SVN_OFFSET..TEE_TCB_SVN_OFFSET + 16],
        mr_signer_seam: &s[MR_SIGNER_SEAM_OFFSET..MR_SIGNER_SEAM_OFFSET + 48],
        seam_attributes: &s[SEAM_ATTRIBUTES_OFFSET..SEAM_ATTRIBUTES_OFFSET + 8],
    };
    let status = evaluate_tcb_info(c.tcb_info, now, min_eval, &platform)?
        .max(evaluate_qe_identity(c.qe_identity, now, min_eval, q.qe_report)?);
    if status >= REVOKED || status > max_status {
        return err(b"TcbStatusNotAccepted");
    }
    Ok(status)
}

#[cfg(test)]
#[path = "collateral_tests.rs"]
mod tests;
