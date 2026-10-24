// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IAssayVerifier, ICollateralVerifier} from "./IAssayVerifier.sol";
import {IReceiptVerifier} from "./IReceiptVerifier.sol";

/// The parts of Assay this account uses: the Ed25519 receipt-key registry, the channel
/// getter (for ERC-1271 scope) and the channel lifecycle it drives as a channel's agent.
interface IAssay {
    function receiptSigners(bytes32 pubkey) external view returns (bytes32 measurement, uint64 expiry);
    function channels(uint256 channelId)
        external
        view
        returns (
            address agent,
            address provider,
            uint128 deposit,
            uint128 paid,
            uint64 openedAt,
            uint64 lastActivityAt,
            uint64 closeRequestedAt,
            bool closed,
            bytes32 measurement,
            bytes32 requestedModelHash
        );
    function openChannel(address provider, uint128 amount, bytes32 measurement, bytes32 requestedModelHash)
        external
        returns (uint256 channelId);
    function requestClose(uint256 channelId) external;
    function finalizeClose(uint256 channelId) external;
}

/// A trading account on Robinhood Chain that holds USDG and Stock Tokens and trades only
/// through the canonical Uniswap v4 PoolManager, only when called by an agent key the Stylus
/// TDX Verifier admitted under an owner-approved measurement, only within owner-set per-token
/// caps, and only with a verified inference receipt recorded against each trade. Spec:
/// docs/agent-account-spec.md.
///
/// The agent supplies a typed `Trade`, never calldata. The account itself calls
/// unlock/swap/settle/take and takes the output to itself; it never approves any spender for
/// trading. Caps are raw token units on the token that leaves the account.
contract AgentAccount is Ownable2Step, ReentrancyGuardTransient, IUnlockCallback, IERC1271 {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    struct Limits {
        bool allowed;
        uint128 perTrade;
        uint128 daily;
        uint128 approvalAbove;
    }

    struct Trade {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minOut;
        uint64 deadline;
    }

    struct Receipt {
        bytes32 pubkey;
        bytes receiptBytes;
        bytes signature;
    }

    struct Bucket {
        uint32 hour;
        uint224 amount;
    }

    enum Status {
        None,
        Pending,
        Executed,
        Rejected,
        Cancelled
    }

    /// The spec's {tradeHash, agent, expiry, status}, plus the receipt record the proposal
    /// consumed, so the TradeExecuted an approval emits carries the same verified receipt.
    struct Proposal {
        bytes32 tradeHash;
        address agent;
        uint64 expiry;
        Status status;
        bytes32 agentMeasurement;
        bytes32 servedModelHash;
        bytes32 requestHash;
        bytes32 responseHash;
    }

    uint64 public constant ATTESTATION_VALIDITY = 86400;
    /// How long after an ERC-8056 multiplier change takes effect the agent stays out of that token.
    uint256 public constant CORPORATE_ACTION_COOLDOWN = 1 days;
    uint256 private constant WINDOW_HOURS = 25;

    IAssayVerifier public immutable verifier;
    IReceiptVerifier public immutable receiptVerifier;
    IAssay public immutable assay;
    IPoolManager public immutable poolManager;
    address public immutable usdg;

    // agent
    address public agent;
    bytes32 public agentMeasurement;
    uint64 public agentExpiry;
    uint256 public agentEpoch;
    mapping(bytes32 => bool) public approvedMeasurement;
    mapping(bytes32 => bool) public usedQuote;

    // attestation policy: with `requireCollateral` an agent is admitted only through
    // registerAgentWithCollateral, whose platform status must be at most `maxTcbStatus` (0 =
    // UpToDate only) and whose Intel documents must be at least evaluation `minTcbEvaluation`.
    bool public requireCollateral;
    uint8 public maxTcbStatus;
    uint32 public minTcbEvaluation;

    // model pin for per-trade receipts
    bytes32 public requestedModelHash;
    bytes32[4] public acceptedServedHashes;
    bytes32 public gatewayMeasurement;
    mapping(bytes32 => bool) public usedReceipt;

    // policy
    mapping(address => Limits) public limits;
    mapping(PoolId => bool) public allowedPool;
    mapping(address => Bucket[25]) internal window;
    uint64 public approvalTtl = 3600;
    bool public paused;

    // approvals
    mapping(uint256 => Proposal) public proposals;
    uint256 public proposalCount;
    uint256 public tradeCount;

    bool transient swapping;

    event AgentRegistered(address indexed agent, bytes32 indexed measurement, uint64 expiry, uint256 epoch);
    event AgentTcbStatus(address indexed agent, uint8 status);
    event AttestationPolicySet(bool requireCollateral, uint8 maxTcbStatus, uint32 minTcbEvaluation);
    event AgentRevoked(address indexed agent, uint256 epoch);
    event MeasurementSet(bytes32 indexed measurement, bool approved);
    event ModelSet(bytes32 requestedModelHash, bytes32[4] acceptedServedHashes, bytes32 gatewayMeasurement);
    event LimitsSet(address indexed token, Limits limits);
    event PoolSet(PoolId indexed poolId, address currency0, address currency1, uint24 fee, bool allowed);
    event TradeExecuted(
        uint256 indexed tradeId,
        PoolId indexed poolId,
        address indexed agent,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 agentMeasurement,
        bytes32 servedModelHash,
        bytes32 requestHash,
        bytes32 responseHash,
        uint256 proposalId
    );
    event TradeProposed(
        uint256 indexed proposalId,
        address indexed agent,
        bytes32 tradeHash,
        Trade trade,
        uint64 expiry,
        bytes32 agentMeasurement,
        bytes32 servedModelHash,
        bytes32 requestHash,
        bytes32 responseHash
    );
    event TradeRejected(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);
    event Paused(bool paused);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event InferenceChannelOpened(uint256 indexed channelId, address indexed provider, uint128 amount);

    error NotAgent();
    error AgentExpired();
    error IsPaused();
    error StaleRefBlock();
    error QuoteAlreadyUsed();
    error CollateralRequired();
    error TcbStatusTooHigh(uint8 status, uint8 maxStatus);
    error BadTcbStatus(uint8 maxStatus);
    error MeasurementNotApproved(bytes32 measurement);
    error AgentIsOwner();
    error TokenNotAllowed(address token);
    error PoolNotAllowed(PoolId poolId);
    error HookedPool();
    error NativeCurrency();
    error ZeroAmount();
    error ZeroMinOut();
    error DeadlinePassed();
    error ExceedsPerTradeCap(uint256 amountIn, uint256 cap);
    error NeedsApproval(uint256 amountIn, uint256 threshold);
    error ApprovalNotNeeded();
    error DailyCapExceeded(uint256 used, uint256 cap);
    error OverSpent(uint256 spent, uint256 amountIn);
    error InsufficientOutput(uint256 got, uint256 minOut);
    error ReceiptInvalid();
    error ModelMismatch();
    error ReceiptKeyNotRegistered();
    error GatewayMeasurementMismatch();
    error ReceiptKeyExpired();
    error ReceiptAlreadyUsed();
    error ModelNotSet();
    error ProposalNotPending();
    error ProposalExpired();
    error TradeMismatch();
    error ProposerNotCurrentAgent();
    error NotPoolManager();
    error NotSwapping();
    error BadLimits();
    error NoCode(address target);
    error RenounceDisabled();
    error CorporateActionPending(address token, uint256 uiMultiplier, uint256 newUIMultiplier, uint256 effectiveAt);

    constructor(
        address owner_,
        address verifier_,
        address receiptVerifier_,
        address assay_,
        address poolManager_,
        address usdg_
    ) Ownable(owner_) {
        if (verifier_.code.length == 0) revert NoCode(verifier_);
        if (receiptVerifier_.code.length == 0) revert NoCode(receiptVerifier_);
        if (assay_.code.length == 0) revert NoCode(assay_);
        if (poolManager_.code.length == 0) revert NoCode(poolManager_);
        if (usdg_.code.length == 0) revert NoCode(usdg_);
        verifier = IAssayVerifier(verifier_);
        receiptVerifier = IReceiptVerifier(receiptVerifier_);
        assay = IAssay(assay_);
        poolManager = IPoolManager(poolManager_);
        usdg = usdg_;
    }

    // ------------------------------------------------------------------ agent admission

    address private constant ARBSYS = 0x0000000000000000000000000000000000000064;
    bytes4 private constant ARBSYS_ARBBLOCKHASH_SELECTOR = bytes4(keccak256("arbBlockHash(uint256)"));

    /// Assay's _refBlockHash, verbatim: ArbSys.arbBlockHash within its 256-block window, native
    /// blockhash only where 0x64 has no code, and any zero hash reverts (RR-2).
    function _refBlockHash(uint256 refBlock) private view returns (bytes32 h) {
        (bool ok, bytes memory data) = ARBSYS.staticcall(abi.encodeWithSelector(ARBSYS_ARBBLOCKHASH_SELECTOR, refBlock));
        if (!ok) revert StaleRefBlock();
        h = data.length == 32 ? abi.decode(data, (bytes32)) : blockhash(refBlock);
        if (h == bytes32(0)) revert StaleRefBlock();
    }

    /// The value the agent's quote must carry in report_data[32..64].
    function attestNonce(uint256 refBlock) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), agentEpoch, _refBlockHash(refBlock)));
    }

    /// Anyone may submit; the key comes out of the quote. Replaces any current agent. Reverts
    /// while the owner requires Intel collateral (see registerAgentWithCollateral).
    function registerAgent(bytes calldata quote, uint256 refBlock)
        external
        nonReentrant
        returns (address signer, bytes32 measurement)
    {
        if (requireCollateral) revert CollateralRequired();
        bytes32 quoteHash = keccak256(quote);
        if (usedQuote[quoteHash]) revert QuoteAlreadyUsed();
        (signer, measurement) = verifier.verify(quote, attestNonce(refBlock));
        _admit(signer, measurement, quoteHash);
    }

    /// registerAgent plus Intel's collateral for the quote's platform: the Stylus verifier
    /// authenticates the documents against Intel's root and reverts on a revoked platform, a
    /// platform status above `maxTcbStatus`, or documents older than `minTcbEvaluation`. The
    /// ceiling is checked here as well, so the policy holds even against a verifier build that
    /// ignores its arguments.
    function registerAgentWithCollateral(bytes calldata quote, uint256 refBlock, bytes calldata collateral)
        external
        nonReentrant
        returns (address signer, bytes32 measurement)
    {
        bytes32 quoteHash = keccak256(quote);
        if (usedQuote[quoteHash]) revert QuoteAlreadyUsed();
        uint8 status;
        (signer, measurement, status) = ICollateralVerifier(address(verifier)).verifyWithCollateral(
            quote, attestNonce(refBlock), collateral, maxTcbStatus, minTcbEvaluation
        );
        if (status > maxTcbStatus) revert TcbStatusTooHigh(status, maxTcbStatus);
        _admit(signer, measurement, quoteHash);
        emit AgentTcbStatus(signer, status);
    }

    function _admit(address signer, bytes32 measurement, bytes32 quoteHash) private {
        if (!approvedMeasurement[measurement]) revert MeasurementNotApproved(measurement);
        if (signer == owner()) revert AgentIsOwner();
        if (signer == address(0)) revert NotAgent();
        usedQuote[quoteHash] = true;
        uint256 epoch = ++agentEpoch;
        uint64 expiry = uint64(block.timestamp) + ATTESTATION_VALIDITY;
        agent = signer;
        agentMeasurement = measurement;
        agentExpiry = expiry;
        emit AgentRegistered(signer, measurement, expiry, epoch);
    }

    // ------------------------------------------------------------------ agent trading

    function execute(Trade calldata t, Receipt calldata r)
        external
        nonReentrant
        returns (uint256 tradeId, uint256 amountOut)
    {
        _requireAgent();
        (address tokenIn, address tokenOut, PoolId poolId) = _checkTrade(t);
        _requireNoCorporateAction(tokenIn);
        _requireNoCorporateAction(tokenOut);
        Limits memory l = limits[tokenIn];
        if (t.amountIn > l.perTrade) revert ExceedsPerTradeCap(t.amountIn, l.perTrade);
        if (t.amountIn > l.approvalAbove) revert NeedsApproval(t.amountIn, l.approvalAbove);
        _spendWindow(tokenIn, t.amountIn, l.daily);
        (bytes32 served, bytes32 reqHash, bytes32 respHash) = _consumeReceipt(r);
        amountOut = _swap(t, tokenIn, tokenOut);
        tradeId = ++tradeCount;
        emit TradeExecuted(
            tradeId, poolId, msg.sender, tokenIn, tokenOut, t.amountIn, amountOut, agentMeasurement, served, reqHash, respHash, 0
        );
    }

    function propose(Trade calldata t, Receipt calldata r) external nonReentrant returns (uint256 proposalId) {
        _requireAgent();
        (address tokenIn, address tokenOut,) = _checkTrade(t);
        _requireNoCorporateAction(tokenIn);
        _requireNoCorporateAction(tokenOut);
        Limits memory l = limits[tokenIn];
        if (t.amountIn > l.perTrade) revert ExceedsPerTradeCap(t.amountIn, l.perTrade);
        if (t.amountIn <= l.approvalAbove) revert ApprovalNotNeeded();
        (bytes32 served, bytes32 reqHash, bytes32 respHash) = _consumeReceipt(r);

        uint64 ttlEnd = uint64(block.timestamp) + approvalTtl;
        uint64 expiry = t.deadline < ttlEnd ? t.deadline : ttlEnd;
        bytes32 tradeHash = keccak256(abi.encode(t));
        proposalId = ++proposalCount;
        bytes32 m = agentMeasurement;
        proposals[proposalId] = Proposal(tradeHash, msg.sender, expiry, Status.Pending, m, served, reqHash, respHash);
        emit TradeProposed(proposalId, msg.sender, tradeHash, t, expiry, m, served, reqHash, respHash);
    }

    function cancelProposal(uint256 id) external nonReentrant {
        Proposal storage p = proposals[id];
        if (msg.sender != p.agent) revert NotAgent();
        if (p.status != Status.Pending) revert ProposalNotPending();
        p.status = Status.Cancelled;
        emit ProposalCancelled(id);
    }

    function _requireAgent() private view {
        if (msg.sender != agent) revert NotAgent();
        if (block.timestamp > agentExpiry) revert AgentExpired();
        if (paused) revert IsPaused();
    }

    /// Steps 2 and 3 of the trade path. tokenIn and tokenOut come from the key, never the caller.
    function _checkTrade(Trade calldata t) private view returns (address tokenIn, address tokenOut, PoolId poolId) {
        if (block.timestamp > t.deadline) revert DeadlinePassed();
        if (t.amountIn == 0) revert ZeroAmount();
        if (t.minOut == 0) revert ZeroMinOut();
        poolId = t.key.toId();
        if (!allowedPool[poolId]) revert PoolNotAllowed(poolId);
        address c0 = Currency.unwrap(t.key.currency0);
        address c1 = Currency.unwrap(t.key.currency1);
        (tokenIn, tokenOut) = t.zeroForOne ? (c0, c1) : (c1, c0);
        if (!limits[tokenIn].allowed) revert TokenNotAllowed(tokenIn);
        if (!limits[tokenOut].allowed) revert TokenNotAllowed(tokenOut);
    }

    /// ERC-8056 Stock Tokens announce splits and other corporate actions through uiMultiplier(),
    /// newUIMultiplier() and effectiveAt(). A pool's price does not move with the multiplier, so
    /// the agent may not trade a token while a change is pending or within CORPORATE_ACTION_COOLDOWN
    /// after it took effect. The owner can still approve a proposal. A token without the interface
    /// (USDG) passes.
    function _requireNoCorporateAction(address token) private view {
        (bool okCur, bytes memory cur) = token.staticcall(abi.encodeWithSignature("uiMultiplier()"));
        (bool okNext, bytes memory next) = token.staticcall(abi.encodeWithSignature("newUIMultiplier()"));
        (bool okAt, bytes memory at) = token.staticcall(abi.encodeWithSignature("effectiveAt()"));
        if (!okCur || !okNext || !okAt || cur.length < 32 || next.length < 32 || at.length < 32) return;
        uint256 m = abi.decode(cur, (uint256));
        uint256 n = abi.decode(next, (uint256));
        uint256 e = abi.decode(at, (uint256));
        if (m != n || (e != 0 && block.timestamp < e + CORPORATE_ACTION_COOLDOWN)) {
            revert CorporateActionPending(token, m, n, e);
        }
    }

    /// Rolling window: 25 hourly buckets per token. Sums every bucket whose hour is within
    /// the last 24 hours (inclusive), so any 24-hour interval is covered by one check.
    function _spendWindow(address token, uint128 amountIn, uint128 daily) private {
        Bucket[25] storage w = window[token];
        uint256 h = block.timestamp / 3600;
        uint256 used;
        for (uint256 i; i < WINDOW_HOURS; ++i) {
            Bucket memory b = w[i];
            if (uint256(b.hour) + 24 >= h) used += b.amount;
        }
        if (used + amountIn > daily) revert DailyCapExceeded(used, daily);
        Bucket storage slot = w[h % WINDOW_HOURS];
        if (slot.hour != h) {
            slot.hour = uint32(h);
            slot.amount = 0;
        }
        slot.amount += amountIn;
    }

    /// Sum of agent-direct amountIn for `token` over the buckets the next check would read.
    function windowUsed(address token) external view returns (uint256 used) {
        Bucket[25] storage w = window[token];
        uint256 h = block.timestamp / 3600;
        for (uint256 i; i < WINDOW_HOURS; ++i) {
            if (uint256(w[i].hour) + 24 >= h) used += w[i].amount;
        }
    }

    /// Section 6: verify one Phala receipt for the pinned model under a registered, unexpired
    /// gateway key with the pinned measurement, and consume it.
    function _consumeReceipt(Receipt calldata r) private returns (bytes32 served, bytes32 reqHash, bytes32 respHash) {
        bool ok;
        bytes32 requested;
        (ok, requested, served, reqHash, respHash) = receiptVerifier.verifyReceipt(r.pubkey, r.receiptBytes, r.signature);
        if (!ok) revert ReceiptInvalid();
        if (requestedModelHash == bytes32(0)) revert ModelNotSet();
        if (requested != requestedModelHash) revert ModelMismatch();
        if (!_acceptsServed(served)) revert ModelMismatch();
        (bytes32 m, uint64 expiry) = assay.receiptSigners(r.pubkey);
        if (m == bytes32(0)) revert ReceiptKeyNotRegistered();
        if (m != gatewayMeasurement) revert GatewayMeasurementMismatch();
        if (block.timestamp > expiry) revert ReceiptKeyExpired();
        bytes32 key = keccak256(abi.encode(reqHash, respHash));
        if (usedReceipt[key]) revert ReceiptAlreadyUsed();
        usedReceipt[key] = true;
    }

    function _acceptsServed(bytes32 served) private view returns (bool) {
        if (served == bytes32(0)) return false;
        for (uint256 i; i < 4; ++i) {
            if (acceptedServedHashes[i] == served) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------ swap

    /// Balance-delta settlement: whatever the pool reports, the account checks what actually
    /// left and arrived.
    function _swap(Trade calldata t, address tokenIn, address tokenOut) private returns (uint256 got) {
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        swapping = true;
        poolManager.unlock(abi.encode(t.key, t.zeroForOne, t.amountIn));
        swapping = false;
        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        if (spent > t.amountIn) revert OverSpent(spent, t.amountIn);
        got = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (got < t.minOut) revert InsufficientOutput(got, t.minOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!swapping) revert NotSwapping();
        (PoolKey memory key, bool zeroForOne, uint128 amountIn) = abi.decode(data, (PoolKey, bool, uint128));
        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(amountIn)),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency cIn, Currency cOut) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        (int128 dIn, int128 dOut) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (dIn < 0) {
            poolManager.sync(cIn);
            IERC20(Currency.unwrap(cIn)).safeTransfer(address(poolManager), uint256(uint128(-dIn)));
            poolManager.settle();
        }
        if (dOut > 0) poolManager.take(cOut, address(this), uint256(uint128(dOut)));
        return "";
    }

    // ------------------------------------------------------------------ owner: approvals

    function approveTrade(uint256 id, Trade calldata t) external onlyOwner nonReentrant returns (uint256 amountOut) {
        Proposal storage p = proposals[id];
        if (p.status != Status.Pending) revert ProposalNotPending();
        if (block.timestamp > p.expiry) revert ProposalExpired();
        if (keccak256(abi.encode(t)) != p.tradeHash) revert TradeMismatch();
        if (p.agent != agent) revert ProposerNotCurrentAgent();
        if (paused) revert IsPaused();
        (address tokenIn, address tokenOut, PoolId poolId) = _checkTrade(t);
        uint128 cap = limits[tokenIn].perTrade;
        if (t.amountIn > cap) revert ExceedsPerTradeCap(t.amountIn, cap);
        p.status = Status.Executed;
        amountOut = _swap(t, tokenIn, tokenOut);
        uint256 tradeId = ++tradeCount;
        emit TradeExecuted(
            tradeId,
            poolId,
            p.agent,
            tokenIn,
            tokenOut,
            t.amountIn,
            amountOut,
            p.agentMeasurement,
            p.servedModelHash,
            p.requestHash,
            p.responseHash,
            id
        );
    }

    function rejectTrade(uint256 id) external onlyOwner {
        Proposal storage p = proposals[id];
        if (p.status != Status.Pending) revert ProposalNotPending();
        p.status = Status.Rejected;
        emit TradeRejected(id);
    }

    // ------------------------------------------------------------------ owner: policy

    function setLimits(address token, Limits calldata l) external onlyOwner {
        if (l.approvalAbove > l.perTrade) revert BadLimits();
        limits[token] = l;
        emit LimitsSet(token, l);
    }

    function setPool(PoolKey calldata key, bool allowed) external onlyOwner {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (allowed) {
            if (address(key.hooks) != address(0)) revert HookedPool();
            if (c0 == address(0) || c1 == address(0)) revert NativeCurrency();
            if (!limits[c0].allowed) revert TokenNotAllowed(c0);
            if (!limits[c1].allowed) revert TokenNotAllowed(c1);
        }
        PoolId id = key.toId();
        allowedPool[id] = allowed;
        emit PoolSet(id, c0, c1, key.fee, allowed);
    }

    /// Withdrawing approval from the measurement the current agent was admitted under also
    /// revokes that agent: removing trust is instant, not deferred to expiry.
    function setMeasurement(bytes32 measurement, bool approved) external onlyOwner {
        approvedMeasurement[measurement] = approved;
        emit MeasurementSet(measurement, approved);
        if (!approved && agent != address(0) && agentMeasurement == measurement) _revokeAgent();
    }

    /// Sets how the next agent is admitted. A new policy applies to the next admission, so the
    /// current agent, admitted under the old one, is revoked at once: removing trust is instant.
    /// Status 6 (Revoked) can never be accepted.
    function setAttestationPolicy(bool requireCollateral_, uint8 maxTcbStatus_, uint32 minTcbEvaluation_)
        external
        onlyOwner
    {
        if (maxTcbStatus_ > 5) revert BadTcbStatus(maxTcbStatus_);
        requireCollateral = requireCollateral_;
        maxTcbStatus = maxTcbStatus_;
        minTcbEvaluation = minTcbEvaluation_;
        emit AttestationPolicySet(requireCollateral_, maxTcbStatus_, minTcbEvaluation_);
        if (agent != address(0)) _revokeAgent();
    }

    function setModel(bytes32 requestedModelHash_, bytes32[4] calldata acceptedServedHashes_, bytes32 gatewayMeasurement_)
        external
        onlyOwner
    {
        if (requestedModelHash_ == bytes32(0) || gatewayMeasurement_ == bytes32(0)) revert ModelNotSet();
        if (
            (acceptedServedHashes_[0] | acceptedServedHashes_[1] | acceptedServedHashes_[2] | acceptedServedHashes_[3])
                == bytes32(0)
        ) revert ModelNotSet();
        requestedModelHash = requestedModelHash_;
        acceptedServedHashes = acceptedServedHashes_;
        gatewayMeasurement = gatewayMeasurement_;
        emit ModelSet(requestedModelHash_, acceptedServedHashes_, gatewayMeasurement_);
    }

    function setApprovalTtl(uint64 ttl) external onlyOwner {
        approvalTtl = ttl;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    function revokeAgent() external onlyOwner {
        _revokeAgent();
    }

    function _revokeAgent() private {
        address old = agent;
        uint256 epoch = ++agentEpoch;
        agent = address(0);
        agentMeasurement = bytes32(0);
        agentExpiry = 0;
        emit AgentRevoked(old, epoch);
    }

    // ------------------------------------------------------------------ owner: funds

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    function withdrawETH(address payable to, uint256 amount) external onlyOwner nonReentrant {
        (bool ok,) = to.call{value: amount}("");
        require(ok);
        emit Withdrawn(address(0), to, amount);
    }

    // ------------------------------------------------------------------ inference billing

    function openInferenceChannel(address provider, uint128 amount)
        external
        onlyOwner
        nonReentrant
        returns (uint256 channelId)
    {
        if (requestedModelHash == bytes32(0)) revert ModelNotSet();
        IERC20(usdg).forceApprove(address(assay), amount);
        channelId = assay.openChannel(provider, amount, gatewayMeasurement, requestedModelHash);
        IERC20(usdg).forceApprove(address(assay), 0);
        emit InferenceChannelOpened(channelId, provider, amount);
    }

    function requestInferenceClose(uint256 channelId) external onlyOwner nonReentrant {
        assay.requestClose(channelId);
    }

    function finalizeInferenceClose(uint256 channelId) external onlyOwner nonReentrant {
        assay.finalizeClose(channelId);
    }

    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(uint256 channelId,uint256 cumulativeAmount,bytes32 requestHash,bytes32 responseHash)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// Valid only for an Assay Voucher digest on this account's own open channel, signed by the
    /// current unexpired agent while not paused. Any other digest (Permit2, EIP-2612,
    /// EIP-3009, anything) gets 0xffffffff. `sig` is abi.encode(channelId, cumulativeAmount,
    /// requestHash, responseHash, agentSig); a malformed blob reverts, which every caller reads
    /// as invalid.
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length < 224) return 0xffffffff;
        (uint256 channelId, uint256 cumulativeAmount, bytes32 requestHash, bytes32 responseHash, bytes memory agentSig) =
            abi.decode(sig, (uint256, uint256, bytes32, bytes32, bytes));
        bytes32 domain = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Assay"), keccak256("1"), block.chainid, address(assay))
        );
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount, requestHash, responseHash));
        if (hash != keccak256(abi.encodePacked("\x19\x01", domain, structHash))) return 0xffffffff;
        (address chAgent,,,,,,, bool closed,,) = assay.channels(channelId);
        if (chAgent != address(this) || closed) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, agentSig);
        if (err != ECDSA.RecoverError.NoError || recovered != agent) return 0xffffffff;
        if (block.timestamp > agentExpiry || paused) return 0xffffffff;
        return IERC1271.isValidSignature.selector;
    }

    // ------------------------------------------------------------------ ownership

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// The agent key can never become the owner, so it can never approve its own proposals.
    function _transferOwnership(address newOwner) internal override {
        if (newOwner != address(0) && newOwner == agent) revert AgentIsOwner();
        super._transferOwnership(newOwner);
    }
}
