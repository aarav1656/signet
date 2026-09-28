# Assay review: real Paxos USDG deploy on Arbitrum Sepolia 421614

Reviewer: JUDGE (opus/high), read-only. Date 2026-09-27.
Scope: `contracts/src/Assay.sol` end to end (open, permit, redeem, close, register), the attestation path it trusts (`IAssayVerifier`, `verifier/src/lib.rs` as deployed at `0xC14d...1285`), `contracts/script/Deploy.s.sol`, and the real USDG token at `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`.

Fork tests written for this review live at `contracts/test/AssayRealUSDGFork.t.sol`, a fork of Arbitrum Sepolia at block 313045372 that deploys the repo's unmodified `Assay.sol` against the real USDG proxy. `MockVerifier` stands in for the Stylus verifier because revm cannot run Stylus WASM. Run: `cd contracts && forge test --match-contract AssayRealUSDGFork`.

Repo suite: `cd contracts && forge test`: 4 suites, 27 passed, 0 failed.

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
