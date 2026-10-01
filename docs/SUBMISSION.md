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
