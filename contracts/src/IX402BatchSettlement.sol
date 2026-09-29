// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The subset of x402-foundation/x402 `x402BatchSettlement` (contracts/evm/src/x402BatchSettlement.sol,
/// commit a9955ae5) that ChironGate and its tests call. Struct layouts are copied field for field so
/// the ABI encoding, and therefore every selector, is identical to the real contract's.
interface IX402BatchSettlement {
    struct ChannelConfig {
        address payer;
        address payerAuthorizer;
        address receiver;
        address receiverAuthorizer;
        address token;
        uint40 withdrawDelay;
        bytes32 salt;
    }

    struct Voucher {
        ChannelConfig channel;
        uint128 maxClaimableAmount;
    }

    struct VoucherClaim {
        Voucher voucher;
        bytes signature;
        uint128 totalClaimed;
    }

    function deposit(ChannelConfig calldata config, uint128 amount, address collector, bytes calldata collectorData)
        external;
    function claim(VoucherClaim[] calldata voucherClaims) external;
    function claimWithSignature(VoucherClaim[] calldata voucherClaims, bytes calldata authorizerSignature) external;
    function settle(address receiver, address token) external;
    function initiateWithdraw(ChannelConfig calldata config, uint128 amount) external;
    function finalizeWithdraw(ChannelConfig calldata config) external;
    function refundWithSignature(
        ChannelConfig calldata config,
        uint128 amount,
        uint256 nonce,
        bytes calldata receiverAuthorizerSignature
    ) external;

    function channels(bytes32 channelId) external view returns (uint128 balance, uint128 totalClaimed);
    function receivers(address receiver, address token) external view returns (uint128 totalClaimed, uint128 totalSettled);
    function getChannelId(ChannelConfig calldata config) external view returns (bytes32);
    function getVoucherDigest(bytes32 channelId, uint128 maxClaimableAmount) external view returns (bytes32);
    function getClaimBatchDigest(VoucherClaim[] calldata voucherClaims) external view returns (bytes32);
    function getRefundDigest(bytes32 channelId, uint256 nonce, uint128 amount) external view returns (bytes32);
}
