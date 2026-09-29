# Chiron

Hosted app: [chiron-receipts.vercel.app](https://chiron-receipts.vercel.app) . Repo: [github.com/pranjalcodesinw3/chiron](https://github.com/pranjalcodesinw3/chiron) . Video: link pending upload.

Named for the one trustworthy centaur: the attested provider among substitutes.

Chiron is a USDG payment channel on Arbitrum for AI agents that buy inference per call. The agent's money moves only against proof checked onchain: a Stylus contract verifies the provider gateway's Intel TDX attestation, and a second Stylus contract verifies the gateway's signed receipt for each response. A channel pinned to a model pays only when the receipt says that model was served. If the gateway routed the call to a different model, the payment reverts.

The contract is `Assay` (`contracts/src/Assay.sol`).

## What the receipt proves, and what it does not

Proves: a TEE running the allowlisted image measurement signed a receipt naming the model it served and hashes of the exact request and response bytes, so a swapped model or an unattested gateway never gets paid. Does not prove: that the answer is correct. Chiron makes model substitution unprofitable; it makes no claim about output quality. Only the redeemed call's receipt is checked onchain: the highest voucher wins per channel, so a provider who serves one bad call among many good ones and never gets that specific call redeemed is not caught by this contract. Earlier calls in a session rely on the agent's own local check (see "What the agent does before it signs anything"), not an onchain one.

Attestations are valid 24 hours by design (`attestationValidity` is immutable at 86400 seconds). The provider re-registers its keys daily; see "Keeping keys fresh" below.

## Live on Arbitrum Sepolia

Chain 421614, deployed 2026-09-28 from `0x2aD12a72362704367e99a344cFf5affDDF7f5DEF`. Every address below was read back with `cast call` after deployment; `contracts/deployments/421614.json` holds the full record.

| Contract | Address | What it is |
|---|---|---|
| Assay | [`0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC`](https://sepolia.arbiscan.io/address/0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC) | The payment channel. Source verified on Sourcify (exact match, creation and runtime). |
| Verifier | [`0x3c19c10e5c9a82d01ed79e5c6026d73b9b2caf8c`](https://sepolia.arbiscan.io/address/0x3c19c10e5c9a82d01ed79e5c6026d73b9b2caf8c) | Stylus (Rust). Verifies an Intel TDX DCAP quote chain and returns the gateway's signer and image measurement. |
| ReceiptVerifier | [`0x9af7d9c3b27c4a8a11fb879041b931c38b712380`](https://sepolia.arbiscan.io/address/0x9af7d9c3b27c4a8a11fb879041b931c38b712380) | Stylus (Rust). Verifies one Ed25519-signed Phala inference receipt and returns the requested model, served model, request hash and response hash. |
| USDG | [`0xFFC95faa3d63Cde504a05B567C600B78C0b41892`](https://sepolia.arbiscan.io/address/0xFFC95faa3d63Cde504a05B567C600B78C0b41892) | Paxos Global Dollar on Arbitrum Sepolia. Not deployed by this repo. |

Live transactions on this deployment:

| Step | Transaction | Result read back |
|---|---|---|
| Register Phala's gateway signer from a fresh TDX quote bound to Assay's own nonce | [`0xaf4218b9...0d59`](https://sepolia.arbiscan.io/tx/0xaf4218b965aea5b0086a45f12680920411935548698bbebfbe2f085b3bb80d59), block 313675089 | `signers(0x79A5...6B79)` = measurement `0xfd34...0149` |
| Register Phala's Ed25519 receipt key from a second fresh quote | [`0xdff86c7c...ef1f`](https://sepolia.arbiscan.io/tx/0xdff86c7c326ffa23738ec12fc9e7a7c3c930453298c28d7ce26322888a13ef1f), block 313675112 | `receiptSigners(0x110f...aa0a)` = same measurement |
| Open channel 0, pinned to `meta-llama/llama-3.3-70b-instruct` | [`0x61fffc01...bd2`](https://sepolia.arbiscan.io/tx/0x61fffc011aeee16cce4a8075f606bb58d6b05038a7b8d6921460a26db5cacbd2), block 313676162 | deposit 2.000000 USDG |
| Open channel 1, legacy signature path | [`0xb06dae37...2652`](https://sepolia.arbiscan.io/tx/0xb06dae3711bce5b151ea7fb6af0b30a94d37186cd00bb4b06cd7e9460bfd2652), block 313676207 | deposit 2.000000 USDG |

The agent wallet (`0x2aD1...5DEF`) pays and the provider wallet (`0x93e8...EE5A`) is paid; the two are different addresses. `docs/e2e/chiron.md` lists every command and post-condition.

## Keeping keys fresh

`attestationValidity` is immutable at 86400 seconds (24 hours), so a registered signer expires on a fixed clock. A `launchd` job (`com.chiron.keeper.register`, outside `~/Desktop` because launchd cannot read files under `~/Desktop`) re-runs `npm run register` every 20 hours, so a judge opening the app days after submission still sees an unexpired gateway signer and receipt key. Kill it after judging with `launchctl unload ~/Library/LaunchAgents/com.chiron.keeper.register.plist`.

## Arbitrum technology

Both verifier contracts are Stylus (Rust, WASM), not Solidity, because the checks they run are too expensive in the EVM: `Verifier` parses an Intel TDX DCAP quote chain and checks two P-384 and P-256 ECDSA signature chains against Intel's root in one transaction (`cast estimate` measured 2,304,195 gas on a fresh Phala quote, tx `0xaf4218b9...0d59` for the full register call at 2,346,274 gas); `ReceiptVerifier` checks an Ed25519 signature over the receipt's canonical JSON bytes. Neither op is available as an EVM precompile on Arbitrum Sepolia, and a pure-Solidity P-384/TDX-parsing implementation would blow past the block gas limit. Stylus compiles the same logic to WASM and runs it at near-native speed inside the same Arbitrum Sepolia transaction that Assay uses to pay, so the attestation check and the payment share one atomic call.

## The problem

An agent that pays a model API per call cannot see what actually served the call. A provider can substitute a cheaper or quantized model and keep charging the advertised price.

| Source | What it shows |
|---|---|
| [Cai, Shi, Zhao, Song, "Are You Getting What You Pay For? Auditing Model Substitution in LLM APIs", arXiv 2504.04715](https://arxiv.org/abs/2504.04715) | Software-only detection of a substituted model is unreliable: output-statistics tests fail against subtle substitutions, and log-probability checks break on normal inference nondeterminism. The authors propose trusted execution environments as the practical fix. |
| [MoonshotAI/K2-Vendor-Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier) | The model's own publisher measures significant tool-call accuracy differences between API vendors serving the same open-weight model. |
| [OpenRouterTeam/ai-sdk-provider#499](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/499) | A silent provider flip mid-session: a flipped request cost about $0.04 against about $0.005 for a cache hit, and no error reached the caller. |

Phala's confidential gateway already runs in a TEE, publishes a TDX attestation, and signs a receipt for every response that names the model the upstream served. What was missing is a payment that depends on them: checking a receipt in a client library after paying does not stop the payment. Chiron makes the check and the payment the same transaction.

## How it works

**1. Register the gateway's keys.** Anyone can call `register(quote, refBlock)`. Assay issues the nonce the quote must commit to:

```
nonce = keccak256(chainid, assay, caller, registerNonce[caller], arbBlockHash(refBlock))
```

The block hash comes from Arbitrum's ArbSys precompile, which answers only for the last 256 L2 blocks (about 66 seconds on Arbitrum Sepolia), so a quote cannot be fetched ahead of time and banked. `Verifier.verify(quote, nonce)` checks the quote's PCK certificate chain, QE report and quote signature (all P-256) against Intel's root, the certificate validity dates against `block.timestamp`, rejects the TDX DEBUG attribute, and requires `report_data` to carry the nonce. It returns the gateway's signing address and a measurement over nine TD report fields (`mr_seam`, `td_attributes`, `xfam`, `MRTD`, `mr_config_id`, `RTMR0` to `RTMR3`). Assay stores the signer only if that measurement is on the allowlist fixed at construction.

`registerReceiptKey(quote, keysetBytes, refBlock, pubkey)` does the same for the Ed25519 key that signs receipts. Phala's ACI attestation does not sign that key directly: its `report_data` commits to `sha256` of a statement containing the digest of the whole workload keyset. `Verifier.verifyKeyset` recomputes that statement from the supplied keyset bytes and the nonce, requires it to equal `report_data[0..32]`, and only then reads the key out of the keyset's `receipt_signing_keys`.

`cd agent && npm run register` does both inside one ArbSys window and checks the stored result afterwards.

**2. Open a channel.** The agent deposits USDG (`openChannel` after `approve`, or `openChannelWithPermit` in one transaction) and pins two things: the image measurement it trusts and, optionally, a model id hash. The deposit is the most the provider can ever take.

- A channel pinned to a model is **receipt-only**. `redeem()` on it reverts `ModelMismatch`, because the legacy signature carries no model evidence.
- A channel with a zero model hash is **legacy-only**, paid against Phala's per-response ECDSA signature.

**3. Pay per call.** For every call the agent signs an EIP-712 voucher over `(channelId, cumulativeAmount, requestHash, responseHash)`. The provider redeems the highest voucher and Assay pays only the difference from what it already paid.

`redeemWithReceipt` pays only if all of these hold:

- the voucher is signed by the channel's agent (its own ECDSA key, or ERC-1271 if the agent is a contract);
- `ReceiptVerifier.verifyReceipt` accepts the Ed25519 signature over the receipt's exact JCS bytes;
- the receipt's **served** model hash and requested model hash both equal the channel's pinned model;
- the receipt's `request.received` and `response.returned` body hashes equal the voucher's `requestHash` and `responseHash`;
- the receipt key is registered, unexpired, and registered under the measurement this channel pinned.

The served model is read from bytes the gateway's TEE signed, not from anything the provider submits separately. A gateway that routed the call to another model produces a receipt that can never pay this channel.

**4. Close.** The agent calls `requestClose` once the channel has been idle for `channelTimeout` (1 hour here). The provider can still redeem during the `challengeWindow` (1 hour), and `finalizeClose` then refunds the rest to the agent. No owner, no upgrade path, no pause, no admin setter.

## What the agent does before it signs anything

`npm run pay-receipt` requests a completion with a fresh nonce in the body, fetches the signed receipt, and checks it locally before creating a voucher. It canonicalizes the receipt itself (RFC 8785), verifies the Ed25519 signature against the key from a fresh attestation, and compares both body hashes with the exact bytes it sent and received. If the served model differs from the requested one, it prints `REFUSING TO PAY` and exits without signing. The onchain check is the guarantee; the local check means an honest agent never spends gas on a call it already knows is bad.

## What the attestation proves

It proves the gateway's key lives in a TDX guest whose nine-field measurement is on Assay's allowlist, under a certificate chain that ends at Intel's root and was valid at the block that checked it. RTMR3 carries the hash of the deployed compose file, so a changed serving image shows up as a changed measurement.

The receipt is the gateway's signed statement, made inside the TEE, of which model the upstream served for this one request and response. Phala records that in the receipt's `upstream.verified` event from the live response. The measurement does not say which weights a model provider loaded behind that; the receipt carries the upstream's own model label.

Assay checks certificate dates but does not read Intel's TCB status, QE identity or PCK revocation list. Those need Intel's live collateral, which a contract cannot fetch. The allowlist carries a single measurement so that a TCB decision is made once, by whoever deploys, rather than inferred per quote.

## Security

Four review rounds; the record is in `SECURITY-REVIEW.md` and `docs/security/assay-usdg-review.md`. The last two ran against the code deployed here, and each finding came with a test that failed on the unfixed code:

| Finding | Fix |
|---|---|
| A model-pinned channel could still be paid through the legacy path | A pinned channel is receipt-only; `redeem()` reverts `ModelMismatch` |
| An out-of-window `refBlock` produced a zero hash, so the register nonce became a constant a quote could be stockpiled for | ArbSys revert or a zero hash reverts `StaleRefBlock` |
| One receipt could back payments for different requests | The receipt verifier returns `request.received`'s hash and Assay requires it to equal the voucher's |
| An agent whose EIP-7702 delegation changed after signing could void its vouchers | The agent's own ECDSA signature is always accepted; ERC-1271 is asked only if that fails |
| The receipt verifier accepted a forged signature under a small-order public key | `verify_strict` |

Each fix was checked by reverting it and confirming its test goes red, then restoring it. The final review's verdict before redeploy was DEPLOY.

Assay holds real Paxos USDG, whose issuer can pause, freeze and wipe. The fork suite runs against the real USDG proxy and pins what that means: a pause that outlasts the challenge window lets the agent close first, and a frozen agent's refund waits in Assay until Paxos unfreezes (`test_demo_M1_unfreezeRestoresRefund` shows the full refund arriving afterwards). No `refundTo` escape was added, since it would let a frozen party route around the freeze.

Tests on the deployed code:

| Suite | Result |
|---|---|
| `forge test` (unit, attack, fuzz, hardening, re-review regressions) | 61 passed |
| Invariant (escrow conservation) | 1 passed |
| Fork suite against real Paxos USDG at a recent Arbitrum Sepolia block | 13 passed |
| `receipt-verifier` `cargo test` | 18 passed |
| `verifier` `cargo test` | 22 passed |
| `agent` `npm test` | 17 passed |

## Gas

| Call | Gas | Source |
|---|---|---|
| `Verifier.verify` on a fresh Phala quote | 2,304,195 | `cast estimate`, block 313704492 |
| `register` (verify + store) | 2,346,274 | tx `0xaf4218b9...0d59` |
| `registerReceiptKey` (verify keyset + store) | 2,368,996 | tx `0xdff86c7c...ef1f` |
| `openChannel` | 243,470 | tx `0x61fffc01...bd2` |

Registration runs once per key rotation. The per-call path only runs the Ed25519 receipt check.

## Run it

```
cd contracts && forge test
cd receipt-verifier && cargo test
cd verifier && cargo test
cd agent && npm test
```

Against the live deployment (keys in `.env`, loaded by the scripts, never printed): `PRIVATE_KEY` is the agent, `PROVIDER_PRIVATE_KEY` the provider, `PHALA_API_KEY` a Phala Confidential AI key.

```
cd agent
npm run register                # provider registers the gateway signer and receipt key
APPROVED_MEASUREMENT=0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149 npm run open   # receipt-only channel
ASSAY_CHANNEL_ID=0 npm run pay-receipt
npm run refuse                  # shows the agent refusing an unregistered gateway key
```

Web app: `cd web && npm install && npm run dev`. It reads every figure it shows from the chain with the block it was read at.

## Design choices

- **One provider, one image.** Assay verifies and pays one attested gateway. Routing between providers is a separate product and adds a trust decision this contract is built to avoid.
- **No disputes.** Both signatures verify against state already onchain or the call reverts; there is nothing left to arbitrate.
- **Registration is permissionless.** The key comes out of the quote itself, so whoever submits it cannot register anything the quote did not attest.

## Team

Built by pranjalcodesinw3, AI-assisted.
