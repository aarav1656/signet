// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IAssayVerifier} from "./IAssayVerifier.sol";
import {IReceiptVerifier} from "./IReceiptVerifier.sol";

/// A USDG payment channel that pays an inference seller per call only against a
/// cumulative voucher signed by a key whose Intel TDX attestation the Stylus
/// `Verifier` checked onchain, for a measurement on this contract's immutable
/// allowlist. What the attestation proves and does not prove: see this product's own README.
///
/// register(): the contract issues a fresh per-caller nonce (nextRegisterNonce),
/// the caller fetches a Phala quote binding that exact nonce in report_data, and
/// register() calls the verifier once per key rotation (not per call), requires
/// the returned measurement to be on the allowlist fixed at construction, and
/// requires the quote's bytes to never have been submitted before. It stores
/// signer -> (measurement, expiry). openChannel(): the agent deposits USDG.
/// redeem(): the provider submits the highest cumulative voucher signed by a
/// currently registered, unexpired signer, over a (requestHash, responseHash)
/// pair never paid before on any channel; the contract pays only the delta,
/// capped at the channel's deposit, and never below what was already paid.
///
/// Unilateral close is two-phase: requestClose(), callable once channelTimeout
/// has passed since the channel's last redeem (or, if none, since openedAt),
/// opens a challenge window (fixed at construction) measured from that
/// requestClose(); the provider can still redeem any pending voucher during that
/// window; finalizeClose(), callable only after the window elapses, pays the
/// agent whatever remains unredeemed. redeem() reverts once finalizeClose has run.
///
/// openChannel/redeem/requestClose/finalizeClose are each called by the party
/// that receives value in that call; register() is open to anyone, since the key
/// it records comes from the quote itself. No owner, no upgrade, no pause, no
/// setter for the allowlist after construction.
contract Assay is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    struct Signer {
        bytes32 measurement;
        uint64 expiry;
    }

    struct Channel {
        address agent;
        address provider;
        uint128 deposit;
        uint128 paid;
        uint64 openedAt;
        uint64 lastActivityAt;
        uint64 closeRequestedAt;
        bool closed;
        /// Pinned at open() to the enclave measurement this channel will pay against;
        /// redeem() requires the recovered enclaveSigner's registered measurement to
        /// match this exactly (see redeem()). Immutable for the channel's lifetime.
        bytes32 measurement;
        /// Pinned at open() to keccak256(modelId) the agent and provider agreed off
        /// chain (e.g. keccak256("deepseek-v3.1")). When nonzero, redeemWithReceipt()
        /// is the only way to pay the channel: it requires both the receipt's
        /// requested and served model hashes to equal this exactly, and the legacy
        /// redeem() (which carries no model evidence) reverts ModelMismatch. When
        /// zero, the channel is legacy-only and redeemWithReceipt() cannot match it.
        bytes32 requestedModelHash;
    }

    /// Authorizes the payer's spend, not the work itself: the agent's own key,
    /// which always works. Provenance that the work was done inside the attested
    /// enclave comes from a separate signature, checked in redeem() (see there).
    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(uint256 channelId,uint256 cumulativeAmount,bytes32 requestHash,bytes32 responseHash)");

    IERC20 public immutable usdg;
    IAssayVerifier public immutable verifier;
    /// The Stylus Ed25519 receipt verifier (receipt-verifier/, item E5). Checked
    /// only by redeemWithReceipt(); the legacy ECDSA redeem() path never calls it.
    IReceiptVerifier public immutable receiptVerifier;
    uint64 public immutable attestationValidity;
    uint64 public immutable channelTimeout;
    /// Window after requestClose() during which the provider can still redeem a
    /// pending voucher before finalizeClose() pays the remainder to the agent.
    uint64 public immutable challengeWindow;

    mapping(bytes32 => bool) public approvedMeasurement;
    mapping(address => Signer) public signers;
    /// Parallel to `signers`, keyed on the Ed25519 receipt-signing pubkey (raw 32
    /// bytes) instead of a secp256k1 address. Populated by registerReceiptKey().
    mapping(bytes32 => Signer) public receiptSigners;

    /// Per-caller monotonic counter feeding nextRegisterNonce(); advances only on
    /// a successful register().
    mapping(address => uint256) public registerNonce;
    /// Every quote's bytes, once registered, can never be replayed (by anyone),
    /// even after its nonce has gone stale for its original caller.
    mapping(bytes32 => bool) public usedQuote;

    mapping(uint256 => Channel) public channels;
    uint256 public channelCount;

    /// keccak256(provider, requestHash, responseHash) -> paid. One real attested
    /// receipt can be paid at most once, ever, on any channel that provider holds
    /// (the enclave signature itself is not bound to a channel). Both paths bind
    /// both hashes to TEE-signed bytes: the legacy signature covers them directly,
    /// and redeemWithReceipt() requires them to equal the receipt's own
    /// request.received and response.returned body hashes.
    mapping(bytes32 => bool) public consumedReceipt;

    event Registered(address indexed signer, bytes32 measurement, uint64 expiry);
    event ReceiptKeyRegistered(bytes32 indexed pubkey, bytes32 measurement, uint64 expiry);
    event ChannelOpened(
        uint256 indexed channelId,
        address indexed agent,
        address indexed provider,
        uint256 deposit,
        bytes32 requestedModelHash
    );
    event Redeemed(
        uint256 indexed channelId,
        address indexed enclaveSigner,
        uint256 cumulativeAmount,
        uint256 paidNow,
        bytes32 requestHash,
        bytes32 responseHash
    );
    /// requestedModelHash/servedModelHash are the receipt's own fields (see
    /// IReceiptVerifier.verifyReceipt); both equal channelId's pinned
    /// requestedModelHash by the time this fires, since redeemWithReceipt()
    /// reverts ModelMismatch before emitting otherwise. Both are surfaced anyway
    /// so a UI can show "requested vs served" without re-fetching the receipt.
    event RedeemedWithReceipt(
        uint256 indexed channelId,
        bytes32 indexed pubkey,
        uint256 cumulativeAmount,
        uint256 paidNow,
        bytes32 requestHash,
        bytes32 responseHash,
        bytes32 requestedModelHash,
        bytes32 servedModelHash
    );
    event CloseRequested(uint256 indexed channelId, uint64 requestedAt);
    event ChannelClosed(uint256 indexed channelId, uint256 refund);

    error BadParams();
    error MeasurementNotApproved();
    error SignerNotRegistered();
    error AttestationExpired();
    error NotProvider();
    error NotAgent();
    error ChannelClosedErr();
    error AmountNotIncreasing();
    error AmountExceedsDeposit();
    error TimeoutNotElapsed();
    error TransferShort();
    error PayerNotAgent();
    error ReceiptAlreadyConsumed();
    error MeasurementMismatch();
    error QuoteAlreadyUsed();
    error CloseAlreadyRequested();
    error CloseNotRequested();
    error ChallengeWindowActive();
    /// redeemWithReceipt(): the receipt's servedModelHash or requestedModelHash
    /// did not equal the channel's pinned requestedModelHash -- the model-swap
    /// refusal this path exists for.
    error ModelMismatch();
    /// redeemWithReceipt(): IReceiptVerifier.verifyReceipt returned ok == false
    /// (bad signature or malformed/incomplete receipt document).
    error ReceiptInvalid();
    /// redeemWithReceipt(): the receipt's own responseHash did not match the
    /// voucher's responseHash -- the provider and agent disagree on which
    /// response this payment is for.
    error ResponseHashMismatch();
    /// redeemWithReceipt(): the receipt's request.received body hash did not
    /// match the voucher's requestHash.
    error RequestHashMismatch();
    /// nextRegisterNonce(): refBlock has no usable block hash (outside ArbSys's
    /// 256-block window, or zero from native blockhash()). A zero hash would make
    /// the nonce a constant a quote could be fetched for at any time.
    error StaleRefBlock();

    constructor(
        address usdg_,
        address verifier_,
        address receiptVerifier_,
        bytes32[] memory approvedMeasurements_,
        uint64 attestationValidity_,
        uint64 channelTimeout_,
        uint64 challengeWindow_
    ) EIP712("Assay", "1") {
        if (usdg_ == address(0) || verifier_ == address(0) || receiptVerifier_ == address(0)) revert BadParams();
        if (approvedMeasurements_.length == 0 || attestationValidity_ == 0 || channelTimeout_ == 0) revert BadParams();
        if (challengeWindow_ == 0) revert BadParams();
        usdg = IERC20(usdg_);
        verifier = IAssayVerifier(verifier_);
        receiptVerifier = IReceiptVerifier(receiptVerifier_);
        attestationValidity = attestationValidity_;
        channelTimeout = channelTimeout_;
        challengeWindow = challengeWindow_;
        for (uint256 i; i < approvedMeasurements_.length; i++) {
            approvedMeasurement[approvedMeasurements_[i]] = true;
        }
    }

    /// Arbitrum's ArbSys precompile (Offchain Labs, nitro-precompile-interfaces
    /// ArbSys.sol): arbBlockHash(arbBlockNum) returns the Arbitrum block hash for
    /// arbBlockNum, reverting unless currentBlockNum-256 <= arbBlockNum <
    /// currentBlockNum -- the same 256-block window and revert-on-out-of-range shape
    /// as native EVM blockhash().
    address private constant ARBSYS = 0x0000000000000000000000000000000000000064;
    bytes4 private constant ARBSYS_ARBBLOCKHASH_SELECTOR = bytes4(keccak256("arbBlockHash(uint256)"));

    /// A recent, hard-to-predict-before-it-exists block hash, bound into the
    /// register() nonce so a quote cannot be pre-fetched for a future nonce value.
    /// On Arbitrum, ArbSys.arbBlockHash(refBlock) answers for the last 256 L2
    /// blocks and reverts otherwise; that revert is final here. Native blockhash()
    /// is used only where 0x64 has no code (the call "succeeds" with empty
    /// returndata), i.e. off Arbitrum. On Arbitrum, EVM block.number is an L1
    /// estimate, so falling back to blockhash() there would open a second, longer
    /// window. Any zero hash reverts: it would make the nonce a constant.
    function _refBlockHash(uint256 refBlock) private view returns (bytes32 h) {
        (bool ok, bytes memory data) = ARBSYS.staticcall(abi.encodeWithSelector(ARBSYS_ARBBLOCKHASH_SELECTOR, refBlock));
        if (!ok) revert StaleRefBlock();
        h = data.length == 32 ? abi.decode(data, (bytes32)) : blockhash(refBlock);
        if (h == bytes32(0)) revert StaleRefBlock();
    }

    /// The nonce a quote fetched by `provider` must bind (report_data[32:64]) for
    /// its next register() call to succeed, given `refBlock` as the recent-block
    /// reference (see _refBlockHash). Callable by anyone, before fetching the
    /// quote, so the caller knows what to ask Phala's attestation endpoint for.
    function nextRegisterNonce(address provider, uint256 refBlock) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), provider, registerNonce[provider], _refBlockHash(refBlock))
        );
    }

    /// Verify a fresh quote and register (or re-register, extending expiry) its
    /// bound signer, iff the measurement it attests to is on the allowlist fixed at
    /// construction. The quote must bind msg.sender's current nextRegisterNonce(refBlock)
    /// in report_data (checked by the verifier) and must never have been submitted
    /// before (checked here); together these mean a captured or re-broadcast old
    /// quote can never re-register anything. `refBlock` should be a recent block
    /// number (within ArbSys.arbBlockHash's 256-block window) the caller read
    /// nextRegisterNonce against. Anyone may call this for any provider; the signer
    /// address is derived from the quote itself, so this cannot register a key the
    /// quote did not attest to.
    function register(bytes calldata quote, uint256 refBlock) external nonReentrant returns (address signer, bytes32 measurement) {
        bytes32 quoteHash = keccak256(quote);
        if (usedQuote[quoteHash]) revert QuoteAlreadyUsed();
        bytes32 nonce = nextRegisterNonce(msg.sender, refBlock);
        (signer, measurement) = verifier.verify(quote, nonce);
        if (!approvedMeasurement[measurement]) revert MeasurementNotApproved();
        usedQuote[quoteHash] = true;
        registerNonce[msg.sender] += 1;
        uint64 expiry = uint64(block.timestamp) + attestationValidity;
        signers[signer] = Signer(measurement, expiry);
        emit Registered(signer, measurement, expiry);
    }

    /// Verify a fresh quote against Phala's canonical `/v1/aci/attestation`
    /// endpoint and register (or re-register, extending expiry) the Ed25519
    /// `pubkey` it binds, iff the measurement it attests to is on the allowlist
    /// fixed at construction. `keysetBytes` must be the exact JCS bytes of that
    /// quote's `attestation.workload_keyset` object (see
    /// IAssayVerifier.verifyKeyset); `pubkey` must appear in its
    /// `receipt_signing_keys[]`. Reuses the same nonce/quote-replay machinery as
    /// register() (nextRegisterNonce, registerNonce, usedQuote) -- same anti-replay
    /// guarantee, just feeding the ACI endpoint's nonce slot instead of the legacy
    /// endpoint's. Anyone may call this for any provider; the pubkey is bound to
    /// the quote by IAssayVerifier.verifyKeyset's own digest-equality check (see
    /// there), so this cannot register a key the quote did not attest to.
    function registerReceiptKey(bytes calldata quote, bytes calldata keysetBytes, uint256 refBlock, bytes32 pubkey)
        external
        nonReentrant
        returns (bytes32 measurement)
    {
        bytes32 quoteHash = keccak256(quote);
        if (usedQuote[quoteHash]) revert QuoteAlreadyUsed();
        bytes32 nonce = nextRegisterNonce(msg.sender, refBlock);
        measurement = verifier.verifyKeyset(quote, keysetBytes, nonce, pubkey);
        if (!approvedMeasurement[measurement]) revert MeasurementNotApproved();
        usedQuote[quoteHash] = true;
        registerNonce[msg.sender] += 1;
        uint64 expiry = uint64(block.timestamp) + attestationValidity;
        receiptSigners[pubkey] = Signer(measurement, expiry);
        emit ReceiptKeyRegistered(pubkey, measurement, expiry);
    }

    /// Open a channel funded by a prior `usdg.approve(address(this), amount)`,
    /// pinned to `measurement` (must be on the allowlist fixed at construction):
    /// only a signer currently registered under exactly this measurement can
    /// redeem against this channel (see redeem()). `requestedModelHash` pins the
    /// model redeemWithReceipt() will require a receipt's own requested and
    /// served model hashes to equal (see redeemWithReceipt()); pass
    /// `keccak256(abi.encodePacked(modelId))` to make the channel receipt-only,
    /// or `bytes32(0)` for a legacy-only channel paid through redeem().
    function openChannel(address provider, uint128 amount, bytes32 measurement, bytes32 requestedModelHash)
        external
        nonReentrant
        returns (uint256 channelId)
    {
        channelId = _openChannel(provider, amount, measurement, requestedModelHash);
        _pull(msg.sender, amount);
    }

    /// Open a channel funded by an EIP-2612 permit signature, one transaction, no
    /// prior approve. If the permit was already consumed (for example, front-run
    /// by an observer relaying it first), this falls through instead of reverting
    /// as long as the allowance it would have granted is already sufficient.
    function openChannelWithPermit(
        address provider,
        uint128 amount,
        bytes32 measurement,
        bytes32 requestedModelHash,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 channelId) {
        try IERC20Permit(address(usdg)).permit(msg.sender, address(this), amount, deadline, v, r, s) {}
        catch {
            if (usdg.allowance(msg.sender, address(this)) < amount) revert BadParams();
        }
        channelId = _openChannel(provider, amount, measurement, requestedModelHash);
        _pull(msg.sender, amount);
    }

    function _openChannel(address provider, uint128 amount, bytes32 measurement, bytes32 requestedModelHash)
        private
        returns (uint256 channelId)
    {
        if (provider == address(0) || amount == 0) revert BadParams();
        if (!approvedMeasurement[measurement]) revert MeasurementNotApproved();
        channelId = channelCount++;
        channels[channelId] = Channel({
            agent: msg.sender,
            provider: provider,
            deposit: amount,
            paid: 0,
            openedAt: uint64(block.timestamp),
            lastActivityAt: 0,
            closeRequestedAt: 0,
            closed: false,
            measurement: measurement,
            requestedModelHash: requestedModelHash
        });
        emit ChannelOpened(channelId, msg.sender, provider, amount, requestedModelHash);
    }

    /// Redemption needs two independent signatures because they prove two
    /// different things and only one party can ever produce each:
    ///
    /// - `payerSig`: an EIP-712 Voucher{channelId,cumulativeAmount,requestHash,
    ///   responseHash} signed by the channel's own agent. The agent always holds
    ///   this key, so this authorizes spend up to `cumulativeAmount` for this
    ///   exact exchange; it is not attestation evidence.
    /// - `enclaveSig`: Phala's own legacy per-response receipt signature, a
    ///   personal_sign (EIP-191) over the ASCII text
    ///   "<requestHash-as-64-lowercase-hex>:<responseHash-as-64-lowercase-hex>"
    ///   (no `0x`), built onchain from the two bytes32 values to match
    ///   Dstack-TEE/private-ai-gateway's `legacy_signature_text` /
    ///   `sign_legacy_message` byte for byte. Recovering it must land on a
    ///   currently registered, unexpired, allowlisted-measurement signer: that is
    ///   the provenance check, independent of who is paying.
    ///
    /// Only for a legacy-only channel (requestedModelHash == 0): the legacy
    /// signature carries no model evidence, so a model-pinned channel refuses it.
    /// Both must verify, cumulativeAmount must increase and stay within deposit,
    /// the enclave signer's currently registered measurement must match the one
    /// this channel was opened with (see openChannel()), and (provider,
    /// requestHash, responseHash) must never have been paid on ANY channel before
    /// (blocks replaying the same real receipt again on this channel, or across
    /// channels). Pays only the delta over what was already paid. Stays open
    /// through a pending requestClose(); reverts once finalizeClose() has run.
    function redeem(
        uint256 channelId,
        uint256 cumulativeAmount,
        bytes32 requestHash,
        bytes32 responseHash,
        bytes calldata payerSig,
        bytes calldata enclaveSig
    ) external nonReentrant {
        Channel storage c = channels[channelId];
        if (c.provider == address(0)) revert BadParams();
        if (msg.sender != c.provider) revert NotProvider();
        if (c.closed) revert ChannelClosedErr();
        if (c.requestedModelHash != bytes32(0)) revert ModelMismatch();
        if (cumulativeAmount <= c.paid) revert AmountNotIncreasing();
        if (cumulativeAmount > c.deposit) revert AmountExceedsDeposit();

        bytes32 receiptKey = keccak256(abi.encode(c.provider, requestHash, responseHash));
        if (consumedReceipt[receiptKey]) revert ReceiptAlreadyConsumed();

        if (!_payerSigValid(c, channelId, cumulativeAmount, requestHash, responseHash, payerSig)) revert PayerNotAgent();

        bytes32 enclaveDigest = MessageHashUtils.toEthSignedMessageHash(
            bytes.concat(_hex64(requestHash), ":", _hex64(responseHash))
        );
        address enclaveSigner = ECDSA.recover(enclaveDigest, enclaveSig);

        Signer storage s = signers[enclaveSigner];
        if (s.measurement == bytes32(0)) revert SignerNotRegistered();
        if (s.measurement != c.measurement) revert MeasurementMismatch();
        if (block.timestamp > s.expiry) revert AttestationExpired();

        uint256 delta = cumulativeAmount - c.paid;
        // forge-lint: disable-next-line(unsafe-typecast)
        c.paid = uint128(cumulativeAmount); // safe: cumulativeAmount <= c.deposit (uint128), checked above
        consumedReceipt[receiptKey] = true;
        c.lastActivityAt = uint64(block.timestamp);

        emit Redeemed(channelId, enclaveSigner, cumulativeAmount, delta, requestHash, responseHash);
        _push(c.provider, delta);
    }

    /// The model-swap-refusal redemption path (item E5): same payer authorization
    /// as redeem() (`payerSig` over the identical Voucher{channelId,cumulativeAmount,
    /// requestHash,responseHash} EIP-712 struct -- the voucher shape is unchanged),
    /// but provenance comes from a Phala canonical ACI receipt (`receiptBytes` +
    /// `signature`, Ed25519-verified by `receiptVerifier`) instead of the legacy
    /// per-response ECDSA signature. The receipt's own `servedModelHash` and
    /// `requestedModelHash` must both equal this channel's pinned
    /// `requestedModelHash` (set at openChannel()) -- a provider whose enclave
    /// actually routed to a different model cannot get paid, regardless of what it
    /// claims off chain, because `servedModelHash` is read from bytes the TEE
    /// itself signed. `pubkey` must be currently registered (via
    /// registerReceiptKey()) to this channel's exact pinned `measurement`, mirroring
    /// redeem()'s enclaveSigner check. `requestHash` and `responseHash` must equal
    /// the receipt's own request.received and response.returned body hashes, so a
    /// receipt pins its (requestHash, responseHash) pair; the replay key is that
    /// pair per provider, so a receipt cannot be paid twice on this channel or
    /// across channels. Pays only the delta over what was already paid; reverts
    /// once finalizeClose() has run, exactly as redeem() does.
    function redeemWithReceipt(
        uint256 channelId,
        uint256 cumulativeAmount,
        bytes32 requestHash,
        bytes32 responseHash,
        bytes calldata payerSig,
        bytes32 pubkey,
        bytes calldata receiptBytes,
        bytes calldata signature
    ) external nonReentrant {
        Channel storage c = channels[channelId];
        if (c.provider == address(0)) revert BadParams();
        if (msg.sender != c.provider) revert NotProvider();
        if (c.closed) revert ChannelClosedErr();
        if (cumulativeAmount <= c.paid) revert AmountNotIncreasing();
        if (cumulativeAmount > c.deposit) revert AmountExceedsDeposit();

        bytes32 receiptKey = keccak256(abi.encode(c.provider, requestHash, responseHash));
        if (consumedReceipt[receiptKey]) revert ReceiptAlreadyConsumed();

        if (!_payerSigValid(c, channelId, cumulativeAmount, requestHash, responseHash, payerSig)) revert PayerNotAgent();

        (
            bool ok,
            bytes32 requestedModelHash,
            bytes32 servedModelHash,
            bytes32 receiptRequestHash,
            bytes32 receiptResponseHash
        ) = receiptVerifier.verifyReceipt(pubkey, receiptBytes, signature);
        if (!ok) revert ReceiptInvalid();
        if (servedModelHash != c.requestedModelHash) revert ModelMismatch();
        if (requestedModelHash != c.requestedModelHash) revert ModelMismatch(); // defence in depth
        if (receiptRequestHash != requestHash) revert RequestHashMismatch();
        if (receiptResponseHash != responseHash) revert ResponseHashMismatch();

        Signer storage rs = receiptSigners[pubkey];
        if (rs.measurement == bytes32(0)) revert SignerNotRegistered();
        if (rs.measurement != c.measurement) revert MeasurementMismatch();
        if (block.timestamp > rs.expiry) revert AttestationExpired();

        uint256 delta = cumulativeAmount - c.paid;
        // forge-lint: disable-next-line(unsafe-typecast)
        c.paid = uint128(cumulativeAmount); // safe: cumulativeAmount <= c.deposit (uint128), checked above
        consumedReceipt[receiptKey] = true;
        c.lastActivityAt = uint64(block.timestamp);

        emit RedeemedWithReceipt(
            channelId, pubkey, cumulativeAmount, delta, requestHash, responseHash, requestedModelHash, servedModelHash
        );
        _push(c.provider, delta);
    }

    /// payerSig over the EIP-712 Voucher. An ECDSA signature by the agent's own key
    /// is always accepted, so adding, swapping or dropping an EIP-7702 delegation
    /// cannot void vouchers the agent signed. Only if that fails and the agent has
    /// code now is ERC-1271 asked. A smart account's answer is read at redeem time,
    /// so one that rotates its owner voids vouchers it has not had redeemed;
    /// providers serving one should redeem each voucher as it arrives.
    function _payerSigValid(
        Channel storage c,
        uint256 channelId,
        uint256 cumulativeAmount,
        bytes32 requestHash,
        bytes32 responseHash,
        bytes calldata payerSig
    ) private view returns (bool) {
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount, requestHash, responseHash))
        );
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, payerSig);
        if (err == ECDSA.RecoverError.NoError && recovered == c.agent) return true;
        return c.agent.code.length != 0 && SignatureChecker.isValidERC1271SignatureNow(c.agent, digest, payerSig);
    }

    /// `bytes32` as 64 lowercase ASCII hex chars, no `0x`: exactly
    /// `hex::encode` in Phala's Rust gateway. `Strings.toHexString(uint256,32)`
    /// gives the same digits with a leading "0x", so this just drops it.
    function _hex64(bytes32 x) private pure returns (bytes memory out) {
        bytes memory withPrefix = bytes(Strings.toHexString(uint256(x), 32));
        out = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            out[i] = withPrefix[i + 2];
        }
    }

    /// Step one of a unilateral close. Callable only after `channelTimeout` has
    /// elapsed since the channel's last redeem (or, if it was never redeemed,
    /// since it opened) -- not from openedAt alone, so a provider who is actively
    /// redeeming can never be timed out from under a pending voucher. Starts the
    /// challenge window; does not move funds.
    function requestClose(uint256 channelId) external nonReentrant {
        Channel storage c = channels[channelId];
        if (c.agent == address(0)) revert BadParams();
        if (msg.sender != c.agent) revert NotAgent();
        if (c.closed) revert ChannelClosedErr();
        if (c.closeRequestedAt != 0) revert CloseAlreadyRequested();
        uint64 lastActivity = c.lastActivityAt != 0 ? c.lastActivityAt : c.openedAt;
        if (block.timestamp < uint256(lastActivity) + channelTimeout) revert TimeoutNotElapsed();
        c.closeRequestedAt = uint64(block.timestamp);
        emit CloseRequested(channelId, c.closeRequestedAt);
    }

    /// Step two. Callable only after `challengeWindow` has elapsed since
    /// requestClose(); the provider can redeem() any pending voucher any time
    /// before this call. Pays the agent whatever was not redeemed. Idempotent by
    /// construction: `closed` is set here and every entry point checks it first.
    function finalizeClose(uint256 channelId) external nonReentrant {
        Channel storage c = channels[channelId];
        if (c.agent == address(0)) revert BadParams();
        if (msg.sender != c.agent) revert NotAgent();
        if (c.closed) revert ChannelClosedErr();
        if (c.closeRequestedAt == 0) revert CloseNotRequested();
        if (block.timestamp < uint256(c.closeRequestedAt) + challengeWindow) revert ChallengeWindowActive();

        uint256 refund = uint256(c.deposit) - uint256(c.paid);
        c.closed = true;
        c.deposit = c.paid;

        emit ChannelClosed(channelId, refund);
        if (refund != 0) _push(c.agent, refund);
    }

    function _pull(address from, uint256 amount) private {
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(from, address(this), amount);
        if (usdg.balanceOf(address(this)) - before != amount) revert TransferShort();
    }

    function _push(address to, uint256 amount) private {
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransfer(to, amount);
        if (before - usdg.balanceOf(address(this)) != amount) revert TransferShort();
    }
}
