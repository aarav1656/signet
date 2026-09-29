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
/// acceptedServedHashes, measurement, providerPayout, gateNonce)), where acceptedServedHashes is
/// a bytes32[4] (encoded inline as four words) of keccak256(served label) values the payer
/// accepts. A gateway may report the upstream model under its own label (RedPill serves
/// "meta-llama/llama-3.3-70b-instruct" and Tinfoil's attested model_id reads "llama3-3-70b"),
/// so served == requested would refuse honest calls; the payer names the labels instead.
/// Unused slots are zero; at least one slot must be nonzero. Anyone may submit a claim with
/// the preimage; money only ever moves to the pinned `providerPayout`. A claim pays iff:
///   - the payer's side (payerAuthorizer, or payer when that is zero, the same rule x402
///     applies to vouchers) signed a CallAck binding (channelId, totalClaimed, requestHash,
///     responseHash) under this contract's EIP-712 domain. The x402 voucher binds no
///     request, and a Phala receipt key is shared by every Phala customer, so without this
///     a provider could redeem the payer's voucher with some other customer's receipt;
///   - the receipt verifies, its requested model hash equals the pinned one, its served model
///     hash is nonzero and equals one entry of the pinned accepted set, and
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
        bytes32[4] acceptedServedHashes;
        bytes32 measurement;
        address providerPayout;
        bytes32 gateNonce;
    }

    bytes32 public constant CALL_ACK_TYPEHASH =
        keccak256("CallAck(bytes32 channelId,uint128 totalClaimed,bytes32 requestHash,bytes32 responseHash)");

    IX402BatchSettlement public immutable x402;
    IReceiptKeyRegistry public immutable registry;
    IReceiptVerifier public immutable receiptVerifier;

    /// x402 channelId => keccak256(abi.encode(requestHash, responseHash)) => paid. Keyed per
    /// channel, not per provider: anyone can open a channel with a provider's pins and anyone can
    /// submit a claim, so a provider-wide key would let a payer burn a receipt on a throwaway
    /// channel and void the provider's real claim. The payer's CallAck signs the channelId, so a
    /// receipt still pays at most once per channel the payer acknowledged it on.
    mapping(bytes32 => mapping(bytes32 => bool)) public consumed;

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
        return keccak256(
            abi.encode(p.requestedModelHash, p.acceptedServedHashes, p.measurement, p.providerPayout, p.gateNonce)
        );
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
        if (_allZero(pin.acceptedServedHashes)) revert BadPin();

        bytes32 channelId = x402.getChannelId(c);
        bytes32 ack = callAckDigest(channelId, vc.totalClaimed, requestHash, responseHash);
        if (!_payerSigned(c, ack, payerCallSig)) revert BadCallAck();

        (bool ok, bytes32 requestedModel, bytes32 servedModel, bytes32 receiptRequest, bytes32 receiptResponse) =
            receiptVerifier.verifyReceipt(pubkey, receiptBytes, receiptSig);
        if (!ok) revert ReceiptInvalid();
        if (requestedModel != pin.requestedModelHash) revert ModelMismatch();
        if (!_accepts(pin.acceptedServedHashes, servedModel)) revert ModelMismatch();
        if (receiptRequest != requestHash) revert RequestHashMismatch();
        if (receiptResponse != responseHash) revert ResponseHashMismatch();

        (bytes32 measurement, uint64 expiry) = registry.receiptSigners(pubkey);
        if (measurement == bytes32(0)) revert SignerNotRegistered();
        if (measurement != pin.measurement) revert MeasurementMismatch();
        if (block.timestamp > expiry) revert AttestationExpired();

        bytes32 callKey = keccak256(abi.encode(requestHash, responseHash));
        if (consumed[channelId][callKey]) revert ReceiptAlreadyConsumed();
        consumed[channelId][callKey] = true;

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

        uint256 gateBefore = IERC20(token).balanceOf(address(this));
        x402.settle(address(this), token);
        if (IERC20(token).balanceOf(address(this)) - gateBefore != paid) revert SettleShort();

        uint256 providerBefore = IERC20(token).balanceOf(providerPayout);
        IERC20(token).safeTransfer(providerPayout, paid);
        if (IERC20(token).balanceOf(providerPayout) - providerBefore != paid) revert ForwardShort();
    }

    function _allZero(bytes32[4] calldata set) private pure returns (bool) {
        return (set[0] | set[1] | set[2] | set[3]) == bytes32(0);
    }

    /// True iff `served` is nonzero and equals an entry of `set`. Zero slots are padding and
    /// never match, even a receipt whose served hash is zero.
    function _accepts(bytes32[4] calldata set, bytes32 served) private pure returns (bool) {
        if (served == bytes32(0)) return false;
        for (uint256 i; i < 4; ++i) {
            if (set[i] == served) return true;
        }
        return false;
    }

    /// The same authorization rule x402 applies to the channel's vouchers: ECDSA by
    /// payerAuthorizer when it is set, otherwise ECDSA or ERC-1271 by payer.
    function _payerSigned(IX402BatchSettlement.ChannelConfig calldata c, bytes32 digest, bytes calldata sig)
        private
        view
        returns (bool)
    {
        if (c.payerAuthorizer != address(0)) {
            (address recovered,,) = ECDSA.tryRecover(digest, sig);
            return recovered == c.payerAuthorizer;
        }
        return SignatureChecker.isValidSignatureNow(c.payer, digest, sig);
    }
}
