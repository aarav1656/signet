# Signet: Demo Day pitch script

Three minutes, about 500 words: read at 165 words a minute, or drop the Competition beat for a calmer pace. Each beat names the slide it sits on.

## Script

**Title (0:00 to 0:08)**
"Signet. AI trading agents whose track record you can verify, and whose strategy stays private. Built on Robinhood Chain."

**Robinhood Agents launch (0:08 to 0:18)**
"Last month Robinhood launched Agents. More than 150,000 customers already run agentic accounts. That is real money, traded by code."

**The no-audit line (0:18 to 0:30)**
"This is Robinhood's own launch page: 'Robinhood does not control, supervise, monitor, recommend, or audit agents.' You get limits and approvals. Which code is trading your money? Nobody checks."

**Creator posts (0:30 to 0:48)**
"So people choose agents from posts like these. Someone checked 22 viral AI trading bot posts. Not one gave a wallet you could check. The creator is stuck too: the only way to prove a strategy is to publish it, and then it is gone."

**Architecture (0:48 to 1:18)**
"Signet fixes both sides. The creator's agent runs inside an Intel TDX enclave on Phala. The strategy is sealed config, and its hash is pinned in the measured image, so the enclave will not boot on any other strategy. Its quote goes to a Stylus verifier on Robinhood Chain that walks Intel's certificate chain onchain, in Rust. The follower's account admits exactly one measurement, trades only through the canonical Uniswap v4 pool manager, and every trade emits a receipt naming the measurement and the model."

**Live trade and refusal (1:18 to 1:40)**
"This is live on Robinhood Chain testnet. An admitted agent bought TSLA with USDG, and the event carries its enclave measurement and the model hash from its verified inference receipt. Next, a genuine TDX quote from code the follower never approved. The chain refused it: MeasurementNotApproved. Same hardware, different code, no access."

**Leaderboard (1:40 to 1:52)**
"The leaderboard re-reads every trade from the chain. A record belongs to a measurement, so changing the code starts the record at zero. Other agents read it through our MCP server."

**Private strategy, public proof (1:52 to 2:02)**
"The strategy stays private and the proof is public. An enclave pinned to its strategy hash is already admitted on the live account."

**Tests (2:02 to 2:14)**
"The follower's account holds the money, so it carries the tests: 341 forge tests with fuzz and invariants, and a mutation run that deletes the account's guards one at a time. 122 of 123 are caught; the last is equivalent behavior."

**Business model (2:14 to 2:26)**
"Two fees. Creators earn a performance fee on new profit above the follower's high-water mark, followers pay a flat subscription, and Signet takes a share of each. Hyperliquid alone lists 9,478 vaults holding over 405 million dollars, and none of them can say which code trades."

**Competition (2:26 to 2:36)**
"Arcana proves a record was not edited. Hyperliquid proves the PnL. Robinhood Agents gives limits. Phala proves a workload ran in a TEE. Signet builds on Phala and proves the code behind every trade."

**Go to market (2:36 to 2:46)**
"We start with people we can name: Arcana's Season 2 board, 40 creators and 51 agents trading US equities on Robinhood Chain. One message, TSLA receipt attached: your next record can be a measurement, not a screenshot."

**Ask (2:46 to 3:00)**
"Our ask: an introduction to Robinhood Chain partnerships, and five creators ready to run their agent in an enclave. Milestone funding takes us to mainnet with five creators and a measurement on every trade. A record you can verify. A strategy you keep."

## 30-second version

"Robinhood just gave 150,000 customers agentic accounts, and its own page says it does not audit the agents. Signet runs a creator's trading agent in an Intel TDX enclave with the strategy sealed and pinned by hash. A Stylus verifier on Robinhood Chain checks the enclave quote against Intel's root, and the follower's account trades only for the one measurement it approved. Every trade names its code. A record you can verify, a strategy you keep."

## Sources for every figure

| Figure | Source |
|---|---|
| 150,000+ agentic accounts; "does not control, supervise, monitor, recommend, or audit agents" | Robinhood newsroom, 2026-09-29 |
| 0 of 22 viral posts with a checkable wallet | `gtm/signals.md` |
| Attested trade | tx `0x0023f359...0e3b03`, Robinhood Chain testnet, block 127,188,951 |
| Refusal, MeasurementNotApproved | tx `0xf98156ad...e2fcc8`, block 127,632,496 |
| Strategy-pinned enclave admitted | tx `0x5fdc4acb...ce965c`, block 141,688,284 |
| 341 forge tests | `forge test` in `contracts/`, 2026-10-24 |
| 122 of 123 mutants caught | `contracts/test/mutation/` |
| 9,478 vaults, 405 million dollars | `gtm/COMPETITORS.md` |
| 40 creators, 51 agents | Arcana Season 2 board, `gtm/USERS.md` |
