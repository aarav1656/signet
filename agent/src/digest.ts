// Digest construction shared with Assay.sol's redeem() and the web app's
// Channel.tsx VoucherPanel / RedeemPanel Diagnose. Two independent digests:
//
// - The enclave receipt digest: Phala's exact legacy personal_sign format,
//   `hex64(requestHash):hex64(responseHash)` (both lowercase, no `0x`), EIP-191
//   personal_sign over that ASCII text. Mirrors Assay.sol's private `_hex64` +
//   `MessageHashUtils.toEthSignedMessageHash`, and Channel.tsx's `enclaveText` +
//   `hashMessage`. Confirmed byte-for-byte against
//   github.com/Dstack-TEE/private-ai-gateway `legacy_signature_text` /
//   `sign_legacy_message` (src/aggregator/service/helpers.rs, src/dstack.rs).
// - The payer voucher digest: EIP-712 Voucher(channelId,cumulativeAmount,
//   requestHash,responseHash) under domain ("Assay","1",chainId,assayAddress),
//   the exact type Assay.sol's VOUCHER_TYPEHASH and Channel.tsx's VoucherPanel
//   both use.
import { hashMessage, keccak256, toBytes, type Address, type Hex } from 'viem';

/// `bytes32` as 64 lowercase ASCII hex chars, no `0x` -- identical to
/// Assay.sol's `_hex64` and Channel.tsx's `enclaveText` half.
export function hex64(x: Hex): string {
  const stripped = x.slice(2).toLowerCase();
  if (stripped.length !== 64) throw new Error(`hex64: expected 32 bytes, got ${stripped.length / 2}`);
  return stripped;
}

/// Phala's exact legacy signature text: "<requestHash>:<responseHash>", both
/// halves lowercase hex with no `0x`. Identical to Channel.tsx's `enclaveText`.
export function enclaveText(requestHash: Hex, responseHash: Hex): string {
  return `${hex64(requestHash)}:${hex64(responseHash)}`;
}

/// EIP-191 personal_sign digest over `enclaveText`, exactly what
/// `sign_legacy_message` signs and what Assay.sol's redeem() reconstructs
/// onchain via `MessageHashUtils.toEthSignedMessageHash`.
export function enclaveDigest(requestHash: Hex, responseHash: Hex): Hex {
  return hashMessage(enclaveText(requestHash, responseHash));
}

export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'channelId', type: 'uint256' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes32' },
  ],
} as const;

export function voucherDomain(chainId: number, assayAddress: Address) {
  return { name: 'Assay', version: '1', chainId, verifyingContract: assayAddress } as const;
}

export function voucherMessage(channelId: bigint, cumulativeAmount: bigint, requestHash: Hex, responseHash: Hex) {
  return { channelId, cumulativeAmount, requestHash, responseHash } as const;
}

/// Model-swap refusal (redeemWithReceipt() path): `keccak256(abi.encodePacked(modelId))`,
/// exactly what Assay.sol's `openChannel`/`openChannelWithPermit` doc comment
/// (contracts/src/Assay.sol:293) says to pass as `requestedModelHash`, and what
/// receipt-verifier's IReceiptVerifier.verifyReceipt hashes the receipt's own
/// `model` / `upstream.verified.model_id` fields with onchain. `toBytes(string)`
/// is a plain UTF-8 encode, identical to Solidity's `abi.encodePacked(string)`
/// for a single string argument (no length prefix, no padding).
export function modelHash(modelId: string): Hex {
  return keccak256(toBytes(modelId));
}

/// ERC-3009 `receiveWithAuthorization`, the EIP-712 type USDG signs for
/// ERC3009DepositCollector (test/vendor/x402/src/periphery/ERC3009DepositCollector.sol):
/// gasless pull into escrow. USDG's own domain is ("Global Dollar","1",chainId,usdgAddress),
/// not this repo's own EIP712 domains (confirmed live: selector 0x88b7ab63, the
/// `bytes signature` variant IERC3009 declares).
export const RECEIVE_AUTH_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function usdgDomain(chainId: number, usdgAddress: Address) {
  return { name: 'Global Dollar', version: '1', chainId, verifyingContract: usdgAddress } as const;
}
