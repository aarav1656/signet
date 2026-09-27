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
import { hashMessage, type Address, type Hex } from 'viem';

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
