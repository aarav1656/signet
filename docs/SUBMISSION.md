# Chiron

## Tagline

An onchain trading account for AI agents that trades only for a key attestation put there

## Description

Chiron is attested trading accounts for AI agents on Robinhood Chain. An `AgentAccount` holds USDG and Stock Tokens and trades only through the canonical Uniswap v4 PoolManager. Its one trading caller is an agent key admitted by Intel TDX attestation: a Stylus contract parses the quote's certificate chain to Intel's root onchain, and the account accepts the key only when the quote's workload measurement is one the owner approved. Trades stay inside per-token caps the owner set. A trade above the owner's approval threshold becomes a proposal that only the owner can execute, as exactly the trade proposed. Every trade's event carries the agent's workload measurement and the verified inference receipt for the model that informed it, and the agent's inference is billed from the same account through Assay, a pay-per-call USDG channel.

## Problem

Robinhood announced Robinhood Agents at HOOD Summit on 2026-09-29: a dedicated agentic account, trade approvals that default to on, limits the user sets, and Loops "coming soon", for eligible U.S. customers ([newsroom](https://robinhood.com/us/en/newsroom/hood-summit-2026/)). The same page states that "Robinhood does not control, supervise, monitor, recommend, or audit agents." The user chooses the model and trusts the agent software to be what it says.

An agent that trades Stock Tokens onchain needs the same controls, enforced by the account instead of promised by an interface, plus an answer to the question the account can ask only through hardware: which software holds this key. A spend-limit contract checks the signature and the rules. It does not check what produced the signature.

## How it works

**Admit.** The owner approves a workload measurement. Anyone submits `registerAgent(quote, refBlock)`. The quote must carry `agent address || 12 zero bytes || nonce` with `nonce = keccak256(chainid, account, agentEpoch, arbBlockHash(refBlock))`; ArbSys answers only for the last 256 blocks, so a quote cannot be fetched early and saved. The Stylus `Verifier` checks the PCK certificate chain, the QE report and the quote signature, rejects the DEBUG attribute, and returns the signer and a measurement over nine TD report fields. The account stores the key only when the measurement is approved. Quotes are single use, each registration bumps an epoch that invalidates quotes in flight, registrations last 24 hours, and unapproving the measurement revokes the agent immediately.

**Trade.** The agent supplies a typed `Trade` (pool key, direction, `amountIn`, `minOut`, deadline), never calldata. The account checks the agent, the pool and token allowlists, the per-trade cap, the approval threshold and a rolling 24-hour cap per token, then does the swap itself through the PoolManager and settles by balance delta: it reverts if more than `amountIn` left or less than `minOut` arrived.

**Approve.** Above the threshold, `execute` reverts `NeedsApproval`. The agent calls `propose`; the owner's `approveTrade(id, trade)` runs exactly the proposed trade, once, before it expires.

**Record.** Each `TradeExecuted` event carries the TDX workload measurement the agent was admitted under, the served-model hash, and the request and response hashes of the receipt behind the trade. The receipt is verified by the Stylus `ReceiptVerifier` (Ed25519), must name the model the owner pinned, must come from a gateway key registered under the owner's pinned measurement, and can be used once.

**Bill.** The account opens an Assay channel as its own agent. Vouchers signed by the agent key validate through the account's ERC-1271 check, scoped to that channel's voucher digest. The provider is paid by `redeemWithReceipt` only against a receipt naming the pinned model.

## What is new here

- **The account checks the software, not only the signature.** The TDX quote is verified onchain, in Stylus, in the transaction that admits the key. A TEE or TDX attestation verifier appears in none of the 116 Arbitrum Open House Singapore projects read from HackQuest's API on 2026-10-01 (the closest agent-safety project validates trades against a mandate and has no execution path).
- **Caps, approvals and the workload record sit in one transaction with the swap.** The owner's limits are enforced by the account's own code at the moment of the trade, and the event records which attested workload and which verified model receipt produced it.
- **Inference spend is part of the account.** The same account that trades pays for the model that decided to trade, through a channel that pays only when a TEE-signed receipt names the pinned model.
- **Mutation-tested guards.** `contracts/test/mutation/agent_account_mutations.py` removes or weakens 110 guards one at a time; the suites go red for 109 of them, and the remaining mutant is documented as behavior-equivalent against the real Assay.

## Stack

- Robinhood Chain testnet (46630), canonical Uniswap v4 PoolManager and PositionManager, official TSLA Stock Token
- Arbitrum Stylus (Rust, `stylus-sdk`) for the TDX quote verifier and the Ed25519 receipt verifier
- Solidity 0.8.28, Foundry, OpenZeppelin (Ownable2Step, ReentrancyGuardTransient, ECDSA, ERC-1271, SafeERC20)
- Phala Confidential AI gateway and Phala Cloud TDX guests: attestation quotes and Ed25519 receipts
- Agent client: TypeScript, viem, `@noble/curves`; web app: React, Vite, wagmi

## Deploy and live cycle

`contracts/script/rhc/deploy-stylus.sh` deploys the `verifier/` and `receipt-verifier/` crates to RHC testnet and reads each back. `contracts/script/rhc/DeployAgentAccountRHC.s.sol` deploys testUSDG, Assay, the TSLA/testUSDG v4 pool and its liquidity, the factory and an account, configures limits, pool and model pin, funds the account and opens the inference channel, and reverts on any read-back mismatch. The venue's quote asset is `TestUSDG`, a fixture with open minting, and the pool's price is the one the script sets.

The agent client's live-cycle modes each assert a post-condition that only completion can produce:

| Mode | What it asserts |
|---|---|
| `acct-trade` | `TradeExecuted` decoded, account token balance deltas equal the logged amounts, logged `servedModelHash` equals the pinned hash |
| `acct-overcap` | `amountIn = perTrade + 1` reverts `ExceedsPerTradeCap` by `eth_call` and by one real reverted transaction, balances unchanged |
| `acct-approve` | `NeedsApproval`, then a proposal event, then the owner's approval emitting `TradeExecuted` with the proposal id and a balance delta, then a second approval reverting `ProposalNotPending` |

## Evidence

- `forge test`: 292 passed, 0 failed. The `AgentAccount` suites (unit, rolling-window fuzz against an exact reference, drain invariant) are 88 of them; 4 more run against live RHC testnet state through `RHC_FORK_URL`.
- Mutation record: `docs/security/agent-account-mutations.md`, 109 of 110 mutants killed, the restored source green.
- `agent` `npm test`: 23 passed, including the exact 64-byte `report_data` layout the quote must carry and the `Trade` encoding the owner's approval hashes.
- `receipt-verifier` `cargo test`: 18 passed. `verifier` `cargo test`: 22 passed.
- Assay's own record: four review rounds (`SECURITY-REVIEW.md`, `docs/security/assay-usdg-review.md`); each finding came with a test that failed before its fix.

## Deployed on Robinhood Chain testnet (chain 46630)

Deployed 2026-10-01 from `0x2aD12a72362704367e99a344cFf5affDDF7f5DEF`, which owns the account. Every contract below was read back after deployment; `contracts/deployments/46630.json` holds the full record with every transaction hash, and each transaction's `cast receipt` status is success.

| Contract | Address | What it is |
|---|---|---|
| AgentAccount | [`0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D`](https://explorer.testnet.chain.robinhood.com/address/0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D) | The owner's account. Source verified on Blockscout. |
| AgentAccountFactory | [`0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e`](https://explorer.testnet.chain.robinhood.com/address/0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e) | Creates one account per owner. Source verified on Blockscout. |
| Verifier | [`0x3c19C10E5C9a82D01ED79E5c6026D73B9b2CAF8c`](https://explorer.testnet.chain.robinhood.com/address/0x3c19C10E5C9a82D01ED79E5c6026D73B9b2CAF8c) | Stylus (Rust). Verifies an Intel TDX DCAP quote chain, returns the signer and the nine-field measurement. |
| ReceiptVerifier | [`0x9AF7D9C3B27c4A8a11Fb879041B931C38B712380`](https://explorer.testnet.chain.robinhood.com/address/0x9AF7D9C3B27c4A8a11Fb879041B931C38B712380) | Stylus (Rust). Verifies one Ed25519-signed Phala inference receipt. |
| Assay | [`0x2176E7f20654C8747Fa37b3d96E1ACbf7Df55b5D`](https://explorer.testnet.chain.robinhood.com/address/0x2176E7f20654C8747Fa37b3d96E1ACbf7Df55b5D) | The inference payment channel the account bills through. Source verified on Blockscout. |
| TestUSDG | [`0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC`](https://explorer.testnet.chain.robinhood.com/address/0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC) | 6-decimal quote asset for the venue, minted by the deploy script. Source verified on Blockscout. |
| TSLA Stock Token | [`0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E`](https://explorer.testnet.chain.robinhood.com/address/0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E) | Robinhood's official testnet Stock Token. |
| Uniswap v4 PoolManager | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://explorer.testnet.chain.robinhood.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) | Canonical deployment, code hash equal to mainnet. |

| Step | Transactions | Result read back |
|---|---|---|
| Verifier deploy and activation | [`0xf500c6a6...22d8`](https://explorer.testnet.chain.robinhood.com/tx/0xf500c6a6c5b17dde0d2e96d95f7f4d4873af7a78e71e5413396c1ae73c0d22d8), [`0x51206397...c117`](https://explorer.testnet.chain.robinhood.com/tx/0x51206397c65caa23ceabd5397e7ef3c6cb1ce2b69a25713f6af914b8d7cac117) | Stylus program deployed and activated |
| ReceiptVerifier deploy and activation | [`0xb936516b...5b02`](https://explorer.testnet.chain.robinhood.com/tx/0xb936516b05299ec4bba8f9bbbd38e996b109107289647bf6fd8fd53ff9955b02), [`0x062445c2...2d78`](https://explorer.testnet.chain.robinhood.com/tx/0x062445c238af15976d9ff73201026e5b94b6666fabc13ab3c1f1238001da2d78) | Stylus program deployed and activated |
| Deploy script | 18 transactions, first [`0x5c032428...723a`](https://explorer.testnet.chain.robinhood.com/tx/0x5c0324286ef538a446d3614fc178335b5336c2d8e8131121e9033cf2bd88723a), last [`0x49401a8a...84f7`](https://explorer.testnet.chain.robinhood.com/tx/0x49401a8a560deedc1fb0c9f1945102af3c493b5847d9c24d543ccf2d636f84f7), blocks 127033507 to 127033779 | testUSDG, Assay, pool and liquidity, factory, account, limits, pool allowlist, model pin, funding, inference channel 0 (5 testUSDG deposit) |
| Register Phala's gateway signer on this Assay | [`0x58c5a715...1c05`](https://explorer.testnet.chain.robinhood.com/tx/0x58c5a715f26b95c2dd9fff6a845f48cd3761e7f942a6131bbcd54ece65f11c05) | `signers(0x79a5...6b79)` = measurement `0xfd34...0149` |
| Register Phala's Ed25519 receipt key | [`0x31821e0b...432d`](https://explorer.testnet.chain.robinhood.com/tx/0x31821e0bcf0d9f2083516dfd854adb9366636201d51bc0d34e5ee1566076432d) | `receiptSigners(0x110f...aa0a)` = same measurement |
| Owner deposits 10 testUSDG | [`0x34f3650d...58e5`](https://explorer.testnet.chain.robinhood.com/tx/0x34f3650dff287c1c5fea93364be2fac150069a91a11a45724ed4c6fbe31558e5) | account testUSDG 95,000,000 to 105,000,000 |
| Owner deposits 0.0001 TSLA | [`0xb5c82cf6...ec11`](https://explorer.testnet.chain.robinhood.com/tx/0xb5c82cf607b95d465301a02e899613af4f9731a7bf17a8e6adf5c8ced437ec11) | account TSLA balance up by 1e14 |
| Owner sets the testUSDG approval threshold to 3 then back to 2 | [`0x02e1d9f2...21aa`](https://explorer.testnet.chain.robinhood.com/tx/0x02e1d9f29980035b7519a6a8388e702510443f239fe81ab361056e90035221aa), [`0xf37394f3...5a90`](https://explorer.testnet.chain.robinhood.com/tx/0xf37394f3a1cf3332dfa58377e39111c1508f9bcb7f7bc8c933c0b2b1d6175a90) | `limits(testUSDG)` read back as (true, 10e6, 5e6, 3e6), then (true, 10e6, 5e6, 2e6) |
| Owner sets the approval TTL to 1800 s then back to 3600 s | [`0xecea35b9...4e4c`](https://explorer.testnet.chain.robinhood.com/tx/0xecea35b9914a797c3a906e09d14d411cdbd21e832c1b96db422fa50932f34e4c), [`0x6e39dbc8...4ccd`](https://explorer.testnet.chain.robinhood.com/tx/0x6e39dbc8bde12738d4cbf11e38ed0247a590b9930c2283244b49008bdbdb4ccd) | `approvalTtl()` read back after each |
| Owner withdraws 1 testUSDG | [`0xb825cbf6...69ef`](https://explorer.testnet.chain.robinhood.com/tx/0xb825cbf6683bf01d4f80ed84743556100e866a8b8afe16b3154f561b606369ef) | account 105,000,000 to 104,000,000, owner up by 1,000,000 |

Read from the chain on this deployment:

- The Stylus `Verifier` on 46630 verifies a fresh Phala gateway TDX quote: `verify(quote, nonce)` returns signer `0x79A5061efe5A46b0d1F33B11Cf1c5adbEDAe6B79` and measurement `0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149` (2,371,819 gas by `cast estimate`).
- `registerAgent` given a Phala gateway quote bound to the account's own `attestNonce(refBlock)` passes the quote and nonce checks and reverts `MeasurementNotApproved(0xfd34...0149)`, because the owner has not approved that workload. The account admits no agent until the owner approves a measurement and a quote carries it.
- The guards answer on chain: `execute` and `propose` accept only the registered agent (every other caller, the owner included, gets `NotAgent`), `approveTrade` accepts only a pending proposal (`ProposalNotPending`), and `setLimits` keeps the approval threshold at or below the per-trade cap (`BadLimits`).
- Inference channel 0 on Assay lists the account as its agent, the provider wallet `0x93e82363e3481039d2F8Ee3e4b4263B6D141EE5A`, a 5 testUSDG deposit, the gateway measurement above and the model pin `keccak256("phala/qwen3.8-27b-uncensored")`.

## Assay on Arbitrum Sepolia (chain 421614)

Assay is the inference channel an account bills through. It is live on Arbitrum Sepolia against real Paxos USDG with Phala's production gateway keys registered from fresh TDX quotes, and it has paid three real inference calls through `redeemWithReceipt`.

| Contract | Address |
|---|---|
| Assay | [0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC](https://sepolia.arbiscan.io/address/0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC) (Sourcify exact match) |
| Verifier (Stylus) | [0x3c19c10e5c9a82d01ed79e5c6026d73b9b2caf8c](https://sepolia.arbiscan.io/address/0x3c19c10e5c9a82d01ed79e5c6026d73b9b2caf8c) |
| ReceiptVerifier (Stylus) | [0x9af7d9c3b27c4a8a11fb879041b931c38b712380](https://sepolia.arbiscan.io/address/0x9af7d9c3b27c4a8a11fb879041b931c38b712380) |
| USDG (Paxos) | [0xFFC95faa3d63Cde504a05B567C600B78C0b41892](https://sepolia.arbiscan.io/address/0xFFC95faa3d63Cde504a05B567C600B78C0b41892) |
| ChironGate (x402 extension) | [0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e](https://sepolia.arbiscan.io/address/0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e) (Sourcify exact match) |
| x402BatchSettlement | [0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003](https://sepolia.arbiscan.io/address/0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003): the official x402 bytecode, redeployed by us at its canonical CREATE2 address |
| x402 ERC3009DepositCollector | [0x4020806089470a89826cB9fB1f4059150b550004](https://sepolia.arbiscan.io/address/0x4020806089470a89826cB9fB1f4059150b550004): the official x402 bytecode, redeployed by us at its canonical CREATE2 address |

## Live transactions

| What | Transaction |
|---|---|
| Deploy Assay | [0xc70abfb4...b42f](https://sepolia.arbiscan.io/tx/0xc70abfb4accd810744c5490efb4af441264ff95abf4cda15fa0905d0e4bfb42f) |
| Register Phala's gateway signer from a fresh TDX quote | [0xaf4218b9...0d59](https://sepolia.arbiscan.io/tx/0xaf4218b965aea5b0086a45f12680920411935548698bbebfbe2f085b3bb80d59) |
| Register Phala's Ed25519 receipt key through its TDX quote (the first `registerReceiptKey` on this deployment) | [0xdff86c7c...ef1f](https://sepolia.arbiscan.io/tx/0xdff86c7c326ffa23738ec12fc9e7a7c3c930453298c28d7ce26322888a13ef1f) |
| Open channel 0, pinned to `meta-llama/llama-3.3-70b-instruct` | [0x61fffc01...bd2](https://sepolia.arbiscan.io/tx/0x61fffc011aeee16cce4a8075f606bb58d6b05038a7b8d6921460a26db5cacbd2) |
| Open channel 1, legacy signature path | [0xb06dae37...2652](https://sepolia.arbiscan.io/tx/0xb06dae3711bce5b151ea7fb6af0b30a94d37186cd00bb4b06cd7e9460bfd2652) |
| Open channel 2, pinned to `phala/qwen3.8-27b-uncensored` | [0x3ebe01a4...a019](https://sepolia.arbiscan.io/tx/0x3ebe01a4c23a3359599d6ba4c13653b1c5f71649247b02bd7209fe891008a019) |
| Paid call 1, `redeemWithReceipt` against a real Phala receipt | [0x16270367...a55d](https://sepolia.arbiscan.io/tx/0x16270367e3c3e563bd4433d9cb33d9bdf5db84d44fb25fd0f44679aad681a55d) |
| Paid call 2 | [0x4c83cf96...43b7](https://sepolia.arbiscan.io/tx/0x4c83cf961efedc3678c00d18e332aa502ac71e583ec3f5c42f24a1a5589043b7) |
| Paid call 3; channel 2 paid 900000 (0.90 USDG), provider balance 0 to 900000 | [0x4ed9077a...f868](https://sepolia.arbiscan.io/tx/0x4ed9077a367495ddfb1acf4a3bbc54bf4b79b0d9898e4614fbe9148ec12cf868) |
| x402 channel opened with ChironGate as receiver, 1 USDG | [0x2e35e165...d347](https://sepolia.arbiscan.io/tx/0x2e35e16523145ae25f7525321c6ccce71dc005facbb0fbe7806e67c31d89d347) |
| Claim through ChironGate against a real Phala receipt, 0.30 USDG to the provider | [0xbfbd454e...82eb](https://sepolia.arbiscan.io/tx/0xbfbd454e9dff5623677d26b29e402f0390aa1bd53160b0ffa88cb803f60a82eb) |

The agent (`0x2aD1...5DEF`) and the provider (`0x93e8...EE5A`) are separate wallets. `docs/e2e/chiron.md` lists every command and the post-condition read after it.

## Cost per redeem

One `redeemWithReceipt` cost 301,058 gas on the first redeem of channel 2 and 285,057 and 284,888 on the next two (mined transactions above). Vouchers are cumulative, so a provider can settle many calls in one redeem.

## Question for the Arbitrum team

Chiron pays an inference provider in USDG only when Phala's TEE gateway signs a receipt naming the model served. x402's own payment-channel contract, `x402BatchSettlement` (`0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003`, listed in the x402 Foundation's `contracts/evm/README.md`), is deployed on Arbitrum One with 3 transactions to date, all from one address within nine seconds (Blockscout, read 2026-09-29). Would you introduce us to the x402 Foundation's batch-settlement maintainers and to Phala/RedPill, so receipt-gated claims can ship as an x402 extension with Arbitrum as its first live network, and to Virtuals or Olas to route open-weight inference jobs through it?

## Team

Built by pranjalcodesinw3.
