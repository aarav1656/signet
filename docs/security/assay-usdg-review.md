# Assay review: real Paxos USDG deploy on Arbitrum Sepolia 421614

Reviewer: JUDGE (opus/high), read-only. Date 2026-09-27.
Scope: `contracts/src/Assay.sol` end to end (open, permit, redeem, close, register), the attestation path it trusts (`IAssayVerifier`, `verifier/src/lib.rs` as deployed at `0xC14d...1285`), `contracts/script/Deploy.s.sol`, and the real USDG token at `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`.

Fork tests written for this review live at `contracts/test/AssayRealUSDGFork.t.sol`, a fork of Arbitrum Sepolia at block 313045372 that deploys the repo's unmodified `Assay.sol` against the real USDG proxy. `MockVerifier` stands in for the Stylus verifier because revm cannot run Stylus WASM. Run: `cd contracts && forge test --match-contract AssayRealUSDGFork`.

Repo suite: `cd contracts && forge test`: 5 suites, 27 passed, 0 failed, 1 skipped (28
total); the 5th suite is this review's own `AssayRealUSDGFork.t.sol`, whose `setUp()`
calls `vm.skip` unless `CHIRON_FUNDED_TEST_ACCOUNT` is set, in which case its 13 tests run
too (5 suites, 40 passed, 0 failed).

## Verdict

**FIX FIRST, deploy procedure only.** `Assay.sol` needs no code change for this testnet deploy: no Critical, no High in the contract. The one High is that the deploy command documented at review time could not produce the intended artifact (see Resolution below). The Mediums are mainnet-grade issues in how the contract interacts with a pausable, freezable token; accepted for a testnet deploy of a few USDG, to be fixed before any real-value deploy.

## Critical

None.

Checked and clean for this deploy:
- **Provider drain without attestation.** `redeem` (Assay.sol:234-277) needs both a `payerSig` from the channel's agent (EIP-712, recovers to `c.agent`, line 256) and an `enclaveSig` recovering to a registered, unexpired, allowlisted signer (lines 258-266). The amount is inside the agent's signature and capped at deposit (line 247), and only the delta over `paid` moves (line 268). Covered by `test_attack_channelDrain_cappedAtDeposit_reverts`, `test_attack_enclaveSigFromUnregisteredKey_reverts`, `test_attack_payerSigFromNonAgent_reverts` and the two fuzz tests.
- **Voucher replay across channels, contracts, chains.** The voucher digest binds `channelId` in the struct and `chainId` plus `verifyingContract` in the OZ EIP-712 domain (line 127, 253). The prior Assay's channel 0 vouchers cannot redeem on this Assay's channel 0. One enclave receipt pays once per provider across all channels (`consumedReceipt`, lines 250-251, 272).
- **Registration.** Anyone may call `register` (line 156), but the signer comes from the quote, the quote must bind `nextRegisterNonce(msg.sender)` (line 159-160), and quote bytes are single-use (line 158). A front-runner copying a pending `register` tx fails the nonce check because the nonce is keyed on their own `msg.sender`. Re-registration can only extend expiry. No one can deregister or shorten another signer.
- **6 decimals.** The contract has no decimal assumption; amounts are raw `uint128` units. Real USDG `decimals()` is 6, the same as TestUSDG.
- **Permit.** Real USDG implements EIP-2612 with domain `("Global Dollar", "1", 421614, 0xFFC9...1892)`. `openChannelWithPermit` opened a channel on the fork, the permit nonce advanced, and the front-run fallback held (`test_fork_openChannelWithPermit_realUSDG`, `test_fork_permitFrontrun_stillOpens`). The same path is proven able to fail: `test_fork_wrongPermitDomain_surfacesAsBadParams` and `test_fork_permitValueMustEqualAmount` both revert.
- **Balance-delta checks.** `_pull`/`_push` (lines 327-337) match USDG, which has no transfer fee. Three redeems paid the provider exactly 30000 and close refunded 970000, leaving the Assay balance at 0 (`test_fork_threeRedeems_payProviderExactDelta`).

## High

**H-1 The deploy script always deployed a fresh TestUSDG; it could not bind Paxos USDG.** `contracts/script/Deploy.s.sol` (line numbers at review time: 46-50).
`run()` did `new TestUSDG()` and passed that address as `usdg_` without any env override. The NatSpec still said no real USDG exists on 421614, which was by then false.
Attack or failure sequence at review time: running the documented `forge script script/Deploy.s.sol --broadcast` bound the new Assay to a new open-mint TestUSDG. The acceptance check `cast call <new> "usdg()(address)"` catches it, but only after gas is spent and a wrong address could already be copied into `addresses.generated.ts`. Every downstream "paid" figure would then be a mintable fixture, not Paxos USDG.
Proof at review time: `grep -n "new TestUSDG" contracts/script/Deploy.s.sol` returned the constructor line. The then-current Assay `0x6B2a0C4CE50D9788D1FADb6D0eb523e697c4EC41` returned `usdg() = 0x46C42eCD4FFDD0060b2FF4c9F6814D6762868b6D` (block 313045372).
Fix, applied: `contracts/script/Deploy.s.sol` now reads an optional `USDG_ADDRESS` env var. When set, the script binds `usdg_` to that address and deploys no `TestUSDG`; when unset, it falls back to the old fixture-deploy path. The redeploy used this path and bound the real USDG proxy above. The prior TestUSDG-bound Assay is kept in `contracts/deployments/421614.json` for history; every current money path uses the real-USDG Assay instead (see README's Deployed section).
Operator conditions that applied to the live redeploy:
1. Re-run the measurement check right before deploying. A fresh Phala quote run through `Verifier.verify` returned `0xfd34...0149` at block 313045993. The allowlist is immutable (line 136-138), so a Phala image roll between deploy and the next live cycle means another redeploy.
2. Sign the permit over the onchain `DOMAIN_SEPARATOR()` (name `Global Dollar`, version `1`) with `value == amount` exactly. Any mismatch, an expired deadline, `ContractPaused()` or `AddressFrozen()` all surface only as `BadParams()` (L-2).
3. Budget: the deployer held 4.072032 USDG (4072032 raw units) at review time, so a deposit is at most about 2000000 raw units. The old 100000000 figure from the TestUSDG cycle fails `TransferShort`/`SafeERC20` for insufficient balance.

## Medium

**M-1 A USDG pause that spans the challenge window moves an honest provider's earned money to the agent.** `Assay.sol:276` (`_push` inside `redeem`), `Assay.sol:311-325`.
`redeem` settles and transfers in one step, so a token pause makes it revert. `finalizeClose` only checks elapsed time (line 317), not whether the provider was able to act.
Attack sequence: (1) The agent buys calls and signs vouchers. (2) The agent calls `requestClose` once `channelTimeout` has passed since the last redeem. (3) Paxos pauses USDG (their admin action, or by chance). The provider's `redeem` reverts with `ContractPaused()`. (4) The window elapses while the token is paused. (5) On unpause, the agent's `finalizeClose` lands first and refunds the full remainder. (6) The provider's valid, attested voucher now reverts with `ChannelClosedErr()`.
Test: `test_issuerRisk_pauseDuringChallengeWindowVoidsProviderVoucher` (`contracts/test/AssayRealUSDGFork.t.sol`) asserts this sequence directly: the provider's `redeem` reverts while paused, and once the window elapses the agent's `finalizeClose` lands first.
Accepted for this testnet deploy, disclosed in README. Fix if ever carried to a real-value deploy: separate crediting from transferring. `redeem` updates `paid` and `owed[provider] += delta` with no transfer. `finalizeClose` credits `owed[agent]`, and `withdraw()` pulls. A pause then only delays the withdrawal. It no longer changes who is owed.

**M-2 One USDG freeze of the Assay contract strands every channel, and `wipeFrozenAddress` burns all escrow.** `Assay.sol:327-337`.
All deposits pool in one address. Paxos USDG has `freeze(address)` and `wipeFrozenAddress(address)` (facet `0x1d60208df830e4CC460992C13b7AcB21d350171D`).
Sequence: the asset-protection role freezes `address(assay)`. Every `redeem` and `finalizeClose` reverts with `AddressFrozen()` (`0x1fd1cc44`). A later wipe zeroes the contract's balance for every agent and provider at once.
Test: `test_issuerRisk_frozenAssayStrandsAllChannels` asserts `redeem` reverts with `AddressFrozen()`. `test_demo_M2_wipeBurnsEscrow` asserts `balanceOf(assay) == 0` after the wipe.
Fix: this is inherent to any pooled escrow of a regulated stablecoin, so it cannot be coded away. Disclosed in the README risk section; the contract should never interact with a sanctioned party in a way that could get it frozen. Accepted for testnet.

**M-3 The attestation path still skips TCB status, QE identity and the PCK CRL.** `verifier/src/lib.rs:600-603`.
The verifier checks the PCK chain to Intel's root, cert validity dates, the quote signatures, the report_data layout, the nonce and the DEBUG bit. It does not check TCB level, QE identity or revocation. A quote from a platform whose PCK was revoked, or whose TCB is out of date, still registers a signer that `redeem` accepts for 24 h per registration.
Sequence: an attacker holding a revoked or out-of-date TDX platform running the allowlisted image registers their own key as `report_data[0:20]`. They then sign receipts for work that was not done in a trustworthy TEE, and any agent that signs vouchers against those receipts pays them.
Test: none can be built without a revoked-platform quote. The gap is stated in the code comment at `lib.rs:18` and `lib.rs:600-602`. This deploy reuses the same verifier, so a redeploy does not change the exposure. Accepted for testnet, disclosed.

## Low

**L-1 A frozen agent's refund sits in Assay until Paxos unfreezes.** `Assay.sol:324`. `finalizeClose` pushes only to `c.agent` and has no alternate recipient. Test: `test_issuerRisk_frozenAgentRefundStuck` asserts `finalizeClose` reverts with `AddressFrozen()` while the agent is frozen. `test_demo_M1_unfreezeRestoresRefund` proves the refund arrives in full after `unfreeze`, so the funds are held rather than lost. This is the compliance-correct outcome, and a `refundTo(address)` would help a sanctioned party evade a freeze, so none was added. A frozen provider is the mirror case: `redeem` reverts with `AddressFrozen()` and the agent is refunded at close (`test_demo_frozenProvider_cannotRedeem_agentRefunded`).

**L-2 The permit try/catch hides the real failure reason.** `Assay.sol:187-190`. A wrong domain, a permit value different from `amount`, an expired deadline, a pause or a freeze all collapse into `BadParams()` whenever the allowance is short. This is not a fund risk, because `msg.sender` is the permit owner so nobody else's permit can be spent. It is a live-debugging trap. Evidence: `test_fork_wrongPermitDomain_surfacesAsBadParams`, `test_fork_permitValueMustEqualAmount`. Fix if the file is ever touched again: in the catch, re-raise the permit's revert data when the allowance is short.

**L-3 A provider can postpone the agent's close by about N x channelTimeout.** `Assay.sol:273, 301-302`. Each redeem resets `lastActivityAt`. A provider holding N valid cumulative vouchers can redeem them one at a time, just before each timeout. `test_demo_L_providerDelaysCloseWithStaggeredRedeems` shows `requestClose` still reverting `TimeoutNotElapsed` 3 h after open with 3 vouchers. Bounded by vouchers the agent actually signed, and each redeem pays only money already owed. For a three-call live cycle the worst case is 3 h. Fix option: start the close timer from `openedAt` and rely on the challenge window, which already protects pending vouchers after H-1 of the prior review (see `SECURITY-REVIEW.md`).

**L-4 The measurement allowlist is immutable and signers cannot be revoked.** `Assay.sol:136-138, 165`. If Phala rolls the gateway image, `register` fails with `MeasurementNotApproved`, and 24 h later every `redeem` fails with `AttestationExpired`. Funds stay recoverable by the agent through close, but a live cycle would stall until a redeploy. The measurement was `0xfd34...0149` at block 313045993. It changed across earlier cycles (`0x6cbc...` to `0xfd34...`), but that coincided with the verifier adding fields to the measurement hash, so it is not evidence of Phala image churn (unverified either way).

**L-5 The NatSpec describes a different challenge window than the code.** `Assay.sol:30-33` says the window is "measured from the channel's last redeem (or, if none, from openedAt)". The code measures it from `closeRequestedAt` (line 317), and the timeout-from-last-redeem rule belongs to `requestClose` (line 301-302). Lines 36-37 say every entry point is called by the party receiving value, but `register` is open to anyone. Docs only.

## Info

- **There is no top-up.** No such function exists. Each refill is a new channel with its own close cycle, and every channel locks at least `channelTimeout + challengeWindow` = 2 h.
- **The web UI is TestUSDG-shaped.** `web/src/pages/Channel.tsx` calls an open `mint`, which reverts on Paxos USDG because mint needs a role. Copy in that file says TestUSDG, and `web/src/lib/addresses.generated.ts` at review time held the TestUSDG address.
- **Live agent client requirements**, so that "refuse an unregistered gateway" holds before any money moves rather than only at `redeem`:
  1. Request Phala's signature with `signing_algo=ecdsa`. The ed25519 branch of `sign_legacy_message` can never recover onchain.
  2. Recompute `sha256` of the exact request and response bodies.
  3. `ecrecover` the enclave signature over `"<req>:<resp>"`, then require `signers(addr).measurement` on the allowlist and `expiry > now`.
  4. Only then sign the `payerSig`.
  5. Put a unique nonce in each request body. Otherwise an identical request can be answered from a cached, genuinely attested response (prior review L-1, per-provider `consumedReceipt` key; see `SECURITY-REVIEW.md`).
- **Phala's v byte.** `sign_legacy_message` emits `recid + 27` over `ethereum_personal_message_hash(text)` via k256 (low-s), which OZ `ECDSA.recover` accepts. This was read at `github.com/Dstack-TEE/private-ai-gateway` main HEAD `6061f601f7294bd6686e670ad10222e0b87ef8f0`, `src/dstack.rs:398-423`. The running image reports `repo_commit 8d0a666a2418898a8c823a9af49a634edd122a64`, so the source read is not the running build (unverified gap).
- **USDG is an upgradeable proxy** (ERC-1967 impl `0x0643bc7146ab7a2dd4ea10d506ba95e1b933b236`, facet routing via `getFacet`). Paxos can change transfer semantics at any time. The balance-delta checks in `_pull`/`_push` turn a silent change into a revert rather than a loss.

## Onchain facts

RPC `https://sepolia-rollup.arbitrum.io/rpc`. `T = 0xFFC95faa3d63Cde504a05B567C600B78C0b41892`.

| Fact | Call | Block |
|---|---|---|
| name `Global Dollar`, symbol `USDG` | `cast call T "name()(string)"`, `"symbol()(string)"` | 313045372 |
| decimals 6 | `cast call T "decimals()(uint8)"` | 313045372 |
| totalSupply 2111011000100 (2,111,011.0001 USDG) | `cast call T "totalSupply()(uint256)"` | 313045372 |
| DOMAIN_SEPARATOR `0x46977cb1c28d57ba38679456514a0bed7cd16cce0c74ba22ec5c45a1bbc3c4c0` | `cast call T "DOMAIN_SEPARATOR()(bytes32)"` | 313045372 |
| Domain is `EIP712Domain("Global Dollar","1",421614,T)` | fork test `test_fact_permitDomain` recomputes and matches | 313045372 (fork) |
| `eip712Domain()` and `version()` not implemented (revert `0x800ab12c`) | `cast call T "eip712Domain()..."`, `"version()(string)"` | 313045372 |
| `nonces` of the previous testnet deployment's deployer = 0 | `cast call T "nonces(address)(uint256)" <deployer>` | 313045372 |
| deployer balance 4072032 (4.072032 USDG) | `cast call T "balanceOf(address)(uint256)" <deployer>` | 313045372 |
| `paused()` = false | `cast call T "paused()(bool)"` | 313045372 |
| `isFrozen(deployer)` = false, `isFrozen(0x6B2a...EC41)` = false | `cast call T "isFrozen(address)(bool)" <addr>` | 313045372 |
| owner `0xF0863D7A29a55d0c4263c11bFac754312ff078DF`, defaultAdmin same | `cast call T "owner()(address)"`, `"defaultAdmin()(address)"` | 313045372 |
| ERC-1967 impl `0x0643bc7146ab7a2dd4ea10d506ba95e1b933b236` | `cast storage T 0x3608...2bbc` | 313045372 |
| permit, nonces, transferWithAuthorization, receiveWithAuthorization route to facet `0xd35a045761190D4E02b3f2cfbC8bcCcfa78ba29D` | `cast call T "getFacet(bytes4)(address)" <selector>` | 313045372 |
| paused, pause, unpause, isFrozen, freeze, wipeFrozenAddress route to facet `0x1d60208df830e4CC460992C13b7AcB21d350171D` | same | 313045372 |
| `isAddrBlocked`, `blockAddress` not present (facet 0x0) | same | 313045372 |
| Pause revert is `ContractPaused()` `0xab35696f`; freeze revert is `AddressFrozen()` `0x1fd1cc44` | fork tests M-1, M-2, L-1 traces; `cast sig` | 313045372 (fork) |
| Then-current Assay `0x6B2a...EC41` had `usdg()` = TestUSDG `0x46C42eCD4FFDD0060b2FF4c9F6814D6762868b6D`, `verifier()` = `0xC14d...1285` | `cast call 0x6B2a0C4CE50D9788D1FADb6D0eb523e697c4EC41 "usdg()(address)"`, `"verifier()(address)"` | 313045372 |
| Signer `0x79A5...6B79` registered, measurement `0xfd34...0149`, expiry 1790527829 (block ts 1790456990) | `cast call 0x6B2a... "signers(address)(bytes32,uint64)" 0x79A5061efe5A46b0d1F33B11Cf1c5adbEDAe6B79`; `cast block -f timestamp` | 313045372 |
| Verifier Stylus program: time left 31510210 s (about 364.7 days), programVersion 3, stylusVersion 3 | `cast call 0x...71 "programTimeLeft(address)(uint64)" <verifier>`, `"programVersion(address)(uint16)"`, `"stylusVersion()(uint16)"` | 313045372 |
| Fresh Phala quote (nonce `87f5bde0...fd16`, HTTP 200, `signing_algo` ecdsa) verifies to signer `0x79A5061efe5A46b0d1F33B11Cf1c5adbEDAe6B79`, measurement `0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149` | `curl .../v1/attestation/report?nonce=<n>` then `cast call <verifier> "verify(bytes,bytes32)(address,bytes32)" <quote> 0x<n>` | 313045993 |

## Blind spots

- The fork tests use `MockVerifier`, so the real Stylus `verify` is not executed inside them. It was exercised separately by `eth_call` at block 313045993.
- The pause and freeze tests act through a role that the tests granted by pranking Paxos's `defaultAdmin` on the fork. They prove the token's behaviour, not the likelihood that Paxos pauses the testnet token.
- No real Phala `enclaveSig` over a real completion has been redeemed at review time, because the Phala API key was still unplaced. The format match rests on a source read at a different commit than the running image.
- The `test_issuerRisk_*` tests document accepted risk rather than proving a fix; M-1's suggested code fix (separate crediting from transferring) was not applied for this testnet deploy.

## Re-review 2026-09-28 (before redeploy from a new owner wallet)

Reviewer: JUDGE (opus/high), read-only. HEAD `6e35b45`. Scope: 480c525, b995d1b, bdf78f7, a7c9b5b, 4b15d4f, cec9664 and `receipt-verifier/` (daaa69e).

Suites at HEAD: `forge test` 50 passed, 0 failed, 1 skipped. `verifier` `cargo test` 22 passed. `receipt-verifier` `cargo test` 17 passed. `agent` `npm test` 17 passed.

Failing tests for this re-review live outside the repo: `/tmp/chiron-rr/contracts/test/ReReview.t.sol` (run from `/tmp/chiron-rr/contracts`: `forge test --match-contract ReReviewTest`) and `/tmp/chiron-rr/receipt-verifier/tests/weak_key.rs`. Each asserts the safe property. All 7 fail against unmodified HEAD source.

### Verdict

**FIX FIRST.** Assay and the receipt verifier are both immutable with no owner, so every fix below costs another redeploy if it lands after this one. RR-1, RR-2, RR-3 and RR-6 are one to three line changes. Each was applied to a scratch copy and its test went from red to green.

### High

**RR-1 The model pin is bypassed by the legacy path.** `Assay.sol:371-417` (`redeem`) never reads `c.requestedModelHash`. The provider picks the redeem path. The same enclave serves both paths under one measurement (`verifier/src/lib.rs:1099` asserts the ACI and legacy quotes hash to the same measurement). So a provider whose gateway served a swapped model redeems through `redeem()` with the legacy ECDSA signature Phala produces for every response. The claims at `Assay.sol:426-429` ("cannot get paid, regardless of what it claims off chain") and README "Model-swap refusal" hold only for a provider who chooses the receipt path. The repo's own `test_replaySharedAcrossPaths_reverts` (`contracts/test/AssayReceipt.t.sol:188`) runs a legacy `redeem()` on a model-pinned channel and expects it to succeed. The reference agent refuses a swap before it signs (`agent/src/index.ts:235-247`), so the loss needs an agent that trusts the chain instead. That is the agent this feature is built for.
Test: `test_RR1_modelPinnedChannel_legacyRedeemMustRevert` fails ("next call did not revert").
Fix: in `redeem()`, `if (c.requestedModelHash != bytes32(0)) revert ModelMismatch();`. Green on scratch. `test_replaySharedAcrossPaths_reverts` then needs rewriting: with the fix, each channel uses only one path.

### Medium

**RR-2 The H-2 stockpile is back through the zero-hash fallback.** `Assay.sol:216-223`. When `refBlock` is outside both windows, ArbSys reverts, native `blockhash` returns 0, and the nonce is `keccak256(chainid, this, caller, registerNonce, 0)`. That value can be computed and a quote fetched for it at any time. This is judging item B1.1 again. Live on Arbitrum Sepolia, block 313636375: `arbBlockHash(0)` and `arbBlockHash(N-300)` revert `InvalidBlockNumber`. At block 313636466 (eth_call of init code), EVM `block.number` = 11801135 (the L1 estimate), `blockhash(0)` = 0, `blockhash(L2 N-300)` = 0, `blockhash(L1 number-1)` is nonzero. So `refBlock = 0`, or any L2 number older than 256 L2 blocks, yields a constant nonce. A throwaway caller's counter stays 0 until it registers, so a quote banked today registers a year from now. Combined with M-3 (no TCB or CRL check), a quote from a platform that is later revoked stays registrable.
Test: `test_RR2_zeroRefBlockHash_quoteStockpiledForAYear_mustNotRegister` fails.
Fix: revert when the resolved hash is zero. Green on scratch. Stricter: on Arbitrum, drop the `blockhash` fallback. The L1-numbered fallback gives about a 51 minute window, where ArbSys gives 66 s.

**RR-3 One ACI receipt pays more than once.** `Assay.sol:454`. The replay key is `(provider, requestHash, responseHash)`, but the receipt binds only `responseHash`. `IReceiptVerifier` (`contracts/src/IReceiptVerifier.sol:20-24`, `receipt-verifier/src/lib.rs:139-174`) never returns the receipt's `request.received` body hash, so `requestHash` is unchecked. The same signed receipt pays again under any new `requestHash` the agent signs. That contradicts `Assay.sol:431-434` ("a receipt cannot be paid twice"). Phala's receipt key (`dstack-kms-receipt-ed25519-v1`, `fixtures/keyset_bytes_aci1.json`) is shared by every Phala customer, so the request hash is the only link between a receipt and this agent's request. The agent already checks it off chain (`agent/src/index.ts:222-229`); the chain does not.
Test: `test_RR3_sameReceiptPaysTwiceWithDifferentRequestHash_mustRevert` fails.
Minimal fix: consume `keccak256(receiptBytes)` as well. Green on scratch. `test_redeemWithReceipt_cumulativeDeltaInvariantHolds` then needs distinct mock receipt bytes per call. Full fix: return `request.received`'s body hash from `verifyReceipt` and require it to equal `requestHash`.

**RR-4 Voucher validity is revocable after service.** `Assay.sol:397, 460`. `SignatureChecker` is evaluated at redeem time. A smart-account agent that rotates its owner voids every voucher it issued. OZ 5.7 `isValidSignatureNow` also picks ECDSA or ERC-1271 by `signer.code.length`. It does not try one and then the other as `Assay.sol:392-396` says. So an EOA agent that later gains code (EIP-7702 delegation) also voids its own vouchers. Either way the provider cannot redeem, and the agent refunds itself at `finalizeClose`. A 1271 wallet can also burn all forwarded gas, which only costs the provider gas. `isValidSignature` runs under `staticcall` behind `nonReentrant`, so there is no reentrancy. The voucher digest binds `channelId` and the EIP-712 domain, so there is no replay across channels.
Tests: `test_RR4_erc1271AgentRotatesOwner_providerMustStillBePaid` and `test_RR4b_eoaAgentGainsCodeAfterSigning_providerMustStillBePaid` fail with `PayerNotAgent()`.
Fix options: pin an ECDSA voucher signer at `openChannel`, or disclose that providers must redeem every voucher immediately. Fix the comment either way. Whether 7702 is live on 421614 was not checked.

### Low

**RR-5 One measurement slot per key.** `Assay.sol:254, 283` overwrite, and `406, 471` compare. Phala's keys are KMS-derived and survive an image roll. With two approved measurements, anyone can fetch a quote from the other image and re-register the same key, and every channel pinned to the first image stops redeeming. The shipped `Deploy.s.sol:42-43` allowlists one measurement, so this deploy is not exposed.
Test: `test_RR5_thirdPartyReRegisterUnderOtherMeasurement_mustNotBrickPinnedChannel` fails with `MeasurementMismatch()`.
Fix if a second measurement is ever added: key registrations on `(key, measurement)`.

**RR-6 The receipt verifier accepts forgeries under a small-order key.** `receipt-verifier/src/lib.rs:147` uses ed25519-dalek's permissive `verify`. With pubkey = identity and signature `R = identity, s = 0`, any attacker-written receipt verifies. Assay is safe only because the key must also be in `receiptSigners`, which requires an attested keyset. Any other consumer of the deployed verifier is exposed.
Test: `/tmp/chiron-rr/receipt-verifier/tests/weak_key.rs` fails.
Fix: `verify_strict`. Green on scratch, and all 17 existing receipt-verifier tests still pass.

**RR-7 Keyset expiry is not carried into registration expiry.** `verifier/src/lib.rs:857-861` checks keyset `not_after` only at registration. `Assay.sol:282` sets expiry to `now + attestationValidity`, which can run past `not_after`. The live keyset's `not_after` is 1792250755 (2026-10-17). With 1 day validity the overhang is at most 1 day. No test: `verifyKeyset` does not return `not_after`, so the contract cannot see it.

**RR-8 Registration liveness on the redeploy.** Measured on 421614 at block 313636375: 256 L2 blocks span 66 s. `web/src/pages/Verify.tsx:124,230` submits the latest `contractRefBlock`. That value is refetched every 15 s (`web/src/hooks/useAtBlock.ts:20`), not frozen when the quote was fetched, so a quote fetched in one poll fails `NonceMismatch` after the next. No client calls `registerReceiptKey` at all (grep over `agent/src` and `web/src`). After the redeploy, `redeemWithReceipt` stays unusable until someone assembles that call by hand inside the 66 s window. `register()` and `registerReceiptKey()` share `registerNonce`, so the two quotes must be fetched one after the other. Operational only, so no failing test.

### Info

- Receipt JSON extraction: checked and clean for the signed-bytes model. `find_member` reads only the top-level object, so a nested `model` or `model_id` cannot be mistaken for the real field. A string containing `"model":` is skipped whole. Values are compared raw, so an escaped model id fails closed. Duplicate keys cannot occur in Phala's JCS output. The chain reads the first `upstream.verified` event whose `result` is `verified`, which is the event Phala's own `set_upstream_verified_model_id` writes (`src/aci/receipt.rs:364-379` at `fea9d0ed`, fetched this session). The agent reads the first `upstream.verified` of any result (`agent/src/phala.ts:250`), so it is stricter than the chain. Signature malleability does not matter because nothing is keyed on the signature.
- `model_id` in `upstream.verified` is the upstream's self-reported `model` string, or the routed model when the response carries none (same Phala source). The refusal therefore trusts the upstream's label. Whether real requested and served strings match byte for byte is unverified, because no live ACI receipt has been fetched. A format difference such as `deepseek/...` against `deepseek-ai/...` would refuse honest traffic.
- The keyset binding is sound. The digest is checked before any field is read, `report_data[32..64]` must be zero (`verifier/src/lib.rs:833`), the nonce comes from `nextRegisterNonce(msg.sender, ...)`, and there are negative tests for a wrong nonce, tampered bytes, a key not in the keyset, and an expired keyset. A legacy quote cannot pass `verifyKeyset` (its nonce half is nonzero), and an ACI quote cannot pass `verify` (it would need 12 zero digest bytes).
- One call in N, on the receipt path too. A cumulative voucher's receipt proves the model for the redeemed call only. README should say so under "Model-swap refusal".
- Accounting: `redeemWithReceipt` repeats `redeem`'s delta, cap and `paid` code. The invariant handler (`contracts/test/AssayInvariant.t.sol`) never calls `redeemWithReceipt` or `openChannelWithPermit`, so the invariant run does not cover them. Checked by reading the code only.
- Issuer risk is unchanged. `redeemWithReceipt` also pushes USDG in-line, so M-1 (pause over the challenge window) and M-2 (freeze or wipe) apply to both paths.

### Blind spots

- The Solidity tests use mocks for both Stylus contracts. The nonce-bound mock in RR-2 imitates `verifier/src/lib.rs:765`; it is not the real verifier.
- RR-4b simulates EIP-7702 with `vm.etch`. Arbitrum Sepolia 7702 support was not checked live.
- The scratch fixes prove that the tests can go green. They are not reviewed patches.

## Final review 2026-09-28 (pre-redeploy)

Reviewer: JUDGE (opus/high), read-only except this section. Scope: the uncommitted diff against HEAD `6e35b45` in `contracts/`, `receipt-verifier/`, `agent/src/` and `web/src/pages/Verify.tsx`.

Suites on the working tree, run from a scratch copy at `/tmp/chiron-final/contracts`: fast `forge test` 57 passed, 0 failed. `AssayInvariant` 1 passed (256 runs, 128000 calls). `AssayRealUSDGFork` 13 passed, forked at Arbitrum Sepolia head. `receipt-verifier` `cargo test` 18 passed. `agent` `node --test` 17 passed.

New failing tests: `/tmp/chiron-final/ReReview2.t.sol`. To run it, copy it into `test/` of a contracts copy and run `forge test --match-contract ReReview2Test`. Three tests are red on the current tree. The fourth is a guard for the fix, and it passes both before and after.

**FIX FIRST**

One Medium remains, and its fix is three lines. Assay is immutable, so fixing it after the redeploy would cost another redeploy.

### RR-1 to RR-8, verified

- RR-1 is fixed. `Assay.sol:398` reverts `ModelMismatch` on a pinned channel before any signature is checked. A zero-hash channel cannot pass `redeemWithReceipt`, because that path would need `keccak256(model) == 0`. The agent refuses `pay` on a pinned channel (`agent/src/index.ts:196`) and refuses `pay-receipt` on a zero-hash channel.
- RR-2 is fixed. I checked it live by running `eth_call` on a probe contract, deployed with `--create`, that runs the same staticcall logic. The probe ran at L2 head 313660297, where EVM `block.number` was 11801634 (the L1 estimate). Results by refBlock:
  - N-1 and N-200 return 32 bytes.
  - N-300, 0, the L1-numbered 11801135, N+1000 and N+100000 all revert, so they come back as `StaleRefBlock`.
  - `0x64` has code `0xfe`, so the `blockhash` fallback cannot run on Arbitrum.
  - `arbOSVersion()` returned 116.
- RR-3 is fixed, and the digest matches. Phala's `request.received` `body_hash` is `sha256` of the raw bytes axum received (`src/aggregator/service/forward.rs:246-262` and `src/aci/receipt.rs:240` at `fea9d0ed`; `tests/http.rs:601-603` asserts it). The agent sends exactly `completion.requestBody` (`agent/src/phala.ts:55-59`) and signs `sha256` of those same bytes (`index.ts`, the `requestHash` line in `runPayReceipt`). It also refuses before signing unless the receipt's field is equal. The Stylus decoder takes the first `request.received` event, and Phala's builder writes exactly one.
- Tuple order is consistent:
  - Solidity (`Assay.sol:467-478`), the Rust return, `contracts/src/IReceiptVerifier.sol` and `receipt-verifier/solidity/IReceiptVerifier.sol` all use `(ok, requested, served, request, response)`.
  - The web ABI lists `channels()` with 11 outputs: `[9]` is `requestedModelHash` and `[10]` is `agentIsContract`.
  - The web reads (`Channel.tsx:132`, `:658`, `HeroBanner.tsx:36`) and the agent reads (`[0]`, `[1]`, `[2]`, `[3]`, `[9]`) all use the right indices.
- RR-4 is accepted, and `test_RR4_erc1271AgentRotatesOwner_voidsUnredeemedVouchers` pins it. RR-4b is fixed only for an EOA with no code at open. See F-1.
- RR-5 is acceptable for this deploy. `Deploy.s.sol:42-43` builds a one-entry allowlist. The cost is liveness only: a Phala image roll strands every channel, and agents refund themselves after `channelTimeout + challengeWindow`.
- RR-7 is acceptable while `ATTESTATION_VALIDITY` stays at its 1 day default (`Deploy.s.sol:37`). Do not raise it on the redeploy. The overhang equals that value.
- RR-6 is fixed. `receipt-verifier/src/lib.rs:157` uses `verify_strict`, the weak-key test passes, and so does the full suite.
- RR-8: `register` mode (`agent/src/index.ts:92-128`) runs the legacy `register()` first. It waits for that receipt before it reads the second nonce, so the shared `registerNonce` is read after it advances. Each nonce uses refBlock = head-1 and is consumed in the same run, inside the 256-block window. Verify.tsx pins the (nonce, refBlock) pair when the fetch URL is taken.

### Medium

**F-1 An EOA that is already EIP-7702-delegated at open can void every voucher it signed.**

Location: `Assay.sol:356` and `Assay.sol:513-515`.

`agentIsContract` is `msg.sender.code.length != 0` at open. A delegated EOA has 23 bytes of code (`0xef0100 || delegate`), so it is snapshotted as a contract. From then on its vouchers are checked only through ERC-1271 on whatever delegate it points at when the provider redeems.

The agent's wallet signs an ordinary ECDSA voucher, and the provider checks it and serves. The agent then revokes the delegation (a type-4 authorization to address(0)) or re-delegates to a delegate without `isValidSignature`. Now `isValidERC1271SignatureNow` returns false, `redeem` reverts `PayerNotAgent`, and the agent refunds the whole deposit at `finalizeClose`.

The same path also traps an honest agent whose delegate has no ERC-1271. That channel can never pay.

This is the RR-4b threat in the other order, and the NatSpec at `Assay.sol:71-74` does not cover it. The provider cannot see the problem in the signature. Only `channels()[10]` shows it.

7702 is live on Arbitrum Sepolia: `cast estimate` of a type-4 transaction carrying a throwaway signed authorization returned 48869 gas. No transaction was sent.

Tests:
- `test_F1_delegatedAtOpen_revokesDelegation_providerMustStillBePaid` is red with `PayerNotAgent()`.
- `test_F1_delegatedAtOpen_delegateWithout1271_providerMustBePaid` is red with `PayerNotAgent()`.

Fix: accept an ECDSA signature by `c.agent` first, then fall back to ERC-1271 only for a contract agent.

```solidity
(address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, payerSig);
if (err == ECDSA.RecoverError.NoError && recovered == c.agent) return true;
return c.agentIsContract && SignatureChecker.isValidERC1271SignatureNow(c.agent, digest, payerSig);
```

I applied this to the scratch copy. Both F-1 tests went green, and all 57 existing tests and `test_fixGuard_contractAgent_strangerEcdsaStillRejected` still pass. No one holds a key for a CREATE or CREATE2 address, so accepting ECDSA first gives a real contract agent no new path.

### Low

**F-2 A contract agent that opens from its own constructor can never be paid.**

Location: `Assay.sol:356`.

During construction, `code.length` is 0, so the channel is snapshotted as an EOA and ERC-1271 is never consulted. The owner-signed vouchers revert `PayerNotAgent`, and the agent refunds itself. This belongs to the accepted RR-4 class: a contract agent can already void its vouchers. A provider can detect it, because `channels()[10]` is false for an address that has code.

Test: `test_F2_contractOpenedFromConstructor_providerMustBePaid` is red.

Fix: to support this case, fall back to ERC-1271 when `c.agent.code.length != 0` at redeem instead of reading the snapshot. I verified that on scratch too: all 61 tests pass. That variant does let an EOA that later delegates be paid through its own delegate's ERC-1271, which is the agent's own trust choice. Otherwise, disclose it.

### Info

- The agent CLI has three problems, none of which moves funds.
  - `runPayReceipt` (`agent/src/index.ts:289`) lacks the channel-party check that `runPay` has. In `runPay` the check appears twice (`:188-195`). If the channel's provider is not the provider key, viem's gas estimation fails before broadcast, so no voucher leaks.
  - Both pay modes use absolute cumulative amounts (`:204` and `:310`), so a second run on the same channel fails `AmountNotIncreasing`.
  - `runOpen` reads `channelCount` before its transaction (`:145`), so a concurrent open makes the post-check throw even though the channel opened. It should read `ChannelOpened` instead.
- `runRegister` exits 0 without registering anything if the keyset has no ed25519 key (`:108-128`). It should throw when nothing registered. If a load-balanced RPC lags, it can read the pre-register nonce. Gas estimation then fails, and rerunning also re-registers the legacy key.
- The deploy has to point `RECEIPT_VERIFIER` at a fresh build of `receipt-verifier/`. A 4-tuple verifier from before this diff returns 128 bytes, and every `redeemWithReceipt` would revert while decoding. After the deploy, check `verifyReceipt` against `fixtures/receipt_vectors.json`, and compare the 5-word return with the expected hashes.
- Verify.tsx keeps a pin after a successful register or a provider change. That pinned nonce is then stale until the user clicks Unpin.

### Blind spots

- No live ACI receipt was fetched, because a Phala API key is needed. Three things are therefore unproven on real traffic:
  - that the receipt's `request.received` `body_hash` equals `sha256` of the bytes the agent sent, through the public edge;
  - that `upstream.verified` arrives with `result: verified` for the default model;
  - that the requested and served model strings match byte for byte.

  Any of these failing makes pinned channels unpayable. That is liveness, not theft.
- The invariant handler still never calls `redeemWithReceipt` or `openChannelWithPermit`.
- The 7702 tests model delegation with `vm.etch` under Prague. On chain, 7702 was confirmed only by gas estimation.
- The Stylus contracts are mocked in every Solidity test. The 5-tuple ABI was checked by reading the code, not by calling a deployed Stylus build.
