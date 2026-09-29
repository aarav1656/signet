// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IX402BatchSettlement} from "./IX402BatchSettlement.sol";
import {IReceiptVerifier} from "./IReceiptVerifier.sol";

/// The Assay receipt-key registry: `receiptSigners(pubkey)` is the Ed25519 key's attested
/// measurement and expiry, written only by Assay.registerReceiptKey() after an onchain TDX
/// quote check. `receiptVerifier()` is the Stylus Ed25519 receipt verifier Assay itself uses.
interface IReceiptKeyRegistry {
    function receiptSigners(bytes32 pubkey) external view returns (bytes32 measurement, uint64 expiry);
    function receiptVerifier() external view returns (IReceiptVerifier);
}

/// Receipt-gated claims on the official x402 `x402BatchSettlement` contract.
///
/// A payer opens an ordinary x402 batch-settlement channel whose `receiver` AND
/// `receiverAuthorizer` are this contract. x402 then lets nobody but this contract claim
/// (`claim` checks msg.sender against those two fields; `claimWithSignature` and
/// `refundWithSignature` need an ERC-1271 answer from this contract, which it never gives
/// because it implements no `isValidSignature` and no fallback). `settle` pays this
/// contract, which forwards the exact per-claim delta to the provider in the same call.
///
/// The channel's `salt` commits to the pins: keccak256(abi.encode(requestedModelHash,
/// measurement, providerPayout, gateNonce)). Anyone may submit a claim with the preimage;
/// money only ever moves to the pinned `providerPayout`. A claim pays iff:
///   - the payer's side (payerAuthorizer, or payer when that is zero, the same rule x402
///     applies to vouchers) signed a CallAck binding (channelId, totalClaimed, requestHash,
///     responseHash) under this contract's EIP-712 domain. The x402 voucher binds no
///     request, and a Phala receipt key is shared by every Phala customer, so without this
///     a provider could redeem the payer's voucher with some other customer's receipt;
///   - the receipt verifies, its requested AND served model hash equal the pinned one, and
///     its request/response body hashes equal the acknowledged ones;
///   - the signing key is registered in Assay under exactly the pinned measurement and has
///     not expired;
///   - the (requestHash, responseHash) pair was never paid to this provider before.
///
/// No owner, no upgrade, no pause, no admin sweep. Tokens that reach this contract other
/// than through claimWithReceipt (a direct transfer, or a channel with receiver == this but a
/// foreign receiverAuthorizer claiming and settling to it) are never forwarded to anyone.
contract ChironGate is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Pin {
        bytes32 requestedModelHash;
        bytes32 measurement;
        address providerPayout;
        bytes32 gateNonce;
    }

    bytes32 public constant CALL_ACK_TYPEHASH =
        keccak256("CallAck(bytes32 channelId,uint128 totalClaimed,bytes32 requestHash,bytes32 responseHash)");

    IX402BatchSettlement public immutable x402;
    IReceiptKeyRegistry public immutable registry;
    IReceiptVerifier public immutable receiptVerifier;

    /// providerPayout => keccak256(abi.encode(requestHash, responseHash)) => paid
    mapping(address => mapping(bytes32 => bool)) public consumed;

    event ClaimedWithReceipt(
        bytes32 indexed channelId,
        address indexed providerPayout,
        bytes32 indexed pubkey,
        uint128 totalClaimed,
        uint128 paid,
        bytes32 requestHash,
        bytes32 responseHash,
        bytes32 modelHash
    );

    error BadParams();
    error NotGateChannel();
    error PinMismatch();
    error BadPin();
    error BadCallAck();
    error ReceiptInvalid();
    error ModelMismatch();
    error RequestHashMismatch();
    error ResponseHashMismatch();
    error SignerNotRegistered();
    error MeasurementMismatch();
    error AttestationExpired();
    error ReceiptAlreadyConsumed();
    error NothingToClaim();
    error ClaimNotApplied();
    error SettleShort();
    error ForwardShort();

    constructor(IX402BatchSettlement x402_, IReceiptKeyRegistry registry_) EIP712("ChironGate", "1") {
        if (address(x402_).code.length == 0 || address(registry_).code.length == 0) revert BadParams();
        x402 = x402_;
        registry = registry_;
        receiptVerifier = registry_.receiptVerifier();
        if (address(receiptVerifier) == address(0)) revert BadParams();
    }

    function pinSalt(Pin calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.requestedModelHash, p.measurement, p.providerPayout, p.gateNonce));
    }

    function callAckDigest(bytes32 channelId, uint128 totalClaimed, bytes32 requestHash, bytes32 responseHash)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(CALL_ACK_TYPEHASH, channelId, totalClaimed, requestHash, responseHash)));
    }

    function claimWithReceipt(
        IX402BatchSettlement.VoucherClaim calldata vc,
        Pin calldata pin,
        bytes32 requestHash,
        bytes32 responseHash,
        bytes calldata payerCallSig,
        bytes32 pubkey,
        bytes calldata receiptBytes,
        bytes calldata receiptSig
    ) external nonReentrant returns (uint128 paid) {
        IX402BatchSettlement.ChannelConfig calldata c = vc.voucher.channel;
        if (c.receiver != address(this) || c.receiverAuthorizer != address(this)) revert NotGateChannel();
        if (c.salt != pinSalt(pin)) revert PinMismatch();
        if (pin.requestedModelHash == bytes32(0) || pin.providerPayout == address(0)) revert BadPin();

        bytes32 channelId = x402.getChannelId(c);
        bytes32 ack = callAckDigest(channelId, vc.totalClaimed, requestHash, responseHash);
        if (!_payerSigned(c, ack, payerCallSig)) revert BadCallAck();

        (bool ok, bytes32 requestedModel, bytes32 servedModel, bytes32 receiptRequest, bytes32 receiptResponse) =
            receiptVerifier.verifyReceipt(pubkey, receiptBytes, receiptSig);
        if (!ok) revert ReceiptInvalid();
        if (requestedModel != pin.requestedModelHash || servedModel != pin.requestedModelHash) revert ModelMismatch();
        if (receiptRequest != requestHash) revert RequestHashMismatch();
        if (receiptResponse != responseHash) revert ResponseHashMismatch();

        (bytes32 measurement, uint64 expiry) = registry.receiptSigners(pubkey);
        if (measurement == bytes32(0)) revert SignerNotRegistered();
        if (measurement != pin.measurement) revert MeasurementMismatch();
        if (block.timestamp > expiry) revert AttestationExpired();

        bytes32 callKey = keccak256(abi.encode(requestHash, responseHash));
        if (consumed[pin.providerPayout][callKey]) revert ReceiptAlreadyConsumed();
        consumed[pin.providerPayout][callKey] = true;

        paid = _claimAndForward(vc, channelId, c.token, pin.providerPayout);

        emit ClaimedWithReceipt(
            channelId, pin.providerPayout, pubkey, vc.totalClaimed, paid, requestHash, responseHash, servedModel
        );
    }

    /// Claims exactly this channel's increment and forwards exactly that increment. The first
    /// settle flushes anything a foreign channel (receiver == this, other receiverAuthorizer)
    /// left pending for this gate, so the measured settle delta is this claim's alone and one
    /// channel's funds can never be forwarded to another channel's provider.
    function _claimAndForward(
        IX402BatchSettlement.VoucherClaim calldata vc,
        bytes32 channelId,
        address token,
        address providerPayout
    ) private returns (uint128 paid) {
        (, uint128 claimedBefore) = x402.channels(channelId);
        if (vc.totalClaimed <= claimedBefore) revert NothingToClaim();
        paid = vc.totalClaimed - claimedBefore;

        x402.settle(address(this), token);

        IX402BatchSettlement.VoucherClaim[] memory batch = new IX402BatchSettlement.VoucherClaim[](1);
        batch[0] = vc;
        x402.claim(batch);
        (, uint128 claimedAfter) = x402.channels(channelId);
        if (claimedAfter != vc.totalClaimed) revert ClaimNotApplied();

        uint256 gateBefore = IERC20(token).balanceOf(address(this));
        x402.settle(address(this), token);
        if (IERC20(token).balanceOf(address(this)) - gateBefore != paid) revert SettleShort();

        uint256 providerBefore = IERC20(token).balanceOf(providerPayout);
        IERC20(token).safeTransfer(providerPayout, paid);
        if (IERC20(token).balanceOf(providerPayout) - providerBefore != paid) revert ForwardShort();
    }

    /// The same authorization rule x402 applies to the channel's vouchers: ECDSA by
    /// payerAuthorizer when it is set, otherwise ECDSA or ERC-1271 by payer.
    function _payerSigned(IX402BatchSettlement.ChannelConfig calldata c, bytes32 digest, bytes calldata sig)
        private
        view
        returns (bool)
    {
        if (c.payerAuthorizer != address(0)) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
            return err == ECDSA.RecoverError.NoError && recovered == c.payerAuthorizer;
        }
        return SignatureChecker.isValidSignatureNow(c.payer, digest, sig);
    }
}
