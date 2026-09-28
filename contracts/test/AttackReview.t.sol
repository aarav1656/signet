// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";

/// Converted tests for SECURITY-REVIEW.md, each now asserting the SAFE behaviour
/// after the fix (they were red against the pre-fix Assay.sol; see git history /
/// the review doc for the original failing assertions).
/// Run the green suite without them: forge test --no-match-contract AttackReview
contract AttackReviewTest is AssayTestBase {
    /// H-1 fix: requestClose() cannot fire until channelTimeout has elapsed since
    /// the last activity, and opens a challengeWindow during which the provider's
    /// pending voucher still redeems. The agent can no longer close over unpaid
    /// work; finalizeClose only pays out what remains after the window.
    function test_H1_challengeWindowPaysPendingVoucherBeforeClose() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 id = _openChannel(100e6);
        (,,,, uint64 openedAt,,,,,) = assay.channels(id);

        vm.warp(openedAt + CHANNEL_TIMEOUT - 1);
        (bytes memory p, bytes memory e) = _redeemArgs(id, 40e6, keccak256("req"), keccak256("resp"));

        vm.warp(openedAt + CHANNEL_TIMEOUT);
        vm.prank(agent);
        assay.requestClose(id);

        vm.prank(provider);
        assay.redeem(id, 40e6, keccak256("req"), keccak256("resp"), p, e);
        assertEq(usdg.balanceOf(provider), 40e6, "provider paid for delivered work during challenge window");

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        uint256 agentBefore = usdg.balanceOf(agent);
        vm.prank(agent);
        assay.finalizeClose(id);
        assertEq(usdg.balanceOf(agent), agentBefore + 60e6);

        (,,, uint128 paid,,,, bool closed,,) = assay.channels(id);
        assertEq(paid, 40e6);
        assertTrue(closed);
    }

    /// H-2 fix: register() records every quote's bytes as used, so the exact same
    /// quote can never re-register a signer again, however much time has passed.
    /// (The nonce-freshness check itself lives in verifier/tests/attack_review.rs,
    /// since MockVerifier does not run the real report_data binding.)
    function test_H2_staleQuoteCannotReRegister() public {
        bytes memory quote = hex"1234";
        verifier.setNext(signerAddr, APPROVED_MEASUREMENT);
        assay.register(quote, 0);

        vm.warp(block.timestamp + 400 days);
        vm.expectRevert(Assay.QuoteAlreadyUsed.selector);
        assay.register(quote, 0);
    }

    /// M-1 fix: consumedReceipt is keyed globally on (provider, requestHash,
    /// responseHash), not just "the last one on this channel", so A, B, A no
    /// longer pays A twice.
    function test_M1_responseHashReplayABA_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 id = _openChannel(100e6);
        bytes32 rq = keccak256("req");
        bytes32 a = keccak256("A");
        bytes32 b = keccak256("B");

        (bytes memory p1, bytes memory e1) = _redeemArgs(id, 10e6, rq, a);
        vm.prank(provider);
        assay.redeem(id, 10e6, rq, a, p1, e1);
        (bytes memory p2, bytes memory e2) = _redeemArgs(id, 20e6, rq, b);
        vm.prank(provider);
        assay.redeem(id, 20e6, rq, b, p2, e2);

        (bytes memory p3, bytes memory e3) = _redeemArgs(id, 30e6, rq, a);
        vm.prank(provider);
        vm.expectRevert(Assay.ReceiptAlreadyConsumed.selector);
        assay.redeem(id, 30e6, rq, a, p3, e3);
        assertEq(usdg.balanceOf(provider), 20e6);
    }

    /// M-1 fix: the same receipt cannot be paid twice across two different
    /// channels held by the same provider either.
    function test_M1b_sameReceiptPaidOnTwoChannels_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 c1 = _openChannel(100e6);
        uint256 c2 = _openChannel(100e6);
        bytes32 rq = keccak256("req");
        bytes32 rs = keccak256("resp");

        (bytes memory p1, bytes memory e) = _redeemArgs(c1, 10e6, rq, rs);
        vm.prank(provider);
        assay.redeem(c1, 10e6, rq, rs, p1, e);

        bytes memory p2 = _signVoucher(agentPk, c2, 10e6, rq, rs);
        vm.prank(provider);
        vm.expectRevert(Assay.ReceiptAlreadyConsumed.selector);
        assay.redeem(c2, 10e6, rq, rs, p2, e);
        assertEq(usdg.balanceOf(provider), 10e6);
    }

    /// L-2 fix: openChannelWithPermit falls through when a griefer relays the
    /// same permit first, since the allowance it would have granted is already
    /// in place; the agent's open still succeeds instead of reverting.
    function test_L2_permitFrontrunFallsThrough() public {
        uint128 amount = 50e6;
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                agent,
                address(assay),
                uint256(amount),
                usdg.nonces(agent),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);

        vm.prank(makeAddr("griefer"));
        usdg.permit(agent, address(assay), amount, deadline, v, r, s);

        uint256 before = usdg.balanceOf(agent);
        vm.prank(agent);
        uint256 channelId = assay.openChannelWithPermit(provider, amount, APPROVED_MEASUREMENT, bytes32(0), deadline, v, r, s);

        assertEq(usdg.balanceOf(agent), before - amount, "open still pulled the deposit despite the front-run permit");
        (address a, address p,,,,,,,,) = assay.channels(channelId);
        assertEq(a, agent);
        assertEq(p, provider);
    }
}
