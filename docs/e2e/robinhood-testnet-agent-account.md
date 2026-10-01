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
```

The hosted app at https://chiron-receipts.vercel.app reads the account from the chain: it shows the registered agent `0x4a0BCA...8eA8`, the attested measurement, the model pin, one proposal, two executed trades and their model hashes.
