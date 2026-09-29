---
title: "Receipt-gated claims for batch-settlement (proposed)"
description: "A proposed, not adopted, extension to the x402 batch-settlement scheme on EVM: the seller can claim a voucher only with a TEE inference receipt showing the pinned model served this buyer's request."
---

**Status: proposal.** This is not part of the x402 specification and has not been reviewed or adopted by the x402 Foundation. It uses the unmodified `x402BatchSettlement` contract; everything new lives in one extra contract, `ChironGate` (`contracts/src/ChironGate.sol`).

The `batch-settlement` scheme lets a buyer pay per request with cumulative vouchers. A voucher authorizes an amount, not a result: nothing onchain says which model answered. This extension makes the claim conditional on a signed inference receipt from a TEE gateway (Phala Confidential AI today) whose signing key is attested onchain, so a seller who served a cheaper model than the one the buyer paid for cannot collect.

### How It Works

1. **Channel:** the buyer opens an ordinary `batch-settlement` channel whose `receiver` **and** `receiverAuthorizer` are both the `gate` address, and whose `salt` commits to the pins (below). `x402BatchSettlement.claim` accepts only the channel's receiver side, and `claimWithSignature` / `refundWithSignature` need an ERC-1271 answer the gate never gives, so the gate is the only party that can claim.
2. **Voucher:** unchanged. Each request carries a cumulative `Voucher(channelId, maxClaimableAmount)`.
3. **Call acknowledgement:** after the response arrives, the buyer's voucher signer also signs a `CallAck` over the request and response body hashes it saw (below).
4. **Claim:** anyone submits `ChironGate.claimWithReceipt`. The gate checks the receipt, the key registration and the ack, calls `claim` and `settle` on `x402BatchSettlement`, and forwards exactly the claimed increment to the pinned `providerPayout` in the same transaction.
5. **Exit:** the buyer's timed `initiateWithdraw` / `finalizeWithdraw` is unchanged. There is no cooperative `refund` path, because the gate exposes none.

### `PaymentRequirements.extra`

The seller's 402 response advertises these fields in `accepts[].extra`, alongside the scheme's existing ones (`minDeposit` and so on). `payTo` MUST equal `extra.gate`.

| Field | Type | Meaning |
|-------|------|---------|
| `gate` | address | The `ChironGate` deployment. Channel `receiver` and `receiverAuthorizer`. |
| `receiptVerifier` | address | The contract whose `verifyReceipt(pubkey, receiptBytes, signature)` the gate calls. Informational: the gate reads it from `receiptRegistry` at construction, and a client can use it to check a receipt offchain before acking. |
| `receiptRegistry` | address | The registry whose `receiptSigners(pubkey)` returns `(measurement, expiry)` for an attested receipt-signing key (the Assay contract). |
| `requiredMeasurement` | bytes32 | The TEE image measurement the receipt key must be registered under. |
| `modelHash` | bytes32 | `keccak256(utf8(modelId))` of the model id the buyer requests. The receipt's requested model must equal this. Nonzero. |
| `acceptedServedLabels` | bytes32[4] | `keccak256(utf8(label))` of up to four served-model labels the buyer accepts, zero-padded. The receipt's served model (`upstream.verified` `model_id`) must equal one nonzero entry. At least one entry is nonzero; a zero entry never matches. |
| `providerPayout` | address | Where claimed funds go. Nonzero, and not the gate. |
| `gateNonce` | bytes32 | Any value; lets one buyer hold several channels with identical pins. |

The channel salt is

```
salt = keccak256(abi.encode(modelHash, acceptedServedLabels, requiredMeasurement, providerPayout, gateNonce))
```

`acceptedServedLabels` is a static `bytes32[4]`, so it encodes inline as four 32-byte words: the preimage is eight words in all.

Why a set: a gateway can report the upstream model under its own name. A live RedPill call requesting `meta-llama/llama-3.3-70b-instruct` returned a genuine receipt whose served `model_id` is `llama3-3-70b`, Tinfoil's label for the same model, while `phala/qwen3.8-27b-uncensored` reports served == requested. Requiring equality would refuse the honest Llama call, so the buyer names the labels it accepts when opening the channel, for example `[keccak256("meta-llama/llama-3.3-70b-instruct"), keccak256("llama3-3-70b"), 0, 0]`. The set is fixed by the salt for the channel's life; widening it means a new channel.

A client MUST build `ChannelConfig{payer, payerAuthorizer, receiver: gate, receiverAuthorizer: gate, token, withdrawDelay, salt}` from these values and MUST NOT deposit if `payTo != gate`.

### Call acknowledgement

EIP-712 under the gate's own domain `{name: "ChironGate", version: "1", chainId, verifyingContract: gate}`:

```
CallAck(bytes32 channelId,uint128 totalClaimed,bytes32 requestHash,bytes32 responseHash)
```

`requestHash` and `responseHash` are the raw 32-byte SHA-256 digests of the exact request and response bodies, as Phala's receipt records them in the `request.received` and `response.returned` events' `body_hash`. `totalClaimed` is the cumulative amount the seller may claim for this call. The signer is the channel's `payerAuthorizer`, or `payer` when `payerAuthorizer` is zero, the same rule `x402BatchSettlement` applies to vouchers.

The voucher alone is not enough because it binds no request, and a TEE gateway's receipt key is shared by all of its customers: without the ack, a seller could redeem this buyer's voucher with a genuine receipt from some other customer's call, or re-run the buyer's request on the pinned model to mint a receipt after serving the buyer something else. Binding `responseHash` is what ties the receipt to the response this buyer actually received.

### Claim precondition

`claimWithReceipt(voucherClaim, pin, requestHash, responseHash, callAckSig, pubkey, receiptBytes, receiptSig)` pays if and only if all of these hold, and otherwise reverts with no state change:

1. `channel.receiver == channel.receiverAuthorizer == gate`, and `channel.salt` equals the salt of `pin`; `pin.modelHash != 0`, `pin.providerPayout != 0`, and `pin.acceptedServedLabels` has at least one nonzero entry.
2. `callAckSig` is a valid `CallAck` for `(channelId, voucherClaim.totalClaimed, requestHash, responseHash)` by the payer side.
3. `verifyReceipt(pubkey, receiptBytes, receiptSig)` returns `ok`, requested model hash `== pin.modelHash`, served model hash nonzero and equal to one entry of `pin.acceptedServedLabels`, and body hashes equal to `requestHash` and `responseHash`.
4. `receiptSigners(pubkey)` is registered, its measurement `== pin.requiredMeasurement`, and `block.timestamp <= expiry`.
5. `(requestHash, responseHash)` has never been paid to `pin.providerPayout`.
6. `voucherClaim.totalClaimed` exceeds the channel's recorded `totalClaimed`; `x402BatchSettlement.claim` accepts it; the gate's settled balance rises by exactly the increment; `providerPayout`'s balance rises by exactly the increment.

Funds that reach the gate any other way (a direct transfer, or a channel naming the gate as receiver under a foreign `receiverAuthorizer`) are flushed before step 6 and never forwarded.

### Seller obligations

- Claim each call promptly. x402 does not reserve funds for unclaimed vouchers: once a buyer's `finalizeWithdraw` lands, later claims revert with `ClaimExceedsBalance`. Watch `WithdrawInitiated` for your channels and stop serving.
- The ack is signed after the response, so a buyer can withhold it. Require the ack for call *n* before serving call *n+1*; exposure is one call.
- Standard facilitators cannot claim or refund gate channels, because the gate never signs `ClaimBatch` or `Refund`.

### Deployments

`x402BatchSettlement` is used unmodified at its canonical CREATE2 address `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003`. On Arbitrum One that is the live deployment. On Arbitrum Sepolia, any contract at that address is the official x402BatchSettlement bytecode, redeployed by us on Arbitrum Sepolia at the same CREATE2 address, using `contracts/script/x402/DeployX402BatchSettlement.s.sol`, which refuses to broadcast unless the compiled init code hashes to that address. `ChironGate` is not deployed yet.
