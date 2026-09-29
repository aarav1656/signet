# Chiron

## Tagline

Pay per AI call only when a sealed gateway signs a receipt naming your model

## Description

Chiron is a USDG payment channel on Arbitrum for AI agents that buy inference per call. Every payment is checked against the inference gateway's own evidence. First, a Stylus contract verifies the gateway's Intel TDX attestation quote and registers its signing keys. Then, for each call, a second Stylus contract verifies the gateway's Ed25519-signed receipt, and the channel pays only if the receipt says the model the agent pinned is the model that served the call. A gateway that routes a request to a cheaper model produces a receipt that can never pay that channel. The contracts are live on Arbitrum Sepolia against real Paxos USDG, with Phala's production gateway keys registered onchain from fresh attestation quotes.

## Problem

A caller paying a model API cannot see which model answered. Three public sources, each read on 2026-09-29:

- Cai, Shi, Zhao and Song, "Are You Getting What You Pay For? Auditing Model Substitution in LLM APIs" ([arXiv 2504.04715](https://arxiv.org/abs/2504.04715)), state that providers "may covertly substitute cheaper alternatives (e.g., quantized versions, smaller models) to reduce costs while maintaining advertised pricing". They find software-only detection unreliable and propose trusted execution environments as the fix.
- Moonshot, which publishes the Kimi K2 model, built [K2-Vendor-Verifier](https://github.com/MoonshotAI/K2-Vendor-Verifier) after observing significant tool-call accuracy differences between vendors serving the same model.
- [OpenRouterTeam/ai-sdk-provider#499](https://github.com/OpenRouterTeam/ai-sdk-provider/issues/499) describes a silent provider flip where a flipped request cost about $0.04 against about $0.005 for a cache hit, with no error returned.

Phala's confidential gateway already runs in a TEE and signs a receipt per response that records the model the upstream served. Phala's verifier library (`@phala/aci-verifier`, a TypeScript package for browsers, Node.js and Bun) checks those receipts in the client, after the request has been billed. Nothing made the payment depend on the check.

## How it works

**Register.** `Assay.register(quote, refBlock)` asks the Stylus `Verifier` to check a Phala TDX quote against Intel's certificate chain. The quote must commit to a nonce that Assay derives from the caller, a counter, and an Arbitrum block hash from the ArbSys precompile. ArbSys only answers for the last 256 blocks, about 66 seconds, so a quote cannot be fetched early and saved. The verifier returns the gateway's signing address and a measurement over nine TD report fields, and Assay stores the key only if that measurement is on its allowlist. `registerReceiptKey` does the same for the Ed25519 receipt key: Phala's attestation commits to a digest of the whole workload keyset, and the verifier recomputes that digest from the supplied keyset bytes before reading the key out of it.

**Open.** The agent deposits USDG and pins the gateway measurement and a model id hash, for example `keccak256("meta-llama/llama-3.3-70b-instruct")`. The deposit caps what the provider can ever take. A channel pinned to a model is receipt-only.

**Pay.** For each call the agent signs an EIP-712 voucher over the cumulative amount and the request and response hashes. The provider calls `redeemWithReceipt` with that voucher and Phala's receipt. Assay pays the difference from the last redeem only if:

- the Stylus `ReceiptVerifier` accepts the Ed25519 signature over the receipt's canonical bytes;
- the receipt's served model and requested model both hash to the channel's pinned model;
- the receipt's request and response body hashes equal the voucher's;
- the receipt key is registered, unexpired, and registered under the channel's measurement.

**Model-swap refusal.** The served model comes from the receipt's `upstream.verified` event, which the gateway's TEE signed. The provider cannot choose what goes there. If the gateway served any other model, `redeemWithReceipt` reverts `ModelMismatch`, and the agent keeps its deposit and recovers it through the timed close. The agent client (`npm run pay-receipt`) runs the same checks locally first and refuses to sign a voucher for a swapped call, so an honest agent spends no gas on it.

**Close.** After an hour of inactivity the agent requests close; the provider has a one hour challenge window to redeem its last voucher; then the agent takes the remainder. There is no owner, no admin and no upgrade path.

## What is new here

- **The attestation check and the payment happen in the same transaction.** Phala's verifier and every client-side receipt check run after the caller has paid or been billed. In Chiron, the transaction that pays the provider is the one that verifies the receipt.
- **Model pinning per call, signed inside the TEE.** The payment condition is a TEE-signed statement about which model served this specific request, bound to the exact request and response bytes. A measurement allowlist alone says which gateway image is running; the receipt, signed inside that image, names the model the upstream answered with. It carries the upstream's own model label, not a hash of the weights.
- **TDX verification and Ed25519 verification as Stylus contracts.** Verifying a TDX DCAP quote chain costs 2,304,195 gas on the deployed Stylus verifier (`cast estimate` on a fresh Phala quote, Arbitrum Sepolia block 313704492). Registration runs once per key; the per-call path only verifies an Ed25519 signature.
- **Freshness from Arbitrum itself.** The registration nonce includes an `ArbSys.arbBlockHash` value, so every quote is at most about 66 seconds older than the block that accepts it.

Compared with nearby work: x402 settles a payment for an HTTP request but carries no evidence of what computed the answer. Automata's DCAP contracts verify TDX quotes as a standalone service without gating a payment. Chiron composes both halves for one job: paying for inference only when the served model is the one agreed.

## Stack

- Arbitrum Sepolia; Stylus (Rust, `stylus-sdk`) for the TDX quote verifier and the Ed25519 receipt verifier
- Solidity 0.8.28, Foundry, OpenZeppelin (EIP-712, ECDSA, ERC-1271, SafeERC20)
- Paxos USDG with EIP-2612 permit
- Phala Confidential AI gateway: TDX attestation, legacy ECDSA signatures and ACI Ed25519 receipts
- Agent client: TypeScript, viem, `@noble/curves`; web app: React, Vite, wagmi

## Deployed (Arbitrum Sepolia, chain 421614)

| Contract | Address |
|---|---|
| Assay | [0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC](https://sepolia.arbiscan.io/address/0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC) (Sourcify exact match) |
| Verifier (Stylus) | [0x3c19c10e5c9a82d01ed79e5c6026d73b9b2caf8c](https://sepolia.arbiscan.io/address/0x3c19c10e5c9a82d01ed79e5c6026d73b9b2caf8c) |
| ReceiptVerifier (Stylus) | [0x9af7d9c3b27c4a8a11fb879041b931c38b712380](https://sepolia.arbiscan.io/address/0x9af7d9c3b27c4a8a11fb879041b931c38b712380) |
| USDG (Paxos) | [0xFFC95faa3d63Cde504a05B567C600B78C0b41892](https://sepolia.arbiscan.io/address/0xFFC95faa3d63Cde504a05B567C600B78C0b41892) |

## Live transactions

| What | Transaction |
|---|---|
| Deploy Assay | [0xc70abfb4...b42f](https://sepolia.arbiscan.io/tx/0xc70abfb4accd810744c5490efb4af441264ff95abf4cda15fa0905d0e4bfb42f) |
| Register Phala's gateway signer from a fresh TDX quote | [0xaf4218b9...0d59](https://sepolia.arbiscan.io/tx/0xaf4218b965aea5b0086a45f12680920411935548698bbebfbe2f085b3bb80d59) |
| Register Phala's Ed25519 receipt key through its TDX quote (the first `registerReceiptKey` on this deployment) | [0xdff86c7c...ef1f](https://sepolia.arbiscan.io/tx/0xdff86c7c326ffa23738ec12fc9e7a7c3c930453298c28d7ce26322888a13ef1f) |
| Open channel 0, pinned to `meta-llama/llama-3.3-70b-instruct` | [0x61fffc01...bd2](https://sepolia.arbiscan.io/tx/0x61fffc011aeee16cce4a8075f606bb58d6b05038a7b8d6921460a26db5cacbd2) |
| Open channel 1, legacy signature path | [0xb06dae37...2652](https://sepolia.arbiscan.io/tx/0xb06dae3711bce5b151ea7fb6af0b30a94d37186cd00bb4b06cd7e9460bfd2652) |

The agent (`0x2aD1...5DEF`) and the provider (`0x93e8...EE5A`) are separate wallets. `docs/e2e/chiron.md` lists every command and the post-condition read after it.

## Security evidence

- Four review rounds (`SECURITY-REVIEW.md`, `docs/security/assay-usdg-review.md`). The last two reviewed the deployed code; each of their findings came with a test that failed before the fix. The final verdict before deploying was DEPLOY.
- Fixed in those rounds: a pinned channel could be paid through the model-blind path; an out-of-window block reference made the registration nonce predictable; one receipt could back payments for different requests; an agent's changed EIP-7702 delegation could void its vouchers; the receipt verifier accepted forgeries under a small-order Ed25519 key. Each fix was reverted to confirm its test fails, then restored.
- Tests: `forge test` 61 passed, invariant 1 passed, 13 passed in a fork against the real Paxos USDG proxy, `receipt-verifier` 18 passed, `verifier` 22 passed, agent 17 passed.
- The receipt verifier was checked on the live chain against receipts generated by its own Rust tests: an honest receipt returns matching model hashes, a model-swap receipt returns a different served-model hash, and a tampered signature returns false.
- Paxos can pause, freeze and wipe USDG. The fork suite pins what that does to a channel, and the contract adds no escape hatch that would let a frozen address route funds around a freeze.

## Team

Built by pranjalcodesinw3, AI-assisted.
