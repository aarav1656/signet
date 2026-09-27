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
