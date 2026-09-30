// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {Assay} from "../src/Assay.sol";
import {AgentAccountTestBase} from "./AgentAccountTestBase.sol";
import {MockReceiptVerifier} from "./mocks/MockReceiptVerifier.sol";

/// Plays the agent (execute, propose, withdraw attempts, ERC-1271 attempts) and the owner
/// (limits, pause). Every balance decrease must happen inside a successful agent execute.
contract AgentHandler is Test {
    struct Spend {
        address token;
        uint256 at;
        uint256 amountIn;
        uint256 dailyAtTrade;
    }

    AgentAccount internal immutable account;
    Assay internal immutable assay;
    MockReceiptVerifier internal immutable rv;
    address internal immutable owner;
    address internal immutable agent;
    uint256 internal immutable agentPk;
    address internal immutable usdg;
    address internal immutable tsla;
    bytes32 internal immutable agentM;
    bytes32 internal immutable model;
    bytes32 internal immutable served;
    bytes32 internal immutable receiptKey;
    PoolKey internal key;
    bool internal usdgIs0;
    uint256 internal nonce;

    Spend[] public spends;
    uint256 public unexplainedDecrease;
    uint256 public overSpends;
    uint256 public leaks1271;
    uint256 public agentOwnerPowers;
    uint256 public executes;
    uint256 public fails;

    constructor(
        AgentAccount account_,
        Assay assay_,
        MockReceiptVerifier rv_,
        address owner_,
        uint256 agentPk_,
        address usdg_,
        address tsla_,
        PoolKey memory key_,
        bool usdgIs0_,
        bytes32[4] memory ids // agentM, model, served, receiptKey
    ) {
        account = account_;
        assay = assay_;
        rv = rv_;
        owner = owner_;
        agentPk = agentPk_;
        agent = vm.addr(agentPk_);
        usdg = usdg_;
        tsla = tsla_;
        key = key_;
        usdgIs0 = usdgIs0_;
        agentM = ids[0];
        model = ids[1];
        served = ids[2];
        receiptKey = ids[3];
    }

    function spendCount() external view returns (uint256) {
        return spends.length;
    }

    function _balances() internal view returns (uint256 u, uint256 s) {
        u = IERC20(usdg).balanceOf(address(account));
        s = IERC20(tsla).balanceOf(address(account));
    }

    function _noDecreaseSince(uint256 u0, uint256 s0) internal {
        (uint256 u, uint256 s) = _balances();
        if (u < u0) unexplainedDecrease += u0 - u;
        if (s < s0) unexplainedDecrease += s0 - s;
    }

    function _advance(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt % 3 hours);
        vm.roll(vm.getBlockNumber() + 1);
        if (vm.getBlockTimestamp() + 1 hours > account.agentExpiry() && account.agent() != address(0)) {
            account.registerAgent(abi.encode(agent, agentM, account.attestNonce(vm.getBlockNumber() - 1)), vm.getBlockNumber() - 1);
            assay.registerReceiptKey(abi.encode("k", vm.getBlockNumber()), hex"02", vm.getBlockNumber() - 1, receiptKey);
        }
    }

    function _trade(bool buy, uint256 amt) internal view returns (AgentAccount.Trade memory t) {
        t = AgentAccount.Trade(key, buy ? usdgIs0 : !usdgIs0, uint128(amt), 1, uint64(vm.getBlockTimestamp() + 600));
    }

    function _receipt() internal returns (AgentAccount.Receipt memory) {
        nonce++;
        rv.setNext(true, model, served, keccak256(abi.encode("q", nonce)), keccak256(abi.encode("r", nonce)));
        return AgentAccount.Receipt(receiptKey, "", "");
    }

    function agentExecute(bool buy, uint256 amt, uint256 dt) external {
        _advance(dt);
        address tokenIn = buy ? usdg : tsla;
        (, uint128 perTrade, uint128 daily,) = account.limits(tokenIn);
        amt = bound(amt, 1, uint256(perTrade) + uint256(perTrade) / 5 + 1);
        AgentAccount.Trade memory t = _trade(buy, amt);
        AgentAccount.Receipt memory r = _receipt();
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(account));
        address tokenOut = buy ? tsla : usdg;
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(account));
        vm.prank(agent);
        try account.execute(t, r) returns (uint256, uint256 out) {
            executes++;
            uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(account));
            if (spent > amt || IERC20(tokenOut).balanceOf(address(account)) - outBefore != out || out < 1) overSpends++;
            spends.push(Spend(tokenIn, vm.getBlockTimestamp(), amt, daily));
        } catch {
            fails++;
            if (IERC20(tokenIn).balanceOf(address(account)) != inBefore) unexplainedDecrease += 1;
        }
    }

    function agentPropose(bool buy, uint256 amt, uint256 dt) external {
        _advance(dt);
        (, uint128 perTrade,,) = account.limits(buy ? usdg : tsla);
        amt = bound(amt, 1, uint256(perTrade) + 1);
        AgentAccount.Trade memory t = _trade(buy, amt);
        AgentAccount.Receipt memory r = _receipt();
        (uint256 u0, uint256 s0) = _balances();
        vm.prank(agent);
        try account.propose(t, r) {} catch {}
        _noDecreaseSince(u0, s0);
    }

    function agentTriesOwnerPowers(uint256 which, uint256 amt) external {
        (uint256 u0, uint256 s0) = _balances();
        bytes memory call;
        which %= 5;
        if (which == 0) call = abi.encodeCall(AgentAccount.withdraw, (usdg, agent, bound(amt, 1, 1e12)));
        else if (which == 1) call = abi.encodeCall(AgentAccount.withdraw, (tsla, agent, bound(amt, 1, 1e18)));
        else if (which == 2) call = abi.encodeCall(AgentAccount.openInferenceChannel, (agent, uint128(bound(amt, 1, 1e9))));
        else if (which == 3) call = abi.encodeCall(AgentAccount.setLimits, (usdg, AgentAccount.Limits(true, 1e30, 1e30, 1e30)));
        else call = abi.encodeCall(AgentAccount.approveTrade, (bound(amt, 0, 5), _trade(true, 1)));
        vm.prank(agent);
        (bool ok,) = address(account).call(call);
        if (ok) agentOwnerPowers++;
        _noDecreaseSince(u0, s0);
    }

    function agentSigns1271(bytes32 digest, uint256 channelId, uint256 cum) external {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes memory raw = abi.encodePacked(r, s, v);
        if (account.isValidSignature(digest, raw) == 0x1626ba7e) leaks1271++;
        bytes memory wrapped = abi.encode(channelId % 3, cum, digest, digest, raw);
        if (account.isValidSignature(digest, wrapped) == 0x1626ba7e) leaks1271++;
    }

    function ownerSetLimits(bool usdgSide, uint256 perTrade, uint256 daily, uint256 above) external {
        address token = usdgSide ? usdg : tsla;
        uint256 unit = usdgSide ? 1e6 : 1e16;
        perTrade = bound(perTrade, 1, 100) * unit;
        daily = bound(daily, 0, 300) * unit;
        above = bound(above, 0, perTrade);
        vm.prank(owner);
        account.setLimits(token, AgentAccount.Limits(true, uint128(perTrade), uint128(daily), uint128(above)));
    }

    function ownerTogglePause() external {
        vm.startPrank(owner);
        if (account.paused()) account.unpause();
        else account.pause();
        vm.stopPrank();
    }
}

contract AgentAccountInvariantTest is AgentAccountTestBase {
    AgentHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AgentHandler(
            account, assay, receiptVerifier, owner, agentPk, address(usdg), address(tsla), key, usdgIs0,
            [AGENT_M, MODEL, SERVED, RECEIPT_KEY]
        );
        targetContract(address(handler));
    }

    /// I3, I4, I7: balances fall only inside successful executes, each within its amountIn,
    /// and for every trade j the agent-direct amountIn of its token over the preceding 24 hours
    /// is within the daily cap in force at j.
    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 40
    function invariant_agentCannotDrain() public view {
        assertEq(handler.unexplainedDecrease(), 0, "balance fell outside an agent execute");
        assertEq(handler.overSpends(), 0, "execute spent more than amountIn or credited less than reported");
        assertEq(handler.leaks1271(), 0, "isValidSignature accepted a non-voucher digest");
        assertEq(handler.agentOwnerPowers(), 0, "agent used an owner power");
        uint256 n = handler.spendCount();
        for (uint256 j; j < n; ++j) {
            (address token, uint256 at, , uint256 daily) = handler.spends(j);
            uint256 sum;
            for (uint256 i; i <= j; ++i) {
                (address ti, uint256 ati, uint256 amti,) = handler.spends(i);
                if (ti == token && ati + 86400 > at) sum += amti;
            }
            assertLe(sum, daily, "agent-direct outflow over 24 h exceeded the daily cap");
        }
    }

    function afterInvariant() external view {
        console2.log("run: successful executes", handler.executes(), "reverted executes", handler.fails());
    }
}

/// The handler's execute path really trades and records, so the invariant is not vacuous.
contract AgentHandlerSmokeTest is AgentAccountTestBase {
    function test_handler_executeRecordsSpend() public {
        AgentHandler h = new AgentHandler(
            account, assay, receiptVerifier, owner, agentPk, address(usdg), address(tsla), key, usdgIs0,
            [AGENT_M, MODEL, SERVED, RECEIPT_KEY]
        );
        h.agentExecute(true, 1e6, 0);
        h.agentExecute(false, 1e16, 1 hours);
        assertEq(h.executes(), 2);
        assertEq(h.spendCount(), 2);
        assertEq(h.unexplainedDecrease(), 0);
    }
}
