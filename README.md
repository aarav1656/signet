# Chiron

Named for the one trustworthy centaur: the attested provider among substitutes.
Chiron (contract `Assay`): `contracts/src/Assay.sol`.

Chiron is a payment channel for AI agents paying a provider whose serving image was proven, on Arbitrum, by an Intel TDX remote attestation quote.

## Deployed

Network: Arbitrum Sepolia (421614). Explorer: https://sepolia.arbiscan.io

| Contract | Network | Address | Explorer |
|---|---|---|---|
| Assay | Arbitrum Sepolia | `0x(superseded-testnet-deploy)` | [tx](https://sepolia.arbiscan.io/tx/0xcad13796ba4692b112af06943ceab9e92a516880f23d675439ed412b79d622e8) |
| Stylus Verifier | Arbitrum Sepolia | `0x(superseded-testnet-deploy)` | [tx](https://sepolia.arbiscan.io/tx/0x7c78014ce0392a0cbc454561f93a01ecdffc896a2da8967cc61330f2c4b8e6aa) |
| USDG (Paxos Global Dollar, real, not deployed by this repo) | Arbitrum Sepolia | `0xFFC95faa3d63Cde504a05B567C600B78C0b41892` | [contract](https://sepolia.arbiscan.io/address/0xFFC95faa3d63Cde504a05B567C600B78C0b41892) |

Superseded: the prior Assay `0x6B2a0C4CE50D9788D1FADb6D0eb523e697c4EC41` bound `usdg()` to TestUSDG, an open-mint testnet fixture (`0x46C42eCD4FFDD0060b2FF4c9F6814D6762868b6D`), which a real deploy command could produce by mistake (see `SECURITY-REVIEW.md`). It is kept in `contracts/deployments/421614.json` for history; every subsequent money path uses the address above instead, which returns the real USDG address from `cast call <new> "usdg()(address)"`.

Live on testnet against real USDG: `register()` accepted a fresh Phala quote for signer `0x79a5...6b79` ([tx](https://sepolia.arbiscan.io/tx/0x3410ca1d2dd3b93deb09187c94d42d14f3fa766444632b1432fd0a7979c301e0)), then `openChannelWithPermit` opened channel 0 with a 2.000000 USDG deposit signed over the real `Global Dollar`/`1` permit domain ([tx](https://sepolia.arbiscan.io/tx/0x2f5f14672dd085bcceb9e35af405bd7d396eeb716cf24fe1e8777c99dfaaac07)); `balanceOf(assay)` reads back exactly 2000000. See `docs/e2e/chiron.md` for every post-condition read.

Not live yet: the positive paid redeem needs a Phala API key (unset, never requested). It is proven in tests instead: `contracts/test/Assay.t.sol`'s `test_enclaveDigest_matchesPhalaLegacyFormat_andRecovers` and `contracts/test/AssayAttacks.t.sol`.

An agent locks USDG into a channel. `redeem()` requires two independent signatures over the same `(channelId, cumulativeAmount, requestHash, responseHash)`: a `payerSig`, the channel's own agent authorizing spend (EIP-712), and an `enclaveSig`, Phala's own `personal_sign` receipt over the request/response pair, required to recover to a currently registered, unexpired, allowlisted-measurement signer. Authorization and provenance are separate signatures because only one party can ever produce each; no admin, no owner, no upgrade path.

## Who pays

The agent funds the channel (USDG, via `permit` or `approve` depending on what the deployed token supports). The provider is paid out of that deposit as it redeems vouchers. Nobody else moves funds. Closing is two-phase: `requestClose(channelId)` opens an immutable `challengeWindow` (1 hour on testnet) during which the provider can still redeem its latest voucher; only after the window elapses does `finalizeClose(channelId)` refund whatever remains to the agent. The timeout that gates `requestClose` counts from the channel's last redeem (or `openedAt`, if it was never redeemed), not from `openedAt` alone, so an agent cannot time out a provider that is actively being paid. `redeem()` reverts once `finalizeClose` has run.

The deposit itself is a spend cap bound to attestation: `redeem()` requires `cumulativeAmount` to stay within `deposit` and to only increase against the one measurement `register()` accepted for that signer, so the agent's maximum possible loss to a single provider is fixed the moment it deposits, not a number the provider can inflate after the fact. That is the same "spend cap bound to compose-hash" control plane buyers ask for instead of a skimmable prepaid API key; Assay already has it, just not previously named that way.

## What agents on other providers hit today

No attestation, no onchain cap: providers can silently swap models, and an agent has no receipt to check against. Three dated, first-party reports of the exact failure Assay's single onchain `register()` shape and allowlisted measurement are built to close:

| Report | What happened |
|---|---|
| [NousResearch/hermes-agent#12201](https://github.com/NousResearch/hermes-agent/pull/12201) | RedPill returns four different, undocumented attestation-envelope shapes; a strict client has to sniff which one it got, and a real substitution was observed: request `DeepSeek-V3.1`, get `Qwen3.5-122B`. |
| [OpenRouterTeam/ai-sdk-provider#499](https://github.com/OpenRouterTeam/ai-sdk-provider#499) | A silent provider flip broke prompt caching mid-session and turned a $0.005 turn into $0.04, an 8x cost jump with no error surfaced to the caller. |
| [nearai/inference-proxy#129](https://github.com/nearai/inference-proxy/issues/129) | NEAR's own Intel Trust Authority attestation path, live-checked by a third party, returned a valid signature with `attester_tcb_status: OutOfDate` and 10 open advisory IDs, zero policy claims: even a more resourced attestation integration has not closed the TCB-freshness gap Assay discloses below. |

## Security review fixes (SECURITY-REVIEW.md)

| Finding | Fix | Status |
|---|---|---|
| H-1 unilateral close skips payment for delivered work | Two-phase `requestClose`/`finalizeClose` with an immutable challenge window; timeout counts from last activity, not `openedAt`; `redeem()` after `finalizeClose` reverts | Fixed, tested, live |
| H-2 no freshness check on attestation quotes | Contract-issued nonce `keccak256(chainid, address(this), provider, registerNonce[provider])`; `register()` requires `report_data[32:64] == nonce`, `report_data[20:32] == 0`, and advances `registerNonce` only after the check passes; PCK leaf/intermediate cert `notBefore`/`notAfter` checked against `block.timestamp` in the verifier | Fixed, tested, live on-chain (stale quote replay reverts with `NonceMismatch`) |
| M-1 verifier accepts TDATTRIBUTES with DEBUG set | Verifier rejects any quote whose TDATTRIBUTES bit 0 (DEBUG, per the Intel TDX Module Base Architecture Specification's TDATTRIBUTES definition) is set, and requires the `[20:32]` report_data padding to be zero | Fixed, tested (`test_debug_attribute_set_reverts`) |
| L-1 a receipt could be replayed across channels | Global `consumed` mapping keyed on `keccak256(provider, requestHash, responseHash)` | Fixed, tested |
| L-2 `openChannelWithPermit` reverts if a permit is front-run | `try/catch` around the permit call; proceeds if allowance is already sufficient | Fixed, tested |
| L-3 Stylus program reactivation | Documented below: reactivation after an ArbOS upgrade invalidates cached programs is a permissionless call anyone can make; no privileged role needed | Documented |
| L-4 unchecked length arithmetic in the verifier | `checked_end()`/checked arithmetic replacing raw `off + len` on all attacker-controlled length fields | Fixed, tested |

### Issuer risk

Assay pools every channel's deposit in one contract address and pays out of real Paxos USDG, a regulated, admin-controlled stablecoin: Paxos can pause the token, freeze any single address, or wipe a frozen address's balance entirely, and none of that is under Assay.sol's control. This project's own security review accepted three such risks for this testnet deploy, each now asserted as a passing `test_issuerRisk_*` test in `contracts/test/AssayRealUSDGFork.t.sol` (a fork of Arbitrum Sepolia against the real USDG proxy) rather than only described in prose:

- **A pause spanning the challenge window can move an honest provider's earned money to the agent (M-1).** `redeem()` reverts while USDG is paused; if the pause outlasts the window, the agent's `finalizeClose` lands first and the provider's now-late, still-validly-signed voucher reverts `ChannelClosedErr()` instead of paying.
- **Freezing the Assay contract itself strands every open channel, and a later wipe burns all pooled escrow at once (M-2).** `redeem()` reverts `AddressFrozen()` once the contract address is frozen; `wipeFrozenAddress` zeroes its balance for every agent and provider at the same time.
- **A frozen agent's refund has no alternate recipient (L-1).** `finalizeClose` reverts `AddressFrozen()` and the refund sits in Assay until Paxos unfreezes. This is compliance-correct rather than a bug: a `refundTo(address)` escape hatch would let a sanctioned party redirect funds around a freeze, so none was added; the money is held, not lost (proven by `test_demo_M1_unfreezeRestoresRefund`, which shows the full refund arriving after unfreeze).

None of these are fixable from Assay.sol alone: they are inherent to any pooled escrow of a token whose issuer holds pause/freeze/wipe roles. Accepted for a testnet deploy of a few USDG; before any mainnet or higher-value deploy, separate crediting from transferring (`redeem` should credit `owed[provider]` rather than transfer directly, so a pause only delays a `withdraw()` instead of changing who is owed).

Real-USDG deploy path review (Deploy.s.sol's `USDG_ADDRESS` override, the three issuer risks above with live fork evidence): `docs/security/assay-usdg-review.md`.

**L-3 detail:** Stylus caches compiled programs and can invalidate that cache on an ArbOS upgrade (`ProgramNotActivated`). Reactivating a previously-deployed, unchanged Verifier is a call to `ArbWasm.activateProgram(address)` (address `0x0000000000000000000000000000000000000071`), which is **not access-controlled**: any address can pay the (small) activation data fee and call it for this Verifier's address, since the bytecode itself never changes. No owner key, no deployer-only path, and no action is required from Assay.sol, whose `verifier_` reference is immutable and keeps working once the program is reactivated.

## What Intel TDX attestation proves, and what it does not

**Proves:** a TDX quote fetched from Phala's legacy `GET /v1/attestation/report?nonce=...` endpoint chains to Intel's DCAP root (PCK cert chain, QE report signature, top-level quote signature, all P-256). The quote's MRTD and RTMR0-3 measurement registers pin the exact serving image (Docker digests, per Phala's own attestation docs), so `register()` on `Assay.sol` will only accept a signer whose quote measurement matches an allowlisted image. The registered `signer` is `report_data[0:20]`, a real secp256k1/Ethereum address the gateway signs per-response receipts with (`signing_address`, confirmed against `github.com/Dstack-TEE/private-ai-gateway`'s own source and a live fetch, byte for byte) — not the Quoting Enclave's ephemeral attestation key, which never leaves Intel's hardware and cannot sign anything a provider would issue. The canonical `/v1/aci/attestation` endpoint's report_data instead commits to a nonce+keyset-digest hash and carries no raw address, so `register()` must use a legacy-endpoint quote.

**Does not prove:** that the pinned image, once booted, actually loads the model weights a seller advertises. There is no separate "model weight hash" field in this attestation distinct from the compose-hash; whether an image binds a specific weight file depends on how that image was built, and the quote does not distinguish baked-in weights from an unpinned runtime download. There is no NVIDIA GPU evidence anywhere in this endpoint's response and no P-384 anywhere in the quote (an earlier draft of this product claimed both; both were wrong, see `spikes/assay-verify/FINDINGS.md`). The verifier checks the PCK leaf and intermediate certificate validity dates against `block.timestamp`, but it does **not** check TCB status, QE identity, or the PCK CRL, because those require Intel's live PCCS collateral (a network fetch or an oracle feeding it onchain), which this contract does not have. A cert chain that is cryptographically valid and unexpired but whose TCB level has since been marked out-of-date (a microcode/firmware vulnerability disclosed after issuance) is not rejected. This is a real gap, not a checkbox: closing it needs either an onchain PCCS collateral oracle or an offchain relayer that refuses to submit quotes against a stale TCB, and neither exists here yet.

## Measured gas

`verify(bytes,bytes32)` against a real fetched quote, on the current Verifier (with the H-2 nonce/cert-date checks and M-1 DEBUG-bit check added): 2,332,833 gas (`cast estimate` against `0x(superseded-testnet-deploy)` on Arbitrum Sepolia, see `contracts/deployments/421614.json`). The apt Solidity comparison is Automata Network's audited `automata-dcap-attestation` (same PCK chain plus QE-report plus ISV-signature job), at roughly 4 to 5 million gas onchain. That puts the Stylus verifier at roughly 1.7x to 2.1x cheaper, not the order-of-magnitude difference an earlier, wrong Solidity baseline (AWS Nitro validation, a different mechanism entirely) would have implied.

## The split-signature design

`redeem(channelId, cumulativeAmount, requestHash, responseHash, payerSig, enclaveSig)` checks two signatures that prove two different things, because only one party can ever produce each:

- `payerSig`: an EIP-712 `Voucher{channelId,cumulativeAmount,requestHash,responseHash}` signed by the channel's own agent. The agent always holds this key, so this authorizes spend up to `cumulativeAmount` for this exact exchange. It is not attestation evidence, and does not claim to be.
- `enclaveSig`: Phala's own legacy per-response receipt signature, a `personal_sign` (EIP-191) over the exact ASCII text `"<requestHash>:<responseHash>"`, both hashes as 64 lowercase hex characters with no `0x`, built onchain from the two `bytes32` values to match `Dstack-TEE/private-ai-gateway`'s `legacy_signature_text` (`src/aggregator/service/helpers.rs`) and `sign_legacy_message`/`ethereum_personal_message_hash` (`src/dstack.rs`) byte for byte. Recovering it must land on a currently registered, unexpired, allowlisted-measurement signer: that is the provenance check, independent of who is paying.

Both must verify, `cumulativeAmount` must increase and stay within the deposit, and `responseHash` must differ from the last one redeemed on this channel (`lastResponseHash`, blocking a replay of one real receipt under a bumped amount). No complete real Phala-signed `(address, message, signature)` fixture exists in Phala's docs or public repo to hardcode: their own regression test (`tests/http.rs`, `legacy_ecdsa_signature_uses_the_e2ee_signing_address`) signs the literal text `"hello"` with a key generated fresh at test time, not an exported constant. `contracts/test/Assay.t.sol`'s `test_enclaveDigest_matchesPhalaLegacyFormat_andRecovers` instead reproduces Phala's exact algorithm and proves recovery, rather than replaying a value that does not exist to replay.

## What works

- The Stylus verifier (`verifier/`) checks a real Intel TDX quote's chain of trust in one transaction, binds it to a contract-issued nonce, rejects DEBUG-mode quotes, checks PCK cert validity dates, and extracts both a real signer address (`report_data[0:20]`, not a key fingerprint) and an image measurement. 7 Rust unit tests and 3 Rust integration tests pass (`cargo test --lib`, `cargo test --test attack_review`), including one that runs a real fetched legacy-endpoint bundle through the exact `verify()` call path and asserts the extracted signer equals that fetch's own `signing_address`, one that flips the DEBUG bit and asserts the exact `DebugAttributeSet` rejection (not just "some error"), one with a wrong nonce, one with an expired cert, and others that flip a signature or report-data bit. Two mutation tests were run and restored: removing the nonce-equality check turned `test_wrong_nonce_reverts` from a false accept back to green once restored (the check was proven able to fail), and removing the `DebugAttributeSet` check made that test fail for the wrong reason (`SignatureInvalid`, since flipping a real quote's byte also breaks its ISV signature), which is exactly why that test asserts the specific error string rather than a bare `is_err()`.
- `Assay.sol`'s two-phase, split-signature payment channel logic is fully covered: 27 Solidity tests pass with `forge test` across 4 suites (unit, attack, attack-review, fuzz), including the H-1 challenge-window test (a pending voucher still redeems mid-challenge, `finalizeClose` pays only the remainder, `redeem` after `finalizeClose` reverts), the H-2 stale-quote replay test, the two L-1 cross-request and cross-channel receipt-replay tests, and the L-2 permit-front-run fallthrough test. Mutation tests on both H-1 (letting `redeem` ignore the challenge window) and H-2 (dropping the nonce check) were run and confirmed red, then restored to green.
- Live on Arbitrum Sepolia (421614, see `contracts/deployments/421614.json` and the Deployed table above): the deployed Verifier and Assay (`challengeWindow = 3600`) carry all of the fixes above. `register()` was run with a quote fetched **using the contract's own `nextRegisterNonce(deployer)`** and succeeded onchain, storing the real `signing_address` (`0x79a5...6b79`) and measurement `0xfd34ca...0149`. A channel was opened for real (deposit 100000000). Two deliberate failures are live: (1) re-registering the old fixture quote (`fixtures/quote_legacy1.hex`, whose nonce no longer matches) reverts with `NonceMismatch`, confirmed both as a real mined, failing transaction and by replaying the same calldata via `cast call`; `registerNonce(deployer)` stayed at `1`, proving the reverted call consumed no nonce; (2) a `redeem()` with a valid `payerSig` from the real agent but an `enclaveSig` from a freshly generated, never-registered key reverts with `SignerNotRegistered()`, mined as a real transaction with an explicit `--gas-limit`, with the channel's `paid` balance confirmed unchanged afterward.

## What does not work

The positive redemption path, a real Phala `enclaveSig` succeeding against a real `payerSig` on live Arbitrum Sepolia, is still not demonstrated. The one user-supplied item blocking it is **`PHALA_API_KEY`**: getting an actual enclave signature requires a completion via `POST /v1/chat/completions`, then `GET /v1/signature/{chat_id}`, and the completions endpoint returns `401 "This model requires an API key"` with no key (checked live). It was never asked for in chat or read from anywhere but that env var name; it is unset in this environment. Set it to unlock the real call chain: completion, chat_id, signature fetch, `redeem()`. The redemption logic itself, including the exact Phala text format, is proven at the unit-test level (`contracts/test/Assay.t.sol`, `AssayAttacks.t.sol`) with a `MockVerifier` binding `register()` to a key the test controls; `Assay.sol`'s `redeem()` logic does not depend on how the verifier derived that signer. Also still not checked, onchain or off: TCB status, QE identity, and PCK CRL revocation (needs Intel PCCS collateral, see above).

## Run instructions

Verifier tests (Rust):
```
cd verifier && cargo test --lib
```

Contract tests (Solidity, unit + attack + fuzz):
```
cd contracts && forge test
```

Redeploy the verifier (Stylus, needs `PRIVATE_KEY` in `contracts/.env`, loaded only in a subshell):
```
cd verifier
( set -a; source contracts/.env; set +a; cargo stylus deploy --endpoint https://sepolia-rollup.arbitrum.io/rpc --private-key "$PRIVATE_KEY" --no-verify --max-fee-per-gas-gwei 1 )
```

Deploy `TestUSDG` and `Assay.sol`:
```
cd contracts
( set -a; source contracts/.env; set +a; \
  VERIFIER=<verifier address> APPROVED_MEASUREMENT=<bytes32 measurement> \
  forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast --private-key "$PRIVATE_KEY" )
```

## Contributors

Built by pranjalcodesinw3, AI-assisted (Claude Code wrote the Stylus verifier, the Solidity contracts, the test suites, and this README under direction; every claim above was checked against a live testnet transaction, a passing test, or a cited source before being written down).

## What we cut

- **A router or marketplace across multiple providers.** Assay verifies one provider's attestation and pays it; picking between providers is a different product, and no comparable product's first users asked for it ahead of a working single-provider path.
- **Disputes or arbitration.** The two-signature design (`payerSig` + `enclaveSig`) is built so there is nothing to arbitrate: either both signatures verify against the state committed onchain, or `redeem()` reverts. Adding a dispute path would reintroduce the trust it removes.
- **A provider reputation score.** Scoring requires a population of providers and history this testnet deployment does not have yet; shipping a number with one data point is worse than no number.
- **Onchain TCB/PCK-CRL revocation checking.** Documented above as a real, disclosed gap (needs Intel's live PCCS collateral), not silently dropped.

## Roadmap

- **Now (blocked on the user):** the positive redemption path, gated on `PHALA_API_KEY` being placed in `.env`. Everything downstream of that key is already coded and unit-tested.
- **Next:** an onchain PCCS collateral oracle, or an offchain relayer that refuses to submit quotes against a stale TCB, to close the TCB-freshness gap NEAR's own inference-proxy issue #129 documents is still open industry-wide.
- **Later:** a second registered measurement (multi-image allowlist) once a second real provider image exists to test against; no plan to build a router ahead of that.
