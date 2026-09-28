// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";

contract AssayAttacksTest is AssayTestBase {
    uint256 internal attackerPk = 0xBEEF;

    /// A voucher whose enclaveSig comes from a key that was never registered
    /// must not pay, even if payerSig is a perfectly valid agent signature.
    function test_attack_enclaveSigFromUnregisteredKey_reverts() public {
        uint256 channelId = _openChannel(1_000e6);
        (bytes32 measurement,) = assay.signers(vm.addr(attackerPk));
        assertEq(measurement, bytes32(0)); // sanity: never registered

        bytes memory payerSig = _signVoucher(agentPk, channelId, 500e6, keccak256("req-1"), keccak256("call-1"));
        bytes memory enclaveSig = _signEnclave(attackerPk, keccak256("req-1"), keccak256("call-1"));

        vm.prank(provider);
        vm.expectRevert(Assay.SignerNotRegistered.selector);
        assay.redeem(channelId, 500e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }

    /// A payerSig not signed by the channel's own agent must not pay, even with a
    /// genuine enclaveSig from the registered attested signer.
    function test_attack_payerSigFromNonAgent_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        bytes memory payerSig = _signVoucher(attackerPk, channelId, 500e6, keccak256("req-1"), keccak256("call-1"));
        bytes memory enclaveSig = _signEnclave(signerPk, keccak256("req-1"), keccak256("call-1"));

        vm.prank(provider);
        vm.expectRevert(Assay.PayerNotAgent.selector);
        assay.redeem(channelId, 500e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }

    /// The agent and the enclave sign the same (requestHash, responseHash) pair
    /// by construction of the Voucher struct and the enclave digest; a provider
    /// that tries to mix a payerSig for one responseHash with an enclaveSig for
    /// a different one ends up with an enclaveSig that does not recover to the
    /// registered signer (its digest binds a different responseHash), so it
    /// reverts the same way an unregistered signer would.
    function test_attack_mismatchedResponseHashBetweenSignatures_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        bytes memory payerSig = _signVoucher(agentPk, channelId, 500e6, keccak256("req-1"), keccak256("call-1"));
        bytes memory enclaveSig = _signEnclave(signerPk, keccak256("req-1"), keccak256("call-DIFFERENT"));

        vm.prank(provider);
        vm.expectRevert(Assay.SignerNotRegistered.selector);
        assay.redeem(channelId, 500e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }

    /// Resubmitting the exact same voucher a second time (replay) must not pay twice:
    /// the second call's cumulativeAmount no longer exceeds what was already paid.
    function test_attack_replayedVoucher_paysOnce() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);
        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 200e6, keccak256("req-1"), keccak256("call-1"));

        vm.prank(provider);
        assay.redeem(channelId, 200e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 200e6);

        vm.prank(provider);
        vm.expectRevert(Assay.AmountNotIncreasing.selector);
        assay.redeem(channelId, 200e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 200e6);
    }

    /// A responseHash cannot be redeemed twice under a bumped cumulative amount
    /// either: the same attested receipt cannot be billed for a second, larger
    /// amount by resigning a new payerSig over it. Caught by consumedReceipt
    /// (keyed on provider+requestHash+responseHash) now that the weaker,
    /// same-channel-only lastResponseHash guard has been removed as dead code
    /// subsumed by it (see SECURITY-REVIEW.md).
    function test_attack_sameResponseHashReplayedWithHigherAmount_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);
        (bytes memory payerSig1, bytes memory enclaveSig1) =
            _redeemArgs(channelId, 200e6, keccak256("req-1"), keccak256("call-1"));

        vm.prank(provider);
        assay.redeem(channelId, 200e6, keccak256("req-1"), keccak256("call-1"), payerSig1, enclaveSig1);

        bytes memory payerSig2 = _signVoucher(agentPk, channelId, 300e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        vm.expectRevert(Assay.ReceiptAlreadyConsumed.selector);
        assay.redeem(channelId, 300e6, keccak256("req-1"), keccak256("call-1"), payerSig2, enclaveSig1);
        assertEq(usdg.balanceOf(provider), 200e6);
    }

    /// A voucher whose cumulative amount is lower than what was already paid (an
    /// attempt to roll billing backward, or replay an old signed voucher after a
    /// higher one was redeemed) must revert.
    function test_attack_cumulativeGoingDown_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        (bytes memory payerSigHigh, bytes memory enclaveSigHigh) =
            _redeemArgs(channelId, 500e6, keccak256("req-2"), keccak256("call-2"));
        vm.prank(provider);
        assay.redeem(channelId, 500e6, keccak256("req-2"), keccak256("call-2"), payerSigHigh, enclaveSigHigh);

        (bytes memory payerSigLow, bytes memory enclaveSigLow) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        vm.expectRevert(Assay.AmountNotIncreasing.selector);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("call-1"), payerSigLow, enclaveSigLow);
        assertEq(usdg.balanceOf(provider), 500e6);
    }

    /// A signer registered from an attestation whose validity window has elapsed
    /// must not be able to pull payment, even with an otherwise-valid voucher.
    function test_attack_expiredAttestation_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        vm.warp(block.timestamp + ATTESTATION_VALIDITY + 1);

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        vm.expectRevert(Assay.AttestationExpired.selector);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }

    /// register() itself must refuse a quote whose measurement is not on the
    /// immutable allowlist fixed at construction, before any signer is stored.
    function test_attack_measurementNotOnAllowlist_reverts() public {
        verifier.setNext(signerAddr, OTHER_MEASUREMENT);
        vm.expectRevert(Assay.MeasurementNotApproved.selector);
        assay.register(hex"1234", block.number - 1);

        (bytes32 measurement,) = assay.signers(signerAddr);
        assertEq(measurement, bytes32(0));
    }

    /// A voucher cannot claim more than the channel's deposit: this is the deposit
    /// cap that bounds an attested-but-dishonest provider's exposure, and it is what
    /// stops a single voucher from draining more than the agent locked up.
    function test_attack_channelDrain_cappedAtDeposit_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 1_000e6 + 1, keccak256("req-1"), keccak256("drain"));
        vm.prank(provider);
        vm.expectRevert(Assay.AmountExceedsDeposit.selector);
        assay.redeem(channelId, 1_000e6 + 1, keccak256("req-1"), keccak256("drain"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);

        // Exactly the deposit is fine, and is the most a single channel ever pays out.
        (bytes memory payerSigFull, bytes memory enclaveSigFull) =
            _redeemArgs(channelId, 1_000e6, keccak256("req-2"), keccak256("drain-ok"));
        vm.prank(provider);
        assay.redeem(channelId, 1_000e6, keccak256("req-2"), keccak256("drain-ok"), payerSigFull, enclaveSigFull);
        assertEq(usdg.balanceOf(provider), 1_000e6);
        assertEq(usdg.balanceOf(address(assay)), 0);
    }

    /// Only the channel's provider can pull a payout for it; another party holding a
    /// validly-signed voucher for someone else's channel cannot redeem it.
    function test_attack_nonProviderCannotRedeem_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);
        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), keccak256("call-1"));

        vm.prank(makeAddr("rando"));
        vm.expectRevert(Assay.NotProvider.selector);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
    }

    /// The agent cannot even request a close before the channel timeout has
    /// elapsed since the last activity (openedAt, here, since nothing was redeemed).
    function test_attack_closeBeforeTimeout_reverts() public {
        uint256 channelId = _openChannel(1_000e6);
        vm.prank(agent);
        vm.expectRevert(Assay.TimeoutNotElapsed.selector);
        assay.requestClose(channelId);
    }

    /// finalizeClose cannot pay out before the challenge window following
    /// requestClose has elapsed, even once the channel timeout itself is over.
    function test_attack_finalizeCloseBeforeChallengeWindow_reverts() public {
        uint256 channelId = _openChannel(1_000e6);
        vm.warp(block.timestamp + CHANNEL_TIMEOUT + 1);
        vm.prank(agent);
        assay.requestClose(channelId);

        vm.prank(agent);
        vm.expectRevert(Assay.ChallengeWindowActive.selector);
        assay.finalizeClose(channelId);
    }

    /// A provider's pending voucher still redeems during the challenge window
    /// opened by requestClose(); this is H-1's fix, the agent can no longer
    /// front-run the provider's redeem by closing over it.
    function test_redeemDuringChallengeWindow_stillPays() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        vm.warp(block.timestamp + CHANNEL_TIMEOUT + 1);
        vm.prank(agent);
        assay.requestClose(channelId);

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 400e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        assay.redeem(channelId, 400e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 400e6);
    }

    /// Once finalizeClose has run, redeem() must revert: the channel is closed.
    function test_redeemAfterFinalizeClose_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        vm.warp(block.timestamp + CHANNEL_TIMEOUT + 1);
        vm.prank(agent);
        assay.requestClose(channelId);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        vm.prank(agent);
        assay.finalizeClose(channelId);

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 400e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        vm.expectRevert(Assay.ChannelClosedErr.selector);
        assay.redeem(channelId, 400e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
    }
}
