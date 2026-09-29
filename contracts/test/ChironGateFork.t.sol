// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {x402BatchSettlement} from "./vendor/x402/src/x402BatchSettlement.sol";
import {MockDepositCollector} from "./vendor/x402/test/mocks/MockBatchDepositCollectors.sol";
import {ChironGate, IReceiptKeyRegistry} from "../src/ChironGate.sol";
import {IX402BatchSettlement} from "../src/IX402BatchSettlement.sol";
import {IReceiptVerifier} from "../src/IReceiptVerifier.sol";
import {TestUSDG} from "../src/TestUSDG.sol";

/// ChironGate on an Arbitrum Sepolia fork, reading the live Assay receipt-key registry
/// (0x3500...FfCC) and the live Stylus Ed25519 receipt verifier (0x9af7...2380).
///
/// revm cannot execute Stylus WASM, so each verifyReceipt answer is fetched from the live
/// verifier with a real eth_call (vm.rpc) on the fixture receipt and then served to the gate
/// with vm.mockCall. No receipt signed by the live Phala key exists yet in this repo, so the
/// paying test serves the fixture receipt's real verification result under the live key: the
/// registry check is live, the "Phala's key signed this receipt" link is not.
///
/// The live key's registration lasts attestationValidity (1 day). Once it expires,
/// test_liveRegistry_holdsPhalaKey fails by design until the key is re-registered.
contract ChironGateForkTest is Test {
    address constant ASSAY = 0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC;
    address constant LIVE_VERIFIER = 0x9AF7D9C3B27c4A8a11Fb879041B931C38B712380;
    bytes32 constant PHALA_KEY = 0x110f3824daeeef29dbeba9677a5794ffed257b1082d9fd4599b3c0819953aa0a;
    bytes32 constant PHALA_MEASUREMENT = 0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149;
    string constant FIXTURE = "../fixtures/receipt_vectors.json";

    struct Verdict {
        bool ok;
        bytes32 requestedModel;
        bytes32 servedModel;
        bytes32 requestHash;
        bytes32 responseHash;
    }

    IX402BatchSettlement x402;
    MockDepositCollector collector;
    TestUSDG usdg;
    ChironGate gate;
    uint256 payerPk = 0xA0714;
    address payer;
    address payout = makeAddr("payout");
    bytes32 fixtureKey;

    function setUp() public {
        vm.createSelectFork("arbitrum_sepolia");
        x402 = IX402BatchSettlement(address(new x402BatchSettlement()));
        collector = new MockDepositCollector();
        usdg = new TestUSDG();
        gate = new ChironGate(x402, IReceiptKeyRegistry(ASSAY));
        payer = vm.addr(payerPk);
        usdg.mint(payer, 100e6);
        vm.prank(payer);
        usdg.approve(address(collector), type(uint256).max);
        fixtureKey = vm.parseJsonBytes32(vm.readFile(FIXTURE), ".pubkey");
    }

    function _vector(string memory name) internal view returns (bytes memory receipt, bytes memory sig) {
        string memory json = vm.readFile(FIXTURE);
        receipt = vm.parseJsonBytes(json, string.concat(".", name, ".receipt_bytes_hex"));
        sig = vm.parseJsonBytes(json, string.concat(".", name, ".signature_hex"));
    }

    /// Real eth_call to the live Stylus verifier.
    function _liveVerify(bytes32 pubkey, bytes memory receipt, bytes memory sig) internal returns (Verdict memory v) {
        bytes memory data = abi.encodeCall(IReceiptVerifier.verifyReceipt, (pubkey, receipt, sig));
        string memory params = string.concat(
            '[{"to":"', vm.toString(LIVE_VERIFIER), '","data":"', vm.toString(data), '"},"latest"]'
        );
        bytes memory ret = vm.rpc("eth_call", params);
        (v.ok, v.requestedModel, v.servedModel, v.requestHash, v.responseHash) =
            abi.decode(ret, (bool, bytes32, bytes32, bytes32, bytes32));
    }

    function _serve(bytes32 pubkey, bytes memory receipt, bytes memory sig, Verdict memory v) internal {
        vm.mockCall(
            LIVE_VERIFIER,
            abi.encodeCall(IReceiptVerifier.verifyReceipt, (pubkey, receipt, sig)),
            abi.encode(v.ok, v.requestedModel, v.servedModel, v.requestHash, v.responseHash)
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Opens a gate channel pinned to (model, measurement) and returns everything a claim needs.
    function _openAndSign(bytes32 model, bytes32 measurement, uint128 total, bytes32 req, bytes32 resp)
        internal
        returns (IX402BatchSettlement.VoucherClaim memory vc, ChironGate.Pin memory pin, bytes memory ack)
    {
        pin = ChironGate.Pin(model, measurement, payout, bytes32(0));
        IX402BatchSettlement.ChannelConfig memory c = IX402BatchSettlement.ChannelConfig(
            payer, payer, address(gate), address(gate), address(usdg), 1 hours, gate.pinSalt(pin)
        );
        x402.deposit(c, 100e6, address(collector), "");
        bytes32 cid = x402.getChannelId(c);
        vc = IX402BatchSettlement.VoucherClaim(
            IX402BatchSettlement.Voucher(c, total), _sign(payerPk, x402.getVoucherDigest(cid, total)), total
        );
        ack = _sign(payerPk, gate.callAckDigest(cid, total, req, resp));
    }

    function test_liveRegistry_holdsPhalaKey() public view {
        (bytes32 m, uint64 expiry) = IReceiptKeyRegistry(ASSAY).receiptSigners(PHALA_KEY);
        assertEq(m, PHALA_MEASUREMENT);
        assertGt(expiry, block.timestamp, "live Phala receipt key registration has expired");
        assertEq(address(gate.receiptVerifier()), LIVE_VERIFIER);
    }

    function test_liveVerifier_fixtureVectors() public {
        (bytes memory r, bytes memory s) = _vector("honest");
        Verdict memory honest = _liveVerify(fixtureKey, r, s);
        assertTrue(honest.ok);
        assertEq(honest.requestedModel, honest.servedModel);
        (r, s) = _vector("model_swap");
        Verdict memory swap = _liveVerify(fixtureKey, r, s);
        assertTrue(swap.ok);
        assertTrue(swap.requestedModel != swap.servedModel);
    }

    function test_forkClaim_paysAgainstLiveRegistry() public {
        (bytes memory r, bytes memory s) = _vector("honest");
        Verdict memory v = _liveVerify(fixtureKey, r, s);
        _serve(PHALA_KEY, r, s, v);
        (IX402BatchSettlement.VoucherClaim memory vc, ChironGate.Pin memory pin, bytes memory ack) =
            _openAndSign(v.requestedModel, PHALA_MEASUREMENT, 30e6, v.requestHash, v.responseHash);
        assertEq(gate.claimWithReceipt(vc, pin, v.requestHash, v.responseHash, ack, PHALA_KEY, r, s), 30e6);
        assertEq(usdg.balanceOf(payout), 30e6);
        assertEq(usdg.balanceOf(address(gate)), 0);
    }

    function test_forkClaim_modelSwapVector_reverts() public {
        (bytes memory r, bytes memory s) = _vector("model_swap");
        Verdict memory v = _liveVerify(fixtureKey, r, s);
        _serve(PHALA_KEY, r, s, v);
        (IX402BatchSettlement.VoucherClaim memory vc, ChironGate.Pin memory pin, bytes memory ack) =
            _openAndSign(v.requestedModel, PHALA_MEASUREMENT, 30e6, v.requestHash, v.responseHash);
        vm.expectRevert(ChironGate.ModelMismatch.selector);
        gate.claimWithReceipt(vc, pin, v.requestHash, v.responseHash, ack, PHALA_KEY, r, s);
    }

    /// Fully real inputs: the fixture key really signed this receipt, and the live registry
    /// really has no entry for it.
    function test_forkClaim_fixtureKeyNotRegisteredLive_reverts() public {
        (bytes memory r, bytes memory s) = _vector("honest");
        Verdict memory v = _liveVerify(fixtureKey, r, s);
        _serve(fixtureKey, r, s, v);
        (IX402BatchSettlement.VoucherClaim memory vc, ChironGate.Pin memory pin, bytes memory ack) =
            _openAndSign(v.requestedModel, PHALA_MEASUREMENT, 30e6, v.requestHash, v.responseHash);
        vm.expectRevert(ChironGate.SignerNotRegistered.selector);
        gate.claimWithReceipt(vc, pin, v.requestHash, v.responseHash, ack, fixtureKey, r, s);
    }

    function test_forkClaim_wrongMeasurement_reverts() public {
        (bytes memory r, bytes memory s) = _vector("honest");
        Verdict memory v = _liveVerify(fixtureKey, r, s);
        _serve(PHALA_KEY, r, s, v);
        (IX402BatchSettlement.VoucherClaim memory vc, ChironGate.Pin memory pin, bytes memory ack) =
            _openAndSign(v.requestedModel, keccak256("some-other-image"), 30e6, v.requestHash, v.responseHash);
        vm.expectRevert(ChironGate.MeasurementMismatch.selector);
        gate.claimWithReceipt(vc, pin, v.requestHash, v.responseHash, ack, PHALA_KEY, r, s);
    }

    function test_forkClaim_afterLiveExpiry_reverts() public {
        (bytes memory r, bytes memory s) = _vector("honest");
        Verdict memory v = _liveVerify(fixtureKey, r, s);
        _serve(PHALA_KEY, r, s, v);
        (IX402BatchSettlement.VoucherClaim memory vc, ChironGate.Pin memory pin, bytes memory ack) =
            _openAndSign(v.requestedModel, PHALA_MEASUREMENT, 30e6, v.requestHash, v.responseHash);
        (, uint64 expiry) = IReceiptKeyRegistry(ASSAY).receiptSigners(PHALA_KEY);
        vm.warp(uint256(expiry) + 1);
        vm.expectRevert(ChironGate.AttestationExpired.selector);
        gate.claimWithReceipt(vc, pin, v.requestHash, v.responseHash, ack, PHALA_KEY, r, s);
    }
}
