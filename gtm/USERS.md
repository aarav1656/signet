# USERS: first supply side for Signet

Supply side = people who already run an AI or algorithmic trading agent and already publish returns, so they have a track record to prove and a strategy to protect. Follower counts are fxtwitter's on 2026-10-24. "Returns evidence read" says what was opened and read, not what a search engine claimed. A handle that fxtwitter could not resolve, or whose account was suspended, was dropped (@nichxbt: suspended).

## 1. Creators with published returns (off Robinhood Chain)

| # | Handle | Followers | What they run | Published returns | Returns evidence read |
|---|---|---:|---|---|---|
| 1 | [@GrowiHF](https://x.com/GrowiHF) (also [@GrowiFinance](https://x.com/GrowiFinance), 1,612) | 1,592 | Quantitative mean-reversion vault on Hyperliquid | [Hyperliquid vault 0x1e37...8d5e](https://app.hyperliquid.xyz/vaults/0x1e37a337ed460039d1b15bd3bc489de789768d5e) | Hyperliquid `vaultDetails` on 2026-10-24: name "Growi HF", account value $13,394,080.75, all-time PnL +$2,939,277.13, first point 2024-07-10. The PnL is on-chain; the code behind it is not provable (see COMPETITORS.md). |
| 2 | [@DeployFinance](https://x.com/DeployFinance) | 7,285 | Agent "Superstar", directional trader on Hyperliquid | [Post of 2026-10-23](https://x.com/DeployFinance/status/2113642187074195945) | Post text: "We gave an AI $100,000 in its own agentic wallet to trade on Hyperliquid's decentralized perpetuals market [...] for 70 days. Its worst drawdown was 1.2%, and it made money every month." Linked article not opened. |
| 3 | [@senpi_ai](https://x.com/senpi_ai) | 14,741 | Hyperliquid AI trading agents, 114 strategy templates | [senpi.ai/arena](https://senpi.ai/arena) | Page read: strategy templates (Hawk, Hummingbird, Weaver) and a wallet leak-report tool. No per-agent PnL table in the fetched text. |
| 4 | [@betashop](https://x.com/betashop) (Senpi, bio: "building cursor for trading") | 22,573 | Public multi-agent experiments on Hyperliquid | [senpi.ai](https://senpi.ai/) | Bio and site read; experiment claims came from Grok and were not re-read. |
| 5 | [@the_nof1](https://x.com/the_nof1) and founder [@jay_azhang](https://x.com/jay_azhang) | 54,390 and 46,931 | Alpha Arena, frontier LLMs trading live markets | [nof1.ai](https://nof1.ai/), [alphaarena.ai](https://alphaarena.ai/) | nof1.ai read ("AI research lab building new models for financial markets"). alphaarena.ai returned HTTP 429 on 2026-10-24, so season numbers were not read. |
| 6 | [@virtuals_io](https://x.com/virtuals_io) | 292,355 | Agent platform with weekly trading arenas | [Virtuals article of 2026-06-09](https://x.com/virtuals_io/article/2064239913365897280) | Article read: weekly Hyperliquid perps and Virtuals-ecosystem arenas, "Top 10 agents in each lane get copy-traded by Virtuals every week. 50% of profits go to your agent's wallet." degen.virtuals.io returned a Railway 404 on 2026-10-24. |
| 7 | [@quantpilotapp](https://x.com/quantpilotapp) | 3,248 | Agents that build, backtest and deploy Hyperliquid strategies | bio link | Account exists; returns page not read. Lead only. |

## 2. Robinhood Chain operators who run bots on Stock Tokens

No operator below has a PnL record for Stock Token trades that was independently reconstructed in this research. That is the gap Signet's receipts fill. What was read:

| # | Handle | Followers | What they run on Robinhood Chain | Evidence read |
|---|---|---:|---|---|
| 8 | [@Arcana_Arena](https://x.com/Arcana_Arena) | 236 | Agent competition on chain 4663 with a "Season 2 - US Equities (real market)" leaderboard | [arcana-arena.com](https://arcana-arena.com/) read 2026-10-24 01:13Z at block 95,182,673: 51 agents (16 active), 40 creators, 680 settled trades (218 blocked, 4 reverted), 4,756.69 USDG settled volume, 269,778 decisions. Top agents are operator-run (`arcana_labs`). Creators on the leaderboard by platform handle: `headlypark`, `cadivals`, `kizzzz`, `onchain_operator` (X handles not verified). |
| 9 | Meridian402, agent "Merd" (no operator X handle verified) | n/a | Autonomous market making in AAPL, NVDA, TSLA and other tokenized stocks on Uniswap v4 | [github.com/Meridian402/meridian](https://github.com/Meridian402/meridian) (4 stars, last push 2026-09-07) and [meridian402.xyz](https://meridian402.xyz/) read: "Every position and swap is on-chain and public." |
| 10 | [@HarmonicAgents](https://x.com/HarmonicAgents) | 2,502 | Autonomous financial agent that "trades, launches agents and runs compute" (per [@WallStreetAlfa, 197,880 followers, 2026-10-05](https://x.com/WallStreetAlfa/status/2107100997457674695)) | [Post of 2026-10-23](https://x.com/HarmonicAgents/status/2113485183626182928) read: "SPY/WETH did $3.1M in a day, HIMS/SPY $1.2M, AAPL/SPY $847K." |
| 11 | [@itsaikols](https://x.com/itsaikols) | 265 | Marketplace of autonomous trading agents on Robinhood Chain testnet 46630 | [aikols.com](https://www.aikols.com/) read: "Paper-trading records do not represent realised investor returns." |
| 12 | [@Agent_Minimum](https://x.com/Agent_Minimum) | 471 | Agent that buys $1 of a random Stock Token each week | [Post of 2026-10-23](https://x.com/Agent_Minimum/status/2113662630447435813): "195 stock tokens on Robinhood Chain, frozen, sha256 d56d07a5...4873f." |
| 13 | [@OxSimpleFarmer](https://x.com/OxSimpleFarmer) | 28,443 | "Smart LP algos and bots" farming Stock Tokens | [Post of 2026-10-23](https://x.com/OxSimpleFarmer/status/2113651968543494457): "After 45 days live, our volatility farming protocols are consistently delivering 5-15% APY". Claim, no wallet in the post. |
| 14 | [@pxidentities](https://x.com/pxidentities) (OpenCatz) | 4,466 | Multi-agent trading and risk system for the chain | [opencatz.xyz](https://opencatz.xyz/) responds HTTP 200; Stock Token PnL not found. |
| 15 | [@NightDeskUS](https://x.com/NightDeskUS) | 50 | "24/7 equity trading desk of Robinhood Chain", ERC-6551 vaults with ERC-8196 agent policies | [Post of 2026-10-23](https://x.com/NightDeskUS/status/2113534863714492447). Account created 2026-10-10. |

Also on the chain: Olas lists a "Connect" product to "trade Stock Tokens and memecoins from your coding agent on Robinhood Chain" (banner on [olas.network](https://olas.network/), read 2026-10-24), and open source `nirholas/robinhood-chain-trading-bot` (13 stars, pushed 2026-10-20) trades a "Stock Token premium/discount arbitrage" strategy with a BYO-key LLM strategist. The operator's X account is suspended, so no handle is listed.

## 3. Copy-trading communities (the follower side)

| Community | Followers | Why they matter | Evidence |
|---|---:|---|---|
| [@trycoinpilot](https://x.com/trycoinpilot) | 6,479 | Bio: "Copy traders in memecoins, crypto, stocks & prediction markets". Grok reports it copy-trades Alpha Arena's models (not re-read). | fxtwitter bio |
| [@BlockFlow_News](https://x.com/BlockFlow_News) | 4,585 | Publishes wallets of AI models for followers to track. | fxtwitter bio; wallet posts not re-read |
| [@eToro](https://x.com/eToro) | 353,729 | CopyTrader. eToro reports over 5,000 Pro Investors on 2026-02-11 (reported by `chatgpt ask` from eToro's investor presentation; not opened directly). | see COMPETITORS.md |
| [@Bybit_Official](https://x.com/Bybit_Official) | 4,870,316 | Copy Trading with master traders. No aggregate copy-trading figure found. | see COMPETITORS.md |
| fomo app (quoted by [@tatthang](https://x.com/tatthang/status/2110945121776918855), 10,741) | n/a | "90D on the fomo app (375,740 wallets): 95.2% lost money or made <$100". Figure is the poster's, not re-computed. | signals.md row 7 |

## 4. Who to approach first, and what to ask

1. Arcana creators (row 8). They already compete on Robinhood Chain with private prompts and a public record, so the pitch is concrete: the same agent, with the receipts naming a TDX measurement the follower's account enforces. Reach through [@Arcana_Arena](https://x.com/Arcana_Arena).
2. Meridian402 and @HarmonicAgents (rows 9, 10). They trade Stock Tokens from their own wallets with no attested identity.
3. @DeployFinance and @GrowiHF (rows 1, 2). They have 70-day and 27-month records and a strategy they will not open. Ask: run the agent in a TEE and put the measurement on every trade.
4. @senpi_ai, @betashop, @the_nof1 (rows 3 to 5). Run public experiments, so a measurement-named receipt is a new column in a leaderboard they already publish.

## Method and blind spots

- Engines: `grokweb ask -m grok-4 -d` for the account lists, `chatgpt ask` for the Robinhood Chain leads. Every follower count is from fxtwitter, every returns page was opened with `curl r.jina.ai` or an API read, as stated per row.
- Grok and ChatGPT proposed further handles (@ButlerLiquid, @TaXerClaw, @GT_Protocol, @amp_xbt, @ethy_agent, @useOttoAI, @DXRGai, @SuperiorTrade_, @agentrobinrh and others). @ButlerLiquid, @TaXerClaw and @GT_Protocol did not resolve on fxtwitter and were dropped. @agentrobinrh (162 followers) resolves but its site returned HTTP 402 "Deployment Paused". @ethy_agent (6,845), @useOttoAI (2,358), @DXRGai (11,877) and @SuperiorTrade_ (1,304) resolve, but no returns page was read, so they are leads and not listed above. @QuantXTrades (4,750) publishes only "virtual strategy positions" (0 active on 2026-10-24).
- A stock-token trading bot with a verified PnL does not yet exist in this list. Rows 8 to 15 prove that bots trade the chain, not that anyone has a provable record.
- No creator was contacted. Reach and willingness are untested.
