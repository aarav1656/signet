# Chiron security review (2026-09-26)

Scope: `contracts/src/Assay.sol`, `verifier/src/lib.rs`, live deployment in `contracts/deployments/421614.json`. Red tests: `contracts/test/AttackReview.t.sol`, `verifier/tests/attack_review.rs`. Each red test asserts the safe behaviour, so it fails today and passes after the fix.

## High

**H-1 Agent closes over a pending voucher; the provider is never paid.** `Assay.sol:232`. The timeout counts from `openedAt`, not from the last voucher, and there is no challenge window. The spec and the NatSpec at line 25 say "after a timeout with no new voucher"; the code does not do that. Attack: the agent buys inference at `openedAt+3599`, signs the voucher, then calls `closeChannel` at `openedAt+3600` before the provider's `redeem` lands. `redeem` reverts `ChannelClosedErr` and the agent gets a full refund. With `channelTimeout=3600` and no top-up, every channel lives one hour, so the only safe provider redeems every voucher onchain right away, which defeats the channel. Red: `test_RED_H1_agentCloseFrontrunsPendingVoucher` fails with `ChannelClosedErr()`. Fix: `closeChannel` starts a dispute window. `redeem` stays open during the window, and payout happens once it ends.

**H-2 No freshness: one quote registers a signer forever; expiry is cosmetic.** `Assay.sol:110-116`, `lib.rs:436-507`. `verify` has no nonce or time input, and nothing records quotes that were already used. Anyone can resubmit any old quote to reset `expiry = now + 1 day`. So a rotated or leaked gateway key, or a platform whose TCB was later revoked, stays payable indefinitely. TCB Info, QE Identity, the PCK CRL and cert validity dates are all unchecked (TCB and QE Identity are documented, the others are not). The measurement allowlist is also immutable, so a vulnerable image can never be delisted. The docs say "fresh quote", which the contract does not enforce. Live proof: `cast call 0x3e84597107f22743826745602eB73DFBeD6aA117 "register(bytes)(address,bytes32)" <fixtures/quote_legacy1.hex>` against Arbitrum Sepolia at block 312945250 (timestamp 1790431799) returns `0x79A5061e...6B79, 0x6cbc5236...9eb5`. That older fixture would re-register right now. Red: `test_RED_H2_staleQuoteReRegistersForever`. Fix: `register(quote, nonce)`, where the contract issues the nonce (for example `blockhash`-derived, which must be recent), the verifier requires `report_data[32:64] == nonce`, and each quote hash is recorded as used. Add a revocation or allowlist-rotation path.

## Medium

**M-1 The report_data layout and TD attributes are not enforced.** `lib.rs:502-506`. The signer is `report_data[0:20]` with no check that `[20:32]` is zero, no nonce check, and no check of `td_attributes` bit 0 (DEBUG). `mr_seam`, `tee_tcb_svn`, `td_attributes`, `xfam` and `mr_config_id` are not in the measurement (`lib.rs:470-477`), so a debug TD with the same MRTD/RTMR0-3 hashes to the allowlisted measurement. In a debug TD the host can read and write guest memory, so the attacker can put their own key into `report_data`. That registers an attacker key and forges provenance: provider payments for work that never ran in the TEE. Live proof that any layout is accepted: the real `/v1/aci/attestation` quote from the same image (`fixtures/quote1.hex`), sent through `cast call register` on the live Assay, returns signer `0xd2557082b954E059e08c36Fdfdd9EF76d3F30AC1` (a hash prefix, not a key) with the allowlisted measurement. Safety then rests on no allowlisted image ever emitting caller-influenced `report_data[0:20]`. The live fixture's td_attributes are `0000001000000000` (not debug). Red: `red_h3_rejects_report_data_without_zero_padding` (Rust) fails. Blind spot: no signed debug-TD quote exists to test the attribute check end to end. Fix: require `[20:32]==0`, the nonce from H-2, and `td_attributes & 1 == 0`, and fold `td_attributes`, `xfam`, `mr_seam` and `mr_config_id` into the measurement.

## Low

**L-1 The replay guard only remembers the last receipt.** `Assay.sol:187`. The sequence A, B, A pays receipt A twice on one channel. One receipt is also redeemable on every channel the provider holds, because the enclave signature is not bound to a channel. Each payment still needs an agent voucher, so the harm is limited to a provider serving a repeated identical request from cache and being paid as if the TEE produced it. The README's claim ("blocking a replay of one real receipt") is stronger than what the code does. Red: `test_RED_M1_responseHashReplayABA`, `test_RED_M1b_sameReceiptPaidOnTwoChannels`. Fix: `mapping(bytes32 => bool) usedReceipt` keyed on `keccak(requestHash, responseHash)`.

**L-2 openChannelWithPermit can be griefed.** `Assay.sol:134`. Anyone can submit the observed permit first, and the agent's call then reverts. Red: `test_RED_L1_permitFrontrunBlocksOpen` (`ERC2612InvalidSigner`). Fix: wrap the permit in try/catch and fall through when the allowance is already sufficient.

**L-3 Stylus program expiry.** `ArbWasm(0x71).programTimeLeft(0x27b9...a630)` returns 31531780 s (about 364.9 days), and `expiryDays()` returns 365. After expiry, or after an ArbOS Stylus version bump, `register` reverts. One day later every signer lapses and `redeem` reverts. Funds are not stuck (`closeChannel` does not call the verifier), but vouchers in flight go unpaid. Mitigation: anyone can call `ArbWasm.activateProgram`. Monitor it.

**L-4 Verifier length arithmetic wraps on wasm32.** `lib.rs:123, 350, 376, 392, 403`. `usize` is 32 bits on wasm32 and release builds do not check overflow, so a length near `u32::MAX` wraps the bounds check and the slice then panics. With `panic = "abort"` that is a trap, which reverts, so the only cost is DoS to the caller, who pays their own gas. `find_subslice` is O(n*m), and again only the caller pays. Green on the host: `every_truncation_errs_without_panic` (all 5006 cuts, none panic) and `max_length_fields_err_without_panic`. Blind spot: not executed on wasm32. Fix: `checked_add`.

## Info

- Bytes after the declared auth data are ignored: the 70 trailing bytes of the fixture can be anything and still verify. Only 2 of the 3 PEM certs are used, and no basicConstraints or key-usage checks run. None of these is exploitable alone, because each check is anchored on a signature under Intel's root.
- The provider address is not bound to the enclave signer, so any reseller that relays to Phala can collect. `payerSig` is ECDSA only, with no ERC-1271, so smart-wallet agents cannot use Assay.
- Checked and clean: OZ 5.7 `ECDSA.recover` rejects high-s and bad v and reverts on `address(0)`. The EIP-712 domain binds chainId and verifyingContract, so cross-chain and cross-deployment voucher replay fails. The personal_sign length prefix is `"129"` for the 64+1+64 byte text. Cumulative is monotonic and capped at the deposit, the uint128 cast is safe, every entry point is `nonReentrant`, and transfers check the balance delta.

## What a judge can do live on Sepolia

Replay any committed fixture quote into `register` (H-2). Register the ACI quote's keyless address (M-1). Open a channel to themselves and close it over an unredeemed voucher (H-1). TestUSDG `mint` is open by design.

## Test summary

```
forge test: 4 suites, 19 passed, 5 failed (all 5 are AttackReview red tests)
  [FAIL: ChannelClosedErr()] test_RED_H1_agentCloseFrontrunsPendingVoucher
  [FAIL: next call did not revert as expected] test_RED_H2_staleQuoteReRegistersForever
  [FAIL: next call did not revert as expected] test_RED_M1_responseHashReplayABA
  [FAIL: next call did not revert as expected] test_RED_M1b_sameReceiptPaidOnTwoChannels
  [FAIL: ERC2612InvalidSigner(...)] test_RED_L1_permitFrontrunBlocksOpen
cargo test --test attack_review: 2 passed, 1 failed (red_h3_rejects_report_data_without_zero_padding)
cargo test --lib: 4 passed
```
Green suite without the red tests: `forge test --no-match-contract AttackReview`.

## Item 4 hardening (2026-09-28): measurement pinning, dead-code removal, ArbSys nonce, mutation re-run

Changes to `Assay.sol`: (a) `Channel.measurement` is set at `openChannel`/`openChannelWithPermit` time and `redeem` now requires `signers[enclaveSigner].measurement == c.measurement`, so a channel stays pinned to the image it was opened against even if a second image is later added to the allowlist. (b) `lastResponseHash` and the dead post-allowlist-check at the old `:265` are deleted; `consumedReceipt` (keyed `keccak256(provider, requestHash, responseHash)`) is the sole replay guard. (c) `register(quote, refBlock)` derives its nonce from `ArbSys.arbBlockHash(refBlock)` (precompile at `0x64`, `nitro-precompile-interfaces/ArbSys.sol`, BUSL-1.1: reverts unless `currentBlockNum-256 <= refBlock < currentBlockNum`), falling back to native `blockhash(refBlock)` when the precompile is absent or reverts (`_refBlockHash`, `Assay.sol`). (d) `Redeemed` now emits `requestHash` alongside `responseHash`. (e) new tests below, plus a `StdInvariant`/handler-based stateful invariant.

Every mutant below was applied to a throwaway copy of the contract (`/tmp/chiron-mut`, `rsync`'d from `contracts/`, never the tracked source), run against the named test with `forge test --match-contract X [--match-test Y]`, then the copy was restored from the real fixed source and re-run green before moving to the next mutant. The real repo's `Assay.sol` was never edited by this process.

| # | Mutation | Line (fixed source) | Killed by | Result |
|---|---|---|---|---|
| M1 | `requestClose`: drop `if (msg.sender != c.agent) revert NotAgent();` | 343 | `AssayHardeningTest::test_attack_requestClose_byNonAgent_reverts` | KILLED |
| M2 | `finalizeClose`: drop `if (msg.sender != c.agent) revert NotAgent();` | 359 | `AssayHardeningTest::test_attack_finalizeClose_byNonAgent_reverts` | KILLED |
| M3 | `requestClose`: drop `if (c.closeRequestedAt != 0) revert CloseAlreadyRequested();` | 345 | `AssayHardeningTest::test_attack_requestClose_twice_reverts` | KILLED |
| M4 | `redeem`: drop `c.lastActivityAt = uint64(block.timestamp);` | 318 | `AssayHardeningTest::test_redeem_resetsLastActivityAt_delaysRequestCloseEligibility` (non-fork; distinguishes the write from `requestClose`'s `openedAt` fallback) | KILLED |
| M5 | `redeem`: drop the `measurement` pin check | 311 | `AssayHardeningTest::test_redeem_measurementMismatch_reverts` | KILLED |
| M6 | `redeem`: drop `if (consumedReceipt[receiptKey]) revert ReceiptAlreadyConsumed();` | 297 | `AssayAttacksTest::test_attack_replayedVoucher_paysOnce` | Not reached by this test: that test's second call already reverts on `AmountNotIncreasing` (same `cumulativeAmount` both times), so it never reaches the mutated line; the guard itself is exercised by row M6b |
| M6b | same mutation as M6 | 297 | `AttackReviewTest::test_M1_responseHashReplayABA_reverts` (replays with an increasing `cumulativeAmount`, so it genuinely reaches the check) | KILLED |
| M7 | `register`: drop `if (usedQuote[quoteHash]) revert QuoteAlreadyUsed();` | 195 | `AttackReviewTest::test_H2_staleQuoteCannotReRegister` | KILLED |
| M8 | `_refBlockHash`: `return blockhash(refBlock);` -> `return bytes32(0);` (drop the fallback) | 170 | `AssayHardeningTest::test_nextRegisterNonce_usesArbSysWhenPresent_fallsBackOnRevert` | KILLED |
| M9 | `finalizeClose`: drop `c.deposit = c.paid;` (refund accounting) | 366 | `AssayInvariantTest::invariant_escrowEqualsSumOfDepositMinusPaid` | KILLED (`136233595 != 416010131717` after ~20 handler calls) |

M6's "surviving" result against `test_attack_replayedVoucher_paysOnce` is a real, documented finding: that test is not the one carrying the `consumedReceipt` guard's coverage, `test_M1_responseHashReplayABA_reverts` is. Both a Low finding write-up and the mutation table need to point at the actually-load-bearing test, or a future refactor of `test_attack_replayedVoucher_paysOnce` could silently drop real coverage without any test going red.

New Item 4(e) stateful invariant: `AssayInvariant.t.sol`, `AssayHandler` (bounded fuzz `open`/`redeem`/`close`) driven through Foundry's native `StdInvariant`. `invariant_escrowEqualsSumOfDepositMinusPaid` asserts `usdg.balanceOf(assay) == sum(deposit - paid)` over every channel, proven both by M9 above (a real accounting bug makes it fail) and by a clean run: `runs: 256, calls: 128000` with non-vacuous per-handler-function call counts (`open`, `redeem`, `close` each in the tens of thousands, `redeem` reverting only on its own bounded preconditions).

Full re-run after all Item 4 changes: `forge test` -- 38 passed, 0 failed, 1 skipped (39 total; the 1 skip is the funded-account-gated `AssayRealUSDGFork` suite, unchanged from before).

## Item 6 hardening (2026-09-28): ERC-1271 smart-account payers

`Assay.sol:308` swapped the payer-side check from `ECDSA.recover(voucherDigest, payerSig) != c.agent` to `SignatureChecker.isValidSignatureNow(c.agent, voucherDigest, payerSig)` (OZ 5.7 `utils/cryptography/SignatureChecker.sol`). `SignatureChecker` tries `ECDSA.recover` first (identical behaviour for an EOA `c.agent`, including revert-on-`address(0)`), then falls back to a static call to `c.agent.isValidSignature(voucherDigest, payerSig)` when `c.agent` has code, so a contract wallet (Safe, ZeroDev Kernel, any ERC-1271 implementer) can now open and redeem a channel with a voucher signed through its own validation logic. The enclave-signer check (`ECDSA.recover(enclaveDigest, enclaveSig)`, unchanged) stays plain ECDSA: attestation provenance is still a raw Phala `personal_sign`/EIP-191 signature, not a contract signature, so that recovery path was deliberately left alone.

Test fixture: `contracts/test/mocks/ERC1271Wallet.sol`, a minimal real (not mocked) 1-of-1-owner ERC-1271 wallet -- `isValidSignature` calls `ECDSA.tryRecover` and compares to a fixed `owner`, returning the magic value only on a real, valid ECDSA signature from that owner. `contracts/test/AssaySmartAccount.t.sol` (`AssaySmartAccountTest`, extends `AssayTestBase`) opens a channel whose `agent` is the wallet's address and covers three cases: `test_redeem_payerIsEOA_stillSucceeds` (no regression for the common case), `test_redeem_payerIsERC1271Wallet_ownerSignature_succeeds` (the wallet owner signs the voucher digest directly, `redeem` succeeds through the ERC-1271 fallback), `test_redeem_payerIsERC1271Wallet_wrongSigner_reverts` (a non-owner key signs, `isValidSignature` returns `0xffffffff`, `redeem` reverts `PayerNotAgent`).

Mutation (same throwaway-copy methodology as Item 4, `/tmp/chiron-mut`): mutant `M10` comments out the `SignatureChecker.isValidSignatureNow` check at line 308 (always treats the payer as authorized).

| # | Mutation | Line (fixed source) | Killed by | Result |
|---|---|---|---|---|
| M10 | `redeem`: drop the `SignatureChecker.isValidSignatureNow(c.agent, voucherDigest, payerSig)` check | 308 | `AttackReviewTest` (whole contract) | SURVIVES -- wrong target, that contract never exercises `PayerNotAgent` |
| M10b | same mutation as M10 | 308 | `AssayAttacksTest::test_attack_payerSigFromNonAgent_reverts` | KILLED |
| M11 | same mutation as M10 | 308 | `AssaySmartAccountTest::test_redeem_payerIsERC1271Wallet_wrongSigner_reverts` | KILLED |

M10's "surviving" run against `AttackReviewTest` is the same class of finding as Item 4's M6: picking a test contract that doesn't carry the guard's coverage produces a false-negative mutation result. `test_attack_payerSigFromNonAgent_reverts` (EOA path) and `test_redeem_payerIsERC1271Wallet_wrongSigner_reverts` (ERC-1271 path) are the two tests that actually load-bear the `SignatureChecker` check; both kill the mutant, confirming the check is real and covers both signer types, not just the EOA fast path.

Full re-run after Item 6: `forge test` -- 41 passed, 0 failed, 1 skipped (42 total; 8 suites, same 1 skip as Item 4).
