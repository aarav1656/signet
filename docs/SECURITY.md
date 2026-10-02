# Security

Chiron's contracts went through independent adversarial review by a reviewer who did not write the code: four rounds on Assay, the Stylus `Verifier` and the Stylus `ReceiptVerifier`, and two on `ChironGate`. `AgentAccount` is covered by a mutation runner that removes or weakens one guard at a time. Every review finding was resolved in code, and each one ships with a test that fails without its fix.

## Run it

```
make test
```

One command from a clean clone. It fetches the pinned OpenZeppelin (`v5.7.0`) and forge-std (`v1.16.2`), builds the default, `v4` (canonical Uniswap v4 PoolManager) and `x402` (canonical x402 BatchSettlement) Foundry profiles, and runs the whole suite, including the fork tests against Robinhood Chain testnet and Arbitrum Sepolia through their public RPCs.

Result from a fresh `git clone` into an empty directory (commit `a5182ed`, log in `docs/test-logs/make-test-clean-clone-2026-10-02.log`): `make test` exits 0, `forge test` 309 passed, 0 failed, 0 skipped across 20 suites. That includes all 13 `AssayRealUSDGFork` tests, which fork Arbitrum Sepolia at block 315013000 against real Paxos USDG, funded by the deployer that paid the live calls (92 USDG at that block); `ARB_SEPOLIA_FORK_URL`, `CHIRON_FORK_BLOCK` and `CHIRON_FUNDED_TEST_ACCOUNT` override the defaults. Alongside it: `agent` `npm test` 27 passed, `receipt-verifier` `cargo test` 18 passed, `verifier` `cargo test` 22 passed.

The `ChironGate` fork tests read the live Assay receipt-key registry. A registration lasts 24 hours and the public RPC keeps no historical state, so the fork's clock is set to the last second of the registration the registry records. The suite is green on any day, and it turns red if the registered key, its measurement or the verifier address changes.

## Methods

- **Adversarial review.** Each round starts from a hostile read of the source and ends with a verdict, a severity-ranked finding list and a resolution pass that re-reviews the fixes.
- **Proof-of-concept tests in the suite.** Each exploit is written as a Foundry test, shown red on the original source, then kept as a regression test that is green on the fixed source.
- **Mutation testing.** The `AgentAccount` runner (`contracts/test/mutation/agent_account_mutations.py`) kills 109 of 110 mutants, and the one survivor is documented as behavior-equivalent (`docs/security/agent-account-mutations.md`). `ChironGate` has its own runner (`chiron_gate_mutations.py`): 31 of 31 guards fail the tests when removed. Assay's guards were each cut out in a scratch copy, the named test went red, and the restored source went green. The ERC-8056 corporate-action guard was cut out of `execute`: the pending-split and cooldown tests in `AgentAccountCorporateAction.t.sol` went red, and the restored source went green (5 of 5).
- **Invariant suites.** `AssayInvariant` holds `usdg.balanceOf(assay) == sum(deposit - paid)` over every channel across 256 runs and 128,000 calls. `AgentAccountInvariant` holds the account's drain bound.
- **Live reads.** The Stylus verifiers run on Arbitrum Sepolia and Robinhood Chain testnet against real Phala TDX quotes and receipts; the transactions are in the README.

## Findings and their regression tests

| Finding | Resolution | Test |
|---|---|---|
| An agent closed a channel over a voucher the provider had not yet redeemed | Close is two-phase: `requestClose`, then `finalizeClose` after a challenge window during which `redeem` stays open | `AttackReviewTest.test_H1_challengeWindowPaysPendingVoucherBeforeClose` |
| An old quote re-registered a signer and reset its expiry | `register(quote, refBlock)` derives the nonce from the ArbSys block hash of a recent block, and each quote is single use | `AttackReviewTest.test_H2_staleQuoteCannotReRegister` |
| The quote's `report_data` layout and the TD DEBUG attribute were not enforced | The `Verifier` requires zero padding after the signer, a nonce match, and DEBUG clear | `attack_review.rs::red_h3_rejects_report_data_without_zero_padding` |
| One receipt could be paid twice on a channel, or once on each of two channels | `consumedReceipt` keyed by provider, request hash and response hash | `AttackReviewTest.test_M1_responseHashReplayABA_reverts`, `test_M1b_sameReceiptPaidOnTwoChannels_reverts` |
| A permit could be front-run to block `openChannelWithPermit` | The permit is wrapped, and the call falls through when the allowance is already sufficient | `AttackReviewTest.test_L2_permitFrontrunFallsThrough` |
| A model-pinned channel could be paid through the legacy signature path | A pinned channel is receipt-only, and `redeem` on it reverts `ModelMismatch` | `ReReviewTest.test_RR1_modelPinnedChannel_legacyRedeemMustRevert` |
| An out-of-window `refBlock` gave a zero hash and a constant nonce | An ArbSys revert or a zero hash reverts `StaleRefBlock` | `ReReviewTest.test_RR2_zeroRefBlockHash_quoteStockpiledForAYear_mustNotRegister` |
| One receipt backed payments for different requests | The receipt verifier returns the request body hash, and Assay requires it to equal the voucher's | `ReReviewTest.test_RR3_sameReceiptPaysTwiceWithDifferentRequestHash_mustRevert` |
| The receipt verifier accepted a forgery under a small-order public key | `verify_strict` | `receipt-verifier/tests/weak_key.rs::identity_pubkey_forged_receipt_must_not_verify` |
| An EOA delegated by EIP-7702 at open, or a contract opening from its constructor, could void its vouchers | The agent's own ECDSA signature is accepted first, and ERC-1271 is asked only when that fails | `ReReview2Test.test_F1_delegatedAtOpen_revokesDelegation_providerMustStillBePaid`, `test_F2_contractOpenedFromConstructor_providerMustBePaid` |
| A payer could burn a signed `CallAck` through a throwaway channel | `ChironGate.consumed` is keyed by x402 channel id | `ChironGateReviewTest.test_R1_payerCannotBurnSignedAckViaThrowawayChannel` |

## Design decisions

- **Assay has no owner, no upgrade path and no pause.** The measurement allowlist and the timing parameters are immutable constructor values. Escrow leaves only through `redeem`, `redeemWithReceipt` and `finalizeClose`.
- **Attestations last 24 hours.** `attestationValidity` is immutable. A rotated or revoked gateway key stops being payable within a day, and registration is permissionless because the signer comes out of the quote itself.
- **ERC-1271 vouchers are judged at redeem time.** A smart-account agent's contract says whether a voucher is valid when the provider redeems, so a provider redeems as it serves. The behavior is pinned by `ReReviewTest.test_RR4_erc1271AgentRotatesOwner_voidsUnredeemedVouchers`.
- **Stablecoin controls stay with the issuer.** Escrow is USDG, whose pause and freeze belong to Paxos. The contracts hold no key that can move escrow, and `test_issuerRisk_*` in `AssayRealUSDGFork` pins how a paused or frozen token behaves against the real USDG.
- **One attested gateway per Assay.** The measurement is chosen once by whoever deploys, so trust is decided in one place and not inferred per quote.
- **`AgentAccount` owner powers are enumerable.** `pause`, `revokeAgent`, `withdraw`, `withdrawETH` and the policy setters are owner-only, ownership transfer is two-step, `renounceOwnership` reverts, and the agent key can never become the owner.
