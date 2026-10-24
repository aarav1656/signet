// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {Assay} from "../src/Assay.sol";
import {AgentAccountTestBase} from "./AgentAccountTestBase.sol";
import {MockReceiptVerifier} from "./mocks/MockReceiptVerifier.sol";

/// A model of who may trade, built only from the calls it saw succeed, and an adversary that
/// calls everything. The account must agree with the model on every step.
///
/// Actors: A and B (keys a verifier can attest), U (a key nobody ever attests), a stranger and
/// the owner. The owner revokes measurements and agents, changes the attestation policy, pauses,
/// retunes limits, approves proposals and withdraws; the others try every power they lack.
///
/// The model (`gAgent`, `gM`, `gExpiry`, `gApproved`, `gPaused`, `gRequire`, `gMax`, `gMin`) is
/// updated from observed outcomes alone. Each violation counter counts a time the account did
/// something the model forbids.
contract AttestationHandler is Test {
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
    address internal immutable usdg;
    address internal immutable tsla;
    address internal immutable stranger;
    bytes32 internal immutable agentM;
    bytes32 internal immutable otherM;
    bytes32 internal immutable model;
    bytes32 internal immutable served;
    bytes32 internal immutable receiptKey;
    PoolKey internal key;
    bool internal immutable usdgIs0;
    uint256 internal nonce;
    uint256 internal receiptKeyUntil;

    address[3] internal keys; // A, B, U
    AgentAccount.Trade[] internal proposed;
    uint256[] internal proposedId;

    // the model
    address internal gAgent;
    bytes32 internal gM;
    uint256 internal gExpiry;
    mapping(bytes32 => bool) internal gApproved;
    bool internal gPaused;
    bool internal gRequire;
    uint8 internal gMax;
    uint32 internal gMin;
    mapping(address => bool) internal gHadAgentRevoked;

    Spend[] public spends;

    // violations: every one must stay zero
    uint256 public unattestedTrades; // a trade by anyone but the model's live, unexpired, unpaused agent
    uint256 public tradesAfterRevoke; // a trade by an agent the model has revoked
    uint256 public admittedUnapproved; // admission under a measurement the owner had not approved
    uint256 public admittedAgainstPolicy; // admission the attestation policy forbids
    uint256 public notRevokedOnUnapprove; // unapproving the live measurement left its agent in place
    uint256 public notRevokedOnPolicy; // a policy change left the old agent in place
    uint256 public overPerTrade;
    uint256 public overBand;
    uint256 public overDaily;
    uint256 public unexplainedDecrease; // funds left by any route but an agent swap, an approved swap or an owner withdrawal
    uint256 public overSpent; // a swap that spent more than its amountIn
    uint256 public ownerPowersWithoutOwner;
    uint256 public approvedForeignProposal; // owner approval of a proposal whose proposer is not the live agent

    // coverage: the run must reach these or the invariants say nothing
    uint256 public registers;
    uint256 public collateralRegisters;
    uint256 public executes;
    uint256 public approvals;
    uint256 public withdrawals;
    uint256 public revocations;
    uint256 public deniedTrades;

    constructor(
        AgentAccount account_,
        Assay assay_,
        MockReceiptVerifier rv_,
        address owner_,
        address usdg_,
        address tsla_,
        PoolKey memory key_,
        bool usdgIs0_,
        bytes32[5] memory ids, // agentM, otherM, model, served, receiptKey
        bool gated_
    ) {
        account = account_;
        assay = assay_;
        rv = rv_;
        owner = owner_;
        usdg = usdg_;
        tsla = tsla_;
        stranger = makeAddr("handler-stranger");
        key = key_;
        usdgIs0 = usdgIs0_;
        gated = gated_;
        agentM = ids[0];
        otherM = ids[1];
        model = ids[2];
        served = ids[3];
        receiptKey = ids[4];
        keys = [vm.addr(0xA6E47), vm.addr(0xB0B), vm.addr(0xDEAD)];
        // mirror what AgentAccountTestBase.setUp left: AGENT_M approved, agent A admitted
        gApproved[agentM] = true;
        gAgent = keys[0];
        gM = agentM;
        gExpiry = account.agentExpiry();
        (, uint64 until) = assay.receiptSigners(receiptKey);
        receiptKeyUntil = until;
    }

    // ------------------------------------------------------------------ plumbing

    function spendCount() external view returns (uint256) {
        return spends.length;
    }

    /// Eight slots: A takes four, so the live agent acts often enough to reach the trade path.
    function _actor(uint256 seed) internal view returns (address) {
        uint256 i = seed % 8;
        if (i < 4) return keys[0];
        if (i == 4) return keys[1];
        if (i == 5) return keys[2];
        return i == 6 ? stranger : owner;
    }

    /// Owner actions that remove the agent run on one call in `every`, so a run spends most of
    /// its depth with an agent in place.
    uint256 internal tick;
    bool internal immutable gated;

    function _quiet(uint256 every) internal returns (bool) {
        return gated && ++tick % every != 0;
    }

    function _advance(uint256 dt) internal {
        _warp(dt % 45 minutes);
    }

    function _warp(uint256 dt) internal {
        vm.warp(vm.getBlockTimestamp() + dt);
        vm.roll(vm.getBlockNumber() + 1);
        if (vm.getBlockTimestamp() + 3 hours > receiptKeyUntil) {
            assay.registerReceiptKey(abi.encode("k", vm.getBlockNumber()), hex"02", vm.getBlockNumber() - 1, receiptKey);
            (, uint64 until) = assay.receiptSigners(receiptKey);
            receiptKeyUntil = until;
        }
    }

    function _balances() internal view returns (uint256 u, uint256 s) {
        u = IERC20(usdg).balanceOf(address(account));
        s = IERC20(tsla).balanceOf(address(account));
    }

    function _settle(uint256 u0, uint256 s0, uint256 allowU, uint256 allowS) internal {
        (uint256 u1, uint256 s1) = _balances();
        if (u1 + allowU < u0) unexplainedDecrease += u0 - u1 - allowU;
        if (s1 + allowS < s0) unexplainedDecrease += s0 - s1 - allowS;
    }

    function _trade(bool buy, uint256 amt) internal view returns (AgentAccount.Trade memory t) {
        t = AgentAccount.Trade(key, buy ? usdgIs0 : !usdgIs0, uint128(amt), 1, uint64(vm.getBlockTimestamp() + 3 hours));
    }

    function _receipt() internal returns (AgentAccount.Receipt memory) {
        nonce++;
        rv.setNext(true, model, served, keccak256(abi.encode("q", nonce)), keccak256(abi.encode("r", nonce)));
        return AgentAccount.Receipt(receiptKey, "", "");
    }

    function _modelAllowsTrade(address who) internal view returns (bool) {
        return who == gAgent && who != address(0) && vm.getBlockTimestamp() <= gExpiry && !gPaused && gApproved[gM];
    }

    function _revokeInModel() internal {
        if (gAgent != address(0)) gHadAgentRevoked[gAgent] = true;
        gAgent = address(0);
        gM = bytes32(0);
        gExpiry = 0;
        revocations++;
    }

    /// Jumps a day or more ahead so attestations and the receipt key lapse and the 24 h window empties.
    function jump(uint256 hrs) external {
        if (_quiet(6)) return;
        _warp(bound(hrs, 20, 30) * 1 hours);
    }

    // ------------------------------------------------------------------ admission

    function register(uint256 whoSeed, bool useOther, bool collateral, uint8 status, uint32 evaluation, bool authentic)
        external
    {
        _advance(1 minutes + (whoSeed % 3) * 10 minutes);
        address signer = _actor(whoSeed);
        bytes32 m = useOther ? otherM : agentM;
        bytes memory q = abi.encode(signer, m, account.attestNonce(vm.getBlockNumber() - 1));
        bool success;
        if (collateral) {
            status %= 8;
            try account.registerAgentWithCollateral(q, vm.getBlockNumber() - 1, abi.encode(status, evaluation % 40, authentic)) {
                success = true;
                collateralRegisters++;
                if (!authentic || status > gMax || status >= 6 || evaluation % 40 < gMin) admittedAgainstPolicy++;
            } catch {}
        } else {
            try account.registerAgent(q, vm.getBlockNumber() - 1) {
                success = true;
                if (gRequire) admittedAgainstPolicy++;
            } catch {}
        }
        if (!success) return;
        registers++;
        if (!gApproved[m]) admittedUnapproved++;
        if (signer == owner) admittedAgainstPolicy++;
        if (signer != account.agent() || m != account.agentMeasurement()) unexplainedDecrease++; // account disagrees with what it just accepted
        gAgent = signer;
        gM = m;
        gExpiry = account.agentExpiry();
        gHadAgentRevoked[signer] = false;
    }

    // ------------------------------------------------------------------ trading attempts by every actor

    function execute(uint256 whoSeed, bool buy, uint256 amt, uint256 dt) external {
        _advance(dt);
        address who = _actor(whoSeed);
        address tokenIn = buy ? usdg : tsla;
        (, uint128 perTrade, uint128 daily, uint128 above) = account.limits(tokenIn);
        amt = bound(amt, 1, uint256(above) + uint256(above) / 5 + 1);
        AgentAccount.Trade memory t = _trade(buy, amt);
        AgentAccount.Receipt memory r = _receipt();
        (uint256 u0, uint256 s0) = _balances();
        bool allowed = _modelAllowsTrade(who);
        vm.prank(who);
        try account.execute(t, r) returns (uint256, uint256 out) {
            executes++;
            if (!allowed) unattestedTrades++;
            if (gAgent == address(0) || gHadAgentRevoked[who]) tradesAfterRevoke++;
            if (amt > perTrade) overPerTrade++;
            if (amt > above) overBand++;
            spends.push(Spend(tokenIn, vm.getBlockTimestamp(), amt, daily));
            _checkDaily(spends.length - 1);
            (uint256 u1, uint256 s1) = _balances();
            uint256 spent = tokenIn == usdg ? u0 - u1 : s0 - s1;
            if (spent > amt || out == 0) overSpent++;
            _settle(u0, s0, tokenIn == usdg ? amt : 0, tokenIn == tsla ? amt : 0);
        } catch {
            if (!allowed) deniedTrades++;
            _settle(u0, s0, 0, 0);
        }
    }

    /// Six trades back to back at the top of band 1 from the same instant: the shape that crosses a
    /// daily cap, so a missing cap or a missing window write is reached on every run and not by chance.
    function burst(bool buy) external {
        (,,, uint128 above) = account.limits(buy ? usdg : tsla);
        for (uint256 i; i < 6; ++i) this.execute(0, buy, above, 0);
    }

    function _checkDaily(uint256 j) internal {
        Spend memory sj = spends[j];
        uint256 sum;
        for (uint256 i; i <= j; ++i) {
            Spend memory si = spends[i];
            if (si.token == sj.token && si.at + 86400 > sj.at) sum += si.amountIn;
        }
        if (sum > sj.dailyAtTrade) overDaily++;
    }

    function propose(uint256 whoSeed, bool buy, uint256 amt, uint256 dt) external {
        _advance(dt);
        address who = _actor(whoSeed);
        address tokenIn = buy ? usdg : tsla;
        (, uint128 perTrade,, uint128 above) = account.limits(tokenIn);
        if (perTrade <= above) return;
        amt = bound(amt, uint256(above) + 1, perTrade);
        AgentAccount.Trade memory t = _trade(buy, amt);
        AgentAccount.Receipt memory r = _receipt();
        (uint256 u0, uint256 s0) = _balances();
        bool allowed = _modelAllowsTrade(who);
        vm.prank(who);
        try account.propose(t, r) returns (uint256 id) {
            if (!allowed) unattestedTrades++;
            proposed.push(t);
            proposedId.push(id);
        } catch {}
        _settle(u0, s0, 0, 0);
    }

    // ------------------------------------------------------------------ owner

    function ownerApprove(uint256 idSeed) external {
        if (proposed.length == 0) return;
        uint256 i = idSeed % proposed.length;
        AgentAccount.Trade memory t = proposed[i];
        uint256 id = proposedId[i];
        (, address proposer,,,,,,) = account.proposals(id);
        address tokenIn = t.zeroForOne == usdgIs0 ? usdg : tsla;
        (uint256 u0, uint256 s0) = _balances();
        (, uint128 perTrade,,) = account.limits(tokenIn);
        vm.prank(owner);
        try account.approveTrade(id, t) {
            approvals++;
            if (proposer != gAgent || gAgent == address(0)) approvedForeignProposal++;
            if (t.amountIn > perTrade) overPerTrade++;
            _settle(u0, s0, tokenIn == usdg ? t.amountIn : 0, tokenIn == tsla ? t.amountIn : 0);
        } catch {
            _settle(u0, s0, 0, 0);
        }
    }

    function ownerSetMeasurement(bool useOther, bool approved) external {
        if (!useOther && !approved && _quiet(8)) return; // revoking the live image is the rare case
        bytes32 m = useOther ? otherM : agentM;
        vm.prank(owner);
        account.setMeasurement(m, approved);
        gApproved[m] = approved;
        if (!approved && gAgent != address(0) && gM == m) {
            if (account.agent() != address(0)) notRevokedOnUnapprove++;
            _revokeInModel();
        }
    }

    function ownerRevoke() external {
        if (_quiet(10)) return;
        vm.prank(owner);
        account.revokeAgent();
        if (account.agent() != address(0)) notRevokedOnPolicy++;
        _revokeInModel();
    }

    function ownerSetPolicy(bool require_, uint8 maxStatus, uint32 minEval) external {
        if (_quiet(10)) return;
        maxStatus %= 6;
        minEval %= 40;
        vm.prank(owner);
        account.setAttestationPolicy(require_, maxStatus, minEval);
        gRequire = require_;
        gMax = maxStatus;
        gMin = minEval;
        if (account.agent() != address(0)) notRevokedOnPolicy++;
        if (gAgent != address(0)) _revokeInModel();
    }

    function ownerTogglePause() external {
        if (!account.paused() && _quiet(10)) return; // pausing is the rare case, unpausing always runs
        vm.startPrank(owner);
        if (account.paused()) account.unpause();
        else account.pause();
        vm.stopPrank();
        gPaused = account.paused();
    }

    function ownerSetLimits(bool usdgSide, uint256 perTrade, uint256 daily, uint256 above) external {
        address token = usdgSide ? usdg : tsla;
        uint256 unit = usdgSide ? 1e6 : 1e16;
        perTrade = bound(perTrade, 1, 100) * unit;
        daily = bound(daily, perTrade / unit, 300) * unit;
        above = bound(above, perTrade / 4, perTrade);
        vm.prank(owner);
        account.setLimits(token, AgentAccount.Limits(true, uint128(perTrade), uint128(daily), uint128(above)));
    }

    function ownerWithdraw(bool usdgSide, uint256 amt) external {
        address token = usdgSide ? usdg : tsla;
        (uint256 u0, uint256 s0) = _balances();
        amt = bound(amt, 0, IERC20(token).balanceOf(address(account)) / 20);
        vm.prank(owner);
        account.withdraw(token, owner, amt);
        withdrawals++;
        _settle(u0, s0, usdgSide ? amt : 0, usdgSide ? 0 : amt);
    }

    // ------------------------------------------------------------------ everyone else tries the owner's powers

    function tryOwnerPower(uint256 whoSeed, uint256 which, uint256 amt) external {
        address who = _actor(whoSeed);
        if (who == owner) return;
        (uint256 u0, uint256 s0) = _balances();
        bytes memory call_;
        which %= 11;
        // a real pending proposal when one exists, so the call is refused for who is calling and not for a bad id
        uint256 pid = proposedId.length == 0 ? 1 : proposedId[amt % proposedId.length];
        AgentAccount.Trade memory pt = proposed.length == 0 ? _trade(true, 1) : proposed[amt % proposed.length];
        if (which == 0) call_ = abi.encodeCall(AgentAccount.withdraw, (usdg, who, bound(amt, 1, 1e9)));
        else if (which == 1) call_ = abi.encodeCall(AgentAccount.withdraw, (tsla, who, bound(amt, 1, 1e17)));
        else if (which == 2) call_ = abi.encodeCall(AgentAccount.setLimits, (usdg, AgentAccount.Limits(true, 1e30, 1e30, 1e30)));
        else if (which == 3) call_ = abi.encodeCall(AgentAccount.setMeasurement, (otherM, true));
        else if (which == 4) call_ = abi.encodeCall(AgentAccount.setAttestationPolicy, (false, 5, 0));
        else if (which == 5) call_ = abi.encodeCall(AgentAccount.approveTrade, (pid, pt));
        else if (which == 6) call_ = abi.encodeCall(AgentAccount.revokeAgent, ());
        else if (which == 7) call_ = abi.encodeCall(AgentAccount.rejectTrade, (pid));
        else if (which == 8) call_ = abi.encodeCall(AgentAccount.setApprovalTtl, (uint64(bound(amt, 1, 1 days))));
        else if (which == 9) call_ = abi.encodeCall(AgentAccount.pause, ());
        else call_ = abi.encodeCall(AgentAccount.openInferenceChannel, (who, uint128(bound(amt, 1, 1e9))));
        vm.prank(who);
        (bool ok,) = address(account).call(call_);
        if (ok) ownerPowersWithoutOwner++;
        _settle(u0, s0, 0, 0);
    }
}

contract AgentAccountAttestationInvariantTest is AgentAccountTestBase {
    AttestationHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AttestationHandler(
            account, assay, receiptVerifier, owner, address(usdg), address(tsla), key, usdgIs0,
            [AGENT_M, OTHER_M, MODEL, SERVED, RECEIPT_KEY], true
        );
        targetContract(address(handler));
    }

    /// An unattested key never trades; a revoked measurement or agent never trades again;
    /// limits hold across rotations, policy changes and owner retuning; funds leave only through
    /// an agent swap, an approved swap or an owner withdrawal.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_onlyAttestedCodeTradesAndTheLimitsHold() public view {
        assertEq(handler.unattestedTrades(), 0, "a trade by a key the model does not hold as the live agent");
        assertEq(handler.tradesAfterRevoke(), 0, "a revoked agent traded");
        assertEq(handler.admittedUnapproved(), 0, "admitted under an unapproved measurement");
        assertEq(handler.admittedAgainstPolicy(), 0, "admitted against the attestation policy");
        assertEq(handler.notRevokedOnUnapprove(), 0, "unapproving the live measurement left the agent in place");
        assertEq(handler.notRevokedOnPolicy(), 0, "a policy change or revoke left the agent in place");
        assertEq(handler.overPerTrade(), 0, "a swap above the per-trade cap");
        assertEq(handler.overBand(), 0, "an agent swap above the approval threshold");
        assertEq(handler.overDaily(), 0, "agent outflow over 24 h above the daily cap");
        assertEq(handler.unexplainedDecrease(), 0, "funds left outside an agent swap, an approved swap or an owner withdrawal");
        assertEq(handler.overSpent(), 0, "a swap spent more than its amountIn");
        assertEq(handler.ownerPowersWithoutOwner(), 0, "a non-owner used an owner power");
        assertEq(handler.approvedForeignProposal(), 0, "approved a proposal whose proposer was not the live agent");
        // the live agent always holds an approved measurement
        if (account.agent() != address(0)) {
            assertTrue(account.approvedMeasurement(account.agentMeasurement()), "live agent under an unapproved measurement");
            assertTrue(account.agent() != account.owner(), "the owner is the agent");
        }
    }

    /// Foundry rolls state back between runs, so the coverage totals live in process environment
    /// variables; the last line printed is the sum over every run of the invariant.
    function _total(string memory name, uint256 add) internal returns (uint256 total) {
        total = vm.envOr(name, uint256(0)) + add;
        vm.setEnv(name, vm.toString(total));
    }

    function afterInvariant() external {
        console2.log("TOTAL registers", _total("ATT_REG", handler.registers()));
        console2.log("TOTAL collateral registers", _total("ATT_COL", handler.collateralRegisters()));
        console2.log("TOTAL agent swaps", _total("ATT_EXE", handler.executes()));
        console2.log("TOTAL owner approvals", _total("ATT_APP", handler.approvals()));
        console2.log("TOTAL owner withdrawals", _total("ATT_WDR", handler.withdrawals()));
        console2.log("TOTAL revocations", _total("ATT_REV", handler.revocations()));
        console2.log("TOTAL denied trade attempts", _total("ATT_DEN", handler.deniedTrades()));
    }
}

/// The handler really registers, trades, revokes and is denied, and every violation counter can
/// move: each scenario below produces the event the invariant counts, against an account that
/// behaves, so a counter that stayed 0 would mean the model was not looking.
contract AttestationHandlerSmokeTest is AgentAccountTestBase {
    AttestationHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new AttestationHandler(
            account, assay, receiptVerifier, owner, address(usdg), address(tsla), key, usdgIs0,
            [AGENT_M, OTHER_M, MODEL, SERVED, RECEIPT_KEY], false
        );
    }

    function test_agentTradesAndIsRecorded() public {
        h.execute(0, true, 5e6, 0); // actor 0 is A, the admitted agent
        assertEq(h.executes(), 1);
        assertEq(h.spendCount(), 1);
        assertEq(h.unattestedTrades(), 0);
    }

    function test_unattestedKeyIsDenied() public {
        h.execute(5, true, 5e6, 0); // actor 5 is U
        h.execute(6, true, 5e6, 0); // the stranger
        h.execute(7, true, 5e6, 0); // the owner
        assertEq(h.executes(), 0);
        assertEq(h.deniedTrades(), 3);
    }

    function test_burstStopsAtTheDailyCapAndIsRecorded() public {
        h.burst(true); // 6 x 50 USDG against a 250 USDG daily cap
        assertEq(h.executes(), 5);
        assertEq(h.overDaily(), 0);
        assertEq(h.spendCount(), 5);
    }

    function test_jumpLapsesTheAgentAttestation() public {
        h.jump(20); // 20 h: inside the 24 h attestation
        h.execute(0, true, 5e6, 0);
        assertEq(h.executes(), 1);
        h.jump(30); // 30 h more: past it
        h.execute(0, true, 5e6, 0);
        assertEq(h.executes(), 1);
        assertEq(h.deniedTrades(), 1);
        assertEq(h.unattestedTrades(), 0);
    }

    function test_revokedMeasurementStopsTheAgentAndIsRecorded() public {
        h.ownerSetMeasurement(false, false);
        assertEq(h.revocations(), 1);
        h.execute(0, true, 5e6, 0);
        assertEq(h.executes(), 0);
        assertEq(h.deniedTrades(), 1);
        // re-admission under a re-approved measurement trades again
        h.ownerSetMeasurement(false, true);
        h.register(0, false, false, 0, 0, true);
        assertEq(h.registers(), 1);
        h.execute(0, true, 5e6, 0);
        assertEq(h.executes(), 1);
    }

    function test_policyChangeRevokesAndCollateralIsAdmitted() public {
        h.ownerSetPolicy(true, 0, 5);
        assertEq(h.revocations(), 1);
        h.register(4, false, false, 0, 0, true); // plain path refused under the policy
        assertEq(h.registers(), 0);
        h.register(4, false, true, 0, 20, true); // B with good collateral
        assertEq(h.registers(), 1);
        assertEq(h.collateralRegisters(), 1);
        h.execute(4, true, 5e6, 0);
        assertEq(h.executes(), 1);
        assertEq(h.admittedAgainstPolicy(), 0);
    }

    function test_withdrawalAndOwnerPowersAreAccounted() public {
        h.ownerWithdraw(true, 1_000e6);
        assertEq(h.withdrawals(), 1);
        h.tryOwnerPower(6, 0, 5);
        h.tryOwnerPower(0, 4, 5);
        assertEq(h.ownerPowersWithoutOwner(), 0);
        assertEq(h.unexplainedDecrease(), 0);
    }

    function test_approvalPathIsAccounted() public {
        h.propose(0, true, 60e6, 0);
        h.ownerApprove(0);
        assertEq(h.approvals(), 1);
        assertEq(h.unexplainedDecrease(), 0);
    }
}
