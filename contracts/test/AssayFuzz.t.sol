// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";

contract AssayFuzzTest is AssayTestBase {
    /// However a sequence of cumulative vouchers is generated, redeeming them in
    /// increasing order must (a) never revert while amounts stay within the deposit,
    /// (b) pay the provider exactly cumulativeAmount in total, never more, and
    /// (c) leave the contract holding exactly deposit - paid at all times.
    function testFuzz_redeem_cumulativeNeverExceedsDeposit(uint128 deposit, uint8 stepCount, uint256 seed) public {
        deposit = uint128(bound(deposit, 1, 1_000_000e6));
        stepCount = uint8(bound(stepCount, 1, 12));

        _register(signerAddr, APPROVED_MEASUREMENT);
        vm.startPrank(agent);
        usdg.approve(address(assay), deposit);
        uint256 channelId = assay.openChannel(provider, deposit, APPROVED_MEASUREMENT, bytes32(0));
        vm.stopPrank();

        uint256 cumulative = 0;
        for (uint256 i = 0; i < stepCount; i++) {
            uint256 remaining = uint256(deposit) - cumulative;
            if (remaining == 0) break;
            uint256 step = (uint256(keccak256(abi.encode(seed, i))) % remaining) + 1;
            cumulative += step;

            bytes32 requestHash = keccak256(abi.encode("req", i));
            bytes32 responseHash = keccak256(abi.encode("call", i));
            (bytes memory payerSig, bytes memory enclaveSig) =
                _redeemArgs(channelId, cumulative, requestHash, responseHash);
            vm.prank(provider);
            assay.redeem(channelId, cumulative, requestHash, responseHash, payerSig, enclaveSig);

            (,,, uint128 paid,,,,,,,) = assay.channels(channelId);
            assertEq(paid, cumulative);
            assertLe(cumulative, deposit);
            assertEq(usdg.balanceOf(provider), cumulative);
            assertEq(usdg.balanceOf(address(assay)), deposit - cumulative);
        }
    }

    /// No matter the amount requested, a single redeem can never pull out more than
    /// the deposit locked into the channel: this is the property the deposit cap
    /// exists to hold, exercised across a wide amount range.
    function testFuzz_redeem_singleVoucherCannotExceedDeposit(uint128 deposit, uint256 attempt) public {
        deposit = uint128(bound(deposit, 1, 1_000_000e6));
        vm.assume(attempt > deposit);

        _register(signerAddr, APPROVED_MEASUREMENT);
        vm.startPrank(agent);
        usdg.approve(address(assay), deposit);
        uint256 channelId = assay.openChannel(provider, deposit, APPROVED_MEASUREMENT, bytes32(0));
        vm.stopPrank();

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, attempt, keccak256("req-over"), keccak256("over"));
        vm.prank(provider);
        vm.expectRevert(Assay.AmountExceedsDeposit.selector);
        assay.redeem(channelId, attempt, keccak256("req-over"), keccak256("over"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }
}
