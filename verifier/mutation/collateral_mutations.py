#!/usr/bin/env python3
"""Mutation check for the Intel collateral checks: break each guard, confirm a test goes red, restore.

Usage (from verifier/):  python3 mutation/collateral_mutations.py [name-substring]
Runs `cargo test --lib collateral` once unmutated (must be green) and once per mutant. A mutant is
KILLED when at least one test fails (or the mutant no longer compiles, which is reported as such).
Sources are restored on exit. Writes the tally to MUTATIONS.md next to this crate's Cargo.toml.
"""
import subprocess
import sys
from pathlib import Path

COLLATERAL = Path("src/collateral.rs")
LIB = Path("src/lib.rs")
RECORD = Path("MUTATIONS.md")

M = [
    # (file, name, original, mutated)
    (COLLATERAL, "document signature checked", "verify_p256(&signer.pubkey_xy, doc, &sig)?;", ""),
    (COLLATERAL, "signer certificate chained to the root", "verify_p256(root, signer.tbs_bytes, &signer.signature)?;", ""),
    (COLLATERAL, "signer must be named Intel SGX TCB Signing", 'if find_subslice(signer.tbs_bytes, b"Intel SGX TCB Signing").is_none() {', "if false {"),
    (COLLATERAL, "signer certificate validity window", "if now < signer.not_before || now > signer.not_after {", "if false {"),
    (COLLATERAL, "root CRL covers the TCB Info signer", "&[cert_serial(&certs[1])?, &tcb_signer, &qe_signer]", "&[cert_serial(&certs[1])?, &qe_signer]"),
    (COLLATERAL, "root CRL covers the QE Identity signer", "&[cert_serial(&certs[1])?, &tcb_signer, &qe_signer]", "&[cert_serial(&certs[1])?, &tcb_signer]"),
    (COLLATERAL, "root CRL covers the PCK CA", "&[cert_serial(&certs[1])?, &tcb_signer, &qe_signer]", "&[&tcb_signer, &qe_signer]"),
    (COLLATERAL, "PCK CRL consulted", "check_crl(c.pck_crl, &intermediate.pubkey_xy, now, &[cert_serial(&certs[0])?])?;", ""),
    (COLLATERAL, "PCK CRL lists the PCK leaf", "now, &[cert_serial(&certs[0])?])?;", "now, &[])?;"),
    (COLLATERAL, "PCK CRL signed by the quote's CA", "check_crl(c.pck_crl, &intermediate.pubkey_xy,", "check_crl(c.pck_crl, root,"),
    (COLLATERAL, "CRL signature checked", "verify_p256(issuer_pubkey, tbs_bytes, &sig)?;", ""),
    (COLLATERAL, "CRL thisUpdate", "if now < asn1_time_to_unix(tt, this_tlv.content)? {", "if false {"),
    (COLLATERAL, "CRL nextUpdate", "if now >= asn1_time_to_unix(nt, next_tlv.content)? {", "if false {"),
    (COLLATERAL, "CRL membership", "if serials.contains(&listed) {", "if false {"),
    (COLLATERAL, "Revoked never passes", "if status >= REVOKED || status > max_status {", "if status > max_status {"),
    (COLLATERAL, "status ceiling", "if status >= REVOKED || status > max_status {", "if status >= REVOKED {"),
    (COLLATERAL, "QE status counts", ".max(evaluate_qe_identity(c.qe_identity, now, min_eval, q.qe_report)?)", ".max(UP_TO_DATE)"),
    (COLLATERAL, "module status counts", "Ok(platform_status.max(module_status))", "Ok(platform_status)"),
    (COLLATERAL, "Revoked rank", 'b"Revoked" => REVOKED,', 'b"Revoked" => OUT_OF_DATE,'),
    (COLLATERAL, "OutOfDate rank", 'b"OutOfDate" => OUT_OF_DATE,', 'b"OutOfDate" => SW_HARDENING_NEEDED,'),
    (COLLATERAL, "TCB Info id and version", 'if str_member(b, 0, "id")? != b"TDX" || u64_member(b, 0, "version")? != 3 {', "if false {"),
    (COLLATERAL, "FMSPC pinned", "if fmspc != p.pck.fmspc {", "if false {"),
    (COLLATERAL, "issueDate", "if now < issued {", "if false {"),
    (COLLATERAL, "nextUpdate is exclusive", "if now >= next {", "if now > next {"),
    (COLLATERAL, "evaluation number floor", 'if u64_member(b, 0, "tcbEvaluationDataNumber")? < min_eval {', "if false {"),
    (COLLATERAL, "module signer pinned", "if p.mr_signer_seam != signer {", "if false {"),
    (COLLATERAL, "module attributes pinned", "if p.seam_attributes[i] & mask[i] != attrs[i] & mask[i] || p.seam_attributes[i] & !mask[i] != 0 {", "if p.seam_attributes[i] & !mask[i] != 0 {"),
    (COLLATERAL, "module attribute bits outside the mask", "|| p.seam_attributes[i] & !mask[i] != 0 {", "{"),
    (COLLATERAL, "module SVNs left to module identity", "let skip = if module_version > 0 { 2 } else { 0 };", "let skip = 0;"),
    (COLLATERAL, "module identity ISVSVN", "if isv < find_u64_member(", "if isv > find_u64_member("),
    (COLLATERAL, "PCESVN compared", "if (p.pck.pce_svn as u64) < find_u64_member(", "if (p.pck.pce_svn as u64) > find_u64_member("),
    (COLLATERAL, "CPUSVN compared", "if p.pck.cpu_svn[i] < sgx[i] ||", "if false ||"),
    (COLLATERAL, "TEE_TCB_SVN compared", "(i >= skip && p.tee_tcb_svn[i] < tdx[i])", "false"),
    (COLLATERAL, "QE identity id and version", 'if str_member(b, 0, "id")? != b"TD_QE" || (version != 2 && version != 3) {', "if false {"),
    (COLLATERAL, "QE MRSIGNER pinned", "if qe_report[QE_MR_SIGNER..QE_MR_SIGNER + 32] != mrsigner {", "if false {"),
    (COLLATERAL, "QE ISVPRODID pinned", 'if read_u16_le(&qe_report[QE_ISV_PROD_ID..]) as u64 != u64_member(b, 0, "isvprodid")? {', "if false {"),
    (COLLATERAL, "QE MISCSELECT pinned", "if qe_report[QE_MISC_SELECT + i] & misc_mask[i] != misc[i] & misc_mask[i] {", "if false {"),
    (COLLATERAL, "QE ATTRIBUTES pinned", "if qe_report[QE_ATTRIBUTES + i] & attrs_mask[i] != attrs[i] & attrs_mask[i] {", "if false {"),
    (COLLATERAL, "QE ISVSVN level", 'if isv_svn < find_u64_member(b, tcb, "isvsvn")?', 'if isv_svn > find_u64_member(b, tcb, "isvsvn")?'),
    (LIB, "entry runs the quote verification first", "let (signer, measurement) = self.verify(quote.clone(), nonce)?;", "let (signer, measurement) = (Address::ZERO, FixedBytes::<32>::ZERO);"),
    (LIB, "entry forwards the status ceiling", "            max_status,\n            min_eval as u64,", "            255,\n            min_eval as u64,"),
    (LIB, "entry forwards the evaluation floor", "            min_eval as u64,\n            root,", "            0,\n            root,"),
    (LIB, "entry uses Intel's root", "&INTEL_ROOT_PUBKEY)\n    }\n}\n\nimpl Verifier", "&[0u8; 64])\n    }\n}\n\nimpl Verifier"),
]

TEST = ["cargo", "test", "--lib", "collateral"]


def run():
    r = subprocess.run(TEST, capture_output=True, text=True)
    out = r.stdout + r.stderr
    if r.returncode == 0:
        return "survived", out
    if "error[E" in out or "could not compile" in out:
        return "does not compile", out
    return "killed", out


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    originals = {COLLATERAL: COLLATERAL.read_text(), LIB: LIB.read_text()}
    rows = []
    try:
        state, out = run()
        print("baseline:", state)
        if state != "survived":
            print(out[-2000:])
            sys.exit("baseline must be green")
        for path, name, orig, mutated in M:
            if only and only not in name:
                continue
            src = originals[path]
            if src.count(orig) != 1:
                sys.exit(f"mutant '{name}': original text matched {src.count(orig)} times")
            path.write_text(src.replace(orig, mutated))
            state, out = run()
            path.write_text(src)
            failing = sorted({l.split("::")[-1].split(" ")[0] for l in out.splitlines() if l.startswith("test ") and l.endswith("FAILED")})
            print(f"{state:>16}  {name}  {failing[:2]}")
            rows.append((name, state, failing))
    finally:
        for p, s in originals.items():
            p.write_text(s)
    if not only:
        killed = sum(1 for r in rows if r[1] == "killed")
        lines = [
            "# Collateral mutation record",
            "",
            f"{killed} of {len(rows)} mutants killed by `cargo test --lib collateral` in verifier/.",
            "Each row removes or inverts one guard in `src/collateral.rs` or the entry in `src/lib.rs`; a mutant is killed when a test fails.",
            "",
            "| Guard removed or inverted | Result | First failing test |",
            "|---|---|---|",
        ]
        for name, state, failing in rows:
            lines.append(f"| {name} | {state} | {failing[0] if failing else ''} |")
        RECORD.write_text("\n".join(lines) + "\n")
        print(f"{killed}/{len(rows)} killed")
        sys.exit(0 if killed == len(rows) else 1)


main()
