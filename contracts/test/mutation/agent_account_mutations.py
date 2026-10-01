#!/usr/bin/env python3
"""Mutation check for AgentAccount: remove each guard, confirm the suite goes red, restore.

Usage (from contracts/):  python3 test/mutation/agent_account_mutations.py [name-substring]
Builds the canonical PoolManager (`v4` profile) once, then runs the AgentAccount unit, window
and invariant suites once unmutated (must be green) and once per mutant under the `mutation`
profile (no optimizer, own out/cache). A mutant is KILLED when at least one test fails.
Restores the source on exit and writes the tally to ../docs/security/agent-account-mutations.md.
Each forge run is capped at 230 s.
"""
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

SRC = Path("src/AgentAccount.sol")
RECORD = Path("../docs/security/agent-account-mutations.md")
ENV = {**os.environ, "FOUNDRY_DISABLE_NIGHTLY_WARNING": "1", "FOUNDRY_PROFILE": "mutation"}
SKIP = ["script/**", "*RHCFork*", "test/ChironGate*", "test/Assay*", "test/AttackReview*", "test/ReReview*"]
CMD = ["timeout", "230", "forge", "test", "--match-path", "test/AgentAccount*.t.sol"]
for s in SKIP:
    CMD += ["--skip", s]

ANY_AGENT_SIG = (
    "{ (address a0, ECDSA.RecoverError e0,) = ECDSA.tryRecover(hash, sig); "
    "if (e0 == ECDSA.RecoverError.NoError && a0 == agent) return IERC1271.isValidSignature.selector; }\n"
    "        if (sig.length < 224) return 0xffffffff;"
)

MUTANTS = [
    # admission (I1)
    ("quote replay check", "if (usedQuote[quoteHash]) revert QuoteAlreadyUsed();", ""),
    ("quote marked used", "usedQuote[quoteHash] = true;", ""),
    ("measurement approved", "if (!approvedMeasurement[measurement]) revert MeasurementNotApproved(measurement);", ""),
    ("agent != owner at registration", "if (signer == owner()) revert AgentIsOwner();", ""),
    ("agent != 0 at registration", "if (signer == address(0)) revert NotAgent();", ""),
    ("registration bumps epoch", "uint256 epoch = ++agentEpoch;\n        uint64 expiry", "uint256 epoch = agentEpoch;\n        uint64 expiry"),
    ("nonce binds epoch", "address(this), agentEpoch, _refBlockHash", "address(this), _refBlockHash"),
    ("nonce binds account", "block.chainid, address(this), agentEpoch", "block.chainid, agentEpoch"),
    ("nonce binds chain", "abi.encode(block.chainid, address(this), agentEpoch", "abi.encode(address(this), agentEpoch"),
    ("ArbSys revert is final", "if (!ok) revert StaleRefBlock();", ""),
    ("zero ref hash reverts (RR-2)", "if (h == bytes32(0)) revert StaleRefBlock();", ""),
    ("unapproving the live measurement revokes", "if (!approved && agent != address(0) && agentMeasurement == measurement) _revokeAgent();", ""),
    ("revoke clears agent", "agent = address(0);", ""),
    ("revoke bumps epoch", "uint256 epoch = ++agentEpoch;\n        agent = address(0);", "uint256 epoch = agentEpoch;\n        agent = address(0);"),
    # freshness (I2)
    ("caller is agent", "if (msg.sender != agent) revert NotAgent();", ""),
    ("agent unexpired", "if (block.timestamp > agentExpiry) revert AgentExpired();", ""),
    ("not paused (agent)", "if (paused) revert IsPaused();\n    }", "\n    }"),
    # trade shape
    ("deadline", "if (block.timestamp > t.deadline) revert DeadlinePassed();", ""),
    ("amountIn > 0", "if (t.amountIn == 0) revert ZeroAmount();", ""),
    ("minOut > 0", "if (t.minOut == 0) revert ZeroMinOut();", ""),
    ("pool allowlisted", "if (!allowedPool[poolId]) revert PoolNotAllowed(poolId);", ""),
    ("tokens derived from key", "(tokenIn, tokenOut) = t.zeroForOne ? (c0, c1) : (c1, c0);", "(tokenIn, tokenOut) = t.zeroForOne ? (c1, c0) : (c0, c1);"),
    ("tokenIn allowed", "if (!limits[tokenIn].allowed) revert TokenNotAllowed(tokenIn);", ""),
    ("tokenOut allowed", "if (!limits[tokenOut].allowed) revert TokenNotAllowed(tokenOut);", ""),
    # bands and window (I3)
    ("per-trade cap (execute)", "if (t.amountIn > l.perTrade) revert ExceedsPerTradeCap(t.amountIn, l.perTrade);\n        if (t.amountIn > l.approvalAbove)",
     "if (t.amountIn > l.approvalAbove)"),
    ("band 2 needs approval", "if (t.amountIn > l.approvalAbove) revert NeedsApproval(t.amountIn, l.approvalAbove);", ""),
    ("per-trade cap (propose)", "if (t.amountIn > l.perTrade) revert ExceedsPerTradeCap(t.amountIn, l.perTrade);\n        if (t.amountIn <= l.approvalAbove)",
     "if (t.amountIn <= l.approvalAbove)"),
    ("band 1 cannot propose", "if (t.amountIn <= l.approvalAbove) revert ApprovalNotNeeded();", ""),
    ("per-trade cap (approve)", "if (t.amountIn > cap) revert ExceedsPerTradeCap(t.amountIn, cap);", ""),
    ("window checked on execute", "_spendWindow(tokenIn, t.amountIn, l.daily);", ""),
    ("daily cap", "if (used + amountIn > daily) revert DailyCapExceeded(used, daily);", ""),
    ("window sums 25 hours, not 24", "if (uint256(b.hour) + 24 >= h) used += b.amount;", "if (uint256(b.hour) + 23 >= h) used += b.amount;"),
    ("window reads all 25 buckets", "for (uint256 i; i < WINDOW_HOURS; ++i) {\n            Bucket memory b",
     "for (uint256 i; i < 24; ++i) {\n            Bucket memory b"),
    ("reused slot resets", "slot.amount = 0;", ""),
    ("reused slot takes the new hour", "slot.hour = uint32(h);", ""),
    ("window records the trade", "slot.amount += amountIn;", ""),
    # receipt (I6)
    ("receipt ok", "if (!ok) revert ReceiptInvalid();", ""),
    ("model pin set", "if (requestedModelHash == bytes32(0)) revert ModelNotSet();\n        if (requested", "if (requested"),
    ("requested model == pin", "if (requested != requestedModelHash) revert ModelMismatch();", ""),
    ("served model in accepted set", "if (!_acceptsServed(served)) revert ModelMismatch();", ""),
    ("zero served hash never matches", "if (served == bytes32(0)) return false;", ""),
    ("every accepted slot is scanned", "for (uint256 i; i < 4; ++i) {", "for (uint256 i; i < 1; ++i) {"),
    ("receipt key registered", "if (m == bytes32(0)) revert ReceiptKeyNotRegistered();", ""),
    ("receipt key measurement == pin", "if (m != gatewayMeasurement) revert GatewayMeasurementMismatch();", ""),
    ("receipt key unexpired", "if (block.timestamp > expiry) revert ReceiptKeyExpired();", ""),
    ("receipt reuse check", "if (usedReceipt[key]) revert ReceiptAlreadyUsed();", ""),
    ("receipt reuse mark", "usedReceipt[key] = true;", ""),
    ("propose consumes a receipt", "(bytes32 served, bytes32 reqHash, bytes32 respHash) = _consumeReceipt(r);\n\n",
     "(bytes32 served, bytes32 reqHash, bytes32 respHash) = (bytes32(0), bytes32(0), bytes32(0));\n\n"),
    ("setModel: model and gateway nonzero", "if (requestedModelHash_ == bytes32(0) || gatewayMeasurement_ == bytes32(0)) revert ModelNotSet();", ""),
    ("setModel: accepted set nonzero", "== bytes32(0)\n        ) revert ModelNotSet();", "== bytes32(uint256(1))\n        ) revert ModelNotSet();"),
    # swap (I4)
    ("swap flag raised", "swapping = true;", ""),
    ("swap flag lowered", "swapping = false;", ""),
    ("spent <= amountIn", "if (spent > t.amountIn) revert OverSpent(spent, t.amountIn);", ""),
    ("got >= minOut", "if (got < t.minOut) revert InsufficientOutput(got, t.minOut);", ""),
    ("callback only from PoolManager", "if (msg.sender != address(poolManager)) revert NotPoolManager();", ""),
    ("callback only while swapping", "if (!swapping) revert NotSwapping();", ""),
    ("output taken to self", "poolManager.take(cOut, address(this),", "poolManager.take(cOut, msg.sender,"),
    # approvals (I5)
    ("approve: pending", "if (p.status != Status.Pending) revert ProposalNotPending();\n        if (block.timestamp > p.expiry)",
     "if (block.timestamp > p.expiry)"),
    ("approve: unexpired", "if (block.timestamp > p.expiry) revert ProposalExpired();", ""),
    ("approve: exact trade", "if (keccak256(abi.encode(t)) != p.tradeHash) revert TradeMismatch();", ""),
    ("approve: proposer is current agent", "if (p.agent != agent) revert ProposerNotCurrentAgent();", ""),
    ("approve: not paused", "if (paused) revert IsPaused();\n        (address tokenIn", "(address tokenIn"),
    ("approve: status final", "p.status = Status.Executed;", ""),
    ("reject: pending", "if (p.status != Status.Pending) revert ProposalNotPending();\n        p.status = Status.Rejected;", "p.status = Status.Rejected;"),
    ("reject: status final", "p.status = Status.Rejected;", ""),
    ("cancel: proposer only", "if (msg.sender != p.agent) revert NotAgent();", ""),
    ("cancel: pending", "if (p.status != Status.Pending) revert ProposalNotPending();\n        p.status = Status.Cancelled;", "p.status = Status.Cancelled;"),
    ("cancel: status final", "p.status = Status.Cancelled;", ""),
    # policy setters
    ("limits: approvalAbove <= perTrade", "if (l.approvalAbove > l.perTrade) revert BadLimits();", ""),
    ("pool: no hooks", "if (address(key.hooks) != address(0)) revert HookedPool();", ""),
    ("pool: currency0 not native", "if (c0 == address(0) || c1 == address(0)) revert NativeCurrency();", "if (c1 == address(0)) revert NativeCurrency();"),
    ("pool: currency1 not native", "if (c0 == address(0) || c1 == address(0)) revert NativeCurrency();", "if (c0 == address(0)) revert NativeCurrency();"),
    ("pool: currency0 allowed", "if (!limits[c0].allowed) revert TokenNotAllowed(c0);", ""),
    ("pool: currency1 allowed", "if (!limits[c1].allowed) revert TokenNotAllowed(c1);", ""),
    # ERC-1271 scope (I7)
    ("1271: magic on any agent signature", "if (sig.length < 224) return 0xffffffff;", ANY_AGENT_SIG),
    ("1271: wrapped, agent signature only",
     "if (hash != keccak256(abi.encodePacked(\"\\x19\\x01\", domain, structHash))) return 0xffffffff;\n"
     "        (address chAgent,,,,,,, bool closed,,) = assay.channels(channelId);\n"
     "        if (chAgent != address(this) || closed) return 0xffffffff;\n"
     "        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, agentSig);\n"
     "        if (err != ECDSA.RecoverError.NoError || recovered != agent) return 0xffffffff;\n"
     "        if (block.timestamp > agentExpiry || paused) return 0xffffffff;",
     "(address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, agentSig);\n"
     "        if (err != ECDSA.RecoverError.NoError || recovered != agent) return 0xffffffff;"),
    ("1271: short sig returns failure", "if (sig.length < 224) return 0xffffffff;", ""),
    ("1271: digest is the Assay voucher", "if (hash != keccak256(abi.encodePacked(\"\\x19\\x01\", domain, structHash))) return 0xffffffff;", ""),
    ("1271: channel agent is this account", "if (chAgent != address(this) || closed) return 0xffffffff;", "if (closed) return 0xffffffff;"),
    ("1271: channel open", "if (chAgent != address(this) || closed) return 0xffffffff;", "if (chAgent != address(this)) return 0xffffffff;"),
    ("1271: signer is agent", "if (err != ECDSA.RecoverError.NoError || recovered != agent) return 0xffffffff;",
     "if (err != ECDSA.RecoverError.NoError) return 0xffffffff;"),
    ("1271: agent unexpired", "if (block.timestamp > agentExpiry || paused) return 0xffffffff;", "if (paused) return 0xffffffff;"),
    ("1271: not paused", "if (block.timestamp > agentExpiry || paused) return 0xffffffff;", "if (block.timestamp > agentExpiry) return 0xffffffff;"),
    # billing
    ("channel open needs a model pin", "if (requestedModelHash == bytes32(0)) revert ModelNotSet();\n        IERC20(usdg)", "IERC20(usdg)"),
    # Equivalent against the real Assay: _pull transfers exactly the approved amount, so the
    # allowance is already 0. Kept because the spec requires the reset; reported, not hidden.
    ("allowance reset after channel open [equivalent]", "IERC20(usdg).forceApprove(address(assay), 0);", ""),
    # reentrancy
    ("nonReentrant execute", "        external\n        nonReentrant\n        returns (uint256 tradeId", "        external\n        returns (uint256 tradeId"),
    ("nonReentrant propose", "external nonReentrant returns (uint256 proposalId)", "external returns (uint256 proposalId)"),
    ("nonReentrant cancelProposal", "function cancelProposal(uint256 id) external nonReentrant {", "function cancelProposal(uint256 id) external {"),
    # owner powers (I8) and ownership
    ("onlyOwner approveTrade", "Trade calldata t) external onlyOwner nonReentrant", "Trade calldata t) external nonReentrant"),
    ("onlyOwner rejectTrade", "function rejectTrade(uint256 id) external onlyOwner {", "function rejectTrade(uint256 id) external {"),
    ("onlyOwner setLimits", "Limits calldata l) external onlyOwner {", "Limits calldata l) external {"),
    ("onlyOwner setPool", "bool allowed) external onlyOwner {", "bool allowed) external {"),
    ("onlyOwner setMeasurement", "bool approved) external onlyOwner {", "bool approved) external {"),
    ("onlyOwner setModel", "        external\n        onlyOwner\n    {", "        external\n    {"),
    ("onlyOwner setApprovalTtl", "function setApprovalTtl(uint64 ttl) external onlyOwner {", "function setApprovalTtl(uint64 ttl) external {"),
    ("onlyOwner pause", "function pause() external onlyOwner {", "function pause() external {"),
    ("onlyOwner unpause", "function unpause() external onlyOwner {", "function unpause() external {"),
    ("onlyOwner revokeAgent", "function revokeAgent() external onlyOwner {", "function revokeAgent() external {"),
    ("onlyOwner withdraw", "uint256 amount) external onlyOwner nonReentrant {\n        IERC20(token)", "uint256 amount) external nonReentrant {\n        IERC20(token)"),
    ("onlyOwner withdrawETH", "address payable to, uint256 amount) external onlyOwner nonReentrant", "address payable to, uint256 amount) external nonReentrant"),
    ("onlyOwner openInferenceChannel", "        onlyOwner\n        nonReentrant\n        returns (uint256 channelId)", "        nonReentrant\n        returns (uint256 channelId)"),
    ("onlyOwner requestInferenceClose", "function requestInferenceClose(uint256 channelId) external onlyOwner", "function requestInferenceClose(uint256 channelId) external"),
    ("onlyOwner finalizeInferenceClose", "function finalizeInferenceClose(uint256 channelId) external onlyOwner", "function finalizeInferenceClose(uint256 channelId) external"),
    ("renounceOwnership disabled", "revert RenounceDisabled();", ""),
    ("ownership never passes to the agent", "if (newOwner != address(0) && newOwner == agent) revert AgentIsOwner();", ""),
    # constructor
    ("constructor: verifier has code", "if (verifier_.code.length == 0) revert NoCode(verifier_);", ""),
    ("constructor: receiptVerifier has code", "if (receiptVerifier_.code.length == 0) revert NoCode(receiptVerifier_);", ""),
    ("constructor: assay has code", "if (assay_.code.length == 0) revert NoCode(assay_);", ""),
    ("constructor: poolManager has code", "if (poolManager_.code.length == 0) revert NoCode(poolManager_);", ""),
    ("constructor: usdg has code", "if (usdg_.code.length == 0) revert NoCode(usdg_);", ""),
]


def run(force=False):
    p = subprocess.run(CMD + (["--force"] if force else []), capture_output=True, text=True, env=ENV)
    out = p.stdout + p.stderr
    if "Compiler run failed" in out or "Error (" in out:
        return None, ["COMPILE ERROR"]
    failed = sorted(set(re.findall(r"^\[FAIL.*\] (\w+)\(", out, re.M)))  # reasons carry "[1.1e7]"
    passed = re.findall(r"\[PASS\] (\w+)\(", out)
    if not failed and not passed:
        return None, [out[-400:].replace("\n", " ")]
    return len(failed), failed


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    original = SRC.read_text()
    for name, old, _ in MUTANTS:
        if original.count(old) != 1:
            sys.exit(f"mutant '{name}': pattern found {original.count(old)} times")
    subprocess.run(["timeout", "230", "forge", "build"], env={**ENV, "FOUNDRY_PROFILE": "v4"}, check=True,
                   capture_output=True)
    lines = []
    for d in ("cache-mut", "out-mut"):  # a stale mutation cache can fail the baseline with solc 2449
        shutil.rmtree(d, ignore_errors=True)
    try:
        n, failed = run()
        if n != 0:
            sys.exit(f"baseline not green: {n} {failed}")
        print("baseline: green", flush=True)
        survivors = 0
        for name, old, new in MUTANTS:
            if only and only not in name:
                continue
            SRC.write_text(original.replace(old, new))
            t0 = time.time()
            n, failed = run()
            if n == 0:  # an incremental build can miss a same-second rewrite; confirm from scratch
                n, failed = run(force=True)
            SRC.write_text(original)
            status = "KILLED" if n else ("ERROR" if n is None else "SURVIVED")
            if status == "SURVIVED" and "[equivalent]" in name:
                status = "EQUIV"
            survivors += status not in ("KILLED", "EQUIV")
            line = f"{status:8} {name:44} {', '.join(failed)}"
            lines.append(line)
            print(f"{line}  ({time.time() - t0:.0f}s)", flush=True)
        n, _ = run()
        restored = "green" if n == 0 else "NOT GREEN"
        print("restored: " + restored)
        killed = sum(1 for l in lines if l.startswith("KILLED"))
        equiv = sum(1 for l in lines if l.startswith("EQUIV"))
        tally = (f"{killed}/{len(lines)} killed, {equiv} equivalent (documented), "
                 f"{len(lines) - killed - equiv} survived or errored; restored suite {restored}")
        print(tally)
        if not only:
            RECORD.write_text(
                "# AgentAccount mutation record\n\n"
                "Generated by `contracts/test/mutation/agent_account_mutations.py` "
                f"on {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}. Each guard in "
                "`contracts/src/AgentAccount.sol` is removed or weakened one at a time; the unit, window and "
                "invariant suites must go red (KILLED), then the source is restored and must go green.\n\n"
                f"Baseline: green. {tally}.\n\n```\n" + "\n".join(lines) + "\n```\n"
            )
        sys.exit(1 if survivors or n != 0 else 0)
    finally:
        SRC.write_text(original)


if __name__ == "__main__":
    main()
