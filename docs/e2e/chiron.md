# Chiron end-to-end test, Arbitrum Sepolia (421614)

Current deployment record: `contracts/deployments/421614.json`. Redeployed 2026-09-28 from
owner wallet `0x2aD12a72362704367e99a344cFf5affDDF7f5DEF`. All addresses and tx hashes below
were re-verified with `cast receipt <tx> status --rpc-url https://sepolia-rollup.arbitrum.io/rpc`
against a running chain tip of block 313704451; each matched the `status=true` and block number
already on record. The prior deployment (old Assay, old Verifier, older Assay, TestUSDG) is
superseded and dropped from this document; it is not referenced by any current address.

## Contracts

| Step | Command | Result | Explorer |
|---|---|---|---|
| Verifier (Stylus TDX DCAP) deploy | `cast receipt 0x44821001ca69e7d8253707be4950459163e009692fc2353790ee52e39342d8e3 status` | `true`, block 313673523 | [tx](https://sepolia.arbiscan.io/tx/0x44821001ca69e7d8253707be4950459163e009692fc2353790ee52e39342d8e3) |
| Verifier activation | `cast receipt 0x3dff160a324bb673df2e7ede56791a121985f5e3d35891601501797962f390b8 status` | `true`, block 313673561; 37.9 KB in 2 fragments, wasm data fee 0.000198 ETH | [tx](https://sepolia.arbiscan.io/tx/0x3dff160a324bb673df2e7ede56791a121985f5e3d35891601501797962f390b8) |
| Verifier address | | `0x3c19c10e5c9a82d01ed79e5c6026d73b9b2caf8c` | [address](https://sepolia.arbiscan.io/address/0x3c19c10e5c9a82d01ed79e5c6026d73b9b2caf8c) |
| ReceiptVerifier (Stylus Ed25519) deploy | `cast receipt 0x834e701d88fabcdef7c44ac4334f8853e4a41f41ed0d7a3e4f2b97bfa333c4b6 status` | `true`, block 313674048 | [tx](https://sepolia.arbiscan.io/tx/0x834e701d88fabcdef7c44ac4334f8853e4a41f41ed0d7a3e4f2b97bfa333c4b6) |
| ReceiptVerifier activation | `cast receipt 0xf45b75d21cf08e75e6268db6cbb9bbd835a66b029aa8bd4d57bc9d984f98b5b0 status` | `true`, block 313674059; 19.6 KB | [tx](https://sepolia.arbiscan.io/tx/0xf45b75d21cf08e75e6268db6cbb9bbd835a66b029aa8bd4d57bc9d984f98b5b0) |
| ReceiptVerifier address | | `0x9af7d9c3b27c4a8a11fb879041b931c38b712380` | [address](https://sepolia.arbiscan.io/address/0x9af7d9c3b27c4a8a11fb879041b931c38b712380) |
| Assay deploy | `cast receipt 0xc70abfb4accd810744c5490efb4af441264ff95abf4cda15fa0905d0e4bfb42f status` | `true`, block 313674296 | [tx](https://sepolia.arbiscan.io/tx/0xc70abfb4accd810744c5490efb4af441264ff95abf4cda15fa0905d0e4bfb42f) |
| Assay address | | `0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC` | [address](https://sepolia.arbiscan.io/address/0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC) |
| Assay Sourcify verification | Sourcify v2 lookup | `exact_match` for both creation and runtime bytecode | n/a |
| Assay readback | `cast call ... usdg()/verifier()/receiptVerifier()/attestationValidity()/channelTimeout()/challengeWindow()/approvedMeasurement(...)` | usdg `0xFFC95faa3d63Cde504a05B567C600B78C0b41892` (Paxos USDG), verifier and receiptVerifier as above, attestationValidity `86400`, channelTimeout `3600`, challengeWindow `3600`, `approvedMeasurement(0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149)` = `true` | [Assay](https://sepolia.arbiscan.io/address/0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC) |

## Attestation

| Step | Command | Result | Explorer |
|---|---|---|---|
| Fresh Phala quote | `GET /v1/attestation/report` (nonce random) | verified on the new Verifier to signer `0x79A5061efe5A46b0d1F33B11Cf1c5adbEDAe6B79`, measurement `0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149` | n/a |
| ReceiptVerifier eth_call | `eth_call verifyReceipt` on `fixtures/receipt_vectors.json` | `(true, requested, served, request 0xaa.., response 0xbb..)` for honest, served `0x8f03...` for model_swap, `false` for a tampered signature; read at about block 313674174 | [ReceiptVerifier](https://sepolia.arbiscan.io/address/0x9af7d9c3b27c4a8a11fb879041b931c38b712380) |

## Provider funding and registration

| Step | Command | Result | Explorer |
|---|---|---|---|
| Provider wallet funded | owner sends 0.005 ETH | `0x93e82363e3481039d2F8Ee3e4b4263B6D141EE5A` funded | [tx](https://sepolia.arbiscan.io/tx/0xf467275c260e6cdab2c86b1cacaa2ccac740dd62ef9576ef541a1d809fe99a6f) |
| Funding tx status | `cast receipt 0xf467275c260e6cdab2c86b1cacaa2ccac740dd62ef9576ef541a1d809fe99a6f status` | `true`, block 313674952 | [tx](https://sepolia.arbiscan.io/tx/0xf467275c260e6cdab2c86b1cacaa2ccac740dd62ef9576ef541a1d809fe99a6f) |
| `npm run register` (agent/, provider) | Assay.register | stored `signers(0x79a5...6b79)` = measurement `0xfd34...0149`, expiry `1790702137` | [tx](https://sepolia.arbiscan.io/tx/0xaf4218b965aea5b0086a45f12680920411935548698bbebfbe2f085b3bb80d59) |
| Register tx status | `cast receipt 0xaf4218b965aea5b0086a45f12680920411935548698bbebfbe2f085b3bb80d59 status` | `true`, block 313675089 | [tx](https://sepolia.arbiscan.io/tx/0xaf4218b965aea5b0086a45f12680920411935548698bbebfbe2f085b3bb80d59) |
| `npm run register` registerReceiptKey | Assay.registerReceiptKey | stored `receiptSigners(0x110f3824daeeef29dbeba9677a5794ffed257b1082d9fd4599b3c0819953aa0a, key_id dstack-kms-receipt-ed25519-v1)`, same measurement, expiry `1790702143` | [tx](https://sepolia.arbiscan.io/tx/0xdff86c7c326ffa23738ec12fc9e7a7c3c930453298c28d7ce26322888a13ef1f) |
| registerReceiptKey tx status | `cast receipt 0xdff86c7c326ffa23738ec12fc9e7a7c3c930453298c28d7ce26322888a13ef1f status` | `true`, block 313675112 | [tx](https://sepolia.arbiscan.io/tx/0xdff86c7c326ffa23738ec12fc9e7a7c3c930453298c28d7ce26322888a13ef1f) |

## Channels

| Step | Command | Result | Explorer |
|---|---|---|---|
| `npm run open` channel 0 (receipt-only) | Assay.openChannel, owner wallet | pinned to `meta-llama/llama-3.3-70b-instruct` (hash `0x245e10b5c3befa4510d11cba0fe4ad1aa3dc9f8def21eb6287a846f8c0b47b9a`), block 313676162, deposit `2000000` | [tx](https://sepolia.arbiscan.io/tx/0x61fffc011aeee16cce4a8075f606bb58d6b05038a7b8d6921460a26db5cacbd2) |
| Channel 0 tx status | `cast receipt 0x61fffc011aeee16cce4a8075f606bb58d6b05038a7b8d6921460a26db5cacbd2 status` | `true`, block 313676162 | [tx](https://sepolia.arbiscan.io/tx/0x61fffc011aeee16cce4a8075f606bb58d6b05038a7b8d6921460a26db5cacbd2) |
| `npm run open` channel 1 (legacy-only) | Assay.openChannel, owner wallet | block 313676207, deposit `2000000` | [tx](https://sepolia.arbiscan.io/tx/0xb06dae3711bce5b151ea7fb6af0b30a94d37186cd00bb4b06cd7e9460bfd2652) |
| Channel 1 tx status | `cast receipt 0xb06dae3711bce5b151ea7fb6af0b30a94d37186cd00bb4b06cd7e9460bfd2652 status` | `true`, block 313676207 | [tx](https://sepolia.arbiscan.io/tx/0xb06dae3711bce5b151ea7fb6af0b30a94d37186cd00bb4b06cd7e9460bfd2652) |
| USDG `balanceOf(Assay)` equals both deposits | `cast call 0xFFC95faa3d63Cde504a05B567C600B78C0b41892 "balanceOf(address)(uint256)" 0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC` | `4000000` | [Assay](https://sepolia.arbiscan.io/address/0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC) |

## Paid redeem

| Step | Command | Result | Explorer |
|---|---|---|---|
| Open channel 2, pinned to `phala/qwen3.8-27b-uncensored` | `agent` `npm run open` | channel 2, deposit 2000000, block 313984561 | [0x3ebe01a4...a019](https://sepolia.arbiscan.io/tx/0x3ebe01a4c23a3359599d6ba4c13653b1c5f71649247b02bd7209fe891008a019) |
| Receipt-gated paid redeem, call 1 | `agent` `npm run pay-receipt` (RedPill, 8 output tokens) | receipt served == requested == pinned; status true, gas 301,058, block 313984768 | [0x16270367...a55d](https://sepolia.arbiscan.io/tx/0x16270367e3c3e563bd4433d9cb33d9bdf5db84d44fb25fd0f44679aad681a55d) |
| Receipt-gated paid redeem, call 2 | same run | status true, gas 285,057, block 313984791 | [0x4c83cf96...43b7](https://sepolia.arbiscan.io/tx/0x4c83cf961efedc3678c00d18e332aa502ac71e583ec3f5c42f24a1a5589043b7) |
| Receipt-gated paid redeem, call 3 | same run | status true, gas 284,888, block 313984814; `channels(2).paid` 0 to 900000, provider USDG 0 to 900000 (read at block 313984816) | [0x4ed9077a...f868](https://sepolia.arbiscan.io/tx/0x4ed9077a367495ddfb1acf4a3bbc54bf4b79b0d9898e4614fbe9148ec12cf868) |

Both rows above are coded and blocked only on `PHALA_API_KEY`/the Phala Confidential AI key
being unset in this environment; no result is claimed for either until that key is present and
the call actually runs to a terminal state.

## Test suites

| Suite | Command | Result |
|---|---|---|
| Solidity (unit, invariant, fork) | `make test` from a fresh clone | 296 passed, 0 failed, 1 skipped (the real-USDG fork suite, which runs with `CHIRON_FUNDED_TEST_ACCOUNT` set) |
| Rust (receipt verifier) | `cd receipt-verifier && cargo test` | 18 passed, 0 failed |
| Rust (TDX verifier) | `cd verifier && cargo test` | 22 passed, 0 failed |
| Agent client | `cd agent && npm test` | 27 passed, 0 failed |

## Re-verification of this document

Ten of the transaction hashes above were independently re-checked against the live chain
(`cast receipt <tx> status --rpc-url https://sepolia-rollup.arbitrum.io/rpc`), at a chain tip
of block 313704451: the two Verifier txs, the two ReceiptVerifier txs, the Assay deploy tx, the
provider funding tx, the two `register`/`registerReceiptKey` txs, and both `openChannel` txs.
All ten returned `status=true` and the block numbers already recorded above, with no
discrepancy from the original evidence.

## x402 extension: ChironGate

| Step | Command | Result | Transaction |
|---|---|---|---|
| Canonical x402BatchSettlement, redeployed by us at its CREATE2 address | `FOUNDRY_PROFILE=x402 forge script script/x402/DeployX402BatchSettlement.s.sol --broadcast` | status true, block 314008428; init code matches Arbitrum One, runtime differs only in the two chain-bound EIP-712 values | [0x20128b66...9fa2](https://sepolia.arbiscan.io/tx/0x20128b66fcff76804baf86db74558c74d23d9897016359a6f471a18c93aa9fa2) |
| Canonical ERC3009DepositCollector, redeployed by us | `FOUNDRY_PROFILE=x402 forge script script/x402/DeployX402ERC3009Collector.s.sol --broadcast` | status true, block 314009761; runtime identical to Arbitrum One | [0x37ebf09d...1723](https://sepolia.arbiscan.io/tx/0x37ebf09d0b08815002ec18088dc2a136ada7b87fed0b57a56452d671fc491723) |
| ChironGate | `forge script script/DeployGate.s.sol --broadcast` | status true, block 314009316; `x402()`, `registry()`, `receiptVerifier()` read back; Sourcify exact match | [0xb07d013c...cbcf9](https://sepolia.arbiscan.io/tx/0xb07d013c006ece1837cfdcb24cb6f23bc7ac691c078f31a381c074065d1cbcf9) |
| Open x402 channel with the gate as receiver, 1 USDG via ERC-3009 | `agent` `npm run gate-open` | status true, block 314016727; channel balance 1000000 | [0x2e35e165...d347](https://sepolia.arbiscan.io/tx/0x2e35e16523145ae25f7525321c6ccce71dc005facbb0fbe7806e67c31d89d347) |
| Claim through the gate against a real Phala receipt | `agent` `npm run gate-pay` | status true, gas 347,363, block 314016788; provider USDG +300000; `totalClaimed` 300000; `ClaimedWithReceipt` emitted | [0xbfbd454e...82eb](https://sepolia.arbiscan.io/tx/0xbfbd454e9dff5623677d26b29e402f0390aa1bd53160b0ffa88cb803f60a82eb) |
| Claim with a receipt naming another model | `agent` `npm run gate-refuse` (eth_call) | reverts `ModelMismatch` | n/a |

