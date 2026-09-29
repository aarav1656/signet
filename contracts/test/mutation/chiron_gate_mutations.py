#!/usr/bin/env python3
"""Mutation check for ChironGate: remove each guard, confirm the suite goes red, restore.

Usage (from contracts/):  python3 test/mutation/chiron_gate_mutations.py
Runs `forge test --match-path test/ChironGate.t.sol` once unmutated (must be green) and once
per mutant. A mutant is KILLED when at least one test fails. Restores the source on exit.
"""
import re
import subprocess
import sys
from pathlib import Path

SRC = Path("src/ChironGate.sol")

MUTANTS = [
    ("receiver == gate", "c.receiver != address(this) || ", ""),
    ("receiverAuthorizer == gate", " || c.receiverAuthorizer != address(this)", ""),
    ("salt == pin preimage", "if (c.salt != pinSalt(pin)) revert PinMismatch();", ""),
    ("model pin != 0", "pin.requestedModelHash == bytes32(0) || ", ""),
    ("payout != 0", " || pin.providerPayout == address(0)", ""),
    ("CallAck required", "if (!_payerSigned(c, ack, payerCallSig)) revert BadCallAck();", ""),
    ("CallAck signer == payerAuthorizer", "return recovered == c.payerAuthorizer;", "return recovered != address(0);"),
    ("CallAck signer == payer (authorizer 0)", "return SignatureChecker.isValidSignatureNow(c.payer, digest, sig);", "return sig.length == 65;"),
    ("CallAck binds totalClaimed", "callAckDigest(channelId, vc.totalClaimed, requestHash, responseHash);",
     "callAckDigest(channelId, vc.voucher.maxClaimableAmount, requestHash, responseHash);"),
    ("receipt ok", "if (!ok) revert ReceiptInvalid();", ""),
    ("requested model == pin", "requestedModel != pin.requestedModelHash || ", ""),
    ("served model == pin", " || servedModel != pin.requestedModelHash", ""),
    ("receipt requestHash == acked", "if (receiptRequest != requestHash) revert RequestHashMismatch();", ""),
    ("receipt responseHash == acked", "if (receiptResponse != responseHash) revert ResponseHashMismatch();", ""),
    ("key registered", "if (measurement == bytes32(0)) revert SignerNotRegistered();", ""),
    ("measurement == pin", "if (measurement != pin.measurement) revert MeasurementMismatch();", ""),
    ("key unexpired", "if (block.timestamp > expiry) revert AttestationExpired();", ""),
    ("replay check", "if (consumed[channelId][callKey]) revert ReceiptAlreadyConsumed();", ""),
    ("replay mark", "consumed[channelId][callKey] = true;", ""),
    ("totalClaimed strictly increases", "if (vc.totalClaimed <= claimedBefore) revert NothingToClaim();", ""),
    ("pre-claim settle flush", "        x402.settle(address(this), token);\n\n        IX402BatchSettlement", "        IX402BatchSettlement"),
    ("settle delta == claim delta", "if (IERC20(token).balanceOf(address(this)) - gateBefore != paid) revert SettleShort();", ""),
    ("forward delta == claim delta", "if (IERC20(token).balanceOf(providerPayout) - providerBefore != paid) revert ForwardShort();", ""),
    ("nonReentrant", "external nonReentrant returns (uint128 paid)", "external returns (uint128 paid)"),
    ("constructor: x402 has code", "address(x402_).code.length == 0 || ", ""),
    ("constructor: registry has code", " || address(registry_).code.length == 0", ""),
]


def run():
    p = subprocess.run(
        ["forge", "test", "--match-path", "test/ChironGate.t.sol"],
        capture_output=True, text=True, env={**__import__("os").environ, "FOUNDRY_DISABLE_NIGHTLY_WARNING": "1"},
    )
    out = p.stdout + p.stderr
    if "Compiler run failed" in out or "Error (" in out:
        return None, ["COMPILE ERROR"]
    failed = sorted(set(re.findall(r"\[FAIL[^\]]*\] (\w+)\(", out)))
    passed = re.findall(r"\[PASS\] (\w+)\(", out)
    if not failed and not passed:
        return None, [out[-400:]]
    return len(failed), failed


def main():
    original = SRC.read_text()
    try:
        n, _ = run()
        if n != 0:
            sys.exit(f"baseline not green: {n}")
        print("baseline: green")
        survivors = 0
        for name, old, new in MUTANTS:
            if original.count(old) != 1:
                sys.exit(f"mutant '{name}': pattern found {original.count(old)} times")
            SRC.write_text(original.replace(old, new))
            n, failed = run()
            SRC.write_text(original)
            status = "KILLED" if n else ("ERROR" if n is None else "SURVIVED")
            survivors += status != "KILLED"
            print(f"{status:8} {name:40} {', '.join(failed)}", flush=True)
        n, _ = run()
        print("restored: " + ("green" if n == 0 else "NOT GREEN"))
        sys.exit(1 if survivors or n != 0 else 0)
    finally:
        SRC.write_text(original)


if __name__ == "__main__":
    main()
