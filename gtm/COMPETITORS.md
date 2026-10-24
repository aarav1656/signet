# COMPETITORS: verifiable-performance and TEE agents, copy trading

Read on 2026-10-24. Primary reads (API, on-chain, product page) are marked READ. Items that only an engine reported are marked ENGINE and name the engine. Where no usage number was found, the row says so.

The question for each: what does it prove about (a) who or what traded, (b) what the track record is, and (c) that the strategy stays private?

## Summary matrix

| Product | Proves who traded (code identity) | Proves the track record | Strategy private | Robinhood Chain Stock Tokens |
|---|---|---|---|---|
| ARCANA | No. Platform runs the decision engine and holds custodial keys | Platform-recorded decisions, hash-committed, Merkle root anchored on chain 4663 every 15 min | Yes, from the public. Plaintext prompt sits with the platform | Yes (Season 2 US Equities) |
| Hyperliquid vaults | No | Yes, on-chain PnL and TVL | Yes (off-chain bot) | No |
| Virtuals arenas and ACP | No | Platform leaderboard on Hyperliquid fills | Partly | Tokenized equities on Hyperliquid, not the chain |
| Phala dstack, Oasis ROFL, Automata, Marlin | Yes, for the workload they host | Not a trading product | Yes | No product |
| Knidos | ZK proof of "approved exchange and parameters" | ZK-verified trade batches (testnet) | Yes | No |
| Agentics.credit | No | Score from paper plus on-chain trades | n/a | No |
| Olas | Agent multisig activity | Not trading PnL | n/a | Listed network (Mech Marketplace) and a Connect product |
| Giza | Smart-wallet agents | TVL, not a PnL proof | Partly | No |
| eToro, Bybit copy trading | No | Platform-reported, custodial | Lead's choice | No |
| Robinhood Agents | No: limits and approvals, no audit | Account P&L in the app | n/a | Not the chain |
| **Signet** | **Yes: every TradeExecuted names the TDX measurement and model hash; the account refuses any other workload** | **Receipts bound to that code, read from the chain** | **Yes: prompts stay inside the CVM** | **Yes (46630 live; 4663 target)** |

## 1. Closest competitor: ARCANA (Robinhood Chain, mainnet 4663)

- Pitch (their docs, READ [/docs/private-agents](https://arcana-arena.com/docs/private-agents)): "PRIVATE AGENT. PUBLIC PROOF. Protect the intelligence. Prove the performance." Same promise as Signet.
- Usage (READ [arcana-arena.com](https://arcana-arena.com/), 2026-10-24 01:13Z, block 95,182,673): 51 agents, 16 active, 40 creators, 680 settled trades (218 blocked, 4 reverted), 4,756.69 USDG settled volume, 269,778 decisions, 0 trades "today". X: [@Arcana_Arena](https://x.com/Arcana_Arena), 236 followers.
- What it proves: at the moment of each decision the engine writes a manifest (fields, rationale, model and version, parameters, prompt fingerprints, salt, previous commitment), stores sha256 of it, and every 15 minutes writes a Merkle root into a transaction on Robinhood Chain (marker `415243414e410001`). Altering an anchored decision breaks a proof. Anchoring has run since 2026-09-13 (READ [/docs/roadmap](https://arcana-arena.com/docs/roadmap)).
- What it does not prove (their own docs, READ): "A database that refuses to change a sealed row still belongs to whoever runs it." The commitment records what ARCANA's engine says the model and prompt were; nothing attests that the committed model, prompt and code are what ran. Wallets are "custodial", "derived by the signer", and the roadmap states "Keys are file-backed today" ([/docs/roadmap](https://arcana-arena.com/docs/roadmap), [/docs/wallets-and-custody](https://arcana-arena.com/docs/wallets-and-custody)). Inference from their docs: the engine that builds each prompt and calls the model is ARCANA's own code, so the platform handles every private prompt in plaintext. The commitment protects the creator's record from edits; it does not protect the creator's strategy from the platform, and it does not stop the platform or a creator from running different code than the one committed.
- The gap Signet fills: ARCANA's proof is "this record was not edited after the fact". Signet's proof is "this exact code and model made these trades, and the follower's own account refused anyone else". In Signet the follower holds the funds in an `AgentAccount` that admits one agent key, only after the Stylus verifier checks an Intel TDX quote chain and the quote's measurement is one the follower approved (README, contracts/src/AgentAccount.sol). The key lives in the TEE, not in a platform file. ARCANA has no follower-held funds on this model: subscriptions trade from a wallet "derived for that subscription" by the platform.

## 2. Public-PnL venues (proof of the number, not of the code)

| Venue | Usage (READ unless marked) | Proves | Does not prove |
|---|---|---|---|
| Hyperliquid vaults | 9,478 vaults, $405,600,393 summed TVL, 77 vaults over $100k TVL (`stats-data.hyperliquid.xyz/Mainnet/vaults`, 2026-10-24). Example Growi HF: $13,394,080.75 value, all-time PnL +$2,939,277.13, created 2024-07-10 (`api.hyperliquid.xyz/info` `vaultDetails`) | Deposits, fills, PnL are on-chain | Which code or model trades; a vault leader can change bot, model or manual-trade at any time without the record showing it |
| Virtuals arenas and ACP | ACP "onboarded over 2,000 agents" ([os.virtuals.io/acp/overview](https://os.virtuals.io/acp/overview)); weekly Hyperliquid perps and ecosystem arenas where "Top 10 agents in each lane get copy-traded by Virtuals every week" ([article 2026-06-09](https://x.com/virtuals_io/article/2064239913365897280)); [@virtuals_io](https://x.com/virtuals_io) 292,355 followers. degen.virtuals.io was a Railway 404 on 2026-10-24 | Fills on a leaderboard | Code identity; agents are LLM sessions with user wallets |
| BotOrNot | [getbotornot.com/proven-returns](https://getbotornot.com/proven-returns/) lists Hyperliquid vaults whose description says bot, quant or AI | Real on-chain PnL | The "AI" label is self-described (their page says so for descriptions) |
| ClawStreet | [clawstreet.io/leaderboard](https://www.clawstreet.io/leaderboard) | Ranked returns, equity curves, fills. ENGINE: chatgpt says paper capital and simulated execution; the page text read does not confirm that either way | Real capital, if paper as reported |
| QuantX | [quantx.trade/live-positions](https://quantx.trade/live-positions) | "Virtual strategy positions" | Real trades; 0 active positions on 2026-10-24 |

## 3. TEE and attestation infrastructure (identity, no performance)

| Project | Usage | Proves | Does not prove |
|---|---|---|---|
| Phala dstack and Trust Center | 2025 report: 10,004 total users, 398 paid users, 2,529 CVMs, 813 running ([phala.com/zh/posts/phala-2025-report](https://phala.com/zh/posts/phala-2025-report), READ); [@PhalaNetwork](https://x.com/PhalaNetwork) 140,930 followers | A workload ran in a TDX CVM with a given measurement | That any workload is a trader, or what it earned. Chiron already builds on Phala: the receipt gateway Signet's `ReceiptVerifier` checks is Phala's |
| Oasis ROFL | docs.oasis.io/rofl (ENGINE: chatgpt); no trading-agent count found | Attested app, on-chain authenticated | Trading results, a follower-side enforcement contract |
| Automata, Marlin Oyster, Flashbots | no trading-agent usage found (ENGINE: chatgpt) | Attestation verification, confidential compute, private ordering | Trading results |

These are suppliers to Signet, not rivals. None ships the account that refuses unattested trades.

## 4. Adjacent "verifiable agent" products

| Product | Usage | Proves | Gap versus Signet |
|---|---|---|---|
| Knidos ([knidos.xyz](https://www.knidos.xyz/), READ) | Testnet, waitlist. [@knidosxyz](https://x.com/knidosxyz) 23,013 followers. Uses Noir, zkVerify, 0G; "audited by Nethermind" per site | ZK proofs that "each trade batch is proven to have occurred on approved exchanges and within predefined parameters" | Proves rule-compliance of the trades, not which code or model made the decisions; Knidos runs one house AI, no third-party creators; no Robinhood Chain |
| Agentics.credit ([agentics.credit](https://agentics.credit/), READ) | Waitlist; [@agenticscredit](https://x.com/agenticscredit) 58,833 followers | A 300 to 850 score from paper plus on-chain trades; qualifiers get constrained credit | Score built on platform-run paper trades; no code identity; no follower funds |
| Primus / binance-verifiable-skills | [@primus_labs](https://x.com/primus_labs) 85,077 followers; [@StratAlchemy](https://x.com/StratAlchemy/status/2113270408497741865) (1,460 followers, 2026-10-22) says binance-verifiable-skills lets a bot prove "its CEX execution history onchain without revealing the strategy" (post only; repo not found by `gh search repos`, not opened) | zkTLS proof of exchange-side history | A proof that history exists, not that the exact code made it; no onchain enforcement |
| Amadeus ([@ama_protocol](https://x.com/ama_protocol)) | 133,717 followers; "Confidential uPoW L1 for agentic finance" (X bio, linktree READ) | Self-described confidential L1; Robinhood listed in the bio | No trading-track-record product found in this research |
| Olas | READ [olas.network](https://olas.network/) 2026-10-24 00:00 UTC: 20,949,949 total agent transactions, 14,854,039 agent-to-agent transactions across 7 chains including Robinhood, 448 daily active agents, $110,234.94 Mech marketplace turnover | Agent activity and marketplace payments | Not trading PnL; USDG fees counted on Robinhood Chain; a "Connect" banner offers Stock Token trading from a coding agent |
| Giza | READ DefiLlama via `cdata --json llama tvl giza` at 2026-10-24T01:13:20Z: TVL $12,798.53 on 4 chains (all-time high $45.61M on 2026-01-20 per ENGINE: chatgpt citing DefiLlama) | Smart-wallet balances | TVL is not performance; steep decline from peak |
| Hey Anon | [@HeyAnonai](https://x.com/HeyAnonai) 48,355 followers; X bio and [arp.heyanon.ai](https://arp.heyanon.ai/) READ: "AI Agent Launchpad on Robinhood", agent-to-agent hiring and escrow | Escrowed agent jobs | Not a trading track record |
| Ritual | [@ritualnet](https://x.com/ritualnet) 62,487 followers; no trading-agent usage found | AI compute infrastructure | Not a trading product |
| Meridian402 | READ repo: market-making agent on Robinhood Chain, 4 stars | Public positions and swaps | One operator, no attested identity |

## 5. Copy trading (platform-reported records)

| Platform | Usage | Proves | Does not prove |
|---|---|---|---|
| eToro CopyTrader | Over 5,000 Pro Investors on 2026-02-11 (ENGINE: chatgpt citing eToro investor presentation, not opened); no platform-wide copier total found | A custodial platform's record for a lead | Who or what trades for the lead; follower fills differ from the lead's |
| Bybit Copy Trading | No aggregate copy-trading figure found in Bybit pages (ENGINE: chatgpt) | Platform-displayed returns | Same; a poster says leads may earn from the trades they generate (signals.md row 9, a general claim, not Bybit-specific) |
| Alpha Arena (nof1) | [nof1.ai](https://nof1.ai/) READ; [@the_nof1](https://x.com/the_nof1) 54,390 followers | LLMs' results in a benchmark run by one operator | A follower-controlled account; creator-submitted agents |
| Coinpilot | [@trycoinpilot](https://x.com/trycoinpilot) 6,479 followers, copy trading across Hyperliquid, Polymarket, pump.fun | Platform copy results | Code identity |

## 6. The distribution benchmark: Robinhood Agents

READ (README, Robinhood newsroom 2026-09-29): 150,000+ agentic accounts and about 30 million tool uses per day; limits, approvals on by default, and the page states "Robinhood does not control, supervise, monitor, recommend, or audit agents." A user can run any agent against it. Nothing in Robinhood Agents says which model or code a given agent is, or lets a follower trust a creator's agent by measurement. This is the account shape Signet is not competing with: Signet answers the question the page leaves to the user.

## 7. The exact gap

No product found combines all four:
1. The executing key is admitted by hardware attestation (Intel TDX), checked on chain.
2. The follower's own account enforces a measurement allowlist, so a different workload is refused (`MeasurementNotApproved`).
3. Every trade's receipt records the workload measurement and model hash, so a track record is tied to exact code.
4. The strategy stays inside the CVM; the public record carries hashes, not prompts.

ARCANA covers (4) from the public but not from the platform, and has none of (1) to (3). Phala, Oasis, Automata cover (1) and stop before trading. Hyperliquid vaults cover the PnL and none of (1) to (4). Knidos covers rule-compliance with ZK and has no creators or Robinhood Chain.

## Method and blind spots

- Engines: `chatgpt ask` (competitor survey, creators, copy-trading figures), `grokweb ask -m grok-4 -d` (X-side claims), `cdata --json llama tvl` (Giza), direct API reads (Hyperliquid), `curl r.jina.ai` page reads. `treg call treg.web.search` failed with HTTP 401 and is not used.
- Not read: Oasis, Automata, Marlin, ClawStreet internals, Bybit and eToro pages, binance-verifiable-skills repo, Knidos whitepaper. Those rows rest on one engine or on a landing page.
- ARCANA's read is a point-in-time snapshot of a fast-moving product; its roadmap may close the custody and attestation gap. A TEE would not remove the platform seeing prompts unless the engine itself moved into one.
- The Signet rows restate the product brief and the repo README (TDX-admitted key, measurement allowlist, measurement and model hash in `TradeExecuted`). The sealed-prompt claim depends on the agent-cvm work and was not re-verified in this research lane.
- "No product found" is an absence from the searches run, not proof of absence; `gh search repos` and X search were not exhaustive.
