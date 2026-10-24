# Static analysis

Slither and Aderyn run over every contract in `contracts/src/`. The raw output is committed beside the triage so any row below can be checked against the tool's own text.

| File | Tool | Scope |
|---|---|---|
| `static-analysis/slither.md` | Slither checklist, 101 detectors, 60 contracts, 56 results | `slither . --filter-paths "lib\|test\|script" --checklist --json` from `contracts/` |
| `static-analysis/slither.json.gz` | the same run as JSON | |
| `static-analysis/slither.stderr.txt` | the same run, detector text | |
| `static-analysis/aderyn.md` | Aderyn report, 88 detectors, 8 files, 1,162 nSLOC, 1 high and 7 low categories | `aderyn . -o static-analysis/aderyn.md` from `contracts/` |
| `static-analysis/aderyn.stdout.txt` | the same run, console | |

Both runs read the committed source at commit `2f01b5b`. An earlier Aderyn pass raised "empty `require()`" on `withdrawETH` and "state change without event" on `setApprovalTtl`; both are closed in `2f01b5b` (`ETHTransferFailed` and `ApprovalTtlSet`, each with a test) and absent from the run committed here.

Every guard the triage leans on below has a test that goes red when the guard is removed: `docs/security/agent-account-mutations.md` and `docs/security/agent-account-attestation-mutations.md` hold the mutation records, and `contracts/SECURITY.md` maps each guard to its test.

## Slither: 56 results

`AgentAccount` is the account `SECURITY.md` covers; `Assay`, `ChironGate` and `AgentAccountFactory` appear because the tools scan all of `src/`.

| ID | Detector (impact) | Where | Disposition |
|---|---|---|---|
| 0 | weak-prng (High) | `AgentAccount._spendWindow`, `w[h % WINDOW_HOURS]` | Not randomness. `h` is the current hour and the modulo picks the bucket of a 25-slot ring, so any 24-hour interval is covered by one check. `AgentAccountWindowTest.test_window_hour24Boundary`, `test_window_slotReuseResets`, `test_window_readsAllTwentyFiveBuckets` and the fuzz `testFuzz_window_matchesReferenceModel` pin it. |
| 1 | reentrancy-balance (High) | `ChironGate._claimAndForward`, balance read before `x402.settle` | The balance read is the baseline for the delta `balanceOf - gateBefore != paid`, taken after the call on purpose. `x402` is the BatchSettlement address the gate is constructed against. `ChironGateTest.test_reentrantToken_blocked` and `test_honestClaim_paysProviderExactDelta`. |
| 2, 3 | reentrancy-balance (High) | `AgentAccount._swap`, `got` and `spent` | `inBefore` and `outBefore` are baselines; `spent` and `got` are computed after `unlock` from fresh balance reads, so nothing stale is compared. Re-entry is closed three ways: every entry point is `nonReentrant` (transient guard), `unlockCallback` requires `msg.sender == poolManager` and `swapping`, and the account refuses a swap that spent more than `amountIn` or returned less than `minOut`. `test_reentrancy_viaTokenHook_blocked`, `test_callback_revertsFromNonPoolManager`, `test_callback_revertsWhenNotSwapping`, `test_callback_revertsAfterSwapInSameTx`, `test_execute_revertsOverSpent_whenPoolOvercharges`, `test_execute_revertsInsufficientOutput_whenPoolUnderpays`. |
| 4 | uninitialized-state (High) | `AgentAccount.window` | A mapping to a fixed array of buckets. Zero is the empty bucket by design; `hour == 0` never matches a real hour. Exercised by the window suite. |
| 5, 6, 9 | reentrancy-no-eth (Medium) | `Assay.registerReceiptKey`, `redeemWithReceipt`, `register` | Effects after the call to the immutable Stylus verifiers. Both Stylus crates make no external calls (`grep` over `verifier/src` and `receipt-verifier/src` finds none), so there is nothing to re-enter through, and the verifier address is a constructor immutable the deployer chose. Single use of a quote and of a receipt is tested: `AttackReviewTest.test_H2_staleQuoteCannotReRegister`, `test_M1_responseHashReplayABA_reverts`. |
| 7, 8 | reentrancy-no-eth (Medium) | `AgentAccount.registerAgent`, `registerAgentWithCollateral` | Same verifier. Both functions are `nonReentrant`, and `usedQuote` is read before the call and written in `_admit`. `test_register_revertsReplayedQuote`, `test_collateral_aQuoteIsSingleUseAcrossBothPaths`, `test_collateral_inauthenticDocumentsAdmitNobodyAndSpendNoQuote`. |
| 10 | uninitialized-local (Medium) | `_spendWindow.used` | A running sum that starts at zero. |
| 11, 13, 15 | unused-return (Medium) | `ChironGate`, `Assay` | `tryRecover` returns `(address, error, hash)`; the address and the error are both checked and the third value is not needed. `ChironGate` reads one field of `x402.channels`. |
| 12 | unused-return (Medium) | `AgentAccount.isValidSignature`, `tryRecover` | Address and error checked on the next line; any error returns `0xffffffff`. `test_1271_rejectsPausedRevokedWrongSignerClosed`. |
| 14 | unused-return (Medium) | `unlockCallback`, `poolManager.settle()` | The paid amount the pool returns is not trusted; `_swap` measures what left and arrived by balance. Same tests as results 2 and 3. |
| 16 | unused-return (Medium) | `_swap`, `poolManager.unlock` | The callback returns an empty byte string. |
| 17 | unused-return (Medium) | `isValidSignature`, `assay.channels` | Reads the channel's agent and `closed`; the other eight fields are not part of the decision. `test_1271_rejectsForeignChannel`. |
| 18 to 23 | missing-zero-check (Low) | `AgentAccountFactory` constructor and `withdrawETH.to` | The factory only stores wiring. Every account it creates runs the `AgentAccount` constructor, which reverts `NoCode` for an address without code, zero included, so a factory with a zero field cannot create an account (`test_constructor_revertsNoCode`, `test_factory_createsWiredAccount_andEmits`). `withdrawETH` is owner-only and the owner names the recipient. |
| 24 to 34 | reentrancy-benign (Low) | `AgentAccount` execute, propose, approve, register, `_consumeReceipt`, `_swap`; `Assay`; `ChironGate` | Bookkeeping written after a call to a stateless Stylus verifier or to the PoolManager inside a `nonReentrant` entry. The `swapping` flag is transient and reset in the same call. |
| 35 to 48 | timestamp (Low) | expiries, deadlines, the 24 h window, the corporate-action cooldown, Assay timers | Every comparison is a deliberate seconds-to-hours deadline on a chain whose block time is far below the shortest window (one hour). Boundaries are tested to the second: `test_execute_revertsOneSecondAfterExpiry`, `test_approve_atExpirySecond_executes`, `test_approve_revertsExpired`, `test_cooldownAfterEffective_blocksThenClears`. |
| 49 to 51 | cyclomatic-complexity (Info) | `Assay.redeemWithReceipt`, `ChironGate.claimWithReceipt`, `Assay.redeem` | Each branch is a guard with its own test (`AssayHardening`, `ChironGateReview`); `chiron_gate_mutations.py` removes the gate's guards one at a time. |
| 52 | low-level-calls (Info) | `AgentAccount.withdrawETH` | Owner-only and `nonReentrant`; a failed send reverts `ETHTransferFailed`. `test_withdrawETH_revertsWithACustomErrorWhenTheRecipientRejects`. |
| 53 | low-level-calls (Info) | `_requireNoCorporateAction` | ERC-8056 `staticcall`s. A token without the interface (USDG) passes by design; a pending split or the cooldown reverts. `AgentAccountCorporateActionTest`. |
| 54, 55 | low-level-calls (Info) | `_refBlockHash` in `AgentAccount` and `Assay` | `ArbSys.arbBlockHash` through `staticcall` so a missing precompile is detected; a revert or a zero hash reverts `StaleRefBlock`. `test_register_arbSysRevertIsFinal`, `test_register_revertsZeroHash`, `test_register_revertsZeroHash_nativeFallback`. |

## Aderyn: 1 high category and 7 low categories

| ID | Category | Instances | Disposition |
|---|---|---|---|
| H-1 | State change after external call | 6, all in `Assay` and `ChironGate` | Same analysis as Slither 5, 6, 9 and 30. None in `AgentAccount`. |
| L-1 | Centralization risk | 17 | The owner powers are the account's product: the creator holds the funds and the policy. They are enumerated in `SECURITY.md`, ownership transfer is two-step, `renounceOwnership` reverts, the agent key can never become the owner, and each `onlyOwner` has a mutant that the tests kill. |
| L-2 | Literal instead of constant | 24 | Time units, the 25-bucket ring, 32-byte lengths and the 224-byte ERC-1271 minimum. A named constant would add an indirection and no guarantee. |
| L-3 | Local variable shadows state variable | 2 | Members of `Proposal` named `agent` and `agentMeasurement`. A struct member is addressed as `p.agent`; no function parameter or local shadows storage. |
| L-4 | `nonReentrant` is not the first modifier | 6 | `onlyOwner` runs first so a stranger's call fails before the guard slot is touched. Both modifiers run before the body. |
| L-5 | PUSH0 opcode | 8 | Robinhood Chain executes it: the Foundry fork tests (`AgentAccountRHCFork`) run the compiled contracts on the testnet fork under `evm_version = prague`, and the deployed account is live on 46630. |
| L-6 | Unchecked return | 2 | Slither 14 and 16. |
| L-7 | Unspecific pragma | 8 | `^0.8.28`, built with `solc = "0.8.28"` pinned in `foundry.toml`. |

## Result

No finding in `AgentAccount.sol` or `AgentAccountFactory.sol` is open. The two Aderyn items the first pass raised are fixed in code; the rest are properties the tests check by name.
