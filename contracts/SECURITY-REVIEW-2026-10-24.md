# Security review, 2026-10-24: signet-contracts

Scope: the `main...signet-contracts` diff over `contracts/src`, `verifier` and `receipt-verifier` (AgentAccount collateral admission and attestation policy, `ICollateralVerifier`, `verifier/src/collateral.rs`, `verify_with_collateral` in `verifier/src/lib.rs`), plus the unchanged code those paths reach: admission, receipts, swap and unlock callback, owner funds, ERC-1271, and the CVM `/quote` endpoint that feeds admission (`agent/src/cvm.ts`). Source was read only; PoCs are in `contracts/test/security/SecurityReview20261024.t.sol`.

## Verdict: FIX-FIRST (small), fixes applied: see the status table below

The collateral code is sound: every Intel document is authenticated against the hardcoded root before it is parsed, it is bound to the quote's own platform, and every failure reverts. No finding lets a non-owner widen the policy, admit an unapproved measurement, move funds outside the PoolManager path, or re-enter the swap.

Fix first: F-1 (one line in `revokeAgent`, shown drop-in below) and the two `contracts/SECURITY.md` sentences F-1 and F-2 make false. Everything else is Low or Info.

| ID | Severity | Title | PoC |
|---|---|---|---|
| F-1 | Medium | `revokeAgent` is undone by any stranger in one transaction | fork, red/green |
| F-2 | Low | The 24-hour admission is renewable by anyone; SECURITY.md says a key "stops trading within a day on its own" | fork, red/green |
| F-3 | Low | With more than one approved measurement, a stranger can switch the live agent and strand its pending proposals | fork, red/green |
| F-4 | Low | A receipt is not bound to the trade, the account or a time; one inference backs trades on two accounts | fork, red/green |
| F-5 | Low | Collateral freshness is chosen by the submitter: any document inside Intel's 30-day window (root CRL: 1 year) passes | Rust tests already in tree |
| F-6 | Info | `requireCollateral` is opt-in; turning it on stops `agent-cvm/keeper.sh` renewals; the live Verifier lacks `verifyWithCollateral` | code read |
| F-7 | Info | Deviations from Intel QVL: no `tcbType` or `pceId` check; stricter TDX module attribute check | code read |
| F-8 | Info | SECURITY.md guarantee 4 omits the agent's ERC-1271 voucher path into the Assay escrow | code read |
| F-9 | Info | `docs/agent-account-spec.md` lines 381 and 471 still say the Verifier has no TCB, QE or CRL check | code read |

PoC run: `RHC_FORK_BLOCK=141774771 RHC_FORK_URL=https://rpc.testnet.chain.robinhood.com forge test --match-path test/security/SecurityReview20261024.t.sol -j 1`: 8 passed, 0 failed (4 attacks, 4 controls). An unpinned run hit `unsupported block number` on the public RPC for one test; pinning the fork block cleared it.

## Status after the fixes, 2026-10-24

| ID | Status | Evidence |
|---|---|---|
| F-1 | Fixed in source. `revokeAgent` unapproves the live measurement. Not yet on the deployed accounts, which predate the fix. | commit `d2d6522`; the F-1 PoC in `test/security/SecurityReview20261024.t.sol` is red without the line and green with it; `AgentAccount.t.sol` unit test; mutant in `test/mutation/agent_account_mutations.py` |
| F-2 | Wording corrected in `SECURITY.md` (Design decisions, "Admission lasts 24 hours"): expiry shows the CVM is alive, revoking a key is `setMeasurement(m, false)` or `revokeAgent`. | `contracts/SECURITY.md` |
| F-3 | Open in the contract. A follower account created through the follow flow has exactly one approved measurement, so no second measurement exists to switch to. | `agent/src/follow.ts` |
| F-4 | Open by design. A receipt is recorded with the trade and not claimed as causal. Public copy says a trade names the measurement the agent was admitted under and the model of its verified inference receipt. | README, deck, canvases |
| F-5 | Open. Collateral freshness is the submitter's. An owner who sets `requireCollateral` accepts that window. | `contracts/src/AgentAccount.sol` |
| F-6 | Open until the next deployment. `SECURITY.md` now states which guards are live. | `contracts/SECURITY.md`, section "Source and deployed code" |
| F-7 | Accepted. Both deviations are documented above. | this file |
| F-8 | Fixed. Guarantee 4 names the ERC-1271 voucher path. | `contracts/SECURITY.md` |
| F-9 | Fixed. The two spec lines state the collateral path. | `docs/agent-account-spec.md` |

## Findings

### F-1 Medium: `revokeAgent` is undone by any stranger

`AgentAccount.revokeAgent()` clears `agent` and bumps `agentEpoch`, but leaves `approvedMeasurement[agentMeasurement] == true`. `registerAgent` is permissionless, and the CVM serves an unauthenticated `POST /quote?account=` (`agent/src/cvm.ts` 101 to 106) that returns its key bound to any account's current `attestNonce`. So anyone fetches a fresh quote and re-admits the key the owner just revoked. `agent-cvm/keeper.sh` does exactly this on a timer ("registerAgent is permissionless").

Impact: the owner's "revoke this key now" lasts one transaction. If the key is suspected compromised while the CVM still runs, the attacker re-admits it and trades inside the caps. `contracts/SECURITY.md` guarantee 6 ("calling `revokeAgent` clears the agent at once") is literally true but misleading, and the line "stops trading ... at once on `revokeAgent`" under "Admission lasts 24 hours" is false.

PoC: `test_F1_revokeAgent_isUndoneByAStranger`: owner `revokeAgent()`, stranger `registerAgent` with a fresh quote, `agent()` is the revoked key and it executes a trade on the real PoolManager. Control `test_F1_control_unapproveMeasurement_isDurable`: after `setMeasurement(m, false)` the same stranger replay reverts `MeasurementNotApproved`.

Fix (measurements are per boot, RTMR3 carries the instance id, so unapproving the live one costs nothing):

```solidity
function revokeAgent() external onlyOwner {
    if (agentMeasurement != bytes32(0)) {
        approvedMeasurement[agentMeasurement] = false;
        emit MeasurementSet(agentMeasurement, false);
    }
    _revokeAgent();
}
```

Proven in a sandbox copy of `contracts/`: with the fix the F-1 PoC goes red (`MeasurementNotApproved(0x1ebf...1a63)`), the control stays green, and the default suite stays green (338 passed, 0 failed, 12 fork tests skipped). Alternative: a `revokedSigner` mapping checked in `_admit`.

### F-2 Low: the 24-hour admission is renewable by anyone

`ATTESTATION_VALIDITY = 86400` bounds how long one quote counts, not how long a key trades: any caller renews it with a fresh `/quote`. The 24 hours is a liveness bound on the CVM (it must still answer `/quote`), which is useful, but SECURITY.md says "A rotated or compromised agent key stops trading within a day on its own".

PoC: `test_F2_expiry_isRenewedByAStranger`: a stranger renews at hour 23, the key trades at hour 25. Control `test_F2_control_withoutRenewal_expires`: no renewal, hour 25 reverts `AgentExpired`.

Fix: correct the sentence (expiry proves the CVM is alive, revocation of a key is `setMeasurement(m, false)` or the F-1 fix). If renewal should be gated, restrict re-admission of a different signer while one is live (see F-3).

### F-3 Low: a stranger can switch the live agent among approved measurements

`_admit` replaces any current agent. When the owner holds two approved measurements (the contract allows a set; a reboot or a follow approval adds one), anyone can flip the live agent between the two CVMs. Each flip bumps `agentEpoch` (in-flight quotes of the keeper die) and makes the previous agent's pending proposals unapprovable (`ProposerNotCurrentAgent`). Funds are not at risk; trade continuity and the approval queue are.

PoC: `test_F3_strangerSwapsAgent_strandsPendingProposal`: agent proposes 3 USDG, stranger admits the second CVM, owner `approveTrade` reverts `ProposerNotCurrentAgent`. Control `test_F3_control_noSwap_ownerApproves`: same proposal, no swap, the owner approves and the trade executes.

Fix: in `_admit`, when a live unexpired agent exists and `signer != agent`, require `msg.sender == owner()`; same-signer renewal stays permissionless. Or keep the follow flow at exactly one approved measurement and unapprove the old boot on rotation.

### F-4 Low: a receipt is not bound to the trade, the account or a time

`_consumeReceipt` checks the model pin, the served label, the gateway key and its expiry, and marks `(requestHash, responseHash)` used in this account's own `usedReceipt`. Nothing ties the receipt to `t`, to `address(this)`, or to when the inference happened. So claim (b) holds exactly as stated (the receipt binds the model), but a `TradeExecuted` proves "some inference by the pinned model happened", not "that inference decided this trade". The same receipt backs trades on two accounts, and an old receipt counts while the gateway key is registered.

PoC: `test_F4_oneReceipt_backsTradesOnTwoAccounts`: one `(req, resp)` pair consumed on two factory accounts, both emit `TradeExecuted` naming it. Control `test_F4_control_sameAccountReplay_refused`: the same pair twice on one account reverts `ReceiptAlreadyUsed`.

Fix, cheapest first: keep public copy at "receipts bind the model"; consume receipts in one registry shared by all accounts (Assay already keeps `consumedReceipt` per provider); have the CVM put `keccak256(abi.encode(account, t))` into the request body and publish the body so the binding is checkable off chain.

### F-5 Low: collateral freshness is chosen by the submitter

`registerAgentWithCollateral` is permissionless and the submitter picks the documents. `check_fresh` and `check_crl` accept any authentic document inside its own window, and nothing enforces a newest one. Windows in the captured Intel collateral (`fixtures/collateral`, read with `openssl crl -noout -lastupdate -nextupdate` and the JSON fields): TCB Info and QE Identity issueDate 2026-10-24 to nextUpdate 2026-11-23 (30 days); PCK CRLs 2026-10-24 to 2026-11-23 (30 days); root CRL 2026-02-26 to 2027-02-26 (1 year). The in-tree tests prove the acceptance: `document_freshness_boundaries_are_exact` passes the TCB Info at `nextUpdate - 1`, and `crl_freshness_and_membership_on_a_test_issuer` passes a CRL anywhere inside its window.

Impact: a PCK revoked by Intel is admitted for up to 30 days through the last CRL that predates the revocation; an intermediate or TCB signer for up to a year through the root CRL. A TCB recovery is enforced only once the owner raises `minTcbEvaluation`, whose default is 0. An admitted platform then trades for the 24-hour admission plus every renewal with still-valid documents.

Not a PoC on the fork: anvil cannot execute the Stylus WASM. Evidence is the two Rust tests above (`cargo test --release` in `verifier/`: 64 + 3 passed today).

Fix: pass an owner `maxCollateralAge` into `verify_with_collateral` and require `issueDate` and CRL `thisUpdate` to be at least `now - maxCollateralAge` (for example one or two days), alongside `minTcbEvaluation`.

### F-6 Info: policy rollout

- `requireCollateral`, `maxTcbStatus`, `minTcbEvaluation` all default to zero/false; the factory sets none of them. Until an owner calls `setAttestationPolicy(true, ...)` admission runs the plain quote path. SECURITY.md line 47 states this correctly; public copy must not claim TCB/CRL checks on accounts that have not opted in.
- `agent-cvm/keeper.sh` renews with `registerAgent`. On an account with `requireCollateral` it reverts `CollateralRequired` every run and the agent lapses within 24 hours. The keeper needs a collateral fetch and `registerAgentWithCollateral` before any account turns the policy on.
- The live Verifier `0x3c19C10E...CAF8c` has no `verifyWithCollateral` (builder's `cast code` selector check). An account wired to it with `requireCollateral` set admits nobody; the owner recovers with `setAttestationPolicy(false, ...)`. `DeployAttestedFactory.s.sol` must take the new Verifier.

### F-7 Info: deviations from Intel QVL

- No check that TCB Info `tcbType == 0` or that `pceId` matches the PCK certificate (fixture: `tcbType 0`, `pceId 0000`). FMSPC is bound, so a document for another platform still fails.
- `check_module` also requires TDX module attribute bits outside `attributesMask` to be clear. QVL does not; this can only refuse a platform QVL accepts (fail closed).

### F-8 Info: SECURITY.md guarantee 4 wording

"The agent's only fund-moving call is `execute`." The agent also authorizes payments through `isValidSignature`: an Assay Voucher on this account's own open channel, paid to the provider the owner chose, capped by the deposit the owner escrowed, and still requiring the provider's enclave signature or receipt (`Assay.redeem`, `redeemWithReceipt`). Bounded and owner-configured, but it is a second agent-authorized outflow and the guarantee should name it.

### F-9 Info: stale spec

`docs/agent-account-spec.md` 381 and 471 say the Verifier does no TCB, QE identity or CRL check. On this branch it does, behind `requireCollateral`.

## Attacked and cleared

- **Test root reachable on chain.** `verify_with_collateral_under(.., root)` lives in a second `impl Verifier` without `#[public]`. `cargo stylus export-abi` lists exactly `verify`, `verifyKeyset`, `verifyWithCollateral(bytes,bytes32,bytes,uint8,uint32) returns (address,bytes32,uint8)`, which matches `ICollateralVerifier`. The public entry hardcodes `INTEL_ROOT_PUBKEY`.
- **Forged or substituted collateral.** TCB and QE documents must verify under the first certificate of their chain, which must verify directly under the hardcoded root, be inside its validity, and carry "Intel SGX TCB Signing". Its serial goes to the root CRL with the PCK CA serial. The PCK CRL must verify under the quote's own PCK CA key. TCB Info must be `id TDX`, `version 3`, the quote's FMSPC; QE Identity must be `TD_QE`. Signatures are checked before any JSON is parsed. Swapping a signature between documents, a PCK CA in the signer slot, the other CA's PCK CRL, or a PCK CRL in the root slot each have a refusing test in `collateral_tests.rs`.
- **Certificate passed as a CRL.** A certificate signed by the same CA has the CRL's outer shape, but its element in the thisUpdate slot is an AlgorithmIdentifier, so `asn1_time_to_unix` fails and the call reverts.
- **Platform facts.** CPUSVN, PCESVN and FMSPC come from the Intel-signed PCK leaf; TEE_TCB_SVN, MRSIGNERSEAM and SEAM attributes from the PCK-signed TD report (offsets 48, 112, 160 match dcap-qvl's TDReport10); QE fields from the PCK-signed QE report (MISCSELECT 16, ATTRIBUTES 48, MRSIGNER 128, ISVPRODID 256, ISVSVN 258). Level matching is first-match over Intel's descending order with the two-component skip when the module version is non-zero, as in dcap-qvl. An unknown status string reverts. `Revoked` (6) never passes in Rust (`status >= REVOKED`) and cannot be configured in Solidity (`BadTcbStatus` above 5).
- **Status not enforced by a different verifier build.** The account re-checks `status > maxTcbStatus` after the call.
- **Replay and nonce reuse.** `attestNonce` binds chain id, account, `agentEpoch` and an ArbSys block hash inside 256 blocks. Every admission and every revocation bumps the epoch, so a quote counts once; `usedQuote` also blocks the identical bytes. A P-256 high-s copy of the quote has a new hash, but its nonce is already stale after the first admission.
- **Policy widening by a non-owner.** `setAttestationPolicy` is `onlyOwner`; it revokes the live agent so a looser policy never grandfathers a stricter admission, and a stricter one applies at once. `registerAgent` refuses under `requireCollateral`. `_admit` is the only writer of `agent`.
- **Revoked measurement trading.** `setMeasurement(m, false)` revokes the live agent when `m` is its measurement, and `_admit` refuses `m` afterwards (F-1 control). A pending proposal of a revoked agent cannot be approved (`ProposerNotCurrentAgent`).
- **Receipt keys.** The gateway key must be registered in Assay under the pinned gateway measurement and unexpired; the requested model must equal the pin and the served label must be in the accepted set; zero served hash is refused.
- **Funds outside the PoolManager.** `withdraw`, `withdrawETH`, `openInferenceChannel` are `onlyOwner`. `execute`/`approveTrade` reach tokens only through `poolManager.unlock` on an owner-allowlisted, hookless, non-native pool; the pair comes from the key; balances are measured before and after (`OverSpent`, `InsufficientOutput`). ERC-1271 is scoped to Assay vouchers on the account's own channel (F-8).
- **Reentrancy in the unlock callback.** `unlockCallback` requires `msg.sender == poolManager` and the transient `swapping` flag, which is set only inside `_swap` under `nonReentrant`; the PoolManager refuses a nested `unlock`; hookless pools give the pool no callback into the account.
- **Gas griefing of the Stylus verifier.** Admission holds no shared state that a failed call can poison: a revert leaves `usedQuote` and the epoch untouched, and the caller pays for the 2.37M-gas quote check plus collateral. All attacker-sized input before signature checks is processed linearly (ABI decode, PEM split, hashing). Arbitrum has no public mempool to front-run an honest registration from; a front-run with the same quote and valid collateral produces the same admission.

## Blind spots

- PoCs use the repo's verifier doubles; the collateral checks are proven only by `cargo test` on captured Intel collateral, never on chain (Stylus activation is paused on RHC testnet and Arbitrum Sepolia per the builder).
- The CVM's public `/quote` is read from source (`agent/src/cvm.ts` on this branch); the live image may differ, and `signet-strategy-commit` changes the CVM.
- The 30-day and 1-year windows come from one captured fixture set, not from a history of PCS responses.
- JSON parsing of Intel-signed bytes (`verifier/src/json.rs`) was not fuzzed here; it only sees documents that already passed Intel's signature.
