// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";

/// Item E5 / redeemWithReceipt(): tests Assay.sol's own logic (allowlist, replay,
/// signer/measurement binding, model-hash comparison, delta/paid bookkeeping) against
/// a MockReceiptVerifier returning controlled (ok, requestedModelHash, servedModelHash,
/// responseHash) tuples, not a real Ed25519 verification -- receipt-verifier's real
/// cryptography is proven separately (`cargo test --lib` + `--test vectors` +
/// `--test export_fixture`, receipt-verifier/README.md). The two "honest"/"model_swap"
/// fixtures below are read from `../fixtures/receipt_vectors.json`
/// (forge's `fs_permissions` in foundry.toml already grants read access to that
/// directory), which that Rust `export_fixture` test regenerates on every
/// `cargo test`, so the requestedModelHash/servedModelHash/responseHash bytes hardcoded
/// into the assertions below are exactly what `verify_receipt_core` computed, not
/// separately invented in Solidity. See MockReceiptVerifier.sol's doc comment for why
/// a mock, not a Solidity Ed25519 library, stands in for the cryptography here.
contract AssayReceiptTest is AssayTestBase {
    string internal constant FIXTURE_PATH = "../fixtures/receipt_vectors.json";

    bytes32 internal honestRequestedModelHash;
    bytes32 internal honestServedModelHash;
    bytes32 internal honestResponseHash;
    bytes32 internal swapRequestedModelHash;
    bytes32 internal swapServedModelHash;
    bytes32 internal swapResponseHash;

    function setUp() public override {
        super.setUp();
        string memory json = vm.readFile(FIXTURE_PATH);
        honestRequestedModelHash = vm.parseJsonBytes32(json, ".honest.requested_model_hash");
        honestServedModelHash = vm.parseJsonBytes32(json, ".honest.served_model_hash");
        honestResponseHash = vm.parseJsonBytes32(json, ".honest.response_hash");
        swapRequestedModelHash = vm.parseJsonBytes32(json, ".model_swap.requested_model_hash");
        swapServedModelHash = vm.parseJsonBytes32(json, ".model_swap.served_model_hash");
        swapResponseHash = vm.parseJsonBytes32(json, ".model_swap.response_hash");

        // The fixture's honest case is requested == served (no swap); confirm the
        // fixture itself still matches that shape before any test relies on it.
        assertEq(honestRequestedModelHash, honestServedModelHash, "fixture drift: honest case must have no swap");
        assertTrue(swapRequestedModelHash != swapServedModelHash, "fixture drift: swap case must actually differ");
    }

    function _openReceiptChannel(uint128 amount) internal returns (uint256 channelId) {
        channelId = _openChannel(amount, APPROVED_MEASUREMENT, honestRequestedModelHash);
    }

    /// Case 1: honest receipt pays. servedModelHash == requestedModelHash ==
    /// channel's pinned requestedModelHash, receipt's own responseHash matches the
    /// voucher's, pubkey registered to the channel's exact measurement.
    function test_redeemWithReceipt_honestReceipt_pays() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        uint256 channelId = _openReceiptChannel(1_000e6);

        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-1"), honestResponseHash);
        bytes memory payerSig = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), honestResponseHash);

        vm.prank(provider);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), honestResponseHash, payerSig, receiptPubkey, hex"aa", hex"bb"
        );

        assertEq(usdg.balanceOf(provider), 100e6);
        (,, uint128 deposit, uint128 paid,,,,,,) = assay.channels(channelId);
        assertEq(deposit, 1_000e6);
        assertEq(paid, 100e6);
    }

    /// Case 2 (mutation-proof target): a receipt whose servedModelHash differs from
    /// the channel's pinned requestedModelHash must revert ModelMismatch, even though
    /// the receipt itself is genuine (`ok == true`) -- the exact model-swap refusal
    /// item E5 targets.
    function test_redeemWithReceipt_modelSwap_revertsModelMismatch() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        uint256 channelId = _openReceiptChannel(1_000e6);

        receiptVerifier.setNext(true, swapRequestedModelHash, swapServedModelHash, keccak256("req-1"), swapResponseHash);
        bytes memory payerSig = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), swapResponseHash);

        vm.prank(provider);
        vm.expectRevert(Assay.ModelMismatch.selector);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), swapResponseHash, payerSig, receiptPubkey, hex"aa", hex"bb"
        );
    }

    /// A receipt that swaps the model but whose fixture's requestedModelHash also
    /// no longer matches the channel (defence-in-depth branch: requestedModelHash !=
    /// c.requestedModelHash checked independently of servedModelHash).
    function test_redeemWithReceipt_requestedHashMismatch_revertsModelMismatch() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        // Pin the channel to the swap-case's SERVED hash, so servedModelHash matches
        // but the receipt's own requestedModelHash (a different string) does not --
        // isolates the second `if` in redeemWithReceipt from the first.
        uint256 channelId = _openChannel(1_000e6, APPROVED_MEASUREMENT, swapServedModelHash);

        receiptVerifier.setNext(true, swapRequestedModelHash, swapServedModelHash, keccak256("req-1"), swapResponseHash);
        bytes memory payerSig = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), swapResponseHash);

        vm.prank(provider);
        vm.expectRevert(Assay.ModelMismatch.selector);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), swapResponseHash, payerSig, receiptPubkey, hex"aa", hex"bb"
        );
    }

    /// Case 3: the voucher's responseHash and the receipt's own responseHash must
    /// agree; a provider (or a compromised relay) supplying a voucher for a
    /// different response than the receipt actually covers must not get paid.
    function test_redeemWithReceipt_tamperedResponseHash_reverts() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        uint256 channelId = _openReceiptChannel(1_000e6);

        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-1"), honestResponseHash);
        bytes32 tamperedResponseHash = keccak256("not-the-real-response");
        bytes memory payerSig = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), tamperedResponseHash);

        vm.prank(provider);
        vm.expectRevert(Assay.ResponseHashMismatch.selector);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), tamperedResponseHash, payerSig, receiptPubkey, hex"aa", hex"bb"
        );
    }

    /// Case 4: a pubkey that was never registered via registerReceiptKey() can never
    /// redeem, regardless of what the mock receipt verifier says.
    function test_redeemWithReceipt_unregisteredPubkey_reverts() public {
        uint256 channelId = _openReceiptChannel(1_000e6);
        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-1"), honestResponseHash);
        bytes memory payerSig = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), honestResponseHash);

        vm.prank(provider);
        vm.expectRevert(Assay.SignerNotRegistered.selector);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), honestResponseHash, payerSig, receiptPubkey, hex"aa", hex"bb"
        );
    }

    /// Case 5: a pubkey registered to a DIFFERENT measurement than the one this
    /// channel is pinned to must not be able to redeem against this channel --
    /// mirrors redeem()'s existing MeasurementMismatch check for the ECDSA path.
    function test_redeemWithReceipt_pubkeyRegisteredToDifferentMeasurement_reverts() public {
        _registerReceiptKey(APPROVED_MEASUREMENT_2); // channel below is pinned to APPROVED_MEASUREMENT
        uint256 channelId = _openReceiptChannel(1_000e6);

        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-1"), honestResponseHash);
        bytes memory payerSig = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), honestResponseHash);

        vm.prank(provider);
        vm.expectRevert(Assay.MeasurementMismatch.selector);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), honestResponseHash, payerSig, receiptPubkey, hex"aa", hex"bb"
        );
    }

    /// Case 6: replay -- the same (provider, requestHash, responseHash) triple can
    /// never be paid twice, sharing consumedReceipt's namespace with the legacy
    /// redeem() path (proven separately by test_replaySharedAcrossPaths_reverts).
    function test_redeemWithReceipt_replay_reverts() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        uint256 channelId = _openReceiptChannel(1_000e6);
        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-1"), honestResponseHash);

        bytes memory payerSig1 = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), honestResponseHash);
        vm.prank(provider);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), honestResponseHash, payerSig1, receiptPubkey, hex"aa", hex"bb"
        );

        // Same (requestHash, responseHash) again, bumping cumulativeAmount (which
        // alone would otherwise be a valid increasing voucher) -- must still revert,
        // proving the replay guard keys on the receipt identity, not merely on
        // cumulativeAmount monotonicity.
        bytes memory payerSig2 = _receiptPayerSig(channelId, 200e6, keccak256("req-1"), honestResponseHash);
        vm.prank(provider);
        vm.expectRevert(Assay.ReceiptAlreadyConsumed.selector);
        assay.redeemWithReceipt(
            channelId, 200e6, keccak256("req-1"), honestResponseHash, payerSig2, receiptPubkey, hex"aa", hex"bb"
        );
    }

    /// A model-pinned channel is receipt-only: the legacy redeem() carries no model
    /// evidence, so a provider cannot route a swapped model's response through it
    /// (re-review RR-1). With each channel restricted to one path, a pair can no
    /// longer be paid once per path on the same channel.
    function test_modelPinnedChannel_refusesLegacyRedeem() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openReceiptChannel(1_000e6);

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), honestResponseHash);
        vm.prank(provider);
        vm.expectRevert(Assay.ModelMismatch.selector);
        assay.redeem(channelId, 100e6, keccak256("req-1"), honestResponseHash, payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }

    /// A legacy-only channel (requestedModelHash == 0) cannot be paid by a receipt:
    /// the receipt's model hash is never zero, so it can never match.
    function test_legacyOnlyChannel_refusesReceipt() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);
        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-1"), honestResponseHash);
        bytes memory payerSig = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), honestResponseHash);
        vm.prank(provider);
        vm.expectRevert(Assay.ModelMismatch.selector);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), honestResponseHash, payerSig, receiptPubkey, hex"aa", hex"bb"
        );
    }

    /// The receipt's request.received body hash must equal the voucher's requestHash,
    /// so one receipt cannot back payments for different requests (re-review RR-3).
    function test_receiptRequestHashMismatch_reverts() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        uint256 channelId = _openReceiptChannel(1_000e6);
        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-1"), honestResponseHash);

        bytes memory payerSig1 = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), honestResponseHash);
        vm.startPrank(provider);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), honestResponseHash, payerSig1, receiptPubkey, hex"aa", hex"bb"
        );
        bytes memory payerSig2 = _receiptPayerSig(channelId, 200e6, keccak256("req-2"), honestResponseHash);
        vm.expectRevert(Assay.RequestHashMismatch.selector);
        assay.redeemWithReceipt(
            channelId, 200e6, keccak256("req-2"), honestResponseHash, payerSig2, receiptPubkey, hex"aa", hex"bb"
        );
        vm.stopPrank();
        assertEq(usdg.balanceOf(provider), 100e6);
    }

    /// Invariant: two successive honest redeemWithReceipt() calls still pay only the
    /// delta each time and never exceed the deposit, exactly like redeem()'s own
    /// cumulative-voucher invariant (Assay.t.sol's test_redeem_paysDeltaToProvider).
    function test_redeemWithReceipt_cumulativeDeltaInvariantHolds() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        uint256 channelId = _openReceiptChannel(1_000e6);
        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-1"), honestResponseHash);

        bytes memory payerSig1 = _receiptPayerSig(channelId, 100e6, keccak256("req-1"), honestResponseHash);
        vm.prank(provider);
        assay.redeemWithReceipt(
            channelId, 100e6, keccak256("req-1"), honestResponseHash, payerSig1, receiptPubkey, hex"aa", hex"bb"
        );
        assertEq(usdg.balanceOf(provider), 100e6);

        bytes32 secondResponseHash = keccak256("second-call-response");
        receiptVerifier.setNext(true, honestRequestedModelHash, honestServedModelHash, keccak256("req-2"), secondResponseHash);
        bytes memory payerSig2 = _receiptPayerSig(channelId, 250e6, keccak256("req-2"), secondResponseHash);
        vm.prank(provider);
        assay.redeemWithReceipt(
            channelId, 250e6, keccak256("req-2"), secondResponseHash, payerSig2, receiptPubkey, hex"aa", hex"bb"
        );
        // Paid only the 150e6 delta the second time, not the full 250e6 again.
        assertEq(usdg.balanceOf(provider), 250e6);

        (,, uint128 deposit, uint128 paid,,,,,,) = assay.channels(channelId);
        assertEq(deposit, 1_000e6);
        assertEq(paid, 250e6);
        assertLe(paid, deposit);
    }
}
