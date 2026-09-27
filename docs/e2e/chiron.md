# Chiron end-to-end test, Arbitrum Sepolia (421614)

## Real Paxos USDG redeploy (2026-09-27)

An internal, read-only security review found: the documented deploy
command always deployed a fresh TestUSDG and could not bind real Paxos USDG, now live on
421614 at `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`. No Critical or High was found in
`Assay.sol` itself. Fix and live run below; full detail in
`contracts/deployments/421614.json`'s `liveCycle_wp12_realUSDG`.

1. **Fixed `script/Deploy.s.sol`.** It now takes `USDG_ADDRESS` from env and deploys no
   TestUSDG when it is set (`contracts/script/Deploy.s.sol`).
2. **Measurement re-check right before deploying** (H-1 condition 1): fetched a fresh
   Phala legacy quote and ran it through the reused Verifier's `verify()`. Signer
   `0x79A5061efe5A46b0d1F33B11Cf1c5adbEDAe6B79`, measurement `0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149`, block 313048442, unchanged from the review's own read.
3. **Deployed a new Assay** bound to real USDG, reusing the existing Verifier:
   `forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast` with
   `USDG_ADDRESS=0xFFC95faa3d63Cde504a05B567C600B78C0b41892 VERIFIER=0x(superseded-testnet-deploy) APPROVED_MEASUREMENT=0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149`.
   New Assay: `0x(superseded-testnet-deploy)`.
   Tx [0xcad13796...79d622e8](https://sepolia.arbiscan.io/tx/0xcad13796ba4692b112af06943ceab9e92a516880f23d675439ed412b79d622e8), block 313048522, `status 1`.
4. **Registered the provider's attested signer** with a fresh quote fetched using the new
   contract's own `nextRegisterNonce(deployer)`. Tx
   [0x3410ca1d...79c301e0](https://sepolia.arbiscan.io/tx/0x3410ca1d2dd3b93deb09187c94d42d14f3fa766444632b1432fd0a7979c301e0), block 313048640, `status 1`.
5. **Opened one channel with `openChannelWithPermit`**, permit domain `("Global Dollar",
   "1", 421614, 0xFFC9...1892)`, `value` exactly `2000000` (2.000000 USDG), equal to the
   deposit; agent and provider are the same funded EOA (only one funded key available, same
   pattern as every prior liveCycle in `deployments/421614.json`). Tx
   [0x2f5f1467...99dfaaac07](https://sepolia.arbiscan.io/tx/0x2f5f14672dd085bcceb9e35af405bd7d396eeb716cf24fe1e8777c99dfaaac07), block 313048902, `status 1`.

### Post-conditions (this run)

| Check | Command | Result |
|---|---|---|
| New Assay's `usdg()` is real USDG | `cast call 0x(superseded-testnet-deploy) "usdg()(address)" --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | `0xFFC95faa3d63Cde504a05B567C600B78C0b41892` |
| Deploy tx status | `cast receipt 0xcad13796ba4692b112af06943ceab9e92a516880f23d675439ed412b79d622e8 status --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | `true`, block 313048522 |
| Register tx status | `cast receipt 0x3410ca1d2dd3b93deb09187c94d42d14f3fa766444632b1432fd0a7979c301e0 status --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | `true`, block 313048640 |
| Registered signer / measurement | `cast call 0x(superseded-testnet-deploy) "signers(address)(bytes32,uint64)" 0x79A5061efe5A46b0d1F33B11Cf1c5adbEDAe6B79 --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | measurement `0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149`, expiry `1790544213` |
| Channel 0 deposit | `cast call 0x(superseded-testnet-deploy) "channels(uint256)(address,address,uint128,uint128,uint64,uint64,uint64,bool)" 0 --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | deposit `2000000`, paid `0`, closed `false` |
| openChannelWithPermit tx status | `cast receipt 0x2f5f14672dd085bcceb9e35af405bd7d396eeb716cf24fe1e8777c99dfaaac07 status --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | `true`, block 313048902 |
| USDG `balanceOf(new Assay)` equals deposit | `cast call 0xFFC95faa3d63Cde504a05B567C600B78C0b41892 "balanceOf(address)(uint256)" 0x(superseded-testnet-deploy) --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | `2000000` |
| Deployer's remaining USDG | `cast call 0xFFC95faa3d63Cde504a05B567C600B78C0b41892 "balanceOf(address)(uint256)" <this product's own funded testnet EOA> --rpc-url https://sepolia-rollup.arbitrum.io/rpc` | `2072032` (2.072032 USDG), read at block 313048957 |

### Issuer risk on real USDG

`contracts/test/AssayRealUSDGFork.t.sol` (a fork of Arbitrum Sepolia at block 313045372
against the real USDG proxy) has 13 passing tests, including `test_issuerRisk_frozenAgentRefundStuck`,
`test_issuerRisk_frozenAssayStrandsAllChannels`, and
`test_issuerRisk_pauseDuringChallengeWindowVoidsProviderVoucher`, each asserting the ACTUAL
current behaviour of a pooled escrow against a pausable, freezable issuer token (documented
in this project's own SECURITY-REVIEW.md and in the README's "Issuer risk"
section). These were confirmed able to fail: removing the `vm.expectRevert` from
`test_issuerRisk_frozenAssayStrandsAllChannels` turns it red (`[FAIL: custom error
0x1fd1cc44]`), then restoring it turns it green again.

### Sourcify

Not run for this deploy. A repo-wide grep for `sourcify`/`Sourcify` in this repo
found no prior verification of any Assay contract, so this cycle does not introduce one
either, consistent with the repo's existing practice for this product.

### Solidity test suite (updated)

`cd contracts && forge test`: **5 suites, 40 passed, 0 failed** (the prior 4 suites, 27
passed, plus the new `AssayRealUSDGForkTest`, 13 passed).

## Agent client (agent/, 2026-09-27)

A small TypeScript/viem client, `agent/`, that buys inference through Chiron
and pays only against a receipt an attested enclave key signed. TypeScript with viem, matching
the web app (`web/package.json`, viem 2.56.9) and reusing its ABI and generated addresses by
relative import (`web/src/abi/Assay.generated.ts`, `web/src/lib/addresses.generated.ts`) and
its digest encoding (`web/src/pages/Channel.tsx`'s `enclaveText`, reproduced identically in
`agent/src/digest.ts`, not reinvented).

**Live refusal (run against the real Assay `0x(superseded-testnet-deploy)`, no
`PHALA_API_KEY` needed):** `npm run refuse` derives a fresh, never-registered key each run and
checks `signers(address)` on the live contract before allowing any payment.

```
Checking gateway signer 0x8E8E4c5961ba9b4fF20a2785cD11912f7ee020E9 against Assay 0x(superseded-testnet-deploy) on chain 421614...
signers(0x8E8E4c5961ba9b4fF20a2785cD11912f7ee020E9) => measurement=0x0000000000000000000000000000000000000000000000000000000000000000 expiry=0 (chain now=1790498017)
REFUSING TO PAY: signer 0x8E8E4c5961ba9b4fF20a2785cD11912f7ee020E9 is not registered on Assay (signers() returned an empty measurement)
```

Exit code `1`, read at block 313208406 (`cast block-number`). The check is real, not
vacuous: pointed at the actually-registered signer `0x79A5061efe5A46b0d1F33B11Cf1c5adbEDAe6B79`
it reads `measurement 0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149,
expiry 1790544213`, currently unexpired, and would proceed instead of refusing.

**Paid path (three calls, cumulative amounts increasing): coded, unit-tested, blocked only on
`PHALA_API_KEY`.** `npm run pay` first checks `PHALA_API_KEY`; absent, it prints exactly
`PHALA_API_KEY is not set. Refusing to pay: no enclave signature can be requested without it.`
and exits `1` before any HTTP call. With the key present it requests a completion with a unique
nonce per call (`POST /v1/chat/completions`), fetches the enclave receipt
(`GET /v1/signature/{chat_id}?signing_algo=ecdsa`), recomputes `sha256` of the exact request and
response bytes and checks them against the receipt's embedded hashes, `recoverAddress`s the
enclave signature and requires it to equal Phala's own reported `signing_address`, re-checks
`signers(address)` for that exact recovered signer, signs the cumulative EIP-712 voucher, and
submits `redeem()` for amounts 300000/600000/900000 (0.3/0.6/0.9 USDG, well inside channel 0's
2,000,000 deposit). It then reads `channels(0).paid` and the provider's USDG balance before and
after all three calls, at the final block number, and asserts `paid` increased by exactly the
sum of the voucher amounts and that the provider's USDG balance delta equals that same amount;
either mismatch throws before the script reports success.

Unit tests (`agent/test/digest.test.ts`, `node --test`, no mock of Assay behaviour): the
enclave digest's exact vector, `keccak256("some request body")`/`keccak256("some response
body")` producing digest
`0xed749ec2672e4dbaef68df8ef5ddb6002b886c0db7ac4d92103b54a549d7a76c`, the same inputs as
`contracts/test/Assay.t.sol::test_enclaveDigest_matchesPhalaLegacyFormat_andRecovers`, plus a
sign/recover round trip; and the voucher's EIP-712 domain compared live against the deployed
contract's own `eip712Domain()` view, plus a `signTypedData`/`recoverTypedDataAddress` round
trip. **4 passed, 0 failed.** Confirmed each check can fail: mutating the expected digest vector
to an adjacent value turned that test red, restoring it turned it green again.

## Prior run (TestUSDG-bound Assay, superseded)

Run date: 2026-09-26. Contracts: Assay `0x6B2a0C4CE50D9788D1FADb6D0eb523e697c4EC41` (superseded
by the real-USDG Assay above), Stylus Verifier
`0x(superseded-testnet-deploy)`. Test EOA (agent, provider, and registering
address across every live action below): this product's own funded testnet EOA.

The wallet in the browser is a real EIP-1193 provider shim that forwards
`eth_requestAccounts` / `eth_sendTransaction` / `eth_signTypedData_v4` / `personal_sign` to a
local signer process holding the testnet key from `contracts/.env`, refusing any chain id
other than 46630/421614. Every write below is proven by a post-condition read or balance
delta, never by a receipt status alone. The one positive-paid-redeem path needs a live Phala
enclave signature, which requires `PHALA_API_KEY` (unset in this environment); it is marked
BLOCKED below and proven instead by contract tests using a registered test key, labelled.

## Feature matrix

| Feature | Path | Method | Evidence | Result |
|---|---|---|---|---|
| nextRegisterNonce | Verify.tsx `/verify` (contract read) | live testnet | UI read at block #312,987,391: `0x60891e2ae33e0cc48dd6c6f6f65aa3626d28174b68d1594a9bb50e343748f96f` | PASS |
| Fresh Phala quote with that nonce (legacy endpoint, no key) | `GET https://inference.phala.com/v1/attestation/report?nonce=...` via UI "Fetch" | live testnet | UI parsed `signing_address 0x79a5061efe5a46b0d1f33b11cf1c5adbedae6b79`, "nonce matches section 02: yes"; cross-checked byte-for-byte against `curl` of the same endpoint | PASS |
| register, attested signer checked vs fetch's signing_address | Assay.register | live testnet | tx [0xa16745e9...36d7d5972](https://sepolia.arbiscan.io/tx/0xa16745e9d9830266065b4ca5aa3d276ba359b8777c9890a52f5c6e436d7d5972). Post-condition: `signers(0x79a5...6b79)` measurement/expiry set; UI dry-run/simulate both independently recovered the same signer `0x79A5061efe5A46b0d1F33B11Cf1c5adbEDAe6B79` at block #312,987,545 before the send | PASS |
| Re-register the old quote (fails) | Assay.register | live testnet | tx [0xaa95c340...a404fd50ed](https://sepolia.arbiscan.io/tx/0xaa95c34075350f1566e2a5ba17928c2122b077b0ab6b4fc74ce036a404fd50ed), block 312983660, `status 0 (failed)`. Forced past client gas estimation with `--gas-limit`; decoded `QuoteAlreadyUsed()` | PASS |
| Debug-TD / zero-padding violation | Rust verifier crate | test | `cargo test --lib`: `test_debug_attribute_set_reverts` PASS; `cargo test --test attack_review`: `red_h3_rejects_report_data_without_zero_padding` PASS | PASS (test) |
| openChannel with approve | Assay.openChannel | live testnet | tx [0xa21d4f77...019ac6e3ffd95d5](https://sepolia.arbiscan.io/tx/0xa21d4f7787d8a789e2df5e2b6c2967df203eafe16a7390869019ac6e3ffd95d5) opened channel 0 (100.00 USDG); tx [0xa6cc7d5f...8b3d96e3](https://sepolia.arbiscan.io/tx/0xa6cc7d5fed949e87797b853ad104a11815e35ce73dceefc127ceeaba8b3d96e3) opened channel 1. Post-condition: `channels(0/1).deposit == 100000000` | PASS |
| openChannel with the permit path | Assay.openChannelWithPermit | live testnet | tx [0xff7d73ae...90fb35bf73](https://sepolia.arbiscan.io/tx/0xff7d73ae58a24217f17a8bb5996767a5d807356ae394403ee6cd1c90fb35bf73) opened channel 2; tx [0x496e35de...48c4065559](https://sepolia.arbiscan.io/tx/0x496e35de11e6d4e76f175cea3e9e9fc65de48fbfc8d26cf7e1015d48c4065559) opened channel 3, both via the `0x69e26db0` selector (`openChannelWithPermit`), confirmed against no prior `approve` call in either tx's trace | PASS |
| Permit front-run fallback | Assay.openChannelWithPermit try/catch | test | `AttackReview.t.sol::test_L2_permitFrontrunFallsThrough` PASS. Not reproduced live: it requires a second party consuming the same permit signature first, which is an adversarial timing race unsafe to script against a shared live nonce | PASS (test) |
| Voucher EIP-712 signing in the UI | Channel.tsx VoucherPanel, `eth_signTypedData_v4` | live testnet | Signed `{channelId:0, cumulativeAmount:1000000, requestHash, responseHash}` through the injected wallet; UI shows `payerSig` and "Recovered 0xeF2E...d953: matches the channel agent." Screenshot `docs/screenshots/assay/03-voucher-signed.png` | PASS |
| Redeem with an unregistered enclave key (fails live) | RedeemPanel Diagnose + Simulate | live testnet | Diagnose (local recovery against live chain reads): "enclaveSig recovers to 0xDAb758D8...42C287: never registered. redeem reverts SignerNotRegistered()." Simulate (`eth_call` against real Assay state): "Simulation reverts with SignerNotRegistered()." Screenshots `04-diagnose-unregistered-enclave.png`, `05-simulate-signernotregistered.png` | PASS |
| Mismatched responseHash | RedeemPanel Diagnose + Simulate | live testnet | Same payerSig/enclaveSig (signed over the original responseHash) re-diagnosed after swapping `r-resp` to an unrelated hash: both signatures now recover to different, unregistered addresses ("payerSig recovers to 0x2B9a...B6: NOT the channel agent"; "enclaveSig recovers to 0x4f5b...7fb: never registered"). Live `simulateContract` reverts `PayerNotAgent()` (checked first in the contract). Screenshot `06-diagnose-mismatched-responsehash.png` | PASS |
| Replay of the same receipt (fails) | Assay.redeem `consumedReceipt` | test | `AttackReview.t.sol::test_M1_responseHashReplayABA_reverts`, `test_M1b_sameReceiptPaidOnTwoChannels_reverts`; `AssayAttacks.t.sol::test_attack_replayedVoucher_paysOnce`, all PASS. Live replay needs a first successful paid redemption, which is PHALA_API_KEY-blocked (see below) | PASS (test) |
| requestClose | Assay.requestClose | live testnet | tx [0xb874379a...78be0ae8e6](https://sepolia.arbiscan.io/tx/0xb874379a3e19ac1598bec60198076816d8b5c1ad5bebb87ff7462c78be0ae8e6), channel 0, block 312978091, `blockTimestamp 0x6ab7f278 = 1790440056`. Post-condition: `channels(0).closeRequestedAt == 1790440056` | PASS |
| Challenge window countdown | Channel.tsx UI | live testnet | UI rendered "Close requested: 2026-09-26 16:27:36 UTC (finalize after 2026-09-26 17:27:36 UTC, 00h 31m 12s)" live against the read block's timestamp, counting down to the same 1790443656 finalize instant used below | PASS |
| Redeem inside the challenge window | Assay.redeem | live testnet + test | Diagnose against the live open-but-close-requested channel 0 stated: "Close was requested but finalize has not run: redeem still succeeds inside the challenge window." (contract does not gate redeem on `closeRequestedAt`). Positive-pay path proven by `AssayAttacks.t.sol::test_redeemDuringChallengeWindow_stillPays` and `AttackReview.t.sol::test_H1_challengeWindowPaysPendingVoucherBeforeClose`, both PASS | PASS (live gate + test for the paid case) |
| finalizeClose after the window | Assay.finalizeClose | live testnet | Window was short enough on testnet: polled `cast block latest --field timestamp` from 1790442363 to 1790443678, past channel 0's `finalizeAt = closeRequestedAt(1790440056) + challengeWindow(3600) = 1790443656`, then sent tx [0x1e275fb4...4b0ffe704](https://sepolia.arbiscan.io/tx/0x1e275fb4af1ce2324d71362066d7cfd83767dc980801a54c8b509c34b0ffe704), status 1. Post-condition: `channels(0)` now `deposit=0, closed=true`; `ChannelClosed(0, refund=100000000)` and a 100.00 USDG `Transfer` back to the agent both logged | PASS (live) |
| Finalization boundary (same call fails differently before/after) | Assay.redeem | live testnet | Same throwaway-key `redeem(0,...)` call: `eth_call` as the provider before finalize decoded to `SignerNotRegistered()`; after `finalizeClose`, the identical call decodes to `ChannelClosedErr()` (`0xd039dbbe`), proving the channel-closed check now fires first | PASS |
| Positive paid redeem | Assay.redeem | **BLOCKED** | Needs a real Phala enclave `personal_sign` over the exact request/response text, which only the enclave's private key can produce; `PHALA_API_KEY` is unset in this environment so no live response can be requested. Proven instead by `Assay.t.sol::test_redeem_paysDeltaToProvider` and `test_enclaveDigest_matchesPhalaLegacyFormat_andRecovers`, using a registered test key, both PASS | BLOCKED (PHALA_API_KEY unset); proven in tests |
| Agent client refuses an unregistered gateway key | `agent` `npm run refuse` | live testnet | Fresh derived key `0x8E8E4c5961ba9b4fF20a2785cD11912f7ee020E9` each run; `signers()` returns an empty measurement, client prints `REFUSING TO PAY: ... not registered` and exits 1, read at block 313208406 | PASS (live) |
| Agent client paid path (3 calls, cumulative amounts) | `agent` `npm run pay` | coded + unit-tested | Checks `PHALA_API_KEY` first, absent it prints the exact refusal message and exits 1 before any network call; with the key it verifies the enclave signer, signs the voucher, and asserts `channels(0).paid` delta and provider USDG balance delta both equal the voucher amounts. See "Agent client" above | BLOCKED (PHALA_API_KEY unset); code and digest tests pass |
| Web `/` (Providers) | UI | live testnet | Registered-signer table, allowlist status, contract constants all read live; screenshot `docs/screenshots/assay/01-providers-connected.png` | PASS |
| Web `/verify` | UI | live testnet | Nonce read, live Fetch, parsed fields, live Dry-run verify and Simulate register all exercised in one pass; screenshot `02-verify-simulate-register.png` | PASS |
| Web `/channel` | UI | live testnet | Channel state, Open/Voucher/Redeem/Close sections all render against real chain data post-bug-fix (see Bugs); screenshots `03-voucher-signed.png` through `06-diagnose-mismatched-responsehash.png` | PASS |
| Decoded errors in UI | `ERROR_HELP` map + `errorNameFrom` | live testnet | Live-decoded `SignerNotRegistered`, `PayerNotAgent`, `QuoteAlreadyUsed`, `ChannelClosedErr`, `NotProvider` all surfaced with the exact plain-language explanation from the map | PASS |
| Block numbers shown | UI | live testnet | `/` "read at block", `/verify` "read at block #312,987,391" and "VERIFIER RESULT READ AT BLOCK #312,987,545" | PASS |
| Mobile width (390px) | UI | live testnet | CDP `Emulation.setDeviceMetricsOverride(390,844)` on `/verify` and `/channel`, no crash, full content visible; screenshots `07-mobile-verify.png`, `08-mobile-channel.png` | PASS |

## Solidity tests

`cd contracts && forge test`: **27 passed, 0 failed, 0 skipped** across 4 suites
(`AssayTest` 6, `AttackReviewTest` 5, `AssayAttacksTest` 14, `AssayFuzzTest` 2, the latter two
fuzz tests at 256 runs each).

## Rust tests

`cd verifier && cargo test`: **10 passed, 0 failed, 0 ignored** (7 unit tests in
`src/lib.rs` including `test_debug_attribute_set_reverts`, plus 3 integration tests in
`tests/attack_review.rs` including `red_h3_rejects_report_data_without_zero_padding`).

## Bugs found and fixed

**App-crashing tuple-vs-object decode bug in `Channel.tsx`** (fixed in this owned path,
re-tested live). `channels()` and `signers()` are multi-value Solidity view functions; viem's
`readContract` decodes their return as a positional tuple, not a named object, even though the
ABI carries field names (the correct pattern already existed in `Providers.tsx`:
`const [measurement, expiry] = await contract.read.signers(...)`). The original `Channel.tsx`
did an unchecked `as unknown as {namedFields...}` cast with no runtime conversion at three call
sites (the channel snapshot read, and twice inside the Diagnose panel), so every named field
read back `undefined`, and `fmtUsdg(undefined)` threw inside viem's `formatUnits`, an uncaught
render error that unmounts the whole React 18 tree. This made every page section below the
channel lookup (Open, Voucher, Redeem, Close) unusable for any channel that actually exists,
which was all of them. Fixed by destructuring the raw tuple positionally at all three sites and
building a named object from it before use; verified live against real channel 0 data with a
global error-capture probe showing zero uncaught errors after the fix.

No contract bugs were found; all four described attack surfaces (stale quote, replayed
receipt, mismatched hash, unregistered signer) reverted exactly as specified, live where
possible and by existing test otherwise.
