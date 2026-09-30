// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountTestBase} from "./AgentAccountTestBase.sol";

/// I3: the rolling daily window, against an exact reference that keeps every trade.
contract AgentAccountWindowTest is AgentAccountTestBase {
    uint128 internal constant CAP = 120e6;
    uint128 internal constant BAND1 = 50e6;

    uint256[] internal times;
    uint256[] internal amounts;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        account.setLimits(address(usdg), AgentAccount.Limits(true, BAND1, CAP, BAND1));
    }

    function _refresh() internal {
        vm.roll(vm.getBlockNumber() + 1);
        _registerAgent(agentAddr, AGENT_M);
        assay.registerReceiptKey(abi.encode(vm.getBlockNumber()), hex"02", vm.getBlockNumber() - 1, RECEIPT_KEY);
    }

    function _try(uint128 amount) internal returns (bool ok, bytes memory err) {
        AgentAccount.Trade memory t = _buy(amount);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        try account.execute(t, r) {
            ok = true;
        } catch (bytes memory e) {
            err = e;
        }
    }

    /// Exact check: no 24-hour interval [t, t + 86400) holds more than CAP. The heaviest
    /// interval can always be taken to start at a trade, so checking those starts is complete.
    function _referenceHolds() internal view returns (bool) {
        for (uint256 s; s < times.length; ++s) {
            uint256 sum;
            for (uint256 i; i < times.length; ++i) {
                if (times[i] >= times[s] && times[i] < times[s] + 86400) sum += amounts[i];
            }
            if (sum > CAP) return false;
        }
        return true;
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_window_matchesReferenceModel(uint256 seed) public {
        for (uint256 step; step < 24; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 dt = seed % 3 hours;
            uint128 amount = uint128(1 + (seed >> 64) % BAND1);
            vm.warp(vm.getBlockTimestamp() + dt);
            if (vm.getBlockTimestamp() + 1 hours > account.agentExpiry()) _refresh();

            times.push(vm.getBlockTimestamp());
            amounts.push(amount);
            bool exactAccepts = _referenceHolds();

            (bool ok, bytes memory err) = _try(amount);
            if (ok) {
                assertTrue(exactAccepts, "account accepted a trade the exact reference rejects");
            } else {
                assertEq(bytes4(err), AgentAccount.DailyCapExceeded.selector);
                times.pop();
                amounts.pop();
            }
        }
    }

    /// The case that separates a 25-bucket sum from a 24-bucket one: the end of hour h0 and
    /// the start of hour h0 + 24 are 82801 s apart, inside one 24-hour interval.
    function test_window_hour24Boundary() public {
        uint256 h0 = vm.getBlockTimestamp() / 3600 + 1;
        vm.warp(h0 * 3600 + 3599);
        _exec(_buy(BAND1));
        _exec(_buy(BAND1));
        _exec(_buy(CAP - 2 * BAND1));
        vm.warp((h0 + 24) * 3600);
        _refresh();
        (bool ok, bytes memory err) = _try(1);
        assertFalse(ok, "a trade 82801 s after a full window was accepted");
        assertEq(err, abi.encodeWithSelector(AgentAccount.DailyCapExceeded.selector, CAP, CAP));
        vm.warp((h0 + 25) * 3600);
        (ok,) = _try(BAND1);
        assertTrue(ok, "the hour rolled out but the window still refused");
        assertEq(account.windowUsed(address(usdg)), BAND1);
    }

    /// Ring reuse: hour h0 + 25 lands in hour h0's slot and must start from zero there.
    function test_window_slotReuseResets() public {
        uint256 h0 = vm.getBlockTimestamp() / 3600 + 1;
        vm.warp(h0 * 3600);
        _exec(_buy(BAND1));
        vm.warp((h0 + 25) * 3600);
        _refresh();
        _exec(_buy(BAND1));
        _exec(_buy(BAND1));
        (bool ok, bytes memory err) = _try(CAP - 2 * BAND1 + 1);
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(AgentAccount.DailyCapExceeded.selector, 2 * BAND1, CAP));
        assertEq(account.windowUsed(address(usdg)), 2 * BAND1);
    }

    /// Every one of the 25 buckets is read: fill 25 consecutive hours, then the sum covers them.
    function test_window_readsAllTwentyFiveBuckets() public {
        vm.prank(owner);
        account.setLimits(address(usdg), AgentAccount.Limits(true, BAND1, 25e6, BAND1));
        uint256 h0 = vm.getBlockTimestamp() / 3600 + 1;
        for (uint256 i; i < 25; ++i) {
            vm.warp((h0 + i) * 3600);
            if (vm.getBlockTimestamp() + 1 hours > account.agentExpiry()) _refresh();
            _exec(_buy(1e6));
        }
        assertEq(account.windowUsed(address(usdg)), 25e6);
        (bool ok, bytes memory err) = _try(1);
        assertFalse(ok);
        assertEq(err, abi.encodeWithSelector(AgentAccount.DailyCapExceeded.selector, 25e6, 25e6));
    }

    /// Approved trades bypass and do not fill the agent's window.
    function test_window_approvedTradesNotRecorded() public {
        vm.prank(owner);
        account.setLimits(address(usdg), AgentAccount.Limits(true, 100e6, CAP, BAND1));
        AgentAccount.Trade memory t = _buy(100e6);
        uint256 id = _propose(t);
        vm.prank(owner);
        account.approveTrade(id, t);
        assertEq(account.windowUsed(address(usdg)), 0);
        _exec(_buy(BAND1));
        _exec(_buy(BAND1));
        assertEq(account.windowUsed(address(usdg)), 2 * BAND1);
    }
}
