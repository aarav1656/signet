# AgentAccount security

`AgentAccount` holds a creator's USDG and Robinhood Stock Tokens and lets exactly one thing trade them: a key that came out of an Intel TDX quote whose measurement the owner approved. Every trade goes through the canonical Uniswap v4 PoolManager and emits a receipt that names the measurement and the model that made the decision. This page maps each guard to the test that goes red when the guard is removed.

Source: `contracts/src/AgentAccount.sol`. Static analysis: `STATIC-ANALYSIS.md` with the raw Slither and Aderyn output in `static-analysis/`. Mutation records: `../docs/security/agent-account-mutations.md` (original guards), `../docs/security/agent-account-attestation-mutations.md` (collateral admission and owner attestation policy), `../verifier/MUTATIONS.md` (Stylus collateral checks).

## Roles

| Role | Who | Can | Cannot |
|---|---|---|---|
| Owner | the creator, two-step transfer (`Ownable2Step`) | approve measurements, set the attestation policy, caps, allowed pools and the model pin; pause; revoke the agent; approve or reject proposals; withdraw; open and close the inference channel | renounce ownership (reverts `RenounceDisabled`); hand ownership to the live agent key (reverts `AgentIsOwner`) |
| Agent | the key generated inside the CVM and bound into its TDX quote | `execute` and `propose` inside the caps, for 24 hours (`ATTESTATION_VALIDITY`) after admission | admit itself, change a cap, approve its own proposal, withdraw, trade while paused, trade after revoke or expiry |
| Anyone | any address | submit a quote (`registerAgent`, `registerAgentWithCollateral`); the key comes out of the quote, not from the caller | admit a key under a measurement the owner has not approved |
| PoolManager | the canonical Uniswap v4 deployment, an immutable | call `unlockCallback` while a swap is in flight | call it at any other time (`NotPoolManager`, `NotSwapping`) |
| Stylus verifiers | `Verifier` (TDX quote and Intel collateral) and `ReceiptVerifier` (Ed25519 receipt), immutables | return facts about bytes | hold state or make external calls |

## What the account guarantees

1. **Only attested code trades.** `execute` and `propose` require `msg.sender == agent`, an unexpired admission and an unpaused account. `agent` is set only by `_admit`, which requires a quote the Stylus `Verifier` authenticated, a measurement in `approvedMeasurement`, a signer that is neither zero nor the owner, and a quote hash never used before.
2. **A different workload is refused.** A genuine Intel TDX quote from another workload reverts `MeasurementNotApproved`. Live on Robinhood Chain testnet 46630: transaction `0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8`, block 127,632,496, status 0, 2,349,054 gas (`cast receipt`, read 2026-10-24). The verifier checks the whole quote first, then the allowlist refuses the key.
3. **Receipts bind the model.** `_consumeReceipt` verifies an Ed25519 receipt through the Stylus `ReceiptVerifier`, then requires the requested model to equal the pinned one, the served label to be in the accepted set, the gateway key to be registered in Assay under the pinned gateway measurement and unexpired, and the (request, response) pair never to have been used. Live: attested trade `0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03`, block 127,188,951, status 1, 504,449 gas; its `TradeExecuted` log on `0x9c69A43F...Aa6D` carries `agentMeasurement 0xeb2d9462...6829`, `servedModelHash 0xc8536dbf...78df59`, `amountIn 1000000` and `amountOut 3910026278631909` (`cast receipt --json`, decoded 2026-10-24).
4. **Funds move only through the PoolManager path or to the owner.** The agent's only fund-moving call is `execute`, which swaps through `poolManager.unlock`. Pools are allowlisted by the owner, hookless and non-native. The token pair is derived from the pool key, never from the caller. After the swap the account measures what left and what arrived by balance, and reverts `OverSpent` or `InsufficientOutput` whatever the pool reports. `withdraw` and `withdrawETH` are owner-only.
5. **Caps hold.** Per-trade cap, a band above which the owner must approve, and a rolling 24-hour cap built from 25 hourly buckets, all per token in the token being sold.
6. **Trust is withdrawn instantly.** Unapproving the live measurement, changing the attestation policy, or calling `revokeAgent` clears the agent at once and bumps `agentEpoch`, which invalidates every in-flight quote nonce.

## The attestation path

```
quote + refBlock [+ Intel collateral]
  -> attestNonce(refBlock) = keccak(chainid, account, agentEpoch, ArbSys blockhash(refBlock))
  -> Verifier.verify / verifyWithCollateral        (Stylus, one transaction)
       DCAP chain: PCK leaf -> PCK CA -> Intel SGX Root CA (key hardcoded in the contract)
       QE report signature, attestation-key binding, quote signature
       report_data = signer || nonce, DEBUG attribute clear
       measurement = keccak(mr_seam, td_attributes, xfam, mr_td, mr_config_id, rtmr0..3)
  -> _admit: measurement approved, signer not owner or zero, quote single use
  -> agent, agentMeasurement, agentExpiry = now + 24 h, agentEpoch + 1
```

`registerAgentWithCollateral` adds Intel's own collateral for the quote's platform. Every byte is authenticated against the hardcoded Intel root, so a hostile relayer can withhold collateral and cannot forge it:

- **PCK CRL**, signed by the quote's PCK CA: the PCK leaf serial must not be listed.
- **Root CA CRL**, signed by Intel's root: neither the PCK CA nor the TCB signing certificate may be listed.
- **TCB Info (TDX v3)**, signed by an Intel TCB Signing certificate that chains to the root: FMSPC equals the PCK certificate's, the document is inside its issue and next-update window, the TDX module signer and attributes match, and CPUSVN, PCESVN and TEE_TCB_SVN select a TCB level.
- **QE Identity (TD_QE)**, signed the same way: MRSIGNER, ISVPRODID, MISCSELECT and ATTRIBUTES match and ISVSVN selects a level.

The worst of the three levels is the quote's status. The owner chooses the policy with `setAttestationPolicy(requireCollateral, maxTcbStatus, minTcbEvaluation)`: `Revoked` (6) never passes, the default ceiling is `UpToDate` (0), and `minTcbEvaluation` rejects Intel documents older than the owner's floor. With `requireCollateral` set, the plain `registerAgent` path is closed (`CollateralRequired`). The account re-checks the ceiling after the verifier returns (`TcbStatusTooHigh`), so the policy holds even against a verifier build that ignores its arguments. Every collateral admission emits `AgentTcbStatus`.

## Guards and the tests that catch them

Each row names a guard in `AgentAccount.sol`, the revert it raises, and tests that fail when the guard is removed. The runners in `test/mutation/` remove one guard at a time, require a red suite, restore the source and require a green suite.

| Guard | Revert | Test (red without the guard) |
|---|---|---|
| Quote single use, both admission paths | `QuoteAlreadyUsed` | `test_register_revertsReplayedQuote`, `test_collateral_aQuoteIsSingleUseAcrossBothPaths` |
| Measurement must be approved | `MeasurementNotApproved` | `test_register_revertsUnapprovedMeasurement`, `test_collateral_stillNeedsAnApprovedMeasurement` |
| Agent is neither owner nor zero | `AgentIsOwner`, `NotAgent` | `test_register_revertsAgentIsOwner`, `test_register_revertsZeroSigner`, `test_collateral_theOwnerKeyCannotBeAdmitted` |
| Nonce binds chain, account, epoch and a recent block | `StaleRefBlock` and verifier nonce revert | `test_register_nonceBindsChainAndAccount`, `test_register_epochInvalidatesInflightQuote`, `test_register_arbSysRevertIsFinal`, `test_register_revertsZeroHash` |
| Collateral required closes the plain path | `CollateralRequired` | `test_collateral_requiredPolicyClosesThePlainPath` |
| Owner's TCB ceiling and evaluation floor reach the verifier | verifier revert | `test_collateral_theOwnersCeilingAndFloorReachTheVerifier`, `test_collateral_documentsOlderThanTheFloorAreRefused` |
| Account re-checks the ceiling | `TcbStatusTooHigh` | `test_collateral_theAccountHoldsItsCeilingAgainstAVerifierThatIgnoresIt`, `test_collateral_statusAboveTheCeilingIsRefused` |
| `Revoked` never passes | verifier revert | `test_collateral_revokedPlatformNeverPasses` |
| Inauthentic documents admit nobody and spend no quote | verifier revert | `test_collateral_inauthenticDocumentsAdmitNobodyAndSpendNoQuote` |
| Policy change revokes the live agent | none (event `AgentRevoked`) | `test_policy_changeRevokesTheCurrentAgentAtOnce`, `test_policy_onlyTheOwnerSetsIt` |
| Unapproving the live measurement revokes the agent | none | `test_setMeasurement_unapproveRevokesCurrentAgent` |
| Caller is the agent, unexpired, not paused | `NotAgent`, `AgentExpired`, `IsPaused` | `test_execute_revertsNotAgent`, `test_execute_revertsOneSecondAfterExpiry`, `test_execute_revertsWhenPaused`, `test_unattestedKeyIsDenied` |
| Pool allowlisted, tokens derived from the key | `PoolNotAllowed`, `TokenNotAllowed` | `test_execute_revertsPoolNotAllowed`, `test_execute_revertsTokenNotAllowed_afterDelist` |
| Per-trade cap, approval band, daily window | `ExceedsPerTradeCap`, `NeedsApproval`, `DailyCapExceeded` | `test_execute_revertsOverPerTradeCap`, `test_execute_revertsNeedsApproval_inBand2`, `test_execute_revertsDailyCapExceeded`, `AgentAccountWindowTest` (5 tests), `testFuzz_window_matchesReferenceModel` |
| Receipt checks (model pin, served set, gateway key, measurement, expiry, single use) | `ReceiptInvalid`, `ModelMismatch`, `ReceiptKeyNotRegistered`, `GatewayMeasurementMismatch`, `ReceiptKeyExpired`, `ReceiptAlreadyUsed` | `test_receipt_revertsInvalid`, `test_receipt_revertsModelMismatch_requested`, `test_receipt_revertsModelMismatch_served`, `test_receipt_revertsKeyNotRegistered`, `test_receipt_revertsGatewayMeasurementMismatch`, `test_receipt_revertsKeyExpired`, `test_receipt_revertsReuse` |
| Balance-delta settlement | `OverSpent`, `InsufficientOutput` | `test_execute_revertsOverSpent_whenPoolOvercharges`, `test_execute_revertsInsufficientOutput_whenPoolUnderpays`, `test_execute_revertsInsufficientOutput_realPool` |
| Callback only from the PoolManager, only mid-swap | `NotPoolManager`, `NotSwapping` | `test_callback_revertsFromNonPoolManager`, `test_callback_revertsWhenNotSwapping`, `test_callback_revertsAfterSwapInSameTx` |
| Reentrancy (transient guard) | `ReentrancyGuardReentrantCall` | `test_reentrancy_viaTokenHook_blocked` |
| Approvals: pending, unexpired, exact trade, proposer is the live agent, not paused | `ProposalNotPending`, `ProposalExpired`, `TradeMismatch`, `ProposerNotCurrentAgent` | `test_approve_revertsReplay`, `test_approve_revertsExpired`, `test_approve_revertsTradeMismatch`, `test_approve_revertsAfterAgentRotated`, `test_approve_revertsWhenPaused` |
| Every owner power is owner-only | `OwnableUnauthorizedAccount` | `test_ownerOnly_everyPolicyPower`, `test_approve_revertsNotOwner`, `test_withdraw_revertsNotOwner`, `test_policy_onlyTheOwnerSetsIt`, and the fuzzed model |
| Ownership can neither be renounced nor given to the agent | `RenounceDisabled`, `AgentIsOwner` | `test_renounceOwnership_reverts`, `test_ownership_cannotPassToAgent` |
| ERC-8056 corporate action pending or in cooldown | `CorporateActionPending` | `AgentAccountCorporateActionTest` (5 tests) |
| Scoped ERC-1271: only an Assay voucher digest on this account's own open channel, signed by the live agent | `0xffffffff` | `test_1271_rejectsPermit2Digest`, `test_1271_rejectsUsdgPermitDigest`, `test_1271_rejectsForeignChannel`, `test_1271_rejectsExpiredAgent`, `test_1271_rejectsPausedRevokedWrongSignerClosed` |
| Constructor wiring has code | `NoCode` | `test_constructor_revertsNoCode` |

### Fuzzed models that can fail

- `AgentAccountAttestationInvariantTest.invariant_onlyAttestedCodeTradesAndTheLimitsHold` (256 runs, depth 100) drives A and B (keys a verifier can attest), U (a key nobody attests), a stranger and the owner through every entry point, including day-long time jumps and a daily-cap burst. It keeps a model built from calls it saw succeed and counts thirteen violations that must stay at zero: a trade by anyone but the live unexpired unpaused agent, a trade after revoke, admission under an unapproved measurement or against the policy, an unapproval or policy change that left the agent in place, over-cap trades, unexplained fund decrease, over-spend, owner powers without the owner, and approval of a foreign proposal. Eight smoke tests (`AttestationHandlerSmokeTest`) produce each event the violation counters watch against an account that behaves, so every counter is shown able to move, and `afterInvariant` prints the registrations, collateral admissions, swaps, approvals, withdrawals, revocations and denied attempts each run reached.
- `AgentAccountInvariantTest` holds the account's drain bound; `testFuzz_window_matchesReferenceModel` checks the rolling window against a reference model.
- `../docs/security/agent-account-attestation-mutations.md`: 38 of 38 mutants killed (24 against the fuzzed model, 14 against the unit suite), baseline green, restored suite green.
- `../docs/security/agent-account-mutations.md`: 121 of 122 mutants killed over the full guard set (admission, freshness, trade shape, caps and window, receipts, swap settlement, approvals, pool policy, ERC-1271, reentrancy, owner-only, constructor), one behaviour-equivalent mutant documented, restored suite green.
- `../verifier/MUTATIONS.md`: 43 of 43 collateral mutants killed by `cargo test --lib collateral`.

## Gas

| Call | Gas | Source |
|---|---|---|
| `registerAgent`, admitted (quote verified in one transaction) | 2,584,842 | RHC testnet tx `0x1f15df28...a68134`, block 127,176,129 |
| `registerAgent`, refused with `MeasurementNotApproved` | 2,349,054 | RHC testnet tx `0xf98156ad...fcc8`, block 127,632,496 |
| `execute`, attested trade with real receipt verification and 37,653 gas of L1 data | 504,449 | RHC testnet tx `0x0023f359...3b03`, block 127,188,951 |
| `execute` against the canonical PoolManager, receipt verifier mocked | 299,895 to 316,905 | `forge test --gas-report`, `AgentAccountTest` |
| `propose` / `approveTrade` | 278,282 / 182,156 | same |
| `setMeasurement` | 48,239 | same |

## Counts

Run from `contracts/` on 2026-10-24:

- `forge test` with the public Robinhood Chain testnet RPC: 342 passed, 0 failed, 0 skipped across 24 suites (338 in the default run, 4 in `AgentAccountRHCFork` with `RHC_FORK_URL=https://rpc.testnet.chain.robinhood.com`, `-j 1`). The fork suite runs the real TSLA Stock Token, the canonical PoolManager and PositionManager, and the real Stock pause.
- `cargo test` in `verifier/`: 67 passed (64 library, 3 attack-review). In `receipt-verifier/`: 18 passed.
- Slither: 56 results over `src/`; Aderyn: 1 high and 7 low categories. Every row is triaged in `STATIC-ANALYSIS.md`; none is open in `AgentAccount.sol` or `AgentAccountFactory.sol`.

## Design decisions

- **The owner holds the policy.** The creator owns the funds, the caps, the allowlists and the model pin. Each of those powers is enumerated above, owner-only, and has a mutant that the tests kill. Removing trust is instant (revoke, unapprove, policy change, pause); granting it needs an approved measurement and a fresh quote.
- **`approvedMeasurement` is a set.** A follower who wants exactly one live workload approves one measurement and unapproves the rest; the account never infers trust from a previous boot.
- **Admission lasts 24 hours.** A rotated or compromised agent key stops trading within a day on its own, and at once on `revokeAgent`.
- **Collateral is relayed, not trusted.** Anyone can supply Intel's documents because each one is authenticated against the hardcoded Intel root; a withheld document delays admission and cannot widen it.
- **The corporate-action guard fails open for tokens without ERC-8056.** USDG has no multiplier and stays tradable. A token with the interface and a pending or recent change blocks the agent; the owner can still approve a proposal by hand.
- **Owner approval skips the agent's receipt.** `approveTrade` executes the exact trade a proposal recorded, with the receipt consumed at proposal time, under the per-trade cap and an unpaused account.
- **Creator fee is a business arrangement.** The account holds no fee logic and moves no funds to a creator except through `withdraw` by the owner.
