# Signet

**AI trading agents whose track record is provable and whose strategy stays private, on Robinhood Chain.**

| | |
|---|---|
| Network | Robinhood Chain testnet, chain 46630 |
| App | [chiron-receipts.vercel.app](https://chiron-receipts.vercel.app): the leaderboard of attested agents, each row re-reading its trades from the chain and recomputing every receipt hash in the browser; no wallet needed |
| Attested trade | [`0x0023f359...3b03`](https://explorer.testnet.chain.robinhood.com/tx/0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03), block 127,188,951: the TDX-attested agent buys TSLA with 1 Paxos USDG, and `TradeExecuted` records the agent's workload measurement and the model hash |
| Refusal | [`0xf98156ad...fcc8`](https://explorer.testnet.chain.robinhood.com/tx/0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8), block 127,632,496: a genuine Intel TDX quote from a different workload reverts `MeasurementNotApproved` after 2,349,054 gas of onchain verification |
| Follower account | [`0xFaaAa4d1...3b55`](https://explorer.testnet.chain.robinhood.com/address/0xFaaAa4d1ee944d317b10233505D8c57425C53b55): holds USDG, trades only through the canonical Uniswap v4 PoolManager, admits one agent key |
| Agents | `claude mcp add --transport http signet https://chiron-receipts.vercel.app/mcp` |
| Deck and canvases | [Signet-Deck.pdf](deck/Signet-Deck.pdf), [Product canvas](deck/canvas/Signet-Product-Canvas.pdf), [GTM canvas](deck/canvas/Signet-GTM-Canvas.pdf), [deck/index.html](deck/index.html) |
| Repo | [github.com/pranjalcodesinw3/chiron](https://github.com/pranjalcodesinw3/chiron) |

## Verify it in 60 seconds

1. **0 to 15 s.** Open the [app](https://chiron-receipts.vercel.app). Each agent on the leaderboard is a TDX workload measurement with its trades linked beside it, and its chain check turns green only when every receipt hash recomputed in your browser matches the chain.
2. **15 to 30 s.** Open the [attested trade](https://explorer.testnet.chain.robinhood.com/tx/0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03), Logs tab. `TradeExecuted` carries `agentMeasurement` and `servedModelHash`. That pair names the workload the account admitted and the model behind the inference receipt the account verified.
3. **30 to 45 s.** Open the [refusal](https://explorer.testnet.chain.robinhood.com/tx/0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8). The status is failed and the error is `MeasurementNotApproved(0xfd34...0149)`. The hardware is genuine Intel TDX and the workload is not the one the account owner approved, so the chain turns it away.
4. **45 to 60 s.** Run the MCP line from the table and ask your agent to call `verify_receipt` on the attested trade. It answers `verified: true` with seven checks. Give it a different expected model hash and it answers `verified: false`.

## What Signet is

A trading agent is only as good as the claim that it made its own record. Today that claim is a screenshot. Signet replaces it with a chain read.

- **Creators run the agent in an Intel TDX confidential VM.** The agent generates its trading key inside the enclave and the decision loop runs there; the CVM serves a quote and no signing endpoint. The strategy text arrives as sealed config, and the measured compose pins its SHA-256: the CVM refuses to boot on a byte that does not hash to the pin, so a changed strategy is a changed compose hash.
- **Every trade names its code.** A Stylus contract on Robinhood Chain parses the enclave's quote chain to Intel's root, and the account stores the agent key only if the quote's workload measurement is one the account owner approved. Each `TradeExecuted` records that measurement, the served model hash, and the hashes of the request and response behind the trade. A track record is the list of trades that name one workload. Each boot has a measurement of its own (the instance id is in RTMR3), so the stable identity of a strategy is its compose hash: the leaderboard groups boots by compose hash, and new code is a new compose hash with an empty record.
- **Followers let that code, and only that code, trade their Stock Tokens.** A follower owns an `AgentAccount`. Following approves the creator's measurement on their own account and unapproves every other one first, so exactly one workload is approved (`agent/src/follow.ts` and the Follow panel, tested on an anvil fork of the live account). Funds never leave the account: the account swaps through the canonical Uniswap v4 PoolManager and settles by balance delta.
- **Limits are the safety net underneath.** A per-trade cap, a rolling 24-hour cap, an approval threshold above which a trade waits for the owner, a pool allowlist and an ERC-8056 corporate-action guard are enforced by the account in the same transaction as the swap. Unapproving a measurement revokes the agent in the same transaction.

Public: the measurement, the compose hash, the model hashes, the trades and the SHA-256 of each request and response body. Sealed: the strategy text, which the chain only ever sees as its digest.

## What a signed code identity changes

| Today | With Signet |
|---|---|
| A PnL screenshot or a wallet link proves a balance, not who made it | Every trade names the measurement the agent was admitted under and the model of its verified inference receipt |
| The creator can change the strategy and keep the name | A changed strategy is a changed compose hash: a new agent with its own record |
| Proving the record means publishing the strategy | The record is public and the strategy text is committed by its digest |
| A copier trusts a platform's displayed returns | A follower's own account refuses every workload they did not approve |
| Limits cap the loss and say nothing about whose code is trading | Limits cap the loss and the measurement names who is trading |

Robinhood Agents gives a customer limits and approvals and states that Robinhood does not audit the agents ([Robinhood newsroom, 2026-09-29](https://robinhood.com/us/en/newsroom/hood-summit-2026/)). The same page reports over 150,000 customers with agentic trading accounts and agents using Robinhood's tools almost 30 million times a day. Signet answers the question those accounts leave open: which code is this?

## How the proof is built

1. The owner approves a workload measurement on their account (`setMeasurement`) and sets caps (`setLimits`), pools (`setPool`) and a model pin (`setModel`).
2. Anyone submits `registerAgent(quote, refBlock)`. The nonce the quote must commit to is derived from the chain id, the account, the agent epoch and a block hash from the last 256 L2 blocks, so a quote cannot be banked in advance.
3. The Stylus `Verifier` checks the PCK certificate chain, the quote-enclave report and the quote signature against Intel's root, rejects the TDX DEBUG attribute, and returns the agent address and a measurement over nine TD report fields. The account stores the agent only if that measurement is approved. A registration lasts 24 hours and a keeper renews it from a fresh quote.
4. The agent calls `execute(trade, receipt)`. The account checks the caller, the caps, the pool and an inference receipt (an Ed25519-signed Phala gateway receipt verified by the Stylus `ReceiptVerifier`) whose served model is in the owner's accepted set, then swaps.
5. `TradeExecuted` records `agentMeasurement`, `servedModelHash`, `requestHash`, `responseHash` and the trade amounts. The leaderboard and the MCP server read exactly these events.

Strategy commitment, live: the CVM `signet-demo-tsla-prod` boots with `STRATEGY_SHA256 3723fda7...0db26` in its measured compose (compose hash `9f997c38...2606`), and its quote was admitted on the live account by the Stylus Verifier: owner approval [`0x749003ce...7b8b`](https://explorer.testnet.chain.robinhood.com/tx/0x749003ce338eed7782f37dad1ad6528f9cebf74ff80a0c15da8a47c7e6717b8b), registration [`0x5fdc4acb...965c`](https://explorer.testnet.chain.robinhood.com/tx/0x5fdc4acb64d8f1dddc9042c9101c652f87f7483cc1163d0c878b431c44ce965c). `agent-cvm/deployments/2026-10-24.json` holds the image digest and the reads. The digest recomputes from `agent/strategies/demo-tsla.json` with `openssl dgst -sha256`.

## Why Stylus on Robinhood Chain

Admitting a key means walking an X.509 and P-256 certificate chain to Intel's root, which is heavy cryptography. The Stylus `Verifier` runs it inside the admitting transaction, so anyone can repeat the check by replaying one transaction instead of trusting a service. Measured on chain 46630 with `cast receipt` on 2026-10-24: the admitting `registerAgent` [`0x1f15df28...8134`](https://explorer.testnet.chain.robinhood.com/tx/0x1f15df28041e7b8938ca6653eb5a75231f525568ab015644ec535796caa68134) used 2,584,842 gas (block 127,176,129), the refusal 2,349,054 gas (block 127,632,496), and the attested trade 504,449 gas. The registration nonce binds the chain id, the account, the agent epoch and an ArbSys block hash, and the account swaps through the chain's canonical Uniswap v4 PoolManager on the official TSLA Stock Token.

The contract-level description, every live transaction with its read-back, gas figures and the security review are in [docs/ENGINEERING.md](docs/ENGINEERING.md).

## What exists

| Piece | Where | What it does |
|---|---|---|
| `AgentAccount`, `AgentAccountFactory` | `contracts/src/` | The follower's account: attested agent admission, caps, approvals, swaps through Uniswap v4, receipt-checked trades |
| `Verifier`, `ReceiptVerifier` | `verifier/`, `receipt-verifier/` | Stylus (Rust): the Intel TDX DCAP quote chain and the Ed25519 inference receipt, verified in the transaction that uses them |
| Reference agent | `agent/`, `agent-cvm/` | A trading agent in a Phala Cloud TDX CVM: it generates its key in memory, serves quotes per account, runs the decision loop and signs its trades inside, and boots only on a strategy whose SHA-256 matches the measured compose |
| Assay | `contracts/src/Assay.sol` | Pay-per-call USDG channel that settles inference only against a receipt naming the pinned model |
| MCP server | `mcp/` | `verify_receipt`, `account_state`, `explain_refusal` over viem, and `get_track_record(measurement)`: every trade of one TDX workload with the Chainlink round that priced it, its PnL and return, attestations and refusals; hosted at `/mcp` |
| Web app | `web/` | The Signet leaderboard, agent profile with receipt timeline, follow flow, creator page, and the account gate log |

Deployed on Robinhood Chain testnet (46630):

| Contract | Address |
|---|---|
| AgentAccount (app default, Paxos USDG, corporate-action guard) | [`0xFaaAa4d1ee944d317b10233505D8c57425C53b55`](https://explorer.testnet.chain.robinhood.com/address/0xFaaAa4d1ee944d317b10233505D8c57425C53b55) |
| AgentAccount (first account, where the attested trades ran) | [`0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D`](https://explorer.testnet.chain.robinhood.com/address/0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D) |
| AgentAccountFactory | [`0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e`](https://explorer.testnet.chain.robinhood.com/address/0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e) |
| Verifier (Stylus, TDX quote) | [`0x3c19C10E5C9a82D01ED79E5c6026D73B9b2CAF8c`](https://explorer.testnet.chain.robinhood.com/address/0x3c19C10E5C9a82D01ED79E5c6026D73B9b2CAF8c) |
| ReceiptVerifier (Stylus, Ed25519) | [`0x9AF7D9C3B27c4A8a11Fb879041B931C38B712380`](https://explorer.testnet.chain.robinhood.com/address/0x9AF7D9C3B27c4A8a11Fb879041B931C38B712380) |
| TSLA Stock Token (Robinhood official) | [`0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E`](https://explorer.testnet.chain.robinhood.com/address/0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E) |
| Uniswap v4 PoolManager (canonical, code hash equal to mainnet) | [`0x8366a39CC670B4001A1121B8F6A443A643e40951`](https://explorer.testnet.chain.robinhood.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951) |

`contracts/deployments/46630.json` holds every deployment transaction hash.

## Business model

- **Creator performance fee.** A creator earns a share of the profit a follower's account makes through their code, above the follower's high-water mark, so the creator is paid only for new profit. Signet takes a share of that fee.
- **Follower subscription.** A follower pays a flat monthly fee for an admitted agent. Signet takes a share of that fee.

The account contracts enforce the code, the model and the limits. Fees are the business model between creator and follower, settled as a transfer the follower's owner signs.

## Run it

```
make test                          # pinned libs, every Foundry profile, then the whole forge suite
cd mcp && npm install && npm test
cd web && npm install && npm run dev
```

## Verification

| Check | Result | Source |
|---|---|---|
| `forge test -j 1` on the integrated tree (25 suites, fork tests against live testnet state included) | 351 passed, 0 failed, 0 skipped | `docs/test-logs/forge-test-signet-2026-10-24.log` |
| Mutation runner, one `AgentAccount` guard removed or weakened at a time | 122 of 123 killed, the remaining mutant is behavior-equivalent and documented | `docs/security/agent-account-mutations.md` |
| Stylus crates, `cargo test --release` | verifier 67 passed, receipt-verifier 18 passed | `verifier/`, `receipt-verifier/` |
| Agent, MCP and web suites | agent 51 passed, mcp 22 passed, web 85 passed | `npm test` in each |
| Attested trade `0x0023f359...3b03` | status success, block 127,188,951, 504,449 gas | `cast receipt`, 2026-10-24 |
| Refusal `0xf98156ad...fcc8` | status failed, block 127,632,496, 2,349,054 gas | `cast receipt`, 2026-10-24 |

## Team

Built by pranjalcodesinw3 and aarav1656.
