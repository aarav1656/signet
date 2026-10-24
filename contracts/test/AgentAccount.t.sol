// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {Assay} from "../src/Assay.sol";
import {AgentAccountTestBase} from "./AgentAccountTestBase.sol";
import {AgentQuoteVerifier} from "./mocks/AgentQuoteVerifier.sol";
import {ArbSysDouble} from "./mocks/ArbSysDouble.sol";
import {ShortPoolManager} from "./mocks/ShortPoolManager.sol";
import {ITransferHook} from "./mocks/TestStockToken.sol";

/// A contract agent (the key is a contract so a hook token can call back through it) that
/// tries to re-enter the account from inside a swap and records how each attempt reverted.
contract ReentrantAgent is ITransferHook {
    AgentAccount public account;
    AgentAccount.Trade internal inner;
    AgentAccount.Receipt internal innerReceipt;
    bool internal armed;
    bytes public executeRevert;
    bytes public proposeRevert;
    bytes public cancelRevert;

    function arm(AgentAccount a, AgentAccount.Trade memory t, AgentAccount.Receipt memory r) external {
        account = a;
        inner = t;
        innerReceipt = r;
        armed = true;
    }

    function run(AgentAccount.Trade memory t, AgentAccount.Receipt memory r) external {
        account.execute(t, r);
    }

    function onTokenTransfer(address, address, uint256) external {
        if (!armed) return;
        armed = false;
        try account.execute(inner, innerReceipt) {} catch (bytes memory e) { executeRevert = e; }
        try account.propose(inner, innerReceipt) {} catch (bytes memory e) { proposeRevert = e; }
        try account.cancelProposal(1) {} catch (bytes memory e) { cancelRevert = e; }
    }
}

contract AgentAccountTest is AgentAccountTestBase {
    using PoolIdLibrary for PoolKey;

    event TradeExecuted(
        uint256 indexed tradeId,
        PoolId indexed poolId,
        address indexed agent,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 agentMeasurement,
        bytes32 servedModelHash,
        bytes32 requestHash,
        bytes32 responseHash,
        uint256 proposalId
    );
    event AgentRegistered(address indexed agent, bytes32 indexed measurement, uint64 expiry, uint256 epoch);
    event AccountCreated(address indexed account, address indexed owner, uint256 index);

    address internal agent2 = makeAddr("agent2");
    address internal agent3 = makeAddr("agent3");

    // ------------------------------------------------------------------ registration

    function test_register_admitsApprovedMeasurement() public {
        assertEq(account.agent(), agentAddr);
        assertEq(account.agentMeasurement(), AGENT_M);
        assertEq(account.agentExpiry(), block.timestamp + 86400);
        assertEq(account.agentEpoch(), 1);

        uint256 later = block.timestamp + 25 hours; // the first admission has expired: the slot is open
        vm.warp(later);
        vm.roll(block.number + 5);
        bytes memory q = _quote(agent2, AGENT_M);
        vm.expectEmit(address(account));
        emit AgentRegistered(agent2, AGENT_M, uint64(vm.getBlockTimestamp() + 86400), 2);
        vm.prank(stranger); // anyone may submit; the key comes out of the quote
        (address signer, bytes32 m) = account.registerAgent(q, block.number - 1);
        assertEq(signer, agent2);
        assertEq(m, AGENT_M);
        assertEq(account.agent(), agent2);
        assertTrue(account.usedQuote(keccak256(q)));
    }

    function test_register_revertsUnapprovedMeasurement() public {
        bytes memory q = _quote(agent2, OTHER_M);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.MeasurementNotApproved.selector, OTHER_M));
        account.registerAgent(q, block.number - 1);
        assertEq(account.agent(), agentAddr);
    }

    function test_register_revertsStaleRefBlock_outOfWindow() public {
        vm.etch(address(0x64), address(new ArbSysDouble()).code);
        // positive control: the ArbSys path admits an in-window refBlock
        vm.roll(block.number + 1);
        _replaceAgentAsOwner(agent2, AGENT_M);
        assertEq(account.agent(), agent2);

        uint256 old = block.number - 300;
        bytes memory q = abi.encode(agent3, AGENT_M, bytes32(0));
        vm.expectRevert(AgentAccount.StaleRefBlock.selector);
        account.registerAgent(q, old);
        vm.expectRevert(AgentAccount.StaleRefBlock.selector);
        account.attestNonce(old);
    }

    function test_register_revertsZeroHash() public {
        ArbSysDouble arb = ArbSysDouble(address(0x64));
        vm.etch(address(arb), address(new ArbSysDouble()).code);
        uint256 ref = block.number - 1;
        arb.setZero(ref);
        // the quote binds exactly the nonce a zero hash would produce, so only the RR-2 check stops it
        bytes32 constantNonce = keccak256(abi.encode(block.chainid, address(account), account.agentEpoch(), bytes32(0)));
        bytes memory q = abi.encode(agent2, AGENT_M, constantNonce);
        vm.expectRevert(AgentAccount.StaleRefBlock.selector);
        account.registerAgent(q, ref);
        assertEq(account.agent(), agentAddr);
    }

    function test_register_arbSysRevertIsFinal() public {
        ArbSysDouble arb = ArbSysDouble(address(0x64));
        vm.etch(address(arb), address(new ArbSysDouble()).code);
        uint256 ref = block.number - 1;
        arb.setRevert(ref);
        // native blockhash(ref) exists here, so only "an ArbSys revert is final" stops a fallback to it
        assertTrue(blockhash(ref) != bytes32(0));
        bytes32 nativeNonce = keccak256(abi.encode(block.chainid, address(account), account.agentEpoch(), blockhash(ref)));
        bytes memory q = abi.encode(agent2, AGENT_M, nativeNonce);
        vm.expectRevert(AgentAccount.StaleRefBlock.selector);
        account.registerAgent(q, ref);
    }

    function test_register_revertsZeroHash_nativeFallback() public {
        // off Arbitrum, blockhash(current block) is zero
        bytes32 constantNonce = keccak256(abi.encode(block.chainid, address(account), account.agentEpoch(), bytes32(0)));
        bytes memory q = abi.encode(agent2, AGENT_M, constantNonce);
        vm.expectRevert(AgentAccount.StaleRefBlock.selector);
        account.registerAgent(q, block.number);
    }

    function test_register_revertsReplayedQuote() public {
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, AGENT_M);
        vm.prank(owner);
        account.registerAgent(q, block.number - 1);
        vm.expectRevert(AgentAccount.QuoteAlreadyUsed.selector);
        account.registerAgent(q, block.number - 1);
    }

    function test_register_epochInvalidatesInflightQuote() public {
        vm.roll(block.number + 1);
        bytes memory qA = _quote(agent2, AGENT_M);
        bytes memory qB = _quote(agent3, AGENT_M);
        vm.prank(owner);
        account.registerAgent(qA, block.number - 1);
        vm.expectPartialRevert(AgentQuoteVerifier.NonceMismatch.selector);
        account.registerAgent(qB, block.number - 1);

        bytes memory qC = _quote(agent3, AGENT_M);
        vm.prank(owner);
        account.revokeAgent();
        vm.expectPartialRevert(AgentQuoteVerifier.NonceMismatch.selector);
        account.registerAgent(qC, block.number - 1);
        assertEq(account.agent(), address(0));
    }

    function test_register_nonceBindsChainAndAccount() public {
        AgentAccount other = AgentAccount(factory.createAccount(owner));
        vm.prank(owner);
        other.setMeasurement(AGENT_M, true);
        _registerAgentOn(other, agent3, AGENT_M);
        assertEq(other.agentEpoch(), account.agentEpoch()); // same epoch: only the account differs
        bytes memory q = _quote(agent2, AGENT_M); // nonce for `account`
        vm.expectPartialRevert(AgentQuoteVerifier.NonceMismatch.selector);
        other.registerAgent(q, block.number - 1);

        bytes32 n = account.attestNonce(block.number - 1);
        vm.chainId(block.chainid + 1);
        assertTrue(account.attestNonce(block.number - 1) != n);
    }

    function test_register_revertsAgentIsOwner() public {
        bytes memory q = _quote(owner, AGENT_M);
        vm.expectRevert(AgentAccount.AgentIsOwner.selector);
        account.registerAgent(q, block.number - 1);
    }

    function test_register_revertsZeroSigner() public {
        bytes memory q = _quote(address(0), AGENT_M);
        vm.expectRevert(AgentAccount.NotAgent.selector);
        account.registerAgent(q, block.number - 1);
    }

    function test_setMeasurement_unapproveRevokesCurrentAgent() public {
        vm.prank(owner);
        account.setMeasurement(OTHER_M, false); // unrelated measurement: agent stays
        assertEq(account.agent(), agentAddr);
        vm.prank(owner);
        account.setMeasurement(AGENT_M, false);
        assertEq(account.agent(), address(0));
        assertEq(account.agentEpoch(), 2);
        AgentAccount.Trade memory t = _buy(1e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.NotAgent.selector);
        account.execute(t, r);
    }

    // ------------------------------------------------------------------ execute: happy path

    function test_execute_buyAndSell_balanceDeltasAndEvent() public {
        uint256 u0 = usdg.balanceOf(address(account));
        uint256 s0 = tsla.balanceOf(address(account));
        AgentAccount.Trade memory t = _buy(10e6);
        t.minOut = 0.039e18; // 10 USDG at 250 USDG/TSLA, less the 0.3% fee
        AgentAccount.Receipt memory r = _receipt();
        vm.expectEmit(true, true, true, false, address(account));
        emit TradeExecuted(1, key.toId(), agentAddr, address(usdg), address(tsla), 10e6, 0, AGENT_M, SERVED, 0, 0, 0);
        vm.prank(agentAddr);
        (uint256 id, uint256 out) = account.execute(t, r);
        assertEq(id, 1);
        assertGe(out, t.minOut);
        assertLe(out, 0.04e18);
        assertEq(usdg.balanceOf(address(account)), u0 - 10e6);
        assertEq(tsla.balanceOf(address(account)), s0 + out);
        assertEq(account.windowUsed(address(usdg)), 10e6);
        assertEq(usdg.allowance(address(account), address(manager)), 0);

        (, uint256 back) = _exec(_sell(uint128(out)));
        assertEq(tsla.balanceOf(address(account)), s0);
        assertGt(back, 9.9e6);
        assertLt(back, 10e6);
        assertEq(account.windowUsed(address(tsla)), out);
        assertEq(account.tradeCount(), 2);
    }

    function test_execute_band1Boundary_executes() public {
        _exec(_buy(USDG_APPROVAL_ABOVE));
        assertEq(account.windowUsed(address(usdg)), USDG_APPROVAL_ABOVE);
    }

    // ------------------------------------------------------------------ execute: agent gates (I2)

    function test_execute_revertsNotAgent() public {
        AgentAccount.Trade memory t = _buy(1e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotAgent.selector);
        account.execute(t, r);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.NotAgent.selector);
        account.execute(t, r);
    }

    function test_execute_revertsOneSecondAfterExpiry() public {
        vm.warp(account.agentExpiry());
        _exec(_buy(1e6)); // still valid at the expiry second
        vm.warp(account.agentExpiry() + 1);
        AgentAccount.Trade memory t = _buy(1e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.AgentExpired.selector);
        account.execute(t, r);
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.AgentExpired.selector);
        account.propose(_buy(60e6), r);
    }

    function test_execute_revertsWhenPaused() public {
        vm.prank(owner);
        account.pause();
        AgentAccount.Trade memory t = _buy(1e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.IsPaused.selector);
        account.execute(t, r);
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.IsPaused.selector);
        account.propose(_buy(60e6), r);
        vm.prank(owner);
        account.unpause();
        _exec(_buy(1e6));
    }

    function test_revokeAgent_unapprovesTheMeasurementSoAReplayIsRefused() public {
        assertTrue(account.approvedMeasurement(AGENT_M));
        vm.prank(owner);
        account.revokeAgent();
        assertFalse(account.approvedMeasurement(AGENT_M));
        bytes memory q = _quote(agentAddr, AGENT_M);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.MeasurementNotApproved.selector, AGENT_M));
        account.registerAgent(q, block.number - 1);
        assertEq(account.agent(), address(0));
    }

    /// Review F-3. A second approved measurement must not let a stranger swap the live agent.
    function test_admit_strangerCannotReplaceTheLiveAgent() public {
        vm.prank(owner);
        account.setMeasurement(OTHER_M, true);
        bytes memory q = _quote(agent2, OTHER_M);
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.OwnerMustReplaceLiveAgent.selector);
        account.registerAgent(q, block.number - 1);
        assertEq(account.agent(), agentAddr, "live agent untouched");
        assertEq(account.agentMeasurement(), AGENT_M);
    }

    /// Review F-3 controls: the owner replaces the live agent, a stranger renews the same key,
    /// and a stranger admits a different key once the live one has expired.
    function test_admit_ownerReplacesStrangerRenewsAndExpiryOpensTheSlot() public {
        vm.prank(owner);
        account.setMeasurement(OTHER_M, true);

        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + 1);
        uint64 before = account.agentExpiry();
        bytes memory q1 = _quote(agentAddr, AGENT_M);
        vm.prank(stranger);
        account.registerAgent(q1, block.number - 1);
        assertGt(account.agentExpiry(), before, "same key renewed by a stranger");
        assertEq(account.agent(), agentAddr);

        bytes memory q2 = _quote(agent2, OTHER_M);
        vm.prank(owner);
        account.registerAgent(q2, block.number - 1);
        assertEq(account.agent(), agent2, "owner replaced the live agent");

        vm.warp(block.timestamp + 25 hours);
        vm.roll(block.number + 1);
        bytes memory q3 = _quote(agentAddr, AGENT_M);
        vm.prank(stranger);
        account.registerAgent(q3, block.number - 1);
        assertEq(account.agent(), agentAddr, "expired slot is open to a stranger");
    }

    function test_execute_revertsAfterRevoke() public {
        vm.prank(owner);
        account.revokeAgent();
        assertEq(account.agent(), address(0));
        assertEq(account.agentExpiry(), 0);
        AgentAccount.Trade memory t = _buy(1e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.NotAgent.selector);
        account.execute(t, r);
    }

    // ------------------------------------------------------------------ execute: bands (I3)

    function test_execute_revertsOverPerTradeCap() public {
        AgentAccount.Trade memory t = _buy(USDG_PER_TRADE + 1);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAccount.ExceedsPerTradeCap.selector, USDG_PER_TRADE + 1, USDG_PER_TRADE)
        );
        account.execute(t, r);
        // band 3 binds the approval path too
        vm.prank(agentAddr);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAccount.ExceedsPerTradeCap.selector, USDG_PER_TRADE + 1, USDG_PER_TRADE)
        );
        account.propose(t, r);
    }

    function test_execute_revertsNeedsApproval_inBand2() public {
        AgentAccount.Trade memory t = _buy(USDG_APPROVAL_ABOVE + 1);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAccount.NeedsApproval.selector, USDG_APPROVAL_ABOVE + 1, USDG_APPROVAL_ABOVE)
        );
        account.execute(t, r);
    }

    function test_propose_revertsApprovalNotNeeded_inBand1() public {
        AgentAccount.Trade memory t = _buy(USDG_APPROVAL_ABOVE);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.ApprovalNotNeeded.selector);
        account.propose(t, r);
    }

    function test_execute_capsApplyToTokenIn_sellBoundedInStockUnits() public {
        // selling TSLA is bounded by TSLA limits, whatever USDG it returns
        AgentAccount.Trade memory t = _sell(TSLA_APPROVAL_ABOVE + 1);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAccount.NeedsApproval.selector, TSLA_APPROVAL_ABOVE + 1, TSLA_APPROVAL_ABOVE)
        );
        account.execute(t, r);
        _exec(_sell(TSLA_APPROVAL_ABOVE));
        assertEq(account.windowUsed(address(tsla)), TSLA_APPROVAL_ABOVE);
        assertEq(account.windowUsed(address(usdg)), 0);
    }

    function test_execute_revertsDailyCapExceeded() public {
        _exec(_buy(50e6));
        _exec(_buy(50e6));
        _exec(_buy(50e6));
        _exec(_buy(50e6));
        _exec(_buy(50e6)); // 250 = daily
        AgentAccount.Trade memory t = _buy(1);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.DailyCapExceeded.selector, 250e6, USDG_DAILY));
        account.execute(t, r);
        // 24 hours later (hour h0 + 24) the first hour is still in the window
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.roll(block.number + 1);
        _registerAgent(agentAddr, AGENT_M);
        _refreshReceiptKey();
        t = _buy(1);
        r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.DailyCapExceeded.selector, 250e6, USDG_DAILY));
        account.execute(t, r);
        // an hour later it has rolled out
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _exec(_buy(50e6));
    }

    function test_setLimits_revertsBadLimits() public {
        vm.prank(owner);
        vm.expectRevert(AgentAccount.BadLimits.selector);
        account.setLimits(address(usdg), AgentAccount.Limits(true, 10, 100, 11));
        vm.prank(owner);
        account.setLimits(address(usdg), AgentAccount.Limits(true, 10, 100, 10));
    }

    function test_newAccount_canDoNothingUntilConfigured() public {
        AgentAccount fresh = AgentAccount(factory.createAccount(owner));
        (bool allowed, uint128 perTrade, uint128 daily, uint128 approvalAbove) = fresh.limits(address(usdg));
        assertFalse(allowed);
        assertEq(perTrade + daily + approvalAbove, 0);
        vm.prank(owner);
        fresh.setMeasurement(AGENT_M, true);
        _registerAgentOn(fresh, agentAddr, AGENT_M);
        AgentAccount.Trade memory t = _buy(1e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.PoolNotAllowed.selector, key.toId()));
        fresh.execute(t, r);
    }

    // ------------------------------------------------------------------ execute: pools and tokens

    function test_execute_revertsTokenNotAllowed_afterDelist() public {
        vm.prank(owner);
        account.setLimits(address(tsla), AgentAccount.Limits(false, TSLA_PER_TRADE, TSLA_DAILY, TSLA_APPROVAL_ABOVE));
        AgentAccount.Trade memory t = _buy(1e6); // tsla is tokenOut
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TokenNotAllowed.selector, address(tsla)));
        account.execute(t, r);
        t = _sell(0.1e18); // tsla is tokenIn
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TokenNotAllowed.selector, address(tsla)));
        account.execute(t, r);
    }

    function test_setPool_revertsHookedPool() public {
        PoolKey memory k = key;
        k.hooks = IHooks(address(0x1234));
        vm.prank(owner);
        vm.expectRevert(AgentAccount.HookedPool.selector);
        account.setPool(k, true);
    }

    function test_setPool_revertsNativeCurrency() public {
        PoolKey memory k = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(usdg)), FEE, SPACING, IHooks(address(0)));
        vm.prank(owner);
        vm.expectRevert(AgentAccount.NativeCurrency.selector);
        account.setPool(k, true);
        k = PoolKey(Currency.wrap(address(usdg)), Currency.wrap(address(0)), FEE, SPACING, IHooks(address(0)));
        vm.prank(owner);
        vm.expectRevert(AgentAccount.NativeCurrency.selector);
        account.setPool(k, true);
    }

    function test_setPool_revertsTokenNotAllowed() public {
        address other = address(new AgentQuoteVerifier()); // any unlisted address
        (Currency a, Currency b) = other < address(usdg)
            ? (Currency.wrap(other), Currency.wrap(address(usdg)))
            : (Currency.wrap(address(usdg)), Currency.wrap(other));
        PoolKey memory k = PoolKey(a, b, FEE, SPACING, IHooks(address(0)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TokenNotAllowed.selector, other));
        account.setPool(k, true);
        k = PoolKey(b, a, FEE, SPACING, IHooks(address(0)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TokenNotAllowed.selector, other));
        account.setPool(k, true);
    }

    function test_execute_revertsPoolNotAllowed() public {
        PoolKey memory k = key;
        k.fee = 500;
        k.tickSpacing = 10;
        AgentAccount.Trade memory t = _buy(1e6);
        t.key = k;
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.PoolNotAllowed.selector, k.toId()));
        account.execute(t, r);
        // delisting the pool freezes it
        vm.prank(owner);
        account.setPool(key, false);
        t = _buy(1e6);
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.PoolNotAllowed.selector, key.toId()));
        account.execute(t, r);
    }

    function test_execute_revertsDeadline() public {
        AgentAccount.Trade memory t = _buy(1e6);
        t.deadline = uint64(block.timestamp - 1);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.DeadlinePassed.selector);
        account.execute(t, r);
        t.deadline = uint64(block.timestamp);
        vm.prank(agentAddr);
        account.execute(t, r);
    }

    function test_execute_revertsZeroMinOut() public {
        AgentAccount.Trade memory t = _buy(1e6);
        t.minOut = 0;
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.ZeroMinOut.selector);
        account.execute(t, r);
    }

    function test_execute_revertsZeroAmount() public {
        AgentAccount.Trade memory t = _buy(0);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.ZeroAmount.selector);
        account.execute(t, r);
    }

    function test_execute_revertsInsufficientOutput_realPool() public {
        AgentAccount.Trade memory t = _buy(10e6);
        t.minOut = 0.04e18; // the pool can only give 10 USDG less the fee
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectPartialRevert(AgentAccount.InsufficientOutput.selector);
        account.execute(t, r);
    }

    // ------------------------------------------------------------------ callback and balance deltas (I4)

    function test_callback_revertsFromNonPoolManager() public {
        bytes memory data = abi.encode(key, usdgIs0, uint128(1e6));
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotPoolManager.selector);
        account.unlockCallback(data);
    }

    function test_callback_revertsWhenNotSwapping() public {
        bytes memory data = abi.encode(key, usdgIs0, uint128(1e6));
        vm.prank(address(manager));
        vm.expectRevert(AgentAccount.NotSwapping.selector);
        account.unlockCallback(data);
    }

    function _shortAccount() internal returns (AgentAccount a, ShortPoolManager pm) {
        pm = new ShortPoolManager();
        a = new AgentAccount(owner, address(verifier), address(receiptVerifier), address(assay), address(pm), address(usdg));
        _configure(a);
        _registerAgentOn(a, agentAddr, AGENT_M);
        usdg.mint(address(a), 1_000e6);
        tsla.mint(address(pm), 100e18);
    }

    function test_execute_revertsInsufficientOutput_whenPoolUnderpays() public {
        (AgentAccount a, ShortPoolManager pm) = _shortAccount();
        AgentAccount.Trade memory t = _buy(10e6);
        t.minOut = 1e18;

        pm.configure(1e18, 0, 0); // control: an honest report passes
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        (, uint256 out) = a.execute(t, r);
        assertEq(out, 1e18);

        pm.configure(1e18, 1, 0); // reports 1e18, delivers 1e18 - 1
        r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.InsufficientOutput.selector, 1e18 - 1, 1e18));
        a.execute(t, r);
    }

    function test_callback_revertsAfterSwapInSameTx() public {
        (AgentAccount a, ShortPoolManager pm) = _shortAccount();
        pm.configure(1e18, 0, 0);
        AgentAccount.Trade memory t = _buy(10e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        a.execute(t, r);
        // later in the same transaction the pool calls back on its own: the flag is already down
        bytes memory data = abi.encode(key, usdgIs0, uint128(10e6));
        vm.prank(address(pm));
        vm.expectRevert(AgentAccount.NotSwapping.selector);
        a.unlockCallback(data);
    }

    function test_execute_revertsOverSpent_whenPoolOvercharges() public {
        (AgentAccount a, ShortPoolManager pm) = _shortAccount();
        pm.configure(1e18, 0, 1); // claims one unit more input than the trade offered
        AgentAccount.Trade memory t = _buy(10e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.OverSpent.selector, 10e6 + 1, 10e6));
        a.execute(t, r);
    }

    // ------------------------------------------------------------------ receipts (I6)

    function _expectExecRevert(AgentAccount.Receipt memory r, bytes4 sel) internal {
        AgentAccount.Trade memory t = _buy(1e6);
        vm.prank(agentAddr);
        vm.expectRevert(sel);
        account.execute(t, r);
    }

    function test_receipt_revertsInvalid() public {
        AgentAccount.Receipt memory r = _receipt();
        receiptVerifier.setNext(false, MODEL, SERVED, bytes32(uint256(1)), bytes32(uint256(2)));
        _expectExecRevert(r, AgentAccount.ReceiptInvalid.selector);
    }

    function test_receipt_revertsModelMismatch_requested() public {
        _expectExecRevert(_receiptFor(keccak256("other-model"), SERVED), AgentAccount.ModelMismatch.selector);
    }

    function test_receipt_revertsModelMismatch_served() public {
        _expectExecRevert(_receiptFor(MODEL, keccak256("other-model")), AgentAccount.ModelMismatch.selector);
        // zero padding slots never match, even a zero served hash
        _expectExecRevert(_receiptFor(MODEL, bytes32(0)), AgentAccount.ModelMismatch.selector);
        // both configured labels are accepted
        _exec(_buy(1e6));
        AgentAccount.Receipt memory r = _receiptFor(MODEL, MODEL);
        AgentAccount.Trade memory t = _buy(1e6);
        vm.prank(agentAddr);
        account.execute(t, r);
    }

    function test_receipt_acceptsEverySlot() public {
        bytes32 s3 = keccak256("slot-3-label");
        vm.prank(owner);
        account.setModel(MODEL, [SERVED, MODEL, keccak256("slot-2-label"), s3], GATEWAY_M);
        AgentAccount.Receipt memory r = _receiptFor(MODEL, s3);
        AgentAccount.Trade memory t = _buy(1e6);
        vm.prank(agentAddr);
        account.execute(t, r);
    }

    function test_receipt_revertsKeyNotRegistered() public {
        AgentAccount.Receipt memory r = _receipt();
        r.pubkey = keccak256("unregistered-key");
        _expectExecRevert(r, AgentAccount.ReceiptKeyNotRegistered.selector);
    }

    function test_receipt_revertsGatewayMeasurementMismatch() public {
        vm.prank(owner);
        account.setModel(MODEL, [SERVED, MODEL, bytes32(0), bytes32(0)], OTHER_M);
        _expectExecRevert(_receipt(), AgentAccount.GatewayMeasurementMismatch.selector);
    }

    function test_receipt_revertsKeyExpired() public {
        (, uint64 keyExpiry) = assay.receiptSigners(RECEIPT_KEY);
        vm.warp(uint256(keyExpiry) + 1);
        vm.roll(block.number + 1);
        _registerAgent(agentAddr, AGENT_M); // the agent is fresh; only the receipt key is stale
        _expectExecRevert(_receipt(), AgentAccount.ReceiptKeyExpired.selector);
    }

    function test_receipt_revertsReuse() public {
        AgentAccount.Receipt memory r = _receipt();
        AgentAccount.Trade memory t = _buy(1e6);
        vm.prank(agentAddr);
        account.execute(t, r);
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.ReceiptAlreadyUsed.selector);
        account.execute(t, r);
        // and a proposal cannot reuse it either
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.ReceiptAlreadyUsed.selector);
        account.propose(_buy(60e6), r);
    }

    function test_receipt_revertsModelNotSet() public {
        AgentAccount fresh = AgentAccount(factory.createAccount(owner));
        vm.startPrank(owner);
        fresh.setLimits(address(usdg), AgentAccount.Limits(true, USDG_PER_TRADE, USDG_DAILY, USDG_APPROVAL_ABOVE));
        fresh.setLimits(address(tsla), AgentAccount.Limits(true, TSLA_PER_TRADE, TSLA_DAILY, TSLA_APPROVAL_ABOVE));
        fresh.setPool(key, true);
        fresh.setMeasurement(AGENT_M, true);
        vm.expectRevert(AgentAccount.ModelNotSet.selector);
        fresh.setModel(bytes32(0), [SERVED, bytes32(0), bytes32(0), bytes32(0)], GATEWAY_M);
        vm.expectRevert(AgentAccount.ModelNotSet.selector);
        fresh.setModel(MODEL, [bytes32(0), bytes32(0), bytes32(0), bytes32(0)], GATEWAY_M);
        vm.expectRevert(AgentAccount.ModelNotSet.selector);
        fresh.setModel(MODEL, [SERVED, bytes32(0), bytes32(0), bytes32(0)], bytes32(0));
        vm.stopPrank();
        _registerAgentOn(fresh, agentAddr, AGENT_M);
        usdg.mint(address(fresh), 10e6);
        AgentAccount.Receipt memory r = _receipt();
        AgentAccount.Trade memory t = _buy(1e6);
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.ModelNotSet.selector);
        fresh.execute(t, r);
    }

    // ------------------------------------------------------------------ approvals (I5)

    function test_propose_storesProposalAndExpiry() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        assertEq(id, 1);
        (bytes32 h, address a, uint64 expiry, AgentAccount.Status s, bytes32 m, bytes32 served,,) = account.proposals(id);
        assertEq(h, keccak256(abi.encode(t)));
        assertEq(a, agentAddr);
        assertEq(expiry, block.timestamp + 600); // deadline (now + 600) is earlier than now + ttl (3600)
        assertEq(uint8(s), uint8(AgentAccount.Status.Pending));
        assertEq(m, AGENT_M);
        assertEq(served, SERVED);

        t.deadline = uint64(block.timestamp + 7200);
        (,, expiry,,,,,) = account.proposals(_propose(t));
        assertEq(expiry, block.timestamp + 3600);
        assertEq(usdg.balanceOf(address(account)), 10_000e6); // proposing moves nothing
    }

    function test_approve_executesExactTrade_once() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        uint256 u0 = usdg.balanceOf(address(account));
        uint256 s0 = tsla.balanceOf(address(account));
        vm.expectEmit(true, true, true, false, address(account));
        emit TradeExecuted(1, key.toId(), agentAddr, address(usdg), address(tsla), 60e6, 0, AGENT_M, SERVED, 0, 0, id);
        vm.prank(owner);
        uint256 out = account.approveTrade(id, t);
        assertGt(out, 0);
        assertEq(usdg.balanceOf(address(account)), u0 - 60e6);
        assertEq(tsla.balanceOf(address(account)), s0 + out);
        (,,, AgentAccount.Status s,,,,) = account.proposals(id);
        assertEq(uint8(s), uint8(AgentAccount.Status.Executed));
        // approved trades are the owner's decision: not recorded in the agent's window
        assertEq(account.windowUsed(address(usdg)), 0);
    }

    function test_approve_revertsReplay() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        vm.prank(owner);
        account.approveTrade(id, t);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ProposalNotPending.selector);
        account.approveTrade(id, t);
    }

    function test_approve_revertsExpired() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        (,, uint64 expiry,,,,,) = account.proposals(id);
        vm.warp(expiry + 1);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ProposalExpired.selector);
        account.approveTrade(id, t);
    }

    function test_approve_atExpirySecond_executes() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        (,, uint64 expiry,,,,,) = account.proposals(id);
        vm.warp(expiry);
        vm.prank(owner);
        account.approveTrade(id, t);
    }

    function test_approve_revertsTradeMismatch() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        AgentAccount.Trade memory changed = t;
        changed.minOut = 2;
        vm.prank(owner);
        vm.expectRevert(AgentAccount.TradeMismatch.selector);
        account.approveTrade(id, changed);
        changed = _buy(61e6);
        changed.deadline = t.deadline;
        vm.prank(owner);
        vm.expectRevert(AgentAccount.TradeMismatch.selector);
        account.approveTrade(id, changed);
    }

    function test_approve_revertsAfterAgentRotated() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        vm.roll(block.number + 1);
        _replaceAgentAsOwner(agent2, AGENT_M);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ProposerNotCurrentAgent.selector);
        account.approveTrade(id, t);

        vm.roll(block.number + 1);
        _replaceAgentAsOwner(agentAddr, AGENT_M);
        uint256 id2 = _propose(t);
        vm.prank(owner);
        account.revokeAgent();
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ProposerNotCurrentAgent.selector);
        account.approveTrade(id2, t);
    }

    function test_approve_revertsNotOwner() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agentAddr));
        account.approveTrade(id, t);
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agentAddr));
        account.rejectTrade(id);
    }

    function test_approve_revertsWhenPaused() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        vm.startPrank(owner);
        account.pause();
        vm.expectRevert(AgentAccount.IsPaused.selector);
        account.approveTrade(id, t);
        vm.stopPrank();
    }

    function test_approve_revertsWhenPoolOrTokenDelisted() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        vm.startPrank(owner);
        account.setPool(key, false);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.PoolNotAllowed.selector, key.toId()));
        account.approveTrade(id, t);
        account.setPool(key, true);
        account.setLimits(address(tsla), AgentAccount.Limits(false, TSLA_PER_TRADE, TSLA_DAILY, TSLA_APPROVAL_ABOVE));
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TokenNotAllowed.selector, address(tsla)));
        account.approveTrade(id, t);
        vm.stopPrank();
    }

    function test_approve_revertsWhenPerTradeLowered() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        vm.startPrank(owner);
        account.setLimits(address(usdg), AgentAccount.Limits(true, 59e6, USDG_DAILY, 10e6));
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ExceedsPerTradeCap.selector, 60e6, 59e6));
        account.approveTrade(id, t);
        vm.stopPrank();
    }

    function test_approve_enforcesMinOut() public {
        AgentAccount.Trade memory t = _buy(60e6);
        t.minOut = 1e18; // far more TSLA than 60 USDG buys
        uint256 id = _propose(t);
        vm.prank(owner);
        vm.expectPartialRevert(AgentAccount.InsufficientOutput.selector);
        account.approveTrade(id, t);
    }

    function test_reject_thenApproveReverts() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        vm.prank(owner);
        account.rejectTrade(id);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ProposalNotPending.selector);
        account.approveTrade(id, t);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ProposalNotPending.selector);
        account.rejectTrade(id);
    }

    function test_cancelProposal_onlyProposer_thenApproveReverts() public {
        AgentAccount.Trade memory t = _buy(60e6);
        uint256 id = _propose(t);
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotAgent.selector);
        account.cancelProposal(id);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.NotAgent.selector);
        account.cancelProposal(id);
        vm.prank(agentAddr);
        account.cancelProposal(id);
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.ProposalNotPending.selector);
        account.cancelProposal(id);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ProposalNotPending.selector);
        account.approveTrade(id, t);
    }

    // ------------------------------------------------------------------ ERC-1271 scope (I7)

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant VOUCHER_TYPEHASH =
        keccak256("Voucher(uint256 channelId,uint256 cumulativeAmount,bytes32 requestHash,bytes32 responseHash)");

    function _voucherDigest(uint256 id, uint256 cum, bytes32 rq, bytes32 rs) internal view returns (bytes32) {
        bytes32 domain =
            keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Assay"), keccak256("1"), block.chainid, address(assay)));
        return keccak256(
            abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(VOUCHER_TYPEHASH, id, cum, rq, rs)))
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _wrapped(uint256 id, uint256 cum, bytes32 rq, bytes32 rs, bytes32 signed) internal view returns (bytes memory) {
        return abi.encode(id, cum, rq, rs, _sign(agentPk, signed));
    }

    function _openChannel(uint128 amount) internal returns (uint256 id) {
        vm.prank(owner);
        id = account.openInferenceChannel(provider, amount);
    }

    function test_1271_acceptsAssayVoucher_andAssayRedeemPays() public {
        uint256 id = _openChannel(100e6);
        bytes32 rq = keccak256("inference-request");
        bytes32 rs = keccak256("inference-response");
        bytes32 digest = _voucherDigest(id, 3e6, rq, rs);
        bytes memory payerSig = _wrapped(id, 3e6, rq, rs, digest);
        assertEq(account.isValidSignature(digest, payerSig), bytes4(0x1626ba7e));

        receiptVerifier.setNext(true, MODEL, MODEL, rq, rs);
        uint256 before = usdg.balanceOf(provider);
        vm.prank(provider);
        assay.redeemWithReceipt(id, 3e6, rq, rs, payerSig, RECEIPT_KEY, bytes("jcs"), bytes("sig"));
        (,,, uint128 paid,,,,,,) = assay.channels(id);
        assertEq(paid, 3e6);
        assertEq(usdg.balanceOf(provider) - before, 3e6);
    }

    function test_1271_rejectsPermit2Digest() public {
        _openChannel(100e6);
        // Permit2 PermitSingle digest for the account's USDG, signed by the agent key
        bytes32 permit2Domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("Permit2"),
                block.chainid,
                0x000000000022D473030F116dDEE9F6B43aC78BA3
            )
        );
        bytes32 details = keccak256(
            abi.encode(
                keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"),
                address(usdg),
                type(uint160).max,
                type(uint48).max,
                0
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
                ),
                details,
                stranger,
                type(uint256).max
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", permit2Domain, structHash));
        _assertRejected(digest);
    }

    function test_1271_rejectsUsdgPermitDigest() public {
        _openChannel(100e6);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                address(account),
                stranger,
                type(uint256).max,
                usdg.nonces(address(account)),
                type(uint256).max
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash));
        _assertRejected(digest);
        // EIP-3009 transferWithAuthorization-shaped digest over the same domain
        bytes32 auth = keccak256(
            abi.encode(
                keccak256(
                    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
                ),
                address(account),
                stranger,
                1_000e6,
                0,
                type(uint256).max,
                bytes32(uint256(7))
            )
        );
        _assertRejected(keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), auth)));
    }

    /// A foreign digest signed by the agent is refused in every encoding: the raw 65-byte
    /// signature, and wrapped with a real open channel of this account.
    function _assertRejected(bytes32 digest) internal view {
        bytes memory raw = _sign(agentPk, digest);
        assertEq(account.isValidSignature(digest, raw), bytes4(0xffffffff));
        assertFalse(SignatureChecker.isValidSignatureNow(address(account), digest, raw));
        bytes memory wrapped = _wrapped(0, 1, bytes32(0), bytes32(0), digest);
        assertEq(account.isValidSignature(digest, wrapped), bytes4(0xffffffff));
        assertFalse(SignatureChecker.isValidSignatureNow(address(account), digest, wrapped));
    }

    function test_1271_rejectsForeignChannel() public {
        // a channel whose Assay agent is someone else (the agent key itself, as an EOA)
        usdg.mint(agentAddr, 50e6);
        vm.startPrank(agentAddr);
        usdg.approve(address(assay), 50e6);
        uint256 foreign = assay.openChannel(provider, 50e6, GATEWAY_M, MODEL);
        vm.stopPrank();
        bytes32 rq = keccak256("rq");
        bytes32 rs = keccak256("rs");
        bytes32 digest = _voucherDigest(foreign, 1e6, rq, rs);
        assertEq(account.isValidSignature(digest, _wrapped(foreign, 1e6, rq, rs, digest)), bytes4(0xffffffff));
        assertEq(account.isValidSignature(digest, _sign(agentPk, digest)), bytes4(0xffffffff));
        // a channel id that does not exist
        digest = _voucherDigest(99, 1e6, rq, rs);
        assertEq(account.isValidSignature(digest, _wrapped(99, 1e6, rq, rs, digest)), bytes4(0xffffffff));
        // control: the same voucher on the account's own channel is valid
        uint256 own = _openChannel(10e6);
        digest = _voucherDigest(own, 1e6, rq, rs);
        assertEq(account.isValidSignature(digest, _wrapped(own, 1e6, rq, rs, digest)), bytes4(0x1626ba7e));
    }

    function test_1271_rejectsExpiredAgent() public {
        uint256 id = _openChannel(10e6);
        bytes32 digest = _voucherDigest(id, 1e6, keccak256("rq"), keccak256("rs"));
        bytes memory sig = _wrapped(id, 1e6, keccak256("rq"), keccak256("rs"), digest);
        vm.warp(account.agentExpiry());
        assertEq(account.isValidSignature(digest, sig), bytes4(0x1626ba7e));
        vm.warp(account.agentExpiry() + 1);
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
        assertEq(account.isValidSignature(digest, _sign(agentPk, digest)), bytes4(0xffffffff));
    }

    function test_1271_rejectsPausedRevokedWrongSignerClosed() public {
        uint256 id = _openChannel(10e6);
        bytes32 rq = keccak256("rq");
        bytes32 rs = keccak256("rs");
        bytes32 digest = _voucherDigest(id, 1e6, rq, rs);
        bytes memory sig = _wrapped(id, 1e6, rq, rs, digest);
        // signed by someone other than the agent
        assertEq(account.isValidSignature(digest, abi.encode(id, 1e6, rq, rs, _sign(0xBEEF, digest))), bytes4(0xffffffff));
        // fields that do not match the digest
        assertEq(account.isValidSignature(digest, abi.encode(id, 2e6, rq, rs, _sign(agentPk, digest))), bytes4(0xffffffff));
        vm.prank(owner);
        account.pause();
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
        vm.prank(owner);
        account.unpause();
        assertEq(account.isValidSignature(digest, sig), bytes4(0x1626ba7e));
        // closed channel
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(owner);
        account.requestInferenceClose(id);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(owner);
        account.finalizeInferenceClose(id);
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
    }

    function test_1271_revokedAgentVoucherNotRedeemable() public {
        uint256 id = _openChannel(10e6);
        bytes32 rq = keccak256("rq");
        bytes32 rs = keccak256("rs");
        bytes32 digest = _voucherDigest(id, 1e6, rq, rs);
        bytes memory sig = _wrapped(id, 1e6, rq, rs, digest);
        vm.prank(owner);
        account.revokeAgent();
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
        receiptVerifier.setNext(true, MODEL, MODEL, rq, rs);
        vm.prank(provider);
        vm.expectRevert(Assay.PayerNotAgent.selector);
        assay.redeemWithReceipt(id, 1e6, rq, rs, sig, RECEIPT_KEY, bytes("jcs"), bytes("sig"));
    }

    // ------------------------------------------------------------------ owner exit and powers (I8)

    function test_withdraw_worksWhilePausedAndRevoked() public {
        vm.startPrank(owner);
        account.pause();
        account.revokeAgent();
        account.withdraw(address(usdg), owner, 10_000e6);
        account.withdraw(address(tsla), owner, 10e18);
        vm.stopPrank();
        assertEq(usdg.balanceOf(owner), 10_000e6);
        assertEq(tsla.balanceOf(owner), 10e18);
        assertEq(usdg.balanceOf(address(account)), 0);

        vm.deal(address(account), 1 ether);
        vm.prank(owner);
        account.withdrawETH(payable(owner), 1 ether);
        assertEq(owner.balance, 1 ether);
    }

    function test_withdraw_worksAfterExpiry() public {
        vm.warp(account.agentExpiry() + 7 days);
        vm.prank(owner);
        account.withdraw(address(usdg), owner, 1e6);
        assertEq(usdg.balanceOf(owner), 1e6);
    }

    function test_withdraw_revertsNotOwner() public {
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agentAddr));
        account.withdraw(address(usdg), agentAddr, 1);
        vm.deal(address(account), 1 ether);
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agentAddr));
        account.withdrawETH(payable(agentAddr), 1);
    }

    function test_withdrawETH_revertsWithACustomErrorWhenTheRecipientRejects() public {
        vm.deal(address(account), 1 ether);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ETHTransferFailed.selector);
        account.withdrawETH(payable(address(usdg)), 1 ether); // TestUSDG has no receive()
        assertEq(address(account).balance, 1 ether);
    }

    function test_renounceOwnership_reverts() public {
        vm.prank(owner);
        vm.expectRevert(AgentAccount.RenounceDisabled.selector);
        account.renounceOwnership();
        assertEq(account.owner(), owner);
    }

    function test_ownership_cannotPassToAgent() public {
        vm.prank(owner);
        account.transferOwnership(agentAddr);
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.AgentIsOwner.selector);
        account.acceptOwnership();
        assertEq(account.owner(), owner);
        // two-step: a real new owner must accept
        vm.prank(owner);
        account.transferOwnership(stranger);
        assertEq(account.owner(), owner);
        vm.prank(stranger);
        account.acceptOwnership();
        assertEq(account.owner(), stranger);
    }

    function test_ownerOnly_everyPolicyPower() public {
        bytes[] memory calls = new bytes[](13);
        calls[0] = abi.encodeCall(AgentAccount.setLimits, (address(usdg), AgentAccount.Limits(true, 1, 1, 1)));
        calls[1] = abi.encodeCall(AgentAccount.setPool, (key, true));
        calls[2] = abi.encodeCall(AgentAccount.setMeasurement, (OTHER_M, true));
        calls[3] = abi.encodeCall(AgentAccount.setModel, (MODEL, [SERVED, bytes32(0), bytes32(0), bytes32(0)], GATEWAY_M));
        calls[4] = abi.encodeCall(AgentAccount.setApprovalTtl, (1));
        calls[5] = abi.encodeCall(AgentAccount.pause, ());
        calls[6] = abi.encodeCall(AgentAccount.unpause, ());
        calls[7] = abi.encodeCall(AgentAccount.revokeAgent, ());
        calls[8] = abi.encodeCall(AgentAccount.openInferenceChannel, (provider, 1e6));
        calls[9] = abi.encodeCall(AgentAccount.requestInferenceClose, (0));
        calls[10] = abi.encodeCall(AgentAccount.finalizeInferenceClose, (0));
        calls[11] = abi.encodeCall(AgentAccount.rejectTrade, (1));
        calls[12] = abi.encodeCall(Ownable.transferOwnership, (agentAddr));
        _propose(_buy(60e6));
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(agentAddr);
            (bool ok, bytes memory ret) = address(account).call(calls[i]);
            assertFalse(ok, "agent called an owner power");
            assertEq(ret, abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agentAddr));
        }
    }

    event ApprovalTtlSet(uint64 ttl);

    function test_setApprovalTtl_bindsNewProposals() public {
        vm.expectEmit(address(account));
        emit ApprovalTtlSet(60);
        vm.prank(owner);
        account.setApprovalTtl(60);
        (,, uint64 expiry,,,,,) = account.proposals(_propose(_buy(60e6)));
        assertEq(expiry, block.timestamp + 60);
    }

    function test_openInferenceChannel_resetsAllowanceToZero() public {
        uint256 before = usdg.balanceOf(address(account));
        uint256 id = _openChannel(40e6);
        assertEq(usdg.allowance(address(account), address(assay)), 0);
        assertEq(before - usdg.balanceOf(address(account)), 40e6);
        (address chAgent, address chProvider, uint128 deposit,,,,,, bytes32 m, bytes32 model) = assay.channels(id);
        assertEq(chAgent, address(account));
        assertEq(chProvider, provider);
        assertEq(deposit, 40e6);
        assertEq(m, GATEWAY_M);
        assertEq(model, MODEL);
    }

    function test_openInferenceChannel_revertsBeforeModelSet() public {
        AgentAccount fresh = AgentAccount(factory.createAccount(owner));
        usdg.mint(address(fresh), 10e6);
        vm.prank(owner);
        vm.expectRevert(AgentAccount.ModelNotSet.selector);
        fresh.openInferenceChannel(provider, 10e6);
        assertEq(usdg.balanceOf(address(fresh)), 10e6);
        assertEq(usdg.allowance(address(fresh), address(assay)), 0);
    }

    function test_inferenceClose_refundLandsInAccount() public {
        uint256 id = _openChannel(40e6);
        uint256 before = usdg.balanceOf(address(account));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(owner);
        account.requestInferenceClose(id);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(owner);
        account.finalizeInferenceClose(id);
        assertEq(usdg.balanceOf(address(account)) - before, 40e6);
    }

    // ------------------------------------------------------------------ reentrancy

    function test_reentrancy_viaTokenHook_blocked() public {
        ReentrantAgent ra = new ReentrantAgent();
        vm.roll(block.number + 1);
        _replaceAgentAsOwner(address(ra), AGENT_M);
        AgentAccount.Receipt memory inner = _receipt();
        ra.arm(account, _buy(60e6), inner);
        tsla.setHook(address(ra));
        AgentAccount.Receipt memory outer = _receipt();
        ra.run(_buy(1e6), outer); // the take() of TSLA to the account fires the hook
        bytes memory guardErr = abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(ra.executeRevert(), guardErr);
        assertEq(ra.proposeRevert(), guardErr);
        assertEq(ra.cancelRevert(), guardErr);
        assertEq(account.proposalCount(), 0);
        assertEq(account.tradeCount(), 1);
    }

    // ------------------------------------------------------------------ factory

    function test_factory_createsWiredAccount_andEmits() public {
        uint256 idx = factory.accountCount();
        vm.expectEmit(false, true, false, true, address(factory));
        emit AccountCreated(address(0), stranger, idx);
        AgentAccount a = AgentAccount(factory.createAccount(stranger));
        assertEq(a.owner(), stranger);
        assertEq(address(a.verifier()), address(verifier));
        assertEq(address(a.receiptVerifier()), address(receiptVerifier));
        assertEq(address(a.assay()), address(assay));
        assertEq(address(a.poolManager()), address(manager));
        assertEq(a.usdg(), address(usdg));
        assertEq(a.approvalTtl(), 3600);
        assertEq(factory.accountCount(), idx + 1);
    }

    function test_constructor_revertsNoCode() public {
        address[5] memory deps = [address(verifier), address(receiptVerifier), address(assay), address(manager), address(usdg)];
        for (uint256 i; i < 5; ++i) {
            address[5] memory args;
            for (uint256 j; j < 5; ++j) {
                args[j] = i == j ? address(0xdead) : deps[j];
            }
            vm.expectRevert(abi.encodeWithSelector(AgentAccount.NoCode.selector, address(0xdead)));
            new AgentAccount(owner, args[0], args[1], args[2], args[3], args[4]);
        }
        new AgentAccount(owner, deps[0], deps[1], deps[2], deps[3], deps[4]);
    }

    function _refreshReceiptKey() internal {
        assay.registerReceiptKey(abi.encode(block.timestamp), hex"02", block.number - 1, RECEIPT_KEY);
    }
}
