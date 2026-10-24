// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountTestBase} from "./AgentAccountTestBase.sol";

/// ERC-8056 corporate actions: the agent stays out of a Stock Token while a multiplier change is
/// pending and for a day after it takes effect; the owner can still approve a proposal.
contract AgentAccountCorporateActionTest is AgentAccountTestBase {
    function _expectPending(AgentAccount.Trade memory t, uint256 cur, uint256 next, uint256 at) internal {
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.CorporateActionPending.selector, address(tsla), cur, next, at));
        account.execute(t, r);
    }

    function test_announcedSplit_blocksBuyAndSell() public {
        uint256 at = vm.getBlockTimestamp() + 2 days;
        tsla.setMultipliers(1e18, 2e18, at);
        _expectPending(_buy(1e6), 1e18, 2e18, at);
        _expectPending(_sell(0.1e18), 1e18, 2e18, at);
    }

    function test_cooldownAfterEffective_blocksThenClears() public {
        uint256 at = vm.getBlockTimestamp();
        tsla.setMultipliers(2e18, 2e18, at);
        _expectPending(_buy(1e6), 2e18, 2e18, at);
        vm.warp(at + account.CORPORATE_ACTION_COOLDOWN() - 1);
        _expectPending(_buy(1e6), 2e18, 2e18, at);
        vm.warp(at + account.CORPORATE_ACTION_COOLDOWN());
        (uint256 id, uint256 out) = _exec(_buy(1e6));
        assertEq(id, 1);
        assertGt(out, 0);
    }

    function test_noAction_tradesNormally() public {
        (uint256 id,) = _exec(_buy(1e6));
        assertEq(id, 1);
    }

    function test_propose_blockedWhilePending() public {
        tsla.setMultipliers(1e18, 3e18, vm.getBlockTimestamp() + 1 days);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectPartialRevert(AgentAccount.CorporateActionPending.selector);
        account.propose(_buy(60e6), r);
    }

    function test_ownerApproval_stillExecutesDuringPendingAction() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        tsla.setMultipliers(1e18, 2e18, vm.getBlockTimestamp() + 1 days);
        vm.prank(owner);
        uint256 out = account.approveTrade(id, t);
        assertGt(out, 0);
    }
}
