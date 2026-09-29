// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ChironGate} from "../src/ChironGate.sol";
import {IX402BatchSettlement} from "../src/IX402BatchSettlement.sol";
import {ChironGateTest} from "./ChironGate.t.sol";

contract JunkToken is ERC20 {
    constructor() ERC20("Junk", "JNK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Paxos-style freeze: any transfer touching a frozen address reverts.
contract FreezeToken is ERC20 {
    mapping(address => bool) public frozen;

    constructor() ERC20("Freeze", "FRZ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function freeze(address a) external {
        frozen[a] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen[from] && !frozen[to], "frozen");
        super._update(from, to, value);
    }
}

/// Independent review 2026-09-29 regressions. R1 and R1b failed before the replay key moved
/// from providerPayout to channelId. Low findings G-2 and G-3 are disclosed, not tested here.
contract ChironGateReviewTest is ChironGateTest {
    /// R1 (High). The payer is served call (REQ1, RESP1) on channel A and signs the CallAck
    /// for 30e6. Before the provider claims, the payer opens a throwaway channel B with the
    /// same pins (different gateNonce) in a worthless token, acks the same call there for
    /// 1 unit and submits it. consumed[] is keyed by providerPayout, not by channel, so the
    /// provider's genuine claim on A is burned. Safe property: the provider's claim on A pays.
    function test_R1_payerCannotBurnSignedAckViaThrowawayChannel() public {
        (ChironGate.Pin memory pa,) = _openA(100e6);
        Claim memory honest = _honest(pa, address(usdg), 30e6, REQ1, RESP1);

        JunkToken junk = new JunkToken();
        junk.mint(agent, 1);
        vm.prank(agent);
        junk.approve(address(collector), 1);
        ChironGate.Pin memory pb = _pin(payoutA, bytes32(uint256(666)));
        _open(_config(pb, address(junk)), 1);
        _receipt(REQ1, RESP1);
        _submit(_honest(pb, address(junk), 1, REQ1, RESP1));
        assertEq(junk.balanceOf(payoutA), 1);

        _receipt(REQ1, RESP1);
        uint128 paid = _submit(honest);
        assertEq(paid, 30e6);
        assertEq(usdg.balanceOf(payoutA), 30e6);
    }

    /// R1 corollary: the docs promise "exposure is one call". Provider serves three calls,
    /// holds acks for 10/20/30 and claims only the latest (batch settlement). The payer burns
    /// all three keys, then the provider can collect nothing and the payer withdraws.
    function test_R1b_exposureIsOneCall() public {
        (ChironGate.Pin memory pa,) = _openA(100e6);
        bytes32[3] memory reqs = [keccak256("q1"), keccak256("q2"), keccak256("q3")];
        bytes32[3] memory resps = [keccak256("r1"), keccak256("r2"), keccak256("r3")];

        JunkToken junk = new JunkToken();
        junk.mint(agent, 3);
        vm.prank(agent);
        junk.approve(address(collector), 3);
        ChironGate.Pin memory pb = _pin(payoutA, bytes32(uint256(667)));
        _open(_config(pb, address(junk)), 3);
        for (uint128 i; i < 3; ++i) {
            _receipt(reqs[i], resps[i]);
            _submit(_honest(pb, address(junk), i + 1, reqs[i], resps[i]));
        }

        uint256 collected;
        for (uint128 i = 3; i > 0; --i) {
            _receipt(reqs[i - 1], resps[i - 1]);
            try gate.claimWithReceipt(
                _honest(pa, address(usdg), i * 10e6, reqs[i - 1], resps[i - 1]).vc,
                pa,
                reqs[i - 1],
                resps[i - 1],
                _honest(pa, address(usdg), i * 10e6, reqs[i - 1], resps[i - 1]).ack,
                receiptPubkey,
                hex"01",
                hex"02"
            ) returns (uint128 p) {
                collected = p;
                break;
            } catch {}
        }
        // One call of exposure means at least calls 1 and 2 (20e6) are collectable.
        assertGe(collected, 20e6);
    }



    /// Control for R3: the payer can always exit through x402 even with the gate frozen.
    function test_R3_control_payerExitsWhileGateFrozen() public {
        FreezeToken tok = new FreezeToken();
        tok.mint(agent, 100e6);
        vm.prank(agent);
        tok.approve(address(collector), type(uint256).max);
        ChironGate.Pin memory p = _pin(payoutB, bytes32(uint256(5)));
        IX402BatchSettlement.ChannelConfig memory c = _config(p, address(tok));
        _open(c, 100e6);
        tok.freeze(address(gate));
        vm.prank(agent);
        x402.initiateWithdraw(c, 100e6);
        vm.warp(block.timestamp + DELAY);
        vm.prank(agent);
        x402.finalizeWithdraw(c);
        assertEq(tok.balanceOf(agent), 100e6);
    }

    /// Checks the fix for R1 keeps the builder's replay property: same channel, same call,
    /// re-acked at a higher total, pays once.
    function test_fixKeepsSameChannelReplayBlocked() public {
        (ChironGate.Pin memory p,) = _openA(100e6);
        _receipt(REQ1, RESP1);
        _submit(_honest(p, address(usdg), 30e6, REQ1, RESP1));
        Claim memory again = _honest(p, address(usdg), 60e6, REQ1, RESP1);
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.ReceiptAlreadyConsumed.selector);
        _submit(again);
    }
}
