#!/usr/bin/env python3
"""Reference (off-chain) verifier for a Phala GET /v1/aci/attestation bundle.

Ground truth for what the Stylus contract must do. Mirrors dcap-qvl's
verify_impl() (Phala-Network/dcap-qvl, src/verify.rs) steps 3, 4, 5, 7:
  - PCK cert chain: leaf <- intermediate <- Intel SGX Root CA (all P-256)
  - QE report signature: leaf cert's pubkey signs qe_report (P-256/SHA256)
  - QE report data binding: SHA256(attestation_key || qe_auth_data) == qe_report.report_data[0:32]
  - ISV (quote) signature: attestation_key signs header||body (P-256/SHA256)

TCB info / QE identity policy checks (steps 1, 2, 6, 8, 9, 10) need Intel's
live PCCS collateral (TCB info + QE identity JSON, each independently signed)
and are NOT done here or on-chain: this is the "TDX collateral is too big"
fallback assay.md names, applied here (see FINDINGS.md caveat).
"""
import json
import sys
import hashlib
import struct

from cryptography.hazmat.primitives.asymmetric import ec, padding, utils as ec_utils
from cryptography.hazmat.primitives import hashes, serialization
from cryptography import x509
from cryptography.exceptions import InvalidSignature

TEE_TYPE_TDX = 0x00000081
ATTESTATION_KEY_TYPE_ECDSA_P256 = 2
PCK_CERT_CHAIN = 5

ENCLAVE_REPORT_LEN = 384  # cpu_svn16+misc4+res28+attr16+mrenclave32+res32+mrsigner32+res96+isvprod2+isvsvn2+res60+reportdata64
TD_REPORT10_LEN = 584
QE_REPORT_SIG_LEN = 64
ECDSA_SIG_LEN = 64
ECDSA_PUBKEY_LEN = 64  # raw x||y, no 0x04 prefix


def raw_sig_to_der(sig64: bytes) -> bytes:
    r = int.from_bytes(sig64[:32], "big")
    s = int.from_bytes(sig64[32:64], "big")
    return ec_utils.encode_dss_signature(r, s)


def raw_pubkey_to_key(pub64: bytes):
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b"\x04" + pub64)


def verify_p256(pubkey, sig_der: bytes, msg: bytes):
    pubkey.verify(sig_der, msg, ec.ECDSA(hashes.SHA256()))


def parse_quote(raw: bytes):
    off = 0
    version, att_key_type, tee_type, qe_svn, pce_svn = struct.unpack_from("<HHIHH", raw, off)
    off += 12
    qe_vendor_id = raw[off:off + 16]; off += 16
    user_data = raw[off:off + 20]; off += 20
    header_end = off
    assert off == 48, f"header should be 48 bytes, got {off}"

    if version == 4:
        assert tee_type == TEE_TYPE_TDX, f"only TDX v4 handled here, got tee_type={tee_type:#x}"
        body = raw[off:off + TD_REPORT10_LEN]
        off += TD_REPORT10_LEN
        report_data = body[-64:]
    else:
        raise ValueError(f"unsupported quote version {version}")

    signed_len = off  # header || body, exactly what the ISV signature covers
    auth_len = struct.unpack_from("<I", raw, off)[0]; off += 4
    auth = raw[off:off + auth_len]; off += auth_len

    a = 0
    ecdsa_signature = auth[a:a + ECDSA_SIG_LEN]; a += ECDSA_SIG_LEN
    ecdsa_attestation_key = auth[a:a + ECDSA_PUBKEY_LEN]; a += ECDSA_PUBKEY_LEN
    cert_type, cert_body_len = struct.unpack_from("<HI", auth, a); a += 6
    cert_body = auth[a:a + cert_body_len]; a += cert_body_len
    assert a == len(auth), "auth_data trailing bytes"

    # cert_body (for cert_type 5 as top-level AuthDataV4.certification_data,
    # dstack wraps QEReportCertificationData inside it - see AuthDataV4::decode
    # in dcap-qvl: certification_data.body IS the QEReportCertificationData bytes)
    b = 0
    qe_report = cert_body[b:b + ENCLAVE_REPORT_LEN]; b += ENCLAVE_REPORT_LEN
    qe_report_signature = cert_body[b:b + QE_REPORT_SIG_LEN]; b += QE_REPORT_SIG_LEN
    qe_auth_len = struct.unpack_from("<H", cert_body, b)[0]; b += 2
    qe_auth_data = cert_body[b:b + qe_auth_len]; b += qe_auth_len
    inner_cert_type, inner_cert_body_len = struct.unpack_from("<HI", cert_body, b); b += 6
    pck_chain_pem = cert_body[b:b + inner_cert_body_len]; b += inner_cert_body_len
    assert b == len(cert_body), f"cert_body trailing bytes: {b} vs {len(cert_body)}"
    assert inner_cert_type == PCK_CERT_CHAIN, f"expected PCK_CERT_CHAIN(5), got {inner_cert_type}"

    return dict(
        version=version, tee_type=tee_type, header_end=header_end,
        signed_scope=raw[:signed_len], report_data=report_data,
        ecdsa_signature=ecdsa_signature, ecdsa_attestation_key=ecdsa_attestation_key,
        qe_report=qe_report, qe_report_signature=qe_report_signature,
        qe_auth_data=qe_auth_data, pck_chain_pem=pck_chain_pem,
    )


def extract_pem_certs(pem_blob: bytes):
    certs = []
    text = pem_blob.decode("utf-8", "ignore")
    parts = text.split("-----BEGIN CERTIFICATE-----")
    for p in parts[1:]:
        body = p.split("-----END CERTIFICATE-----")[0]
        pem = "-----BEGIN CERTIFICATE-----" + body + "-----END CERTIFICATE-----\n"
        certs.append(x509.load_pem_x509_certificate(pem.encode()))
    return certs


def verify_bundle(raw_quote: bytes, root_ca_der: bytes, label: str):
    print(f"\n=== {label} ===")
    q = parse_quote(raw_quote)
    print("quote version:", q["version"], "tee_type:", hex(q["tee_type"]))
    print("signed scope (header||body) length:", len(q["signed_scope"]))
    print("qe_report_data (report_data[0:64] of TD report):", q["report_data"].hex())

    certs = extract_pem_certs(q["pck_chain_pem"])
    print(f"PCK chain certs embedded in quote: {len(certs)}")
    for i, c in enumerate(certs):
        print(f"  [{i}] subject={c.subject.rfc4514_string()}")

    leaf = certs[0]
    intermediate = certs[1] if len(certs) > 1 else None
    root_from_quote = certs[2] if len(certs) > 2 else None
    root_ca = x509.load_der_x509_certificate(root_ca_der)
    print("Known-good Intel SGX Root CA subject:", root_ca.subject.rfc4514_string())

    # 1. leaf signed by intermediate (or root if 2-cert chain)
    signer_of_leaf = intermediate if intermediate is not None else root_ca
    signer_of_leaf.public_key().verify(
        leaf.signature, leaf.tbs_certificate_bytes,
        ec.ECDSA(leaf.signature_hash_algorithm),
    )
    print("[OK] PCK leaf cert signature verifies under its issuer")

    # 2. intermediate signed by root CA (well-known Intel root, hardcoded)
    if intermediate is not None:
        assert intermediate.issuer == root_ca.subject
        root_ca.public_key().verify(
            intermediate.signature, intermediate.tbs_certificate_bytes,
            ec.ECDSA(intermediate.signature_hash_algorithm),
        )
        print("[OK] Intermediate CA cert signature verifies under Intel SGX Root CA")

    # sanity: root cert in quote (if present) byte-identical to the hardcoded trust anchor
    if root_from_quote is not None:
        assert root_from_quote.public_bytes(serialization.Encoding.DER) == root_ca_der
        print("[OK] Root cert embedded in quote is byte-identical to hardcoded Intel root")

    # 3. qe_report signed by PCK leaf's pubkey
    leaf_pub = leaf.public_key()
    qe_sig_der = raw_sig_to_der(q["qe_report_signature"])
    leaf_pub.verify(qe_sig_der, q["qe_report"], ec.ECDSA(hashes.SHA256()))
    print("[OK] qe_report signature verifies under PCK leaf pubkey")

    # 4. qe_report.report_data[0:32] == SHA256(attestation_key || qe_auth_data)
    qe_report_data_field = q["qe_report"][-64:]
    expect = hashlib.sha256(q["ecdsa_attestation_key"] + q["qe_auth_data"]).digest()
    assert qe_report_data_field[:32] == expect, "qe_report_data binding mismatch"
    print("[OK] qe_report_data binds SHA256(attestation_key || qe_auth_data)")

    # 5. ISV (quote) signature: attestation_key signs header||body
    att_pub = raw_pubkey_to_key(q["ecdsa_attestation_key"])
    isv_sig_der = raw_sig_to_der(q["ecdsa_signature"])
    att_pub.verify(isv_sig_der, q["signed_scope"], ec.ECDSA(hashes.SHA256()))
    print("[OK] ISV/quote signature verifies under the attestation key")

    print(f"BUNDLE {label}: ALL CHECKS PASSED (TDX quote chain, no NVIDIA evidence present)")
    return q, certs


def negative_case(raw_quote: bytes, root_ca_der: bytes, mutate_offset: int, label: str):
    mutated = bytearray(raw_quote)
    mutated[mutate_offset] ^= 0x01
    try:
        verify_bundle(bytes(mutated), root_ca_der, label + " [MUTATED, expect failure]")
        print(f"FAIL: {label} did not reject a flipped bit at offset {mutate_offset}")
        return False
    except (InvalidSignature, AssertionError) as e:
        print(f"[OK] {label} correctly rejected: {type(e).__name__}: {e}")
        return True


if __name__ == "__main__":
    root_ca_der = open("TrustedRootCA.der", "rb").read()

    for fname in ["attestation_raw_20260926_1.json", "attestation_raw_20260926_2.json"]:
        bundle = json.load(open(fname))
        quote_hex = bundle["attestation"]["evidence"]["quote"]
        raw_quote = bytes.fromhex(quote_hex)
        q, certs = verify_bundle(raw_quote, root_ca_der, fname)

    print("\n\n########## NEGATIVE CASES (bit flips must be rejected) ##########")
    bundle = json.load(open("attestation_raw_20260926_1.json"))
    raw_quote = bytes.fromhex(bundle["attestation"]["evidence"]["quote"])

    # a) flip a bit in the ISV/quote signature (last ~64 bytes before attestation key)
    sig_offset = 48 + 584 + 4  # start of ecdsa_signature within auth_data
    ok1 = negative_case(raw_quote, root_ca_der, sig_offset + 5, "ISV signature bit flip")

    # b) flip a bit inside the PCK leaf certificate PEM body (well past the -----BEGIN----- marker)
    pem_marker = raw_quote.find(b"-----BEGIN CERTIFICATE-----")
    ok2 = negative_case(raw_quote, root_ca_der, pem_marker + 200, "PCK certificate bit flip")

    # c) flip a bit in report_data (TD report, last 64 bytes of the 584-byte body)
    report_data_offset = 48 + 584 - 64 + 10
    ok3 = negative_case(raw_quote, root_ca_der, report_data_offset, "report_data bit flip")

    print("\n\nSummary:", "ALL NEGATIVE CASES REJECTED" if (ok1 and ok2 and ok3) else "SOME NEGATIVE CASES FAILED TO REJECT")
