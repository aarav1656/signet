# Attested agent live cycle, Robinhood Chain testnet (46630)

Account `0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D`, owner `0x2aD12a72362704367e99a344cFf5affDDF7f5DEF`, Stylus `Verifier` `0x3c19C10E5C9a82D01ED79E5c6026D73b9b2CAF8c`. Run on 2026-10-01 (blocks 127175982 to 127177130). The agent key is generated inside a Phala Cloud dstack CVM and signs every agent-side transaction there; the owner key signs only owner transactions, from the operator machine, and is never in the CVM. Every transaction below was re-read with `cast receipt <hash> status --rpc-url https://rpc.testnet.chain.robinhood.com`; the record with block numbers is `contracts/deployments/46630.json` (`liveCycle`, `agentCvm`, `accountModel`).

## The CVM

| Field | Value |
|---|---|
| Platform | Phala Cloud, `tdx.small`, node prod5 (US-WEST-1), OS `dstack-0.5.9` (not a dev image), app id `e39de5552f988e69e573236137089c81cfbe21d9` |
| Image | pinned by digest in `agent-cvm/docker-compose.yml`: `sha256:a3a879b15202376a24e30e2b593ab9a5b271d2046413f62f39b043614ab3212e`, built by `agent-cvm/build-image.sh` from `agent/src/cvm.ts` |
| Compose hash (RTMR3 input) | `c3103c1d27fae754b023c075567b556625353098992493299535f1b276acad7c` |
| Account and RPC | fixed in the compose file, so they are measured |
| Agent key | generated in memory at boot, address `0x4a0BCAE7f9969EA0f224E69F4b8778A69Df78eA8`, never written out |
| Quote | 5,010 bytes, `report_data` = agent (20) \|\| zero (12) \|\| `attestNonce(refBlock)` (32); `agent/test/cvm.test.ts` checks these bytes against the chain's own nonce |
| Measurement the Verifier returned | `0x9dfd5de3a81d9aa78ab912b6a759c934ba79a20cf86ac57163d05ea4a5b364c8` |

## Admission

| Step | Transaction | Block | Result |
|---|---|---|---|
| Verifier accepts the CVM quote | `cast call Verifier verify(bytes,bytes32)` with the CVM quote and its nonce | refBlock 127175773 | signer `0x4a0BCAE7...78eA8`, measurement `0x9dfd5de3...b364c8` |
| Owner approves the measurement | [`0x6512a61b...f892e0`](https://explorer.testnet.chain.robinhood.com/tx/0x6512a61b07949d06b349e52bfc63e86ae6599e5105322f4276f5ea8da6f892e0) | 127176102 | success, `approvedMeasurement` true |
| `registerAgent(quote, refBlock)` | [`0x1f15df28...a68134`](https://explorer.testnet.chain.robinhood.com/tx/0x1f15df28041e7b8938ca6653eb5a75231f525568ab015644ec535796caa68134) | 127176129 | success, 2,584,842 gas; `agent()` = the CVM key, `agentMeasurement()` = the measurement above, `agentExpiry()` = 1790951403 |

## Trades

All three agent calls carry a real Phala Confidential AI receipt (requested `meta-llama/llama-3.3-70b-instruct`, served `llama3-3-70b`, key `110f3824...aa0a` registered on Assay under the gateway measurement), verified locally and then on chain by the account.

| Step | Transaction | Block | Result |
|---|---|---|---|
| (a) in-cap buy, 1.000000 testUSDG | [`0xe5052266...ddfa2`](https://explorer.testnet.chain.robinhood.com/tx/0xe50522661b55c797071b56e43aaf2bc91d37c9745a295ff6a5976883dd4ddfa2) | 127176968 | success; `TradeExecuted` tradeId 1, `amountIn` 1000000, `amountOut` 3984027527308004 TSLA (minOut 3944187252034923), `servedModelHash` `0xc8536dbf...78df59`, `agentMeasurement` `0x9dfd5de3...b364c8`; account balance deltas equal the logged amounts |
| (b) over-cap, `amountIn` = perTrade + 1 | [`0xb1adb723...12528c`](https://explorer.testnet.chain.robinhood.com/tx/0xb1adb7231fbd38b77489769d7db754b30f36fa9b1ba97bf14f51980f3b12528c) | 127177045 | `cast receipt` status 0 (reverted); the `eth_call` decodes `ExceedsPerTradeCap(10000001, 10000000)`; balances unchanged |
| (c) above the approval threshold, `propose` | [`0x4eb49253...895253`](https://explorer.testnet.chain.robinhood.com/tx/0x4eb4925389368436722b89721dd5db7e28b128923118dfa797e9a7cf42895253) | 127177110 | success; `execute` of the same trade reverts `NeedsApproval`; `TradeProposed` proposal 1, `tradeHash` `0xef014356...f8896f`, `servedModelHash` `0xc8536dbf...78df59` |
| (c) owner `approveTrade(1, trade)` | [`0x7f2a63f4...c4d81ead`](https://explorer.testnet.chain.robinhood.com/tx/0x7f2a63f44c439d6099133bad32da8f346414f66f2f8541a3fedca496c4d81ead) | 127177130 | success; `TradeExecuted` tradeId 2, proposalId 1, `amountIn` 2000001, `amountOut` 7944291302953708 TSLA; a second `approveTrade` reverts `ProposalNotPending`; proposal 1 status Executed (2) |

Read-back after the cycle: `tradeCount` 2, `proposalCount` 1, account testUSDG 104000000 to 100999999 (down 3000001 = 1000000 + 2000001), account TSLA 1000100000000000000 to 1012028318830261712 (up 3984027527308004 + 7944291302953708 = 11928318830261712).

## Supporting transactions

| Step | Transaction | Block |
|---|---|---|
| Owner sends the CVM agent key 0.0002 ETH for gas | [`0xe218cf1e...cace56`](https://explorer.testnet.chain.robinhood.com/tx/0xe218cf1ed290931c4e264d248d561c0520168506fbc91dc3ec56890065cace56) | 127175982 |
| Owner `setModel`: receipt pin `meta-llama/llama-3.3-70b-instruct`, accepted served `llama3-3-70b` | [`0x22a1883e...d2204f`](https://explorer.testnet.chain.robinhood.com/tx/0x22a1883e013ca5e4c1e41167ef24bce5b6919cc6e07ddce328d6cbfa7fd2204f) | 127176866 |

## Reproduce

```
cd agent
CVM_URL=https://<app-id>-8080.<gateway> CVM_CONTROL_TOKEN=... OWNER_PRIVATE_KEY=... ACCOUNT_ADDRESS=0x9c69... npm run acct-register
... npm run acct-trade
... npm run acct-overcap
... npm run acct-approve
... npm run acct-revoke
QUOTE_TOKEN=0x7E955252E15c84f5768B83c41a71F9eba181802F ... npm run acct-trade   # Paxos USDG
```

The hosted app at https://chiron-receipts.vercel.app reads the account from the chain: it shows the registered agent, the attested measurement, the model pin, one proposal, three executed trades and their model hashes.

## Revoke by measurement

The CVM boots with a key and a measurement of its own: this boot's agent is `0xdd241EC759Ec0BA4A1d08C8bf19FC4a8a6aEA5c7`, its measurement `0xeb2d9462332712d80fc18b2a8c07124096b55c3f94a8c8de6ff34692e9396829`, from the same app, compose file and image. `npm run acct-revoke` runs the owner withdrawing trust and the agent trying to trade afterwards. Every transaction was re-read with `cast receipt <hash> status --rpc-url https://rpc.testnet.chain.robinhood.com`.

| Step | Transaction | Block | Result |
|---|---|---|---|
| Owner sends the agent key 0.0003 ETH for gas | [`0x137a85e3...4a64`](https://explorer.testnet.chain.robinhood.com/tx/0x137a85e3c0ef3fd91c2ce2b116794743a1a9cba3f9c73d6161e144e13d1d4a64) | 127186611 | success |
| Owner approves the measurement | [`0xe02b6d61...ff69`](https://explorer.testnet.chain.robinhood.com/tx/0xe02b6d61239ea920589b0abdc8bc48f814e6c66f2baa5ca94cd1529f4a2aff69) | 127186697 | success, `approvedMeasurement` true |
| `registerAgent` with the CVM quote | [`0x06ed38eb...56c3`](https://explorer.testnet.chain.robinhood.com/tx/0x06ed38eb1fc614f1319b377bda6ce74a9b02909f9b838fc14e911b1d8a4a56c3) | 127186719 | success, `agent()` = the key above |
| Owner `setMeasurement(0xeb2d...6829, false)` | [`0x0b34701e...8382`](https://explorer.testnet.chain.robinhood.com/tx/0x0b34701eaee5f698b39988a13810e835abee437363093ebc8949ae89bc258382) | 127187329 | success, one `AgentRevoked` for the agent, `agent()` and `agentMeasurement()` read zero at that block, `approvedMeasurement` false |
| The revoked agent calls `execute` (in-cap, 1 USDG, with a real Phala receipt) | [`0xc0b2e5bc...1e08`](https://explorer.testnet.chain.robinhood.com/tx/0xc0b2e5bc95048ad424a246277a819dfad0238b394ba4bf08cf9dc0231c7e1e08) | 127187358 | `cast receipt` status 0 (reverted); the same call by `eth_call` decodes `NotAgent()`; account balances at blocks 127187357 and 127187358 are equal |
| Owner `setMeasurement(0xeb2d...6829, true)` | [`0xc5e5bb9b...7822`](https://explorer.testnet.chain.robinhood.com/tx/0xc5e5bb9bc3e4ca17ace0b52c4352d5ae7cfed1a9a7a8a43b5f7d229fd6447822) | 127187371 | success, `agent()` is still zero: approval alone does not re-admit |
| `registerAgent` with a fresh CVM quote | [`0x4694b617...9a66`](https://explorer.testnet.chain.robinhood.com/tx/0x4694b617f4bafbd0e3a3f2a09dbe11b5afd0f96fc4023393aaf516ce68f69a66) | 127187385 | success, `agent()` = the key above again |
| Owner unapproves the earlier boot's measurement `0x9dfd5de3...b364c8` | [`0xa1ca94aa...5149`](https://explorer.testnet.chain.robinhood.com/tx/0xa1ca94aa286ebc2d2751e9f8df6b30e501d99b0c5d7bb8cb10509f2f78765149) | 127189110 | success, that boot's key is no longer admissible under it |

## Real USDG

Paxos's testnet USDG on Robinhood Chain, `0x7E955252E15c84f5768B83c41a71F9eba181802F` (6 decimals, `name()` "Global Dollar"), is the quote asset for a second pool and a second set of limits on the same account. `AgentAccount` trades any token the owner gave limits and any hookless pool the owner allowed, so the account itself needs no change; `contracts/script/rhc/AddUSDGVenue.s.sol` creates the TSLA/USDG pool and configures the account in one resumable script.

| Step | Transaction | Block | Result |
|---|---|---|---|
| Account `withdraw`s 0.2 TSLA to the owner | [`0xf3f94216...70df`](https://explorer.testnet.chain.robinhood.com/tx/0xf3f942162cdb78b82e4b75b3723bd40c7692ab956a3dfe17fd02b3f3570870df) | 127188194 | success |
| `PoolManager.initialize` for hookless 0.3% TSLA/USDG at 250 USDG per TSLA | [`0x153afe06...9499`](https://explorer.testnet.chain.robinhood.com/tx/0x153afe0655f12e64710fc2b816f4831c99d0027c32cf2629080f224571169499) | 127188201 | success, pool id `0x38f88da1...94ba384b` |
| Full-range position, about 49.995 USDG and 0.2 TSLA | [`0x81e7fc85...3cf9`](https://explorer.testnet.chain.robinhood.com/tx/0x81e7fc856b46cb01ff433a85dfd5694990404e2ca7eacba7bc9b400aa5b23cf9) | 127188629 | success, pool liquidity 3161961432401 |
| Owner `setLimits(USDG)`: per trade 10 USDG, daily 5 USDG, approval above 2 USDG | [`0x251ef5cc...422c`](https://explorer.testnet.chain.robinhood.com/tx/0x251ef5cce13680cb8ba1f99b1b922d362ef0367ba1d30215672d4fb39b31422c) | 127188646 | success, `limits(USDG)` read back |
| Owner `setPool` for the TSLA/USDG key | [`0xff7b103d...df53`](https://explorer.testnet.chain.robinhood.com/tx/0xff7b103d718067b7759ab4c37c93bedb7bfedfee44033afc648b3872d516df53) | 127188657 | success, `allowedPool` true |
| Owner deposits 5 USDG into the account | [`0xf4110700...f993`](https://explorer.testnet.chain.robinhood.com/tx/0xf41107005b7af474f5107026daa0b76f4267c5ee0f39935980eb2fe46721f993) | 127188667 | success, account USDG 5000000 |
| The attested agent buys TSLA with 1 USDG (`QUOTE_TOKEN=0x7E95...802F npm run acct-trade`) | [`0x0023f359...3b03`](https://explorer.testnet.chain.robinhood.com/tx/0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03) | 127188951 | success; `TradeExecuted` tradeId 3, `tokenIn` the real USDG, `amountIn` 1000000, `amountOut` 3910026278631909 TSLA (minOut 3870926015845589), `agentMeasurement` `0xeb2d...6829`, served model hash `0xc8536dbf...78df59`; account USDG 5000000 to 4000000 and TSLA 812028318830261712 to 815938345108893621 across that block |

At most 55 USDG is in play: about 49.995 USDG in the pool position and 5 USDG in the account. The Assay deployment on this chain takes its token at construction, as does the account's inference-channel token, so the inference channel on this account bills in TestUSDG; Assay on Arbitrum Sepolia bills in Paxos USDG (README, "Inference billing").

## Third boot and two replayable refusals (2026-10-02)

The CVM was restarted at 14:03:15 UTC: agent `0x00e052627F691ca075BCd0dbc7220B5708551579`, measurement `0x0793ff52158fe39bc866db8fbf1f828906fd5f7ab628007586b5fea5ef9431b0`. Every hash below was re-read with `cast receipt <hash> status`; revert reasons were decoded by replaying the mined calldata as `eth_call` at the parent block.

| Step | Transaction | Block | Result |
|---|---|---|---|
| Owner `setMeasurement(0x0793...31b0, true)` | [`0x2186a1c6...93f7`](https://explorer.testnet.chain.robinhood.com/tx/0x2186a1c6fe7e3b2257a991e4e6ad6c59a24ecc4b03786b26d7309b79942f93f7) | 127631365 | success |
| `registerAgent` with the CVM quote | [`0x470b7b86...029e`](https://explorer.testnet.chain.robinhood.com/tx/0x470b7b86b5b55b1fc29c0369acdbc2cdc0bb0bf21d34b5a982e3ffd03867029e) | 127631393 | success, `AgentRegistered`, `agentExpiry()` 1791036260 |
| Keeper `registerAgent` (`agent-cvm/keeper.sh` under launchd) | [`0xbb5b3f02...f119`](https://explorer.testnet.chain.robinhood.com/tx/0xbb5b3f0236640f4fca532fe793e1dd205281def2ee19c39b4c6bef842e74f119) | 127631689 | success, `agentExpiry()` 1791036260 to 1791036303 |
| Stolen signer: Phala gateway TDX quote over this account's `attestNonce(127632376)` to `registerAgent` | [`0xf98156ad...fcc8`](https://explorer.testnet.chain.robinhood.com/tx/0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8) | 127632496 | status 0, 2,348,030 gas, `MeasurementNotApproved(0xfd34caab...0149)` (signer `0x79a5061e...6b79`), `agent()` unchanged |
| Assay (`0x2176E7f2...5b5D`) `openChannel` pinned to `phala/qwen3.8-27b-uncensored` | [`0x7770a689...a9f2`](https://explorer.testnet.chain.robinhood.com/tx/0x7770a689e6c7445d43b64cbcabb665e4924b62412562bf6b9274fed61818a9f2) | 127634074 | channel 1, 1 testUSDG |
| `redeemWithReceipt` on channel 1 with the first trade's Phala receipt (key `0x110f3824...aa0a`, served `llama3-3-70b`) | [`0xfe0f13f0...8eab`](https://explorer.testnet.chain.robinhood.com/tx/0xfe0f13f09e8dc00f99ad8d94024352a127f21150a9340497d3288aec96818eab) | 127634120 | status 0, `ModelMismatch()` `0xa407e5f7`, channel 1 paid 0 |
| Assay `register` / `registerReceiptKey` (gateway key renewal on this chain) | [`0x58bd59e2...56ea`](https://explorer.testnet.chain.robinhood.com/tx/0x58bd59e26b1919af33d4b55e9788914c32955c59394022c7d426ad22755356ea), [`0x59ce051f...041b`](https://explorer.testnet.chain.robinhood.com/tx/0x59ce051f7533270c77080cb878d08c780a5ecb16cb2f2de7ff85581942af041b) | 127634677, 127634712 | receipt key expiry 1791036744 |

## Fourth boot: control token in the sealed env (2026-10-02)

`phala deploy --cvm-id 7f2efb7f-bd87-4d25-9002-870df3018009 -c agent-cvm/docker-compose.yml -e <env file>` replaced the sealed `CONTROL_TOKEN` (same compose file and image digest; update took 63 s). `/tx` answers 401 to a wrong bearer and accepts the operator's. The boot minted agent `0xc662FFE967a845dCB96b75333b6C5853355f93E6` under measurement `0xe1a2b8938825d678136ad8a4841e6f0f97a3e2c91c330cb85364de26c40ab6d0`.

| Step | Transaction | Block | Result |
|---|---|---|---|
| Owner `setMeasurement(0xe1a2...b6d0, true)` | [`0x3ef0c655...7450`](https://explorer.testnet.chain.robinhood.com/tx/0x3ef0c65562fb503b68b72fc226fb89fa49c1ebfc207d69368a174fd630807450) | 127642863 | success |
| `registerAgent` with the CVM quote | [`0xa45b46c6...9798`](https://explorer.testnet.chain.robinhood.com/tx/0xa45b46c61c579c083eea5a5b044f343ad847b64ddfdae356758b6e9ac1b89798) | 127642898 | success, `agentExpiry()` 1791037950 |
| Owner sends the agent key 0.0005 ETH for gas | [`0x3abc88a8...8bfe`](https://explorer.testnet.chain.robinhood.com/tx/0x3abc88a8feacc42e0daeb108c16301648830f2a8a2d2adeacf830503419a8bfe) | | success |

`agent-cvm/register-keys.sh` re-registers the gateway signer and receipt key on all three Assays (Arbitrum Sepolia, Robinhood Chain testUSDG `0x2176...5b5D`, Robinhood Chain Paxos USDG `0xcF4a...3f9d`); each pass runs whether or not an earlier one failed.

## Operator agent serving two client accounts (2026-10-02)

`agent/src/cvm.ts` takes `?account=` on `/quote` and `account` on `/tx`, and answers `/info` and `/quote` cross-origin. Image `ttl.sh/chiron-agent-5ee4c1c6b5d1@sha256:01f18671...1463` (built by `agent-cvm/build-image.sh` with crane 0.22.1, release checksum verified), deployed to the same CVM with `phala deploy --cvm-id`. Agent `0x71f15e33d967F9b0d573Cb03CfE3e7fdBDFd3461`, measurement `0x993bd67c8e9de5d37d9af6ef41c5c5fdb53b113b8a2b666827e0e619f4978e9a`.

| Step | Transaction | Block | Result |
|---|---|---|---|
| Account 1 owner `setMeasurement(0x993b...8e9a, true)` | `0x04ec2e370aa393624ed55c0b0b6679f5a4b8c69063af5af62676536ea242396a` | 127666588 | success |
| Account 1 `registerAgent` | `0x2889f10bf20edff1fa512f52b99d3eb76ac903becdc9410c70a13e11abded196` | 127666613 | agent `0x71f1...3461`, expiry 1791041598 |
| `AgentAccountFactory.createAccount(owner)` | `0xbb77ffc9a2e5f5cda88e9176a0417758da30c9b8dd8e918dee15cb3d5824dae5` | | account 2 `0xE1d7939105cF8B3670d6b4a0E15546C036e6c34c` |
| Account 2 `setMeasurement`, `registerAgent` | `0x12b819825766c94efb8f78c7637f56e535c5d68244df1b6c5a9294f51071003f`, `0xdb52757ab39240be57a4aebd3980a57d4bb8c4d8601722e2774f32ab8f87f04e` | 127666678, 127666698 | same agent, expiry 1791041611 |
| Account 2 `setMeasurement(0x993b...8e9a, false)` | `0x1d34d37a52a7e099a9741ffa2ff04fbd0e09e9dabefb5731a0f93cee635b8008` | 127666780 | at 127666780: account 2 `agent()` zero; account 1 `agent()` `0x71f1...3461`, measurement still approved there |
| Account 2 re-approve, re-admit | `0x47eb49a788edcd1ec319fb5dd0457809c7dae3ac492262669527205ac9acc17e`, `0x8737f5cb2d091b154af0a722ebd1dc2bea1c891cbdeb9730ae1afffbd9487806` | 127666840, 127666867 | admitted again |
| Keeper (launchd, window forced) renews both | `0x20209f03a0232b7db7406b69ab68c265340e0d316688ad71aea29089768f5555`, `0xb6e4dc44288956d22d443ff137326932b1093e484a7e6bc8bc57f59dbc90aa4e` | 127667386, 127667473 | both `agentExpiry()` moved forward |
