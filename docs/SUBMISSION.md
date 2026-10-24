# Signet: HackQuest submission fields

Paste each field as written. All fields are plain text. Facts below were read from the repo at the commit that holds this file; contract addresses come from contracts/deployments/46630.json.

## Project name

Signet

## Tagline (under 80 characters)

AI trading agents with a provable record and a private strategy

(63 characters)

## Short description

Signet lets AI trading agents earn followers on a record they cannot fake. A creator runs the agent inside an Intel TDX enclave. Every trade receipt onchain names the exact enclave measurement and model hash that produced it. A follower's AgentAccount trades their Stock Tokens only for code they admitted, inside caps they set. Live on Robinhood Chain testnet.

## Full description

The problem. An AI agent that trades Stock Tokens has to be trusted twice. Followers cannot tell which code is behind a track record, because a creator can change the strategy and keep the name. Creators cannot publish the strategy to prove it, because publishing it gives it away. Robinhood Agents puts approvals and limits around an agent, and Robinhood states it does not audit the agents themselves. So today the choice is between a record you cannot verify and a strategy you cannot keep.

What Signet does. The creator runs the agent inside an Intel TDX confidential VM. The strategy stays inside the enclave and is never published. A Stylus contract on Robinhood Chain verifies the enclave's attestation quote against Intel's root, onchain, in the transaction that admits the agent's key. The account stores that key only if the quote's workload measurement is one the follower approved.

The proof. Every TradeExecuted event carries the TDX workload measurement the agent was admitted under and the model hash from a verified inference receipt. A track record is therefore a list of trades that each name the exact code and model behind them. A different measurement is a different agent, and the chain says so. The attested trade 0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03 shows the attested agent buying TSLA with Paxos testnet USDG, with its measurement and model hash in the event. The refusal 0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8 shows a genuine TDX quote from a different workload being rejected with MeasurementNotApproved.

The follower side. A follower owns an AgentAccount that holds their USDG and Stock Tokens and swaps only through the canonical Uniswap v4 PoolManager. They approve a measurement, set per-token caps and an approval threshold, and allow specific pools. A trade above the threshold becomes a proposal that only the follower can execute, as exactly the trade proposed. Unapproving the measurement revokes the agent in the same transaction. The caps are the safety net: even an admitted agent cannot spend beyond what the follower set, and settlement is checked by balance delta.

Why it matters on Robinhood Chain. Stock Tokens, canonical Uniswap v4 and a Stylus execution environment are all needed: the quote verifier is heavy cryptography that is practical in Stylus, the assets are Robinhood's own Stock Tokens, and the account trades in the chain's own pools. The account also handles the ERC-8056 corporate-action multiplier, so an agent cannot trade a Stock Token while a split is pending.

What is built. AgentAccount and AgentAccountFactory (Solidity), the Stylus TDX Verifier and Ed25519 ReceiptVerifier (Rust), the Assay inference-payment channel, an agent client and CVM keeper, and a web app that reads every figure from the chain. The test suite is 314 forge tests across 21 suites plus 27 agent tests and 40 Stylus crate tests, and a mutation run removes 110 guards one at a time with 109 killed and the remaining one documented as behavior-equivalent.

## Track and prize selections

Select: Robinhood Chain (the Robinhood Chain Innovation Award, open brief).
Select: General track.
Select: Best Promising Products.

## Tech stack

Robinhood Chain testnet (chain 46630), Arbitrum Stylus (Rust, stylus-sdk) for the TDX quote verifier and Ed25519 receipt verifier, Solidity 0.8.28 with Foundry, OpenZeppelin (Ownable2Step, ReentrancyGuardTransient, ECDSA, ERC-1271, SafeERC20), canonical Uniswap v4 PoolManager and PositionManager, Robinhood Stock Tokens (TSLA, ERC-8056), Paxos testnet USDG, Intel TDX with Phala Cloud confidential VMs and Phala Confidential AI receipts, TypeScript with viem and noble-curves for the agent client, React with Vite and wagmi for the web app, Vercel for hosting.

## Deployed contracts on Robinhood Chain testnet (46630)

Explorer base: https://explorer.testnet.chain.robinhood.com/address/

AgentAccount (first account, TestUSDG venue): 0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D
AgentAccount (app default, Paxos USDG, corporate-action guard): 0xFaaAa4d1ee944d317b10233505D8c57425C53b55
AgentAccountFactory: 0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e
AgentAccountFactoryGuarded: 0x14103f1928AB34b45Cc376fF56fb59d798Deed03
AgentAccountFactoryUSDG: 0xB9F7eB234C2F562475668c1Dc9b6850f235373c3
Verifier (Stylus, TDX quote): 0x3c19C10E5C9a82D01ED79E5c6026D73B9b2CAF8c
ReceiptVerifier (Stylus, Ed25519): 0x9AF7D9C3B27c4A8a11Fb879041B931C38B712380
Assay (inference channel): 0x2176E7f20654C8747Fa37b3d96E1ACbf7Df55b5D
TestUSDG: 0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC
TSLA Stock Token (official): 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E
Uniswap v4 PoolManager (canonical): 0x8366a39CC670B4001A1121B8F6A443A643e40951

Key transactions:
Attested trade: 0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03
Refusal of a different workload: 0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8

## Demo link

https://chiron-receipts.vercel.app

## Repo link

https://github.com/pranjalcodesinw3/chiron

## Video link

FOUNDER TO FILL: paste the public video URL here after recording (script in docs/DEMO-VIDEO.md).

## Team

FOUNDER TO FILL: names, roles and handles. Repo commits are authored by aarav1656 and pranjalcodesinw3.

## Product and GTM canvas

Linked from the repo docs (canvas files are owned by a separate lane): see docs/*CANVAS.md.
