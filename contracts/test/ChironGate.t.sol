// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {x402BatchSettlement} from "./vendor/x402/src/x402BatchSettlement.sol";
import {MockDepositCollector} from "./vendor/x402/test/mocks/MockBatchDepositCollectors.sol";
import {ChironGate, IReceiptKeyRegistry} from "../src/ChironGate.sol";
import {IX402BatchSettlement} from "../src/IX402BatchSettlement.sol";
import {AssayTestBase} from "./AssayTestBase.sol";

/// ERC-20 that, once armed, calls `target` with a stored payload whenever tokens land on
/// `trigger`. Used to re-enter ChironGate mid-forward.
contract ReentrantToken is ERC20 {
    address public target;
    address public trigger;
    bytes public payload;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, address trigger_, bytes calldata payload_) external {
        target = target_;
        trigger = trigger_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == trigger && payload.length != 0) {
            bytes memory p = payload;
            delete payload;
            (bool ok, bytes memory ret) = target.call(p);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

/// ERC-20 that skims 1% of every transfer sent from `taxed`.
contract SkimToken is ERC20 {
    address public taxed;

    constructor() ERC20("Skim", "SK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTaxed(address taxed_) external {
        taxed = taxed_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (taxed != address(0) && from == taxed && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// ChironGate against the real x402BatchSettlement (vendored byte-for-byte) and the real
/// Assay receipt-key registry. Only the Stylus Ed25519 receipt verifier is mocked
/// (MockReceiptVerifier, the repo's existing convention; its crypto is tested in
/// receipt-verifier/).
contract ChironGateTest is AssayTestBase {
    x402BatchSettlement internal x402Impl;
    IX402BatchSettlement internal x402;
    MockDepositCollector internal collector;
    ChironGate internal gate;

    uint256 internal authPk = 0xA0714;
    address internal auth;
    uint256 internal providerPk = 0xB0B;
    address internal payoutA = makeAddr("payoutA");
    address internal payoutB = makeAddr("payoutB");

    bytes32 internal constant MODEL = REQUESTED_MODEL_HASH;
    bytes32 internal constant OTHER_MODEL = keccak256("cheaper-model");
    uint40 internal constant DELAY = 1 hours;
    bytes32 internal constant REQ1 = keccak256("req1");
    bytes32 internal constant RESP1 = keccak256("resp1");
    bytes32 internal constant REQ2 = keccak256("req2");
    bytes32 internal constant RESP2 = keccak256("resp2");

    struct Claim {
        IX402BatchSettlement.VoucherClaim vc;
        ChironGate.Pin pin;
        bytes32 req;
        bytes32 resp;
        bytes ack;
        bytes32 pubkey;
    }

    function setUp() public override {
        super.setUp();
        x402Impl = new x402BatchSettlement();
        x402 = IX402BatchSettlement(address(x402Impl));
        collector = new MockDepositCollector();
        gate = new ChironGate(x402, IReceiptKeyRegistry(address(assay)));
        auth = vm.addr(authPk);
        _registerReceiptKey(APPROVED_MEASUREMENT);
        vm.prank(agent);
        usdg.approve(address(collector), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _set(bytes32 a) internal pure returns (bytes32[4] memory s) {
        s[0] = a;
    }

    function _pin(address payout, bytes32 nonce) internal pure returns (ChironGate.Pin memory) {
        return ChironGate.Pin(MODEL, _set(MODEL), APPROVED_MEASUREMENT, payout, nonce);
    }

    /// Independent of ChironGate.pinSalt: abi.encode inlines bytes32[4] as four words.
    function _salt(ChironGate.Pin memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                p.requestedModelHash,
                p.acceptedServedHashes[0],
                p.acceptedServedHashes[1],
                p.acceptedServedHashes[2],
                p.acceptedServedHashes[3],
                p.measurement,
                bytes32(uint256(uint160(p.providerPayout))),
                p.gateNonce
            )
        );
    }

    function _config(ChironGate.Pin memory p, address token)
        internal
        view
        returns (IX402BatchSettlement.ChannelConfig memory)
    {
        return IX402BatchSettlement.ChannelConfig(agent, auth, address(gate), address(gate), token, DELAY, _salt(p));
    }

    function _open(IX402BatchSettlement.ChannelConfig memory c, uint128 amount) internal returns (bytes32) {
        x402.deposit(c, amount, address(collector), "");
        return x402.getChannelId(c);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// CallAck digest computed independently of ChironGate.callAckDigest.
    function _ackDigest(bytes32 channelId, uint128 total, bytes32 req, bytes32 resp) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ChironGate"),
                keccak256("1"),
                block.chainid,
                address(gate)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("CallAck(bytes32 channelId,uint128 totalClaimed,bytes32 requestHash,bytes32 responseHash)"),
                channelId,
                total,
                req,
                resp
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _vc(IX402BatchSettlement.ChannelConfig memory c, uint128 total, uint256 voucherPk)
        internal
        view
        returns (IX402BatchSettlement.VoucherClaim memory)
    {
        bytes memory sig = _sign(voucherPk, x402.getVoucherDigest(x402.getChannelId(c), total));
        return IX402BatchSettlement.VoucherClaim(IX402BatchSettlement.Voucher(c, total), sig, total);
    }

    /// An honest claim: voucher and CallAck both signed by the channel's payerAuthorizer.
    function _honest(ChironGate.Pin memory p, address token, uint128 total, bytes32 req, bytes32 resp)
        internal
        view
        returns (Claim memory cl)
    {
        IX402BatchSettlement.ChannelConfig memory c = _config(p, token);
        cl.vc = _vc(c, total, authPk);
        cl.pin = p;
        cl.req = req;
        cl.resp = resp;
        cl.ack = _sign(authPk, _ackDigest(x402.getChannelId(c), total, req, resp));
        cl.pubkey = receiptPubkey;
    }

    function _receipt(bytes32 req, bytes32 resp) internal {
        receiptVerifier.setNext(true, MODEL, MODEL, req, resp);
    }

    function _submit(Claim memory cl) internal returns (uint128) {
        return gate.claimWithReceipt(cl.vc, cl.pin, cl.req, cl.resp, cl.ack, cl.pubkey, hex"01", hex"02");
    }

    function _openA(uint128 amount) internal returns (ChironGate.Pin memory p, bytes32 cid) {
        p = _pin(payoutA, bytes32(uint256(1)));
        cid = _open(_config(p, address(usdg)), amount);
    }

    // ---------------------------------------------------------------- honest path

    function test_honestClaim_paysProviderExactDelta() public {
        (ChironGate.Pin memory p, bytes32 cid) = _openA(100e6);
        uint256 x402Before = usdg.balanceOf(address(x402));

        _receipt(REQ1, RESP1);
        assertEq(_submit(_honest(p, address(usdg), 30e6, REQ1, RESP1)), 30e6);
        assertEq(usdg.balanceOf(payoutA), 30e6);
        assertEq(usdg.balanceOf(address(gate)), 0);
        assertEq(usdg.balanceOf(address(x402)), x402Before - 30e6);
        (uint128 bal, uint128 claimed) = x402.channels(cid);
        assertEq(bal, 100e6);
        assertEq(claimed, 30e6);
        (uint128 rClaimed, uint128 rSettled) = x402.receivers(address(gate), address(usdg));
        assertEq(rClaimed, 30e6);
        assertEq(rSettled, 30e6);

        _receipt(REQ2, RESP2);
        assertEq(_submit(_honest(p, address(usdg), 45e6, REQ2, RESP2)), 15e6);
        assertEq(usdg.balanceOf(payoutA), 45e6);
        assertEq(usdg.balanceOf(address(gate)), 0);
        assertTrue(gate.consumed(cid, keccak256(abi.encode(REQ1, RESP1))));
        assertTrue(gate.consumed(cid, keccak256(abi.encode(REQ2, RESP2))));
    }

    /// x402 vouchers carry a ceiling; the claim, the ack and the payout use the claimed total.
    function test_voucherCeilingAboveClaim_paysClaimedTotal() public {
        (ChironGate.Pin memory p, bytes32 cid) = _openA(100e6);
        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        cl.vc = _vc(c, 80e6, authPk);
        cl.vc.totalClaimed = 30e6;
        _receipt(REQ1, RESP1);
        assertEq(_submit(cl), 30e6);
        assertEq(usdg.balanceOf(payoutA), 30e6);
        (, uint128 claimed) = x402.channels(cid);
        assertEq(claimed, 30e6);
    }

    function test_gateDigestMatchesIndependentCallAck() public view {
        bytes32 cid = keccak256("any");
        assertEq(gate.callAckDigest(cid, 7, REQ1, RESP1), _ackDigest(cid, 7, REQ1, RESP1));
    }

    function test_payerAuthorizerZero_payerSignsAckAndVoucher() public {
        ChironGate.Pin memory p = _pin(payoutA, bytes32(uint256(9)));
        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        c.payerAuthorizer = address(0);
        bytes32 cid = _open(c, 100e6);
        Claim memory cl;
        cl.vc = _vc(c, 25e6, agentPk);
        cl.pin = p;
        cl.req = REQ1;
        cl.resp = RESP1;
        cl.ack = _sign(agentPk, _ackDigest(cid, 25e6, REQ1, RESP1));
        cl.pubkey = receiptPubkey;
        _receipt(REQ1, RESP1);
        assertEq(_submit(cl), 25e6);
        assertEq(usdg.balanceOf(payoutA), 25e6);
    }

    // ---------------------------------------------------------------- model pins

    function test_servedModelSwap_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, MODEL, OTHER_MODEL, REQ1, RESP1);
        vm.expectRevert(ChironGate.ModelMismatch.selector);
        _submit(cl);
        assertEq(usdg.balanceOf(payoutA), 0);
    }

    function test_requestedModelSwap_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, OTHER_MODEL, MODEL, REQ1, RESP1);
        vm.expectRevert(ChironGate.ModelMismatch.selector);
        _submit(cl);
    }

    function test_zeroModelPin_reverts() public {
        ChironGate.Pin memory p = ChironGate.Pin(bytes32(0), _set(MODEL), APPROVED_MEASUREMENT, payoutA, bytes32(0));
        _open(_config(p, address(usdg)), 100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, bytes32(0), MODEL, REQ1, RESP1);
        vm.expectRevert(ChironGate.BadPin.selector);
        _submit(cl);
    }

    function test_zeroPayoutPin_reverts() public {
        ChironGate.Pin memory p = _pin(address(0), bytes32(0));
        _open(_config(p, address(usdg)), 100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.BadPin.selector);
        _submit(cl);
    }

    function test_receiptNotOk_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(false, MODEL, MODEL, REQ1, RESP1);
        vm.expectRevert(ChironGate.ReceiptInvalid.selector);
        _submit(cl);
    }

    // ---------------------------------------------------------------- request binding

    /// The provider holds another Phala customer's genuine receipt for (REQ2, RESP2) on the
    /// pinned model and presents it with this payer's voucher. The payer only acked REQ1/RESP1.
    function test_foreignReceiptWithPayerAck_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        cl.req = REQ2;
        cl.resp = RESP2;
        _receipt(REQ2, RESP2);
        vm.expectRevert(ChironGate.BadCallAck.selector);
        _submit(cl);
    }

    function test_receiptForDifferentRequest_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        _receipt(REQ2, RESP1);
        vm.expectRevert(ChironGate.RequestHashMismatch.selector);
        _submit(cl);
    }

    /// The provider served the payer a swapped model, then re-ran the same request on the
    /// pinned model to mint a receipt. Same request hash, different response hash.
    function test_receiptForDifferentResponse_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        _receipt(REQ1, RESP2);
        vm.expectRevert(ChironGate.ResponseHashMismatch.selector);
        _submit(cl);
    }

    function test_ackByPayerInsteadOfAuthorizer_reverts() public {
        (ChironGate.Pin memory p, bytes32 cid) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        cl.ack = _sign(agentPk, _ackDigest(cid, 30e6, REQ1, RESP1));
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.BadCallAck.selector);
        _submit(cl);
    }

    function test_ackByProvider_reverts() public {
        (ChironGate.Pin memory p, bytes32 cid) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        cl.ack = _sign(providerPk, _ackDigest(cid, 30e6, REQ1, RESP1));
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.BadCallAck.selector);
        _submit(cl);
    }

    /// Ack for 10 cannot carry a voucher claim of 50.
    function test_ackBindsTotalClaimed() public {
        (ChironGate.Pin memory p, bytes32 cid) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 50e6, REQ1, RESP1);
        cl.ack = _sign(authPk, _ackDigest(cid, 10e6, REQ1, RESP1));
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.BadCallAck.selector);
        _submit(cl);
    }

    // ---------------------------------------------------------------- replay, registry

    /// The payer re-acked the same call at a higher total (a client retry). One receipt, one payment.
    function test_receiptReplay_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        _receipt(REQ1, RESP1);
        _submit(_honest(p, address(usdg), 30e6, REQ1, RESP1));
        Claim memory again = _honest(p, address(usdg), 60e6, REQ1, RESP1);
        vm.expectRevert(ChironGate.ReceiptAlreadyConsumed.selector);
        _submit(again);
        assertEq(usdg.balanceOf(payoutA), 30e6);
    }

    function test_staleVoucher_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        _receipt(REQ1, RESP1);
        _submit(_honest(p, address(usdg), 30e6, REQ1, RESP1));
        Claim memory stale = _honest(p, address(usdg), 20e6, REQ2, RESP2);
        _receipt(REQ2, RESP2);
        vm.expectRevert(ChironGate.NothingToClaim.selector);
        _submit(stale);
    }

    function test_unregisteredKey_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        cl.pubkey = keccak256("never-registered");
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.SignerNotRegistered.selector);
        _submit(cl);
    }

    function test_wrongMeasurement_reverts() public {
        ChironGate.Pin memory p = ChironGate.Pin(MODEL, _set(MODEL), APPROVED_MEASUREMENT_2, payoutA, bytes32(0));
        _open(_config(p, address(usdg)), 100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.MeasurementMismatch.selector);
        _submit(cl);
    }

    function test_expiredKey_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        (, uint64 expiry) = assay.receiptSigners(receiptPubkey);
        vm.warp(uint256(expiry) + 1);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.AttestationExpired.selector);
        _submit(cl);
    }

    // ---------------------------------------------------------------- channel shape

    function test_receiverNotGate_rejected() public {
        ChironGate.Pin memory p = _pin(payoutA, bytes32(0));
        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        c.receiver = payoutA;
        _open(c, 100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        cl.vc = _vc(c, 30e6, authPk);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.NotGateChannel.selector);
        _submit(cl);
    }

    function test_receiverAuthorizerNotGate_rejected() public {
        ChironGate.Pin memory p = _pin(payoutA, bytes32(0));
        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        c.receiverAuthorizer = payoutA;
        _open(c, 100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        cl.vc = _vc(c, 30e6, authPk);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.NotGateChannel.selector);
        _submit(cl);
    }

    /// The claimer tries to redirect the payout by presenting a different preimage.
    function test_pinPreimageMismatch_reverts() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        cl.pin.providerPayout = payoutB;
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.PinMismatch.selector);
        _submit(cl);
    }

    /// x402's two signature-authorized receiver-side routes ask the gate for ERC-1271, which it
    /// never answers, so nobody can claim or refund a gate channel except through the gate.
    function test_x402SignatureRoutesCannotBypassGate() public {
        (ChironGate.Pin memory p, bytes32 cid) = _openA(100e6);
        IX402BatchSettlement.VoucherClaim[] memory batch = new IX402BatchSettlement.VoucherClaim[](1);
        batch[0] = _vc(_config(p, address(usdg)), 30e6, authPk);
        bytes memory anySig = _sign(providerPk, x402.getClaimBatchDigest(batch));
        vm.expectRevert(x402BatchSettlement.InvalidSignature.selector);
        x402.claimWithSignature(batch, anySig);

        vm.expectRevert(x402BatchSettlement.NotAuthorizedToClaim.selector);
        vm.prank(payoutA);
        x402.claim(batch);

        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        bytes memory refundSig = _sign(providerPk, x402.getRefundDigest(cid, 0, 100e6));
        vm.expectRevert(x402BatchSettlement.InvalidSignature.selector);
        x402.refundWithSignature(c, 100e6, 0, refundSig);
    }

    // ---------------------------------------------------------------- payer exit

    function test_payerWithdrawAfterDelay_stillWorks() public {
        (ChironGate.Pin memory p, bytes32 cid) = _openA(100e6);
        _receipt(REQ1, RESP1);
        _submit(_honest(p, address(usdg), 30e6, REQ1, RESP1));

        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        uint256 agentBefore = usdg.balanceOf(agent);
        vm.prank(agent);
        x402.initiateWithdraw(c, 70e6);
        vm.warp(block.timestamp + DELAY);
        vm.prank(agent);
        x402.finalizeWithdraw(c);
        assertEq(usdg.balanceOf(agent) - agentBefore, 70e6);
        (uint128 bal, uint128 claimed) = x402.channels(cid);
        assertEq(bal, 30e6);
        assertEq(claimed, 30e6);
        assertEq(usdg.balanceOf(payoutA), 30e6);
    }

    /// A claim landing inside the withdraw window wins; finalize is capped to what is left.
    function test_claimDuringWithdrawWindow_capsWithdraw() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        vm.prank(agent);
        x402.initiateWithdraw(c, 100e6);
        _receipt(REQ1, RESP1);
        _submit(_honest(p, address(usdg), 30e6, REQ1, RESP1));
        vm.warp(block.timestamp + DELAY);
        uint256 agentBefore = usdg.balanceOf(agent);
        vm.prank(agent);
        x402.finalizeWithdraw(c);
        assertEq(usdg.balanceOf(agent) - agentBefore, 70e6);
        assertEq(usdg.balanceOf(payoutA), 30e6);
    }

    /// The x402 liveness rule, unchanged by the gate: a claim that lands after the payer's
    /// finalizeWithdraw drained the escrow reverts and pays nothing, and burns no receipt.
    function test_claimAfterFinalizedWithdraw_revertsAndKeepsReceipt() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        vm.prank(agent);
        x402.initiateWithdraw(c, 100e6);
        vm.warp(block.timestamp + DELAY);
        vm.prank(agent);
        x402.finalizeWithdraw(c);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        _receipt(REQ1, RESP1);
        vm.expectRevert(x402BatchSettlement.ClaimExceedsBalance.selector);
        _submit(cl);
        assertFalse(gate.consumed(x402.getChannelId(c), keccak256(abi.encode(REQ1, RESP1))));
    }

    // ---------------------------------------------------------------- isolation

    function test_crossChannelIsolation() public {
        (ChironGate.Pin memory pa, bytes32 cidA) = _openA(100e6);
        ChironGate.Pin memory pb = _pin(payoutB, bytes32(uint256(2)));
        bytes32 cidB = _open(_config(pb, address(usdg)), 50e6);

        _receipt(REQ1, RESP1);
        _submit(_honest(pa, address(usdg), 30e6, REQ1, RESP1));
        assertEq(usdg.balanceOf(payoutA), 30e6);
        assertEq(usdg.balanceOf(payoutB), 0);
        (uint128 balB, uint128 claimedB) = x402.channels(cidB);
        assertEq(balB, 50e6);
        assertEq(claimedB, 0);

        _receipt(REQ2, RESP2);
        _submit(_honest(pb, address(usdg), 20e6, REQ2, RESP2));
        assertEq(usdg.balanceOf(payoutA), 30e6);
        assertEq(usdg.balanceOf(payoutB), 20e6);
        (, uint128 claimedA) = x402.channels(cidA);
        assertEq(claimedA, 30e6);
        assertEq(usdg.balanceOf(address(gate)), 0);
        assertEq(usdg.balanceOf(address(x402)), 100e6);
    }

    /// A foreign channel (receiver == gate, receiverAuthorizer == attacker) leaves a claimed but
    /// unsettled amount credited to the gate. The next honest claim must pay its provider
    /// exactly its own delta: not more (someone else's money) and not revert (griefing).
    function test_foreignPendingClaim_notForwardedAndCannotGrief() public {
        (ChironGate.Pin memory p,) = _openA(100e6);

        uint256 attackerPk = 0xBAD;
        address attacker = vm.addr(attackerPk);
        usdg.mint(attacker, 5e6);
        vm.prank(attacker);
        usdg.approve(address(collector), 5e6);
        IX402BatchSettlement.ChannelConfig memory rogue = IX402BatchSettlement.ChannelConfig(
            attacker, attacker, address(gate), attacker, address(usdg), DELAY, bytes32(0)
        );
        _open(rogue, 5e6);
        IX402BatchSettlement.VoucherClaim[] memory batch = new IX402BatchSettlement.VoucherClaim[](1);
        batch[0] = _vc(rogue, 5e6, attackerPk);
        vm.prank(attacker);
        x402.claim(batch);

        _receipt(REQ1, RESP1);
        assertEq(_submit(_honest(p, address(usdg), 30e6, REQ1, RESP1)), 30e6);
        assertEq(usdg.balanceOf(payoutA), 30e6);
        assertEq(usdg.balanceOf(address(gate)), 5e6);
    }

    // ---------------------------------------------------------------- reentrancy

    /// A hostile token re-enters claimWithReceipt with a second, independently valid claim
    /// (its own ack, voucher and receipt) while the gate is forwarding the first.
    function test_reentrantToken_blocked() public {
        ReentrantToken tok = new ReentrantToken();
        tok.mint(agent, 100e6);
        vm.prank(agent);
        tok.approve(address(collector), type(uint256).max);
        ChironGate.Pin memory p = _pin(payoutA, bytes32(uint256(3)));
        _open(_config(p, address(tok)), 100e6);

        _mockReceipt(hex"01", REQ1, RESP1);
        _mockReceipt(hex"03", REQ2, RESP2);
        Claim memory inner = _honest(p, address(tok), 60e6, REQ2, RESP2);
        tok.arm(
            address(gate),
            payoutA,
            abi.encodeCall(
                ChironGate.claimWithReceipt,
                (inner.vc, inner.pin, inner.req, inner.resp, inner.ack, inner.pubkey, hex"03", hex"02")
            )
        );
        Claim memory outer = _honest(p, address(tok), 30e6, REQ1, RESP1);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _submit(outer);
    }

    function _mockReceipt(bytes memory receiptBytes, bytes32 req, bytes32 resp) internal {
        vm.mockCall(
            address(receiptVerifier),
            abi.encodeWithSelector(receiptVerifier.verifyReceipt.selector, receiptPubkey, receiptBytes, hex"02"),
            abi.encode(true, MODEL, MODEL, req, resp)
        );
    }

    // ---------------------------------------------------------------- balance deltas

    function _openSkim(address taxed) internal returns (SkimToken tok, ChironGate.Pin memory p) {
        tok = new SkimToken();
        tok.mint(agent, 100e6);
        vm.prank(agent);
        tok.approve(address(collector), type(uint256).max);
        p = _pin(payoutA, bytes32(uint256(4)));
        _open(_config(p, address(tok)), 100e6);
        tok.setTaxed(taxed);
    }

    /// x402 settles short. Tokens already stranded in the gate must not top the provider up.
    function test_settleShort_reverts() public {
        (SkimToken tok, ChironGate.Pin memory p) = _openSkim(address(x402));
        tok.mint(address(gate), 10e6);
        Claim memory cl = _honest(p, address(tok), 30e6, REQ1, RESP1);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.SettleShort.selector);
        _submit(cl);
    }

    function test_forwardShort_reverts() public {
        (SkimToken tok, ChironGate.Pin memory p) = _openSkim(address(gate));
        Claim memory cl = _honest(p, address(tok), 30e6, REQ1, RESP1);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.ForwardShort.selector);
        _submit(cl);
        assertEq(tok.balanceOf(payoutA), 0);
    }

    /// A pin that names the gate itself as payout would strand the money; the forward delta
    /// check refuses it.
    function test_payoutIsGate_reverts() public {
        ChironGate.Pin memory p = _pin(address(gate), bytes32(0));
        _open(_config(p, address(usdg)), 100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.ForwardShort.selector);
        _submit(cl);
    }

    function test_payerAuthorizerZero_wrongSigner_reverts() public {
        ChironGate.Pin memory p = _pin(payoutA, bytes32(uint256(9)));
        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(usdg));
        c.payerAuthorizer = address(0);
        bytes32 cid = _open(c, 100e6);
        Claim memory cl;
        cl.vc = _vc(c, 25e6, agentPk);
        cl.pin = p;
        cl.req = REQ1;
        cl.resp = RESP1;
        cl.ack = _sign(providerPk, _ackDigest(cid, 25e6, REQ1, RESP1));
        cl.pubkey = receiptPubkey;
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.BadCallAck.selector);
        _submit(cl);
    }

    function test_constructor_rejectsNonContracts() public {
        vm.expectRevert(ChironGate.BadParams.selector);
        new ChironGate(IX402BatchSettlement(payoutA), IReceiptKeyRegistry(address(assay)));
        vm.expectRevert(ChironGate.BadParams.selector);
        new ChironGate(x402, IReceiptKeyRegistry(payoutA));
    }

    // ---------------------------------------------------------------- accepted served labels

    /// Live RedPill traffic: requesting "meta-llama/llama-3.3-70b-instruct" yields a genuine
    /// receipt whose upstream.verified model_id is Tinfoil's label "llama3-3-70b".
    bytes32 internal constant LLAMA_REQUESTED = keccak256("meta-llama/llama-3.3-70b-instruct");
    bytes32 internal constant LLAMA_TINFOIL = keccak256("llama3-3-70b");

    function _llamaPin(address payout, bytes32 nonce) internal pure returns (ChironGate.Pin memory p) {
        bytes32[4] memory accepted;
        accepted[0] = LLAMA_REQUESTED;
        accepted[1] = LLAMA_TINFOIL;
        p = ChironGate.Pin(LLAMA_REQUESTED, accepted, APPROVED_MEASUREMENT, payout, nonce);
    }

    function _openLlama(address payout, bytes32 nonce) internal returns (ChironGate.Pin memory p) {
        p = _llamaPin(payout, nonce);
        _open(_config(p, address(usdg)), 100e6);
    }

    function test_tinfoilServedLabel_pays() public {
        ChironGate.Pin memory p = _openLlama(payoutA, bytes32(uint256(20)));
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, LLAMA_REQUESTED, LLAMA_TINFOIL, REQ1, RESP1);
        assertEq(_submit(cl), 30e6);
        assertEq(usdg.balanceOf(payoutA), 30e6);
    }

    function test_servedLabelNotInSet_reverts() public {
        ChironGate.Pin memory p = _openLlama(payoutA, bytes32(uint256(21)));
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, LLAMA_REQUESTED, keccak256("llama3-1-8b"), REQ1, RESP1);
        vm.expectRevert(ChironGate.ModelMismatch.selector);
        _submit(cl);
        assertEq(usdg.balanceOf(payoutA), 0);
    }

    /// The served label is accepted, but the receipt's requested id is not the pinned one.
    function test_requestedIdNotPinned_reverts() public {
        ChironGate.Pin memory p = _openLlama(payoutA, bytes32(uint256(22)));
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, LLAMA_TINFOIL, LLAMA_TINFOIL, REQ1, RESP1);
        vm.expectRevert(ChironGate.ModelMismatch.selector);
        _submit(cl);
    }

    /// Slots 2 and 3 of the set are zero; a receipt whose served hash is zero must not match them.
    function test_zeroEntryNeverMatches() public {
        ChironGate.Pin memory p = _openLlama(payoutA, bytes32(uint256(23)));
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, LLAMA_REQUESTED, bytes32(0), REQ1, RESP1);
        vm.expectRevert(ChironGate.ModelMismatch.selector);
        _submit(cl);
    }

    function test_allZeroAcceptedSet_reverts() public {
        ChironGate.Pin memory p = _pin(payoutA, bytes32(uint256(24)));
        p.acceptedServedHashes[0] = bytes32(0);
        _open(_config(p, address(usdg)), 100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, MODEL, bytes32(0), REQ1, RESP1);
        vm.expectRevert(ChironGate.BadPin.selector);
        _submit(cl);
    }

    /// The last slot is live too, and a set whose only nonzero entry is the last slot is valid.
    function test_servedLabelInLastSlot_pays() public {
        ChironGate.Pin memory p = _pin(payoutA, bytes32(uint256(25)));
        p.acceptedServedHashes[0] = bytes32(0);
        p.acceptedServedHashes[3] = LLAMA_TINFOIL;
        _open(_config(p, address(usdg)), 100e6);
        Claim memory cl = _honest(p, address(usdg), 30e6, REQ1, RESP1);
        receiptVerifier.setNext(true, MODEL, LLAMA_TINFOIL, REQ1, RESP1);
        assertEq(_submit(cl), 30e6);
    }

    /// Channel A accepts the Tinfoil label, channel B (same payer, same requested id) accepts only
    /// the exact id. The same served label pays on A and is refused on B; B's escrow is untouched.
    function test_differentSets_isolated() public {
        ChironGate.Pin memory pa = _openLlama(payoutA, bytes32(uint256(26)));
        ChironGate.Pin memory pb = ChironGate.Pin(
            LLAMA_REQUESTED, _set(LLAMA_REQUESTED), APPROVED_MEASUREMENT, payoutB, bytes32(uint256(27))
        );
        bytes32 cidB = _open(_config(pb, address(usdg)), 100e6);

        receiptVerifier.setNext(true, LLAMA_REQUESTED, LLAMA_TINFOIL, REQ1, RESP1);
        assertEq(_submit(_honest(pa, address(usdg), 30e6, REQ1, RESP1)), 30e6);

        Claim memory onB = _honest(pb, address(usdg), 30e6, REQ2, RESP2);
        receiptVerifier.setNext(true, LLAMA_REQUESTED, LLAMA_TINFOIL, REQ2, RESP2);
        vm.expectRevert(ChironGate.ModelMismatch.selector);
        _submit(onB);

        /// B's set cannot be widened by presenting A's set as B's preimage.
        onB.pin.acceptedServedHashes = pa.acceptedServedHashes;
        vm.expectRevert(ChironGate.PinMismatch.selector);
        _submit(onB);

        assertEq(usdg.balanceOf(payoutA), 30e6);
        assertEq(usdg.balanceOf(payoutB), 0);
        (, uint128 claimedB) = x402.channels(cidB);
        assertEq(claimedB, 0);
    }

    function test_pinSaltMatchesIndependentEncoding() public view {
        ChironGate.Pin memory p = _llamaPin(payoutA, bytes32(uint256(28)));
        assertEq(gate.pinSalt(p), _salt(p));
    }
}
