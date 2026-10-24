# Chiron on Robinhood Chain mainnet (4663): runbook

Everything below runs from the repo root with the owner wallet `0x2aD12a72362704367e99a344cFf5affDDF7f5DEF`.
Keys stay in files that the tools read by path; no command here prints one.

## What goes live

| Piece | Source | Mainnet input |
|---|---|---|
| Stylus `Verifier` (TDX DCAP quote check, 38,024 bytes in 2 fragments) | `verifier/` | |
| Stylus `ReceiptVerifier` (Ed25519 receipt check, 19,701 bytes) | `receipt-verifier/` | |
| `Assay` on Paxos USDG | `contracts/src/Assay.sol` | USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals, `symbol()` "USDG") |
| `AgentAccountFactory` and one owner `AgentAccount` with the ERC-8056 guard | `contracts/src/` | canonical v4 PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` (24,009 bytes, same codehash as testnet) |
| TSLA venue | existing pool, nothing created | TSLA `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` ("Tesla • Robinhood Token", 18 decimals, `uiMultiplier` 1e18); pool `0x8517f807...d32e`, hookless, fee 3000, spacing 60, about 370.50 USDG per TSLA |

The pool was chosen by scanning every `Initialize` event of the PoolManager in 10M-block chunks on the public RPC
(4,115 TSLA pools, 43 hookless TSLA/USDG), then reading each pool's in-range liquidity from PoolManager storage
(`extsload` at `keccak256(poolId, 6) + 3`). `0x8517f807` holds 666,422,818,167,788,357; the next holds 20,612,798,403,079.

## Funding the owner wallet

**0.01 ETH and 5 USDG.**

Gas, per step, with the receipt each number comes from:

| Gas | Step | Measured on |
|---:|---|---|
| 14,776,107 | Verifier: fragment 1 (5,736,317), fragment 2 (3,163,589), root (66,386), activation (5,809,815) | testnet receipts `0xfe41a850`, `0xf3f96ccb`, `0xf500c6a6`, `0x51206397` |
| 8,893,753 | ReceiptVerifier: deploy (4,608,733), activation (4,285,020) | testnet receipts `0xb936516b`, `0x062445c2` |
| 9,864,023 | Assay, factory, `createAccount`, `setLimits` x2, `setPool`, `setModel`, `setMeasurement` | this script on an anvil fork of mainnet block 78,599,098 |
| 231,461 | `openInferenceChannel` | testnet receipt `0xed6e42b7` |
| 60,000 | USDG transfer into the account | estimate |
| 4,821,648 | gateway `register` + `registerReceiptKey` on the new Assay | testnet receipts `0x58bd59e2`, `0x59ce051f` |
| 2,461,586 | first `registerAgent` | testnet receipt `0xec2e5aba` |
| 65,549,106 | daily renewals to the CVM stop on Oct 12: `registerAgent` x9 and the gateway pair x9 | the same receipts |
| 10,088,980 | 20 agent trades (504,449 each), sent to the agent key as gas | testnet receipt `0x0023f359` |
| **116,746,664** | **total** | |

Price: mainnet `eth_gasPrice` read 31,488,000 wei (0.0315 gwei), floor `getMinimumGasPrice` 0.02 gwei, and
`ArbGasInfo.getL1BaseFeeEstimate` 0, so a transaction costs gas times price with no L1 surcharge. Testnet receipts
carry an L1 component (for example 295,572 of the ReceiptVerifier deploy), so the testnet-measured lines run high
for mainnet. At a planning price of 0.05 gwei the gas is 0.005837 ETH; at today's price it is 0.003678 ETH.

Stylus activation data fee: `cargo stylus` measured 0.000198 ETH (Verifier) and 0.000123 ETH (ReceiptVerifier) on
testnet, already including its 20% bump (`contracts/deployments/46630-*.log`). The fee comes from ArbOS's data
pricer, so the budget carries three times that, 0.000963 ETH. `cargo stylus check` prints the exact mainnet figure
as the first step of the deploy, once the key is funded.

Budget: 0.0068 ETH at 0.05 gwei, funded as **0.01 ETH**. USDG: 3 into the account (one 1 USDG trade with headroom
under the 2 USDG approval line) and 1 into the inference channel, funded as **5 USDG**.

## Command sequence

1. Build the agent image with the chain id in its environment and push it (`agent-cvm/build-image.sh <ref>`), then
   deploy a mainnet CVM from a compose file with `RHC_CHAIN_ID: "4663"`,
   `RHC_RPC_URL: "https://rpc.mainnet.chain.robinhood.com"` and the account address from step 3 (the CVM quotes for any account; this one is only its default). A second CVM bills
   about 0.061 USD per hour on Phala Cloud, the same as the testnet one.
2. Stylus programs:
   ```
   RHC_CHAIN_ID=4663 RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com PRIVATE_KEY_PATH=<owner key file> \
     contracts/script/rhc/deploy-stylus.sh
   ```
   It refuses any RPC whose chain id is not 4663, runs `cargo stylus check` (prints the data fee), deploys and
   activates both programs, and requires `Verifier.verify` to revert on a stored quote under a foreign nonce.
   `ESTIMATE=1` stops after the check and the gas estimate.
3. Gateway measurement and the rest of the stack:
   ```
   cd contracts
   VERIFIER=<step 2> RECEIPT_VERIFIER=<step 2> \
   GATEWAY_MEASUREMENT=0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149 \
   ACCOUNT_USDG=3000000 CHANNEL_DEPOSIT=1000000 PROVIDER=<provider address> \
   forge script script/rhc/DeployChironMainnet.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
     --private-key-path <owner key file> --broadcast --slow
   ```
   The script requires chain 4663, the canonical PoolManager codehash, the pool key hashing to `0x8517f807...d32e`,
   a non-empty pool, and code at both verifiers. It writes `contracts/deployments/4663.json`.
4. Register Phala's gateway signer and receipt key on the new Assay. `register` sends from `PROVIDER_PRIVATE_KEY`;
   registration is permissionless (the signer comes from the quote), so point it at the owner key and one wallet pays:
   ```
   cd agent && CHAIN_ID=4663 RPC_URL=https://rpc.mainnet.chain.robinhood.com ASSAY_ADDRESS=<Assay> \
     node --env-file-if-exists=../.env src/index.ts register
   ```
5. Admit the agent: approve the mainnet CVM's measurement and register it (`setMeasurement` is skipped when the
   script already received `AGENT_MEASUREMENT`):
   ```
   cd agent && RHC_CHAIN_ID=4663 RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com OWNER_PRIVATE_KEY=... \
     ACCOUNT_ADDRESS=<AgentAccount> CVM_URL=<mainnet CVM> npm run acct-register
   ```
6. Add the account to the keeper's `ACCOUNTS` with `RHC_RPC_URL` set for it, and add a mainnet pass to
   `agent-cvm/register-keys.sh` for the new Assay.

## Checks after the deploy

- `cast codesize` of both Stylus programs is non-zero and starts `0xeff0`.
- `Assay.usdg()` is `0x5fc5...d168` and `approvedMeasurement(0xfd34...0149)` is true.
- `AgentAccount.owner()`, `assay()`, `usdg()`, `allowedPool(0x8517...d32e)`, `CORPORATE_ACTION_COOLDOWN()` (86400),
  `requestedModelHash()` (keccak of the Qwen model id) read back as set; the script already requires each of these.
- After step 5: `agent()` is the CVM key, `agentExpiry()` is about 24 hours ahead, and a `registerAgent` with a
  quote from different code reverts `MeasurementNotApproved` (repeat the testnet stolen-signer check with a Phala
  gateway quote over the mainnet account's nonce).
- `readTour.test.ts` style: each mainnet transaction read back with `cast receipt <hash> status`.

## Rehearsal on a mainnet fork

`anvil --fork-url <Alchemy mainnet archive>` at block 78,599,098 (chain id 4663), owner impersonated with a fork-only
balance:

- `DeployChironMainnet.s.sol` ran end to end: Assay `0x3c19...AF8c`, factory `0x7E3D...f8A0`, account
  `0xd42F...B036`, every read-back requirement held (`contracts/deployments/4663-fork-rehearsal.json`).
- Admission on the fork: with an unapproved measurement `registerAgent` reverted `0x98085a9f`
  (`MeasurementNotApproved`); with the approved one it succeeded, `agent()` set and `agentExpiry()` 24 hours ahead.
- Anvil executes EVM bytecode only, so the fork ran with EVM stand-ins at the verifier addresses
  (`test/mocks/MockVerifier.sol`, `MockReceiptVerifier.sol`) and `test/mocks/ArbSysDouble.sol` at the ArbSys
  precompile `0x64`. The Stylus deploy, activation and the real quote check run on mainnet itself in step 2; their
  gas comes from the testnet receipts above, the same programs on the same ArbOS version (116) and Stylus version (3).
- An `eth_call` of `ArbWasm.activateProgram` with state overrides reverts on both RPCs, including for programs that
  activated on testnet, so the mainnet data fee is read by `cargo stylus check` at deploy time.

## The hosted app on mainnet

The app reads one Robinhood chain, generated from `contracts/deployments/46630.json` by `web/scripts/sync-assay.mjs`
(`RHC_CHAIN_ID`, `RHC_EXPLORER_URL`, account, factory, Assay, tour transactions). Mainnet goes live as a second
Vercel project built from `contracts/deployments/4663.json` once it holds the mainnet transactions the tour reads
(admission, refusal, trade), with the chain block in `web/src/chain.ts` pointed at `https://rpc.mainnet.chain.robinhood.com`
and the explorer `https://robinhoodchain.blockscout.com`. The testnet app stays as it is, with its full lifecycle.
