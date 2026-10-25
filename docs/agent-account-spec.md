# Chiron Agent Account: build spec

Status: the design record for `contracts/src/AgentAccount.sol` and `AgentAccountFactory.sol`, deployed on Robinhood Chain testnet (`contracts/deployments/46630.json`). Written 2026-09-30, facts read between 05:02 and 05:27 UTC.

This is the onchain counterpart to Robinhood Agents. An `AgentAccount` contract on Robinhood Chain (RHC) holds USDG and Stock Tokens. It trades only when the caller is an agent key that Chiron's Stylus TDX Verifier admitted against a measurement the owner approved, within caps the owner set. Every trade records the attested workload and the verified inference receipt that produced it, and the agent's inference is paid from the account through Assay.

## 0. Facts resolved first

Each row gives the evidence and the time it was read (UTC, 2026-09-30).

### 0.1 Robinhood Agents: primary source found

Source: Robinhood newsroom, "Robinhood introduces Robinhood Agents, perpetual futures, earnings contracts, and more", https://robinhood.com/us/en/newsroom/hood-summit-2026/, dated 2026-09-29, fetched raw with curl at 05:23. Exact quotes:

- "Tonight, live from HOOD Summit 2026 at the George R. Brown Convention Center in Houston, ... We announced Robinhood Agents, a fully embedded AI experience that can analyze the market, build strategies, and trade on your behalf around the clock"
- "Setup is simple: give your agent a name, open a dedicated agentic account, choose a model from several leading AI labs including OpenAI, and you're ready to go–with your agent trading within the strategy and limits you set."
- "Your agent can only access the funds in your dedicated agentic trading account. You can choose to manually approve each trade, which is a setting shown during setup and defaults to on, and it is adjustable at any time."
- "Coming soon, we'll launch Loops, which allow you to turn a strategy into a standing, ongoing instruction for your agent to execute on repeat, around the clock."
- "With approvals on, your agent cannot place an order until you approve it."
- "Robinhood Agents and Agent Apps are coming soon to eligible U.S. customers."
- "Since launch, over 150,000 customers have opened agentic trading accounts and now, agents use Robinhood's tools almost 30 million times a day." (This is Robinhood's claim about its earlier Agentic Trading product.)

What the README may say: Robinhood announced Robinhood Agents at HOOD Summit on 2026-09-29, with a dedicated agentic account, trade approvals that default to on, limits the user sets, and Loops "coming soon", for eligible U.S. customers, and it cites the newsroom URL. What it must not say: that Loops are live, that Robinhood Agents trade onchain or on RHC, that Robinhood endorses or knows about Chiron, or that 150,000 users bought anything from us. Drop the word "reportedly", because the primary source exists.

### 0.2 RHC testnet (chain 46630)

| Question | Answer | Evidence, time |
|---|---|---|
| Chain and head | 46630, head 126,533,487 | `cast chain-id`, `cast block-number`, 05:02 |
| Stylus | `ArbWasm.stylusVersion()` = 3. ArbOS 61 (`arbOSVersion()` = 116), the same as Arbitrum Sepolia today (116). `pageLimit` 128, `freePages` 2, `inkPrice` 10000, `maxStackDepth` 22000, `expiryDays` 365, `keepaliveDays` 31: all equal to Arbitrum Sepolia | `cast call 0x…71` and `0x…64` on both chains, 05:02 to 05:04 |
| Verifier deploys | `cargo stylus check --endpoint https://rpc.testnet.chain.robinhood.com` in `verifier/`: "contract size: 38.0 KB (37970 bytes) (2 fragments)", "wasm data fee: 0.000198 ETH". The activation dry run passed | 05:22 |
| ReceiptVerifier deploys | same command in `receipt-verifier/`: "19.7 KB (19668 bytes)", "wasm data fee: 0.000123 ETH". Passed | 05:22 |
| Block time and ArbSys window | 0.165 s average over the last 100,000 blocks; the last 256 blocks spanned 48 s. `arbBlockHash(head-200)` returns a hash; `arbBlockHash(head-300)` reverts `InvalidBlockNumber(126534327, 126534651)` | `cast block`, `cast call 0x…64`, 05:05. Mainnet is about 0.101 s per block (pivot verdict), so its window is about 26 s |
| Gas price | 0.01 gwei (`cast gas-price` = 10000000) | 05:23 |
| Deployer funds | `0x2aD1…5DEF` holds 0 ETH on RHC testnet, nonce 0 | `cast balance`, 05:23 |
| Chain limits to note | Stylus programs expire 365 days after activation unless kept alive (`codehashKeepalive`). No deployer allowlist was hit in the dry run. The EVM contract size limit is not raised, so `AgentAccount` must stay under 24 KB | above reads |

**Official testnet Stock Tokens: yes. Official testnet USDG: no.**

- The official faucet, https://faucet.testnet.chain.robinhood.com/, was read in a `deepsurge` background tab at 05:12 (curl got a Vercel 429). Its text: "Each faucet request will send 0.01 testnet ETH and five of each Stock Token to your wallet. Claim once every 24 hours." The tokens are TSLA, AMZN, PLTR, NFLX and AMD. **It dispenses no USDG.**
- The token addresses come from the explorer API (`/api/v2/tokens?type=ERC-20`, 05:08) and `/api/v2/addresses/<a>` (05:09). All five are BeaconProxies from creator `0x2DD5…e5Da` with implementation `Stock` at `0xBd14156E05c6AF28ad39aA53a2AB8eB9CDf657DA`, and each has a total supply of 6,240,650: TSLA `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E`, AMZN `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02`, AMD `0x71178BAc73cBeb415514eB542a8995b82669778d`, PLTR `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0`, NFLX `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93`.
- The verified `Stock` ABI (explorer `/api/v2/smart-contracts/0xBd14…57DA`, 05:10) includes `pause()`, `paused()`, `tokenPaused()`, `adminBurn(address,uint256)`, `ACCESS_CONTROLLED_REGISTRY()`, `uiMultiplier()`, `updateMultiplier(...)`, `permit(...)`, and the errors `Blocked` and `IsPaused`. TSLA `paused()` = false at 05:27. Its registry is `0x1dF3cA0fD30ED5eeb09eB01938f4E9c5196E6Ca5`.
- docs.robinhood.com/chain/contracts (05:07) lists only mainnet WETH `0x0Bd7…AD73` and USDG `0x5fc5…1d168`. The testnet contracts it lists are core bridge contracts, and it lists no testnet USDG.
- The explorer lists more than 60 tokens with the symbol "USDG" on testnet, all community deployments. The most widely held, `0x915E…03ec` (10,251 holders), is a 5,652-byte non-proxy contract named "USDG" (`cast codesize`, EIP-1967 slot empty). Mainnet USDG is a proxy named "Global Dollar" (implementation slot `0x6818…6f8f`). So `0x915E` is not Paxos's contract and we do not use it.

**Is there a DEX with liquidity? Yes, but there is no USDG market.**

- **Canonical Uniswap v4 is live on testnet.** Its addresses are the ones Uniswap's SDK lists for chain 4663 (`sdks/sdk-core/src/addresses.ts`, `ROBINHOOD_ADDRESSES`, read 05:13). PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951` has a runtime code hash on testnet equal to mainnet (`0xbd38…5626` on both, 05:27). PositionManager `0x58da…4fa7`, StateView `0xf333…673b`, V4Quoter `0x8dc1…8f94`, Universal Router 2.1.1 `0x8876…0904` and Permit2 `0x0000…78BA3` all have code on testnet. PositionManager and Universal Router code hashes differ from mainnet, which is expected, because they embed per-chain immutables such as WETH.
- **Canonical Uniswap v3 is mainnet only.** Factory `0x1f7d…2efa`, SwapRouter02 `0xcaf6…5cb2` and the NFT position manager have code size 0 on testnet and non-zero on mainnet (05:14).
- **Existing Stock Token liquidity is on Synthra, a third-party v3 fork.** Factory `0x911b4000D3422F482F4062a913885f7b035382Df` has no published source. It has pools of the official Stock Tokens against Synthra's own mock USDC `0xbf44…275F`. Example: TSLA/USDC 0.3% pool `0xFfEf…2dA9`, liquidity 8.3e22, last `Swap` at block 126,501,717 through router `0x3Ce9…58fE` (`exactInput`, 03:29). Its creator also deployed the "USDC" and "SYN" tokens (`0x6063…e305`).

The venue is the canonical Uniswap v4 PoolManager with our own TSLA/testUSDG pool and liquidity. No DEX contracts and no RFQ money code are deployed, and the same PoolManager bytecode is live on mainnet at the same address. Synthra's factory and router have no published source and its quote asset is a mock USDC, so the account does not route there.

The README must disclose: "On RHC testnet there is no official USDG. The account's USDG is `testUSDG`, a fixture we deployed with open minting, not Paxos USDG. The TSLA/testUSDG pool is a canonical Uniswap v4 pool that we created and fund alone, initialised at a price we chose, so its price is not a market price. TSLA is Robinhood's official testnet Stock Token from the official faucet."

### 0.3 Attested agent key on Phala Cloud dstack: feasible

| Question | Answer | Evidence |
|---|---|---|
| Can report_data be exactly `agentAddress(20) \|\| zero(12) \|\| nonce(32)`? | **Yes.** The dstack guest agent's `get_quote` does `pad64(&request.report_data)`, i.e. the raw bytes zero-padded to 64 with no hashing and no prefix. The docs say the SDK throws an error above 64 bytes and "does not auto-hash", and short data is "pass directly" (`client.getQuote(bytes)`). Our 64 bytes fit exactly | `Dstack-TEE/dstack` branch `next`, `dstack/guest-agent/src/rpc_service.rs` lines 688 to 691, fetched 05:22; `phala docs read /phala-cloud/attestation/get-attestation.mdx`, 05:21 |
| Does it match the Verifier? | Yes. `verify()` requires `report_data[20..32] == 0` and `report_data[32..64] == nonce`, and returns `report_data[0..20]` as the signer (`verifier/src/lib.rs` 762 to 769) | repo read |
| Phala CLI | `phala` 1.1.22 (npm, repo `Phala-Network/phala-cloud`, modified 2026-09-06). It is not installed here and ran through `npx -y phala@1.1.22`. `phala deploy -c docker-compose.yml -t tdx.small --wait` deploys a CVM | `--help` output, 05:21 |
| Will the CLI use the phak_ key in `chiron/.env`? | **Not by itself.** The CLI reads `PHALA_CLOUD_API_KEY` from the process environment, a `--api-key` flag, or a token stored by `phala login`. It does not load `.env` files. The key must be exported under that exact name in a subshell that never prints it, or stored once with `phala login`. The key was not read | `phala help envs`, 05:21 |
| Will the measurement pass the nine-field hash? | **Yes, with conditions.** The nine fields (mr_seam, td_attributes, xfam, MRTD, mr_config_id, RTMR0 to RTMR3) are all produced by any TDX CVM. On Phala Cloud, RTMR3 chains `app-id`, `compose-hash`, **`instance-id`** and `key-provider`. So the measurement is unique to one CVM instance and is known only after first boot ("its instance_id is minted on first boot", `phala deploy --help`). The owner approves it after reading it from the first quote. It changes on a new compose (new code, which is intended), on an instance-id refresh (`PATCH /cvms/{id}/instance-id`), on a VM size change (RTMR0), and on a host TDX module update (mr_seam). Each change needs a fresh owner approval, and the account fails closed until then | `phala docs read /phala-cloud/attestation/attestation-fields.mdx`, 05:22 |
| DEBUG check | Production Phala Cloud CVMs are not debug TDs. The `--dev-os` image must never be used, because its OS measurement differs and it allows SSH. The bit is `td_attributes[0] & 1`, which the Verifier rejects. The Verifier parsed the first quote from our CVM and admitted it, so that quote's `td_attributes[0] & 1` is 0 (`registerAgent` tx `0x1f15df28…a68134`) | `verifier/src/lib.rs` 586 to 597 |
| Quote format | The Verifier needs a v4 quote with a PCK chain as cert_type 5. Phala's own gateway is a dstack app on the same platform, and its quotes pass (Arbitrum Sepolia tx `0xaf42…0d59`). Our CVM's quote passes the same check (`registerAgent` tx `0x1f15df28…a68134`) | README live table |
| Runtime event injection | dstack 0.6 removed app-emitted RTMR3 events ("Always fails ... so a pre-0.6 client learns why its events stopped being recorded"), so our app cannot perturb its own measurement at runtime | `rpc_service.rs` 693 to 695 |
| Cost | `tdx.small` (1 vCPU, 2 GB) `hourly_rate` "0.058000": $1.39 per day, about $8 through 2026-10-05. Gas on RHC testnet at 0.01 gwei: a registration costs about 2.35M gas (0.0000235 ETH) and a trade about 0.45M gas (estimate) | `GET https://cloud-api.phala.com/api/v1/instance-types` (unauthenticated), 05:22 |
| Time | CVM deploy under 15 minutes. The agent image, compose and registration path take about half a day on top of the contract work. Feasible before the deadline if the contract and tests land by 2026-10-02 | estimate |

Fallback, only if the CVM path fails (for example the quote lacks cert_type 5, or the DEBUG bit is set): deploy the account with an immutable constructor flag `allowUnattested = true` and an owner-only `setUnattestedAgent(address)`. That function emits `AgentRegistered(agent, bytes32(0), expiry, epoch)` with a zero measurement, and every `TradeExecuted` then carries `agentMeasurement = 0`. The factory's default stays `false`, and the attested path is unchanged. The README must then say, in the first screen: "In this deployment the agent key is NOT attested: it is a key the operator holds, set by the owner. The attestation path (`registerAgent`) is implemented and tested against real Phala TDX quotes in `verifier` cargo tests, but no attested agent key traded live." Build this function only if the fallback is triggered.

### 0.4 Conflict with the pivot verdict

`docs/research/chiron-pivot-verdict.md` ends with "NARROW, then use outreach as the test. Do not build yet": 9 agents and about $208 of agent volume on RHC in 30 days, and Stock Tokens are about 5% of RHC DEX volume. The user and coordinator have since decided to build. Both positions are recorded here. The verdict's evidence is better for demand, and this spec does not change that; it only specifies the build.

## 1. Architecture

```
owner (EOA) ──policy, approvals, withdraw──▶ AgentAccount ──unlock/swap/settle/take──▶ Uniswap v4 PoolManager (canonical)
                                               │  ▲
Phala Cloud CVM (dstack, tdx.small)            │  └─ registerAgent(quote, refBlock) ─▶ Verifier (Stylus, TDX DCAP)
  agent key generated in the TD, never leaves  │
  execute(trade, receipt) ─────────────────────┘──▶ ReceiptVerifier (Stylus, Ed25519) + Assay.receiptSigners (registry)
  inference via Phala Confidential AI ──vouchers (ERC-1271 by the account)──▶ Assay channel (agent = the account)
```

Contracts, all non-upgradeable:

1. `Verifier` and `ReceiptVerifier`: redeployed unchanged on RHC.
2. `Assay`: redeployed on RHC with `testUSDG` and the Phala gateway measurement read from a fresh quote at deploy time. It is the receipt-key registry and the inference billing channel.
3. `AgentAccountFactory`: deploys one `AgentAccount` per owner and emits `AccountCreated`. It exists so the 30-day metric (accounts funded by wallets we do not control) can be read from one event stream.
4. `AgentAccount`: the product.

Why typed trades instead of a router with raw calldata: the agent never supplies calldata. `execute()` takes a typed `Trade`, and the account itself calls `PoolManager.unlock`, `swap`, `settle` and `take`. The recipient is the account by construction, no token approval is ever granted to any router, and malicious calldata has no entry point. The "router allowlist" the product asks for becomes a **venue allowlist**: the PoolManager address is immutable, and the owner allowlists individual pools by `PoolId`. A second venue kind (a Uniswap v3 SwapRouter02 `exactInputSingle` adapter for mainnet's v3 Stock Token pools, such as NVDA/USDG 0.05%) is out of scope for v1 and should be added only when a mainnet account needs a v3-only pool.

## 2. Interfaces

```solidity
// Uniswap v4 types, imported from v4-core (not re-declared)
// PoolKey { Currency currency0; Currency currency1; uint24 fee; int24 tickSpacing; IHooks hooks; }

interface IAgentAccount {
    struct Limits {
        bool allowed;
        uint128 perTrade;       // hard cap on amountIn per trade, raw token units
        uint128 daily;          // cap on agent-direct amountIn over the rolling window, raw units
        uint128 approvalAbove;  // amountIn above this needs the owner; must be <= perTrade
    }

    struct Trade {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minOut;
        uint64 deadline;
    }

    struct Receipt {
        bytes32 pubkey;         // Ed25519 receipt key registered in Assay
        bytes receiptBytes;     // JCS bytes, signature member removed
        bytes signature;
    }

    // agent
    function registerAgent(bytes calldata quote, uint256 refBlock) external returns (address agent, bytes32 measurement);
    function attestNonce(uint256 refBlock) external view returns (bytes32);
    function execute(Trade calldata t, Receipt calldata r) external returns (uint256 tradeId, uint256 amountOut);
    function propose(Trade calldata t, Receipt calldata r) external returns (uint256 proposalId);
    function cancelProposal(uint256 id) external;

    // owner
    function approveTrade(uint256 id, Trade calldata t) external returns (uint256 amountOut);
    function rejectTrade(uint256 id) external;
    function setLimits(address token, Limits calldata l) external;
    function setPool(PoolKey calldata key, bool allowed) external;
    function setMeasurement(bytes32 measurement, bool approved) external;
    function setModel(bytes32 requestedModelHash, bytes32[4] calldata acceptedServedHashes, bytes32 gatewayMeasurement) external;
    function setApprovalTtl(uint64 ttl) external;
    function pause() external;
    function unpause() external;
    function revokeAgent() external;
    function withdraw(address token, address to, uint256 amount) external;
    function withdrawETH(address payable to, uint256 amount) external;
    function openInferenceChannel(address provider, uint128 amount) external returns (uint256 channelId);
    function requestInferenceClose(uint256 channelId) external;
    function finalizeInferenceClose(uint256 channelId) external;

    // callbacks
    function unlockCallback(bytes calldata data) external returns (bytes memory);   // IUnlockCallback
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4); // ERC-1271
}

interface IAgentAccountFactory {
    event AccountCreated(address indexed account, address indexed owner, uint256 index);
    function createAccount(address owner) external returns (address account);
}
```

Constructor (set by the factory, immutable): `owner` (via OZ `Ownable2Step`), `verifier`, `receiptVerifier`, `assay` (the receipt-key registry and billing channel), `poolManager`, `usdg`. The constant `ATTESTATION_VALIDITY` is 86400.

### 2.1 Storage

```solidity
// agent
address public agent;               // current attested key, 0 when none
bytes32 public agentMeasurement;    // measurement it was admitted under
uint64  public agentExpiry;
uint256 public agentEpoch;          // bumps on every registration and every revoke; feeds the nonce
mapping(bytes32 => bool) public approvedMeasurement;
mapping(bytes32 => bool) public usedQuote;

// model pin for per-trade receipts
bytes32 public requestedModelHash;
bytes32[4] public acceptedServedHashes;
bytes32 public gatewayMeasurement;  // receipt key must be registered in Assay under exactly this
mapping(bytes32 => bool) public usedReceipt;    // keccak256(requestHash, responseHash)

// policy
mapping(address => Limits) public limits;
mapping(PoolId => bool) public allowedPool;
mapping(address => Bucket[25]) internal window; // Bucket { uint32 hour; uint224 amount; }
uint64 public approvalTtl;                      // default 3600
bool public paused;

// approvals
struct Proposal { bytes32 tradeHash; address agent; uint64 expiry; Status status; } // Status: None, Pending, Executed, Rejected, Cancelled
mapping(uint256 => Proposal) public proposals;
uint256 public proposalCount;
uint256 public tradeCount;

// swap guard (transient)
bool transient swapping;
```

### 2.2 Events

```solidity
event AgentRegistered(address indexed agent, bytes32 indexed measurement, uint64 expiry, uint256 epoch);
event AgentRevoked(address indexed agent, uint256 epoch);
event MeasurementSet(bytes32 indexed measurement, bool approved);
event ModelSet(bytes32 requestedModelHash, bytes32[4] acceptedServedHashes, bytes32 gatewayMeasurement);
event LimitsSet(address indexed token, Limits limits);
event PoolSet(PoolId indexed poolId, address currency0, address currency1, uint24 fee, bool allowed);
event TradeExecuted(
    uint256 indexed tradeId, PoolId indexed poolId, address indexed agent,
    address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut,
    bytes32 agentMeasurement, bytes32 servedModelHash, bytes32 requestHash, bytes32 responseHash,
    uint256 proposalId   // 0 for agent-direct, else the approved proposal
);
event TradeProposed(uint256 indexed proposalId, address indexed agent, bytes32 tradeHash, Trade trade, uint64 expiry,
    bytes32 agentMeasurement, bytes32 servedModelHash, bytes32 requestHash, bytes32 responseHash);
event TradeRejected(uint256 indexed proposalId);
event ProposalCancelled(uint256 indexed proposalId);
event Paused(bool paused);
event Withdrawn(address indexed token, address indexed to, uint256 amount);
event InferenceChannelOpened(uint256 indexed channelId, address indexed provider, uint128 amount);
```

### 2.3 Errors

`NotAgent`, `AgentExpired`, `IsPaused`, `StaleRefBlock`, `QuoteAlreadyUsed`, `MeasurementNotApproved(bytes32 measurement)` (it carries the value so an `eth_call` shows the owner which measurement to approve), `AgentIsOwner`, `TokenNotAllowed(address)`, `PoolNotAllowed(PoolId)`, `HookedPool`, `NativeCurrency`, `ZeroAmount`, `ZeroMinOut`, `DeadlinePassed`, `ExceedsPerTradeCap(uint256 amountIn, uint256 cap)`, `NeedsApproval(uint256 amountIn, uint256 threshold)`, `ApprovalNotNeeded`, `DailyCapExceeded(uint256 used, uint256 cap)`, `OverSpent(uint256 spent, uint256 amountIn)`, `InsufficientOutput(uint256 got, uint256 minOut)`, `ReceiptInvalid`, `ModelMismatch`, `ReceiptKeyNotRegistered`, `GatewayMeasurementMismatch`, `ReceiptKeyExpired`, `ReceiptAlreadyUsed`, `ModelNotSet`, `ProposalNotPending`, `ProposalExpired`, `TradeMismatch`, `ProposerNotCurrentAgent`, `NotPoolManager`, `NotSwapping`, `BadLimits`.

## 3. Policy model

**Tokens.** `limits[token].allowed` gates every token that can be spent or received. USDG and each Stock Token are listed separately. All caps are in **raw token units**: 6 decimals for USDG, 18 for Stock Tokens. Raw units keep their value across ERC-8056 `uiMultiplier` changes, because a split scales the UI amount, not raw balances or the raw price. The UI shows `raw * uiMultiplier / 1e18` for display only.

**Caps apply to what leaves the account.** A trade is checked against `limits[tokenIn]`. Buying TSLA with USDG is bounded in USDG; selling TSLA is bounded in TSLA units. So a sell cannot be disguised as small by quoting the USDG it returns.

**Pools.** `setPool(key, true)` requires `key.hooks == address(0)`, both currencies non-zero (no native ETH), and both currencies `allowed`. `execute` re-checks both currencies' `allowed` flags, so delisting a token freezes its pools without touching the pool list. Hooked pools are refused in v1. Whether mainnet Stock Token v4 pools use hooks is an open question for the mainnet phase.

**Three bands per trade, from `amountIn` against `limits[tokenIn]`:**

1. `amountIn <= approvalAbove`: the agent may `execute` directly, subject to the daily window.
2. `approvalAbove < amountIn <= perTrade`: `execute` reverts `NeedsApproval`. The agent must `propose`, and the owner may `approveTrade`.
3. `amountIn > perTrade`: both paths revert `ExceedsPerTradeCap`. The per-trade cap binds even the approval path, so to go bigger the owner raises the cap first.

`setLimits` reverts `BadLimits` unless `approvalAbove <= perTrade`. Setting `approvalAbove = 0` means every trade needs approval, which is Robinhood's default-on behaviour; the factory's initial limits are all zero and `allowed = false`, so a new account can do nothing until the owner configures it.

**Rolling daily window.** Per token there is a ring of 25 hourly buckets, `window[token][h % 25] = {hour: h, amount}` with `h = block.timestamp / 3600`. On an agent-direct trade:

```
used = sum of bucket.amount over the 25 slots where bucket.hour >= h - 24
require(used + amountIn <= daily)
bucket at h % 25: if bucket.hour != h then reset to {h, 0}; amount += amountIn
```

Guarantee: for every token and every 24-hour interval, the total `amountIn` of agent-direct trades in that interval is at most `daily`, checked against the cap in force at each trade. Proof: a 24-hour interval touches at most 25 hour buckets `h0..h0+24`. The last trade in the interval, at hour `hl <= h0+24`, summed buckets `hl-24..hl`, which covers every bucket from `h0` to `hl`. So that check included every earlier trade in the interval. The window is conservative by up to one hour; it is never lenient. Cost: 25 SLOADs of one token per trade. The check records the requested `amountIn`, not the smaller amount actually spent, which errs conservative.

**Approved trades are the owner's own decision.** They are bounded by `perTrade`, are not checked against the daily window, and are not recorded in it. The daily cap bounds what the agent does alone. Because the approval threshold is a per-trade gate, an agent can split a large order into many small ones; the daily cap is the hard bound on that, and this is stated in the UI next to the threshold.

**Approval queue and expiry.** `propose` runs every check `execute` runs except the band check, which must land in band 2 (`ApprovalNotNeeded` otherwise). It verifies and consumes the receipt, then stores `{tradeHash: keccak256(abi.encode(t)), agent: msg.sender, expiry: min(t.deadline, now + approvalTtl), status: Pending}`. `approveTrade(id, t)`, callable only by the owner, requires:

- `status == Pending`, and `now <= expiry`;
- `keccak256(abi.encode(t)) == tradeHash`;
- `proposal.agent == agent`, so a proposal dies when the agent is revoked or replaced;
- the account is not paused, and the pool and tokens are still allowed.

It sets `status = Executed` before the swap and runs the same swap and balance-delta checks, with the proposal's `minOut`. `rejectTrade` is owner-only; `cancelProposal` is the proposing agent's own. A proposal cannot be approved twice, because its status is final.

**Oracle price band: not in v1.** On mainnet, Chainlink equity feeds cover 33 to 35 tickers, publish 24/5 with a 24 h heartbeat, and were 11.5 h stale on a Saturday (`robinhood-chain-facts` memory, 2026-09-26). There are no official feeds on testnet. For v1, the loss a compromised agent can cause through a manipulated pool is bounded by the per-token caps and the daily window, and `minOut` protects the honest agent. The mainnet phase adds an optional per-token `(feed, maxDeviationBps, maxAge)` guard: when a feed is set and stale, the trade falls into band 2 (owner approval) instead of reverting, so weekend trades still work through approvals. That guard gets a fork test against the real NVDA feed `0x379E…9F15`.

## 4. Agent registration via the Verifier

```
attestNonce(refBlock) = keccak256(abi.encode(block.chainid, address(this), agentEpoch, _refBlockHash(refBlock)))
```

`_refBlockHash` is Assay's function copied verbatim: it static-calls ArbSys `arbBlockHash(refBlock)`, reverts `StaleRefBlock` if the call reverts, falls back to `blockhash` only where `0x64` has no code (off Arbitrum, in unit tests), and reverts on any zero hash. That last check is the RR-2 fix: an out-of-window `refBlock` must not produce a constant nonce that a quote can be banked for (`docs/security/assay-usdg-review.md` RR-2).

`registerAgent(quote, refBlock)` does, in order:

1. `quoteHash = keccak256(quote)`; revert `QuoteAlreadyUsed` if it was seen.
2. `(signer, m) = verifier.verify(quote, attestNonce(refBlock))`. The Verifier checks the DCAP chain to Intel's root, certificate dates against `block.timestamp`, the DEBUG bit, `report_data[20..32] == 0` and `report_data[32..64] == nonce`.
3. Revert `MeasurementNotApproved(m)` unless the owner approved `m`; revert `AgentIsOwner` if `signer == owner()`.
4. Set `usedQuote`, increment `agentEpoch`, and set `agent = signer`, `agentMeasurement = m`, `agentExpiry = now + 86400`. Emit `AgentRegistered`.

Anyone may submit a quote; the key comes out of the quote. The nonce binds the chain, this account and the epoch, not the caller, so the CVM, the owner or a relayer can submit it. Refreshing is the same call with a fresh quote. Because `agentEpoch` changes on every success, two quotes can never both register, and an in-flight quote dies when the owner revokes the agent.

Timing: the CVM reads the head, takes `refBlock = head - 1`, reads `attestNonce(refBlock)` by `eth_call`, calls `getQuote(agent || 0^12 || nonce)` (local to the TD, well under a second), and sends the transaction. The ArbSys window is 256 blocks: about 42 s on testnet today (48 s measured) and about 26 s on mainnet. The CVM retries with a new `refBlock` on `StaleRefBlock`.

The 24 h refresh: an in-CVM keeper re-registers when `agentExpiry - now < 4 h`, i.e. every 20 h, like Assay's launchd job. If refresh fails, for example because a host TDX module update changed `mr_seam` and so the measurement, the agent expires and trading stops. That is the intended fail-closed behaviour. The CVM then exposes its new measurement, and the owner approves it with `setMeasurement`.

Agent key lifecycle: the key is generated in memory at boot and never written to disk or env. A restart means a new key and a new registration, which replaces the old one. No KMS-derived key is used, because persistence buys nothing here.

What the compose file must pin (it is measured into RTMR3 via `compose-hash`): the image **by digest** (`image@sha256:...`, never a tag, or the measurement does not pin the code), the account address, the RPC URL, the inference base URL, the model id and the strategy parameters. Only the Phala Confidential AI key goes in encrypted env, because it is a secret and not an integrity input.

## 5. Trade path

`execute(t, r)`, `nonReentrant`:

1. `msg.sender == agent`, else `NotAgent`; `now <= agentExpiry`, else `AgentExpired`; `!paused`.
2. `now <= t.deadline`; `t.amountIn > 0`; `t.minOut > 0`.
3. `allowedPool[t.key.toId()]`. `(tokenIn, tokenOut)` is derived from `t.key` and `t.zeroForOne`, never supplied separately. Both must be `allowed`.
4. Band check and daily window (section 3).
5. Receipt check (section 6), which marks the receipt used.
6. Read `inBefore = tokenIn.balanceOf(this)` and `outBefore = tokenOut.balanceOf(this)`.
7. `swapping = true`; `poolManager.unlock(abi.encode(t))`; `swapping = false`.
8. `spent = inBefore - inAfter`, which must be `<= t.amountIn` (`OverSpent`); `got = outAfter - outBefore`, which must be `>= t.minOut` (`InsufficientOutput`).
9. `tradeId = ++tradeCount`; emit `TradeExecuted`.

`unlockCallback(data)`: requires `msg.sender == poolManager` (`NotPoolManager`) and `swapping` (`NotSwapping`). It calls `swap(key, SwapParams{zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1}, "")`. It settles only the owed input (`sync(currencyIn)`, `transfer(poolManager, owed)`, `settle()`) and takes the output to `address(this)` only. The contract's only `take` targets `address(this)`. A fill that stops at the price limit pays only what the pool used.

Why this is safe against the listed attacks:

- **Router calldata:** none exists.
- **Approvals:** the account never approves any spender for trading. It approves Assay exactly once per `openInferenceChannel`, for the exact amount, and resets the allowance to 0 afterwards.
- **Recipient:** hard-coded.
- **Slippage:** `minOut` is enforced by the balance delta, not by trusting the pool's return value.
- **Reentrancy:** `nonReentrant` on every state-changing external function, plus the `swapping` flag and the `msg.sender` check on the callback. The allowlisted tokens (OZ-based Stock, USDG) have no transfer hooks, and ERC-777-style tokens are never allowlisted.

## 6. Workload record per trade

Every executed or proposed trade verifies one Phala inference receipt onchain and records it:

1. `(ok, requested, served, reqHash, respHash) = receiptVerifier.verifyReceipt(r.pubkey, r.receiptBytes, r.signature)`. Revert `ReceiptInvalid` if `!ok`.
2. Revert `ModelNotSet` if `requestedModelHash == 0`. Revert `ModelMismatch` if `requested != requestedModelHash`, or if `served` is zero or not in `acceptedServedHashes`. This is ChironGate's rule; four slots exist because upstream labels differ.
3. `(m, expiry) = assay.receiptSigners(r.pubkey)`. Revert `ReceiptKeyNotRegistered` if `m == 0`, `GatewayMeasurementMismatch` if `m != gatewayMeasurement`, and `ReceiptKeyExpired` if `now > expiry`.
4. `key = keccak256(abi.encode(reqHash, respHash))`. Revert `ReceiptAlreadyUsed`, then set it.

`TradeExecuted` then carries `agentMeasurement` (which image signed the trade, enforced), `servedModelHash` (which model answered, from TEE-signed bytes), and `requestHash` and `responseHash` (which exact inference). The cost is about 175K gas per trade (the measured `verifyReceipt` on Arbitrum Sepolia), under 0.000002 ETH at 0.01 gwei.

What this does not prove, and the README must say so: it does not prove that the trade follows from that response. A receipt proves that the pinned model answered some request through the attested gateway; the attested agent image is what links that answer to this trade. A Phala receipt key is shared by all Phala customers, so a key stolen from outside the TEE could attach anyone's receipt for the same model. That is why the receipt is a record of the honest attested agent, not a defence against a stolen key. The defence against a stolen key is attestation plus caps.

## 7. Inference billing through Assay

`openInferenceChannel(provider, amount)` is owner-only. It runs `usdg.forceApprove(assay, amount)`, then `assay.openChannel(provider, amount, gatewayMeasurement, requestedModelHash)`, then `forceApprove(assay, 0)`. In Assay the channel's `agent` is the account, so vouchers are checked through ERC-1271. The deposit is the most inference can ever cost.

`isValidSignature(hash, sig)` returns `0x1626ba7e` only when all of these hold:

- `sig` decodes as `abi.encode(uint256 channelId, uint256 cumulativeAmount, bytes32 requestHash, bytes32 responseHash, bytes agentSig)`;
- `hash` equals Assay's EIP-712 `Voucher` digest recomputed from those fields, with Assay's domain (`"Assay"`, `"1"`, `block.chainid`, `assay`);
- `assay.channels(channelId).agent == address(this)`, and the channel is not closed;
- `ECDSA.recover(hash, agentSig) == agent`, `now <= agentExpiry`, and `!paused`.

For any other digest it returns `0xffffffff`. This is load-bearing: Permit2 and EIP-3009 or permit implementations that accept ERC-1271 from contract holders would otherwise let the agent key sign a transfer of the account's funds. Assay's `_payerSigValid` tries ECDSA first, which fails on this longer blob, then calls ERC-1271 with the raw `payerSig`, so no Assay change is needed.

Consequence to document: a voucher is valid only while its signer is the current unexpired agent, so the provider should redeem promptly. `requestInferenceClose` and `finalizeInferenceClose` are owner-only pass-throughs; the refund lands in the account.

## 8. Owner powers and timelocks

The owner (OZ `Ownable2Step`) can at any time, **without a timelock**:

- withdraw any ERC-20 or ETH, even while paused;
- pause and unpause;
- revoke the agent;
- set limits, pools, measurements and the model pin;
- approve or reject proposals;
- open and close inference channels.

Why there is no timelock: the owner is the principal and the only party who can lose. Every power that reduces risk (pause, revoke, lower caps, withdraw) must be instant. The powers that expand agent authority are signed by that same principal, and a timelock on them protects nothing against a stolen owner key, which can withdraw instantly anyway. The agent can never change policy, withdraw, approve its own proposals, or open channels. `renounceOwnership` is disabled (reverts), so funds can never be stranded without an owner.

Issuer powers the owner cannot override: Stock Token `pause`, `Blocked` and `adminBurn`, and Paxos USDG pause and freeze on mainnet. The account keeps no internal ledger (it reads `balanceOf` at trade time), so an out-of-band burn or freeze breaks no accounting.

## 9. Invariants the tests must prove

1. **I1 Admission.** `agent != 0` only if a quote whose `report_data` binds `agent` and `attestNonce` at the current epoch passed the Verifier under an owner-approved measurement, or, in fallback deployments only, `setUnattestedAgent` was called.
2. **I2 Freshness.** No agent action succeeds when `now > agentExpiry`, after `revokeAgent`, or while paused.
3. **I3 Outflow bound.** For every token T and every 24 h interval, the agent-direct `amountIn` in T is at most `limits[T].daily`, and each single trade's `amountIn` is at most `limits[T].perTrade`.
4. **I4 Only swaps, only to self.** The agent can reduce any token balance of the account only through `execute`, and every `execute` either reverts or leaves `spent <= amountIn` and `got >= minOut`, with `got` credited to the account.
5. **I5 Approval integrity.** A proposal executes at most once, only by the owner, only with the exact proposed `Trade`, only before expiry, and only while its proposer is the current agent.
6. **I6 Receipt integrity.** Every `TradeExecuted` and `TradeProposed` carries a receipt that verified for the pinned model under a registered, unexpired gateway key with the pinned measurement, and each receipt backs at most one trade.
7. **I7 Signature scope.** `isValidSignature` is valid only for an Assay voucher digest on this account's own open channel, signed by the current agent.
8. **I8 Owner exit.** The owner can always withdraw every token the issuer allows to move, in any state, including paused, expired or revoked.

## 10. Threat model

| Threat | Mitigation | Residual |
|---|---|---|
| Agent key stolen from outside the TEE | The key is generated inside the TD and never exported; the owner revokes; expiry after 24 h without a fresh quote from the approved image | Up to one day's `daily` per token plus any open proposals the owner approves by mistake |
| Compromised or buggy agent logic inside the approved image | Caps, the daily window, pool allowlist, approval band, pause | Loss up to caps, including bad fills in a pool the agent pushes (no oracle band in v1) |
| Attacker runs the same image elsewhere | `instance-id` is in RTMR3, so a second CVM has a different measurement, which the owner never approved | If the owner approves a measurement carelessly, that CVM becomes the agent. The UI shows the CVM's app id and instance id next to each measurement |
| Malicious router calldata | No calldata path exists; typed `Trade` only | none |
| Hooked or malicious pool | `hooks == 0` required; pools allowlisted by id; balance-delta checks | A thin pool gives a bad price bounded by `minOut` and caps |
| Approval replay | Status is final; the trade hash is bound; the proposer must be the current agent; expiry | none |
| Quote replay or stockpiling | `usedQuote`; the epoch in the nonce; ArbSys block hash within 256 blocks; zero hash reverts (RR-2) | A quote is usable for about 42 s on testnet and about 26 s on mainnet |
| Reentrancy via callback or tokens | `nonReentrant`; callback gated by `msg.sender` and the transient flag; no hook tokens allowlisted | none known |
| ERC-1271 abuse (Permit2, permit, EIP-3009 signed by the agent) | Signature scope limited to recomputed Assay voucher digests (I7) | none |
| Stock Token paused, account blocklisted, `adminBurn` | Trades involving that token revert atomically; other tokens unaffected; withdraw is per token | Frozen or burned Stock Tokens are the issuer's decision and cannot be recovered by the account |
| Measurement drift (host TDX update, instance-id refresh) | The agent expires and trading halts; the owner approves the new measurement | Downtime until the owner acts |
| TCB, QE identity and CRL checks | `registerAgentWithCollateral` runs them behind the owner's `setAttestationPolicy`; the plain `registerAgent` path leaves the owner to decide per measurement | An account that has not opted in admits a quote from a platform later revoked by Intel until the certificate dates expire |
| Malicious RPC feeding the agent false state | The agent's decisions only; the contract enforces caps regardless | Bad trades within caps |
| Receipt misattribution | Receipt consumed per account; recorded, not claimed as causal | Section 6 limits |

## 11. Test plan (red, then green)

The repo convention holds: every guard has a named test, the guard is removed and the test must go red, then it is restored and must go green. Both runs are recorded in `docs/security/agent-account-mutations.md`, the same way `contracts/test/mutation` is recorded today. Unit tests use the existing mock verifiers only for the Stylus calls. Fork tests use the real RHC testnet TSLA, the canonical PoolManager and the real Stock `pause`, with no mocks.

Unit (`contracts/test/AgentAccount.t.sol`):

- `test_register_admitsApprovedMeasurement` / `test_register_revertsUnapprovedMeasurement` (it asserts the error carries `m`)
- `test_register_revertsStaleRefBlock_outOfWindow` and `test_register_revertsZeroHash` (RR-2; mutation: drop the zero check)
- `test_register_revertsReplayedQuote`
- `test_register_epochInvalidatesInflightQuote` (a quote for epoch n fails after a registration or revoke)
- `test_register_revertsAgentIsOwner`
- `test_execute_revertsNotAgent`, `test_execute_revertsOneSecondAfterExpiry`, `test_execute_revertsWhenPaused`, `test_execute_revertsAfterRevoke`
- `test_execute_revertsOverPerTradeCap`, `test_execute_revertsNeedsApproval_inBand2`, `test_propose_revertsApprovalNotNeeded_inBand1`
- `test_execute_revertsTokenNotAllowed_afterDelist`, `test_setPool_revertsHookedPool`, `test_setPool_revertsNativeCurrency`, `test_execute_revertsPoolNotAllowed`
- `test_execute_revertsDeadline`, `test_execute_revertsZeroMinOut`
- `test_callback_revertsFromNonPoolManager`, `test_callback_revertsWhenNotSwapping`
- `test_execute_revertsInsufficientOutput_whenPoolUnderpays` (a PoolManager test double that credits less than it reports; mutation: drop the balance-delta check)
- `test_receipt_revertsModelMismatch_requested`, `test_receipt_revertsModelMismatch_served`, `test_receipt_revertsKeyNotRegistered`, `test_receipt_revertsGatewayMeasurementMismatch`, `test_receipt_revertsKeyExpired`, `test_receipt_revertsReuse`
- `test_approve_executesExactTrade_once`, `test_approve_revertsReplay`, `test_approve_revertsExpired`, `test_approve_revertsTradeMismatch`, `test_approve_revertsAfterAgentRotated`, `test_approve_revertsNotOwner`, `test_reject_thenApproveReverts`
- `test_1271_acceptsAssayVoucher_andAssayRedeemPays` (real `Assay` plus mock Stylus verifiers; asserts `channels(id).paid` and the provider's balance delta)
- `test_1271_rejectsPermit2Digest`, `test_1271_rejectsUsdgPermitDigest`, `test_1271_rejectsForeignChannel`, `test_1271_rejectsExpiredAgent` (mutation: return magic on any agent signature, and all four must go red)
- `test_withdraw_worksWhilePausedAndRevoked`, `test_withdraw_revertsNotOwner`, `test_renounceOwnership_reverts`
- `test_openInferenceChannel_resetsAllowanceToZero`

Fuzz and invariant (`AgentAccountWindow.t.sol`, `AgentAccountInvariant.t.sol`):

- `testFuzz_window_matchesReferenceModel`: random sequences of `(dt, amount)` against a Solidity reference that keeps every trade and checks every 24 h interval exactly. Assert that the account never accepts a trade the reference rejects (I3). Mutation: sum 24 buckets instead of 25; it must go red.
- `invariant_agentCannotDrain`: a handler plays the agent (execute, propose, 1271 attempts) and the owner (limits, pause). Assert that each token's balance drop outside owner withdrawals and channel opens is at most the window bound (I3, I4, I7).

Fork (`AgentAccountRHCFork.t.sol`, `--fork-url https://rpc.testnet.chain.robinhood.com`):

- `test_fork_swapTSLA_throughCanonicalPoolManager`: initialise a TSLA/testUSDG pool in the fork, add liquidity through the real PoolManager, execute a buy and a sell, and assert the balance deltas.
- `test_fork_stockPaused_revertsTrade_otherTokenWithdrawWorks`: prank the real pauser role holder (found from the registry's role events) and call `pause()` on the real TSLA.
- `test_fork_stylusVerifier_realQuote`: only after step 6 of the deploy plan. Call the deployed RHC Verifier with our CVM's real quote and assert the returned signer and measurement.

Verifier (`cargo test` in `verifier/`): no code change. Add `test_agent_layout_quote_fixture`, which checks a real quote captured from our CVM with the agent layout against a fixed timestamp.

Agent (`agent/test`): `acctTrade.test.ts` builds a `Trade` and checks the exact ABI encoding against `cast abi-encode`; `acctRegister.test.ts` checks that the report_data bytes are `agent || 0^12 || nonce`.

## 12. Deploy plan (RHC testnet)

Each step ends with a read-back.

1. **Fund the deployer.** Use the official faucet form (0.01 ETH and 5 of each Stock Token per 24 h) for `0x2aD1…5DEF` and the owner and CVM addresses. Read-back: `cast balance`.
2. **Stylus.** `cargo stylus deploy` for `verifier/` and `receipt-verifier/` against the RHC testnet RPC (both dry runs passed at 05:22). Read-back: `cast codesize`, then an `eth_call` of `verify` with a stored Phala fixture must revert on the nonce, which proves the code runs.
3. **testUSDG.** Deploy `contracts/src/TestUSDG.sol` unchanged. Read-back: `decimals() == 6`.
4. **Assay.** Fetch a fresh Phala gateway quote and read its measurement by `eth_call` to the new Verifier. Deploy `Assay(testUSDG, verifier, receiptVerifier, [gatewayMeasurement], 86400, 3600, 3600)`, then run `npm run register` with an RHC chain config. Read-back: `receiptSigners(pubkey)` returns the measurement.
5. **Venue.** Initialise the TSLA/testUSDG pool (fee 3000, tickSpacing 60, hooks 0) on PoolManager `0x8366…0951`, then add liquidity through PositionManager `0x58da…4fa7` using Permit2 `0x0000…78BA3`. The liquidity is up to 5 TSLA per faucet claim plus the matching testUSDG. Read-back: StateView `getSlot0` and `getLiquidity`.
6. **CVM.** Run `phala deploy -c agent-cvm/docker-compose.yml -t tdx.small --wait` with the image pinned by digest, no `--dev-os`, and `--public-tcbinfo` on. Fetch one quote from the CVM's `/attestation` endpoint, parse `td_attributes` (the DEBUG bit must be 0) and the cert_type, and `eth_call` `verifier.verify` to read `(agent, measurement)`. Stop here and switch to the fallback if the quote does not verify.
7. **Factory and account.** Deploy the factory, `createAccount(owner)`, and have the owner call `setLimits` for testUSDG and TSLA, `setPool`, `setModel`, `setMeasurement(m, true)` and `openInferenceChannel`. The owner deposits testUSDG and TSLA and sends a little ETH to the agent address for gas. Read-back: every getter.
8. **Register.** The CVM calls `registerAgent`. Read-back: `agent()`, `agentMeasurement()`, `agentExpiry()`.

Record every address and transaction in `contracts/deployments/46630.json`, with block numbers.

## 13. Live-cycle script

`cd agent && npm run acct-cycle` runs the cycle and asserts a post-condition that only completion can produce. The agent-side steps run inside the CVM; the script drives them through the CVM's HTTP control route and reads the chain itself.

| Step | Action | Post-condition asserted |
|---|---|---|
| 1 | Registration is fresh | `agent()` equals the address in the CVM's latest quote; `agentExpiry() - now > 20 h` |
| 2 | In-policy buy: 1 testUSDG to TSLA (band 1), with a real receipt | `TradeExecuted` log; account TSLA delta equals `amountOut >= minOut`; testUSDG delta equals `-spent`; the event's `servedModelHash` equals the pinned hash |
| 3 | Over-cap: `amountIn = perTrade + 1` | the `eth_call` reverts `ExceedsPerTradeCap`, and one real reverted transaction is sent for explorer evidence; balances unchanged |
| 4 | Approval path: `amountIn` in band 2 | `execute` reverts `NeedsApproval`; `propose` emits `TradeProposed(id)`; the owner's `approveTrade(id, t)` emits `TradeExecuted(..., proposalId = id)` with the balance delta; a second `approveTrade(id, t)` reverts `ProposalNotPending` |
| 5 | Daily cap | repeat band-1 trades until the next one reverts `DailyCapExceeded(used, cap)`, with `used` equal to the sum of the logged `amountIn` values |
| 6 | Inference paid | the provider's `redeemWithReceipt` on the account's channel succeeds; `channels(id).paid` increases; the account-signed voucher went through ERC-1271 |
| 7 | Revoke | the owner calls `revokeAgent()`; the next agent `execute` reverts `NotAgent`; the owner's `withdraw` of 1 testUSDG succeeds with a balance delta |

The script fails if any step returns only a transaction hash without its log and balance post-condition.

## 14. Blockers needing the user

1. **Phala Cloud key for the CLI.** The phak_ key in `chiron/.env` is invisible to `phala` unless it is exported as `PHALA_CLOUD_API_KEY` in the deploy subshell, or stored once with `phala login`. Choose one. The Phala Cloud workspace also needs credit: about $1.39 per day for `tdx.small`.
2. **The Confidential AI key inside the CVM.** The agent calls Phala's inference with `PHALA_API_KEY`, which must be set as an encrypted CVM env var. This is the user's decision, because the key then lives in a Phala-hosted TD.
3. **The owner wallet for the demo account.** It must be distinct from the agent key. The proposal is the existing `0x2aD1…5DEF`, and the README must then say the demo owner is ours.
4. **Faucet access.** If the official faucet form shows a captcha or requires a wallet connection in the `deepsurge` tab, the user completes it once for each of the three addresses.
5. **Repo and git identity.** The target repo is `aarav1656/signet`. Confirm the owning account before the first push, per the git identity rule.
6. **Build versus the verdict.** The pivot verdict says "do not build yet" (section 0.4). The build decision stands as the user's; this line records the conflict once.
7. **Mainnet.** Real USDG and Stock Tokens on chain 4663 need an explicit money sign-off, and need the oracle band and hooked-pool questions resolved. They are out of scope here.

## 15. What the README must disclose

- Robinhood Agents framing, exactly as in section 0.1.
- testUSDG is not USDG, and the pool is ours with a price we set (section 0.2).
- The demo owner, the provider wallet and the agent operator are all us. Phala is paid through API credits off chain, and the Assay provider on RHC is our relay wallet, as on Arbitrum Sepolia.
- A receipt records which model answered; it does not prove that the trade follows from the answer (section 6).
- TCB status, QE identity and CRL checks run only on accounts that opt in through `setAttestationPolicy` and register with collateral.
- If the fallback is used, the first-screen statement from section 0.3.
