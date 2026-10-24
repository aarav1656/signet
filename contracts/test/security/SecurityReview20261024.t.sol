// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {Assay} from "../../src/Assay.sol";
import {DeployAgentAccountRHC} from "../../script/rhc/DeployAgentAccountRHC.s.sol";
import {RHCVenue} from "../../script/rhc/RHCVenue.sol";
import {AgentQuoteVerifier} from "../mocks/AgentQuoteVerifier.sol";
import {MockReceiptVerifier} from "../mocks/MockReceiptVerifier.sol";
import {ArbSysDouble} from "../mocks/ArbSysDouble.sol";

/// PoCs for contracts/SECURITY-REVIEW-2026-10-24.md, on an RHC testnet fork (real TSLA, real
/// canonical PoolManager, the deploy script itself). Doubles only where the fork cannot run the
/// real thing (Stylus WASM verifiers, ArbSys), exactly as AgentAccountRHCFork.t.sol.
///
/// The quote double models the CVM's public `POST /quote?account=` (agent/src/cvm.ts 101 to 106):
/// unauthenticated, it returns the CVM key bound to any account's current attestNonce. So any
/// stranger can obtain the live CVM's quote, and `registerAgent` is permissionless.
///
///   RHC_FORK_URL=https://rpc.testnet.chain.robinhood.com forge test --match-path test/security/SecurityReview20261024.t.sol -j 1
contract SecurityReview20261024Test is Test {
    bytes32 internal constant AGENT_M = keccak256("chiron-agent-cvm-image");
    bytes32 internal constant AGENT_M2 = keccak256("chiron-agent-cvm-image-boot-2");
    bytes32 internal constant GATEWAY_M = keccak256("phala-gateway-image");
    string internal constant MODEL_ID = "deepseek/deepseek-chat-v3-0324";
    string internal constant SERVED_ID = "deepseek-ai/DeepSeek-V3-0324";
    bytes32 internal constant RECEIPT_KEY = keccak256("phala-receipt-ed25519-pubkey");

    address internal deployer = makeAddr("rhc-deployer");
    address internal provider = makeAddr("rhc-provider");
    address internal agent = makeAddr("rhc-agent");
    address internal agent2 = makeAddr("rhc-agent-boot-2");
    address internal stranger = makeAddr("stranger");
    AgentQuoteVerifier internal verifier;
    MockReceiptVerifier internal receiptVerifier;
    DeployAgentAccountRHC.Deployment internal d;
    AgentAccount internal account;
    PoolKey internal key;
    IERC20 internal usdg;
    uint256 internal n;

    modifier forked() {
        string memory url = vm.envOr("RHC_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 at = vm.envOr("RHC_FORK_BLOCK", uint256(0));
        if (at == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, at);
        assertEq(block.chainid, RHCVenue.CHAIN_ID);
        _deploy();
        _;
    }

    function _deploy() internal {
        vm.etch(address(0x64), address(new ArbSysDouble()).code);
        verifier = new AgentQuoteVerifier();
        receiptVerifier = new MockReceiptVerifier();
        vm.setEnv("VERIFIER", vm.toString(address(verifier)));
        vm.setEnv("RECEIPT_VERIFIER", vm.toString(address(receiptVerifier)));
        vm.setEnv("GATEWAY_MEASUREMENT", vm.toString(GATEWAY_M));
        vm.setEnv("MODEL_ID", MODEL_ID);
        vm.setEnv("SERVED_MODEL_ID", SERVED_ID);
        vm.setEnv("PROVIDER", vm.toString(provider));
        vm.setEnv("AGENT_MEASUREMENT", vm.toString(AGENT_M));
        vm.setEnv("PRIVATE_KEY", "0");
        deal(RHCVenue.TSLA, deployer, 5e18);
        DeployAgentAccountRHC script = new DeployAgentAccountRHC();
        d = script.deploy(deployer);
        account = AgentAccount(d.account);
        usdg = IERC20(d.usdg);
        key = RHCVenue.poolKey(d.usdg, RHCVenue.TSLA);
        verifier.setKeysetMeasurement(GATEWAY_M);
        Assay(d.assay).registerReceiptKey(hex"01", hex"02", block.number - 1, RECEIPT_KEY);
        _cvmQuoteRegister(account, agent, AGENT_M, address(this));
        assertEq(account.agent(), agent);
    }

    /// What the CVM's public /quote plus a permissionless registerAgent gives anyone.
    function _cvmQuoteRegister(AgentAccount a, address signer, bytes32 m, address caller) internal {
        uint256 ref = block.number - 1;
        bytes memory quote = abi.encode(signer, m, a.attestNonce(ref));
        vm.prank(caller);
        a.registerAgent(quote, ref);
    }

    function _buy(uint128 amountIn) internal view returns (AgentAccount.Trade memory) {
        bool usdgIs0 = Currency.unwrap(key.currency0) == d.usdg;
        return AgentAccount.Trade(key, usdgIs0, amountIn, 1, uint64(block.timestamp + 600));
    }

    function _receipt(bytes32 req, bytes32 resp) internal {
        receiptVerifier.setNext(true, keccak256(bytes(MODEL_ID)), keccak256(bytes(SERVED_ID)), req, resp);
    }

    function _execute(AgentAccount a, address who, uint128 amountIn) internal returns (uint256 tradeId) {
        n++;
        _receipt(keccak256(abi.encode("q", n)), keccak256(abi.encode("r", n)));
        vm.prank(who);
        (tradeId,) = a.execute(_buy(amountIn), AgentAccount.Receipt(RECEIPT_KEY, "", ""));
    }

    // ------------------------------------------------------------- F-1 revokeAgent is not durable

    /// revokeAgent unapproves the live measurement, so a stranger replaying the revoked key's quote
    /// is refused. Before the fix the same replay re-admitted the key and it traded again.
    function test_F1_revokeAgent_isDurable() public forked {
        vm.prank(deployer);
        account.revokeAgent();
        assertEq(account.agent(), address(0));
        assertFalse(account.approvedMeasurement(AGENT_M), "measurement still approved");

        uint256 ref = block.number - 1;
        bytes memory quote = abi.encode(agent, AGENT_M, account.attestNonce(ref));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.MeasurementNotApproved.selector, AGENT_M));
        account.registerAgent(quote, ref);
        assertEq(account.agent(), address(0), "revoked key is not back");
    }

    /// Control: unapproving the measurement is durable, the same stranger replay is refused.
    function test_F1_control_unapproveMeasurement_isDurable() public forked {
        vm.prank(deployer);
        account.setMeasurement(AGENT_M, false);
        uint256 ref = block.number - 1;
        bytes memory quote = abi.encode(agent, AGENT_M, account.attestNonce(ref));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.MeasurementNotApproved.selector, AGENT_M));
        account.registerAgent(quote, ref);
    }

    // ------------------------------------------------------------- F-2 24 h expiry is renewable by anyone

    /// "A rotated or compromised agent key stops trading within a day on its own": a stranger renews
    /// at hour 23 and the key trades at hour 25.
    function test_F2_expiry_isRenewedByAStranger() public forked {
        vm.warp(block.timestamp + 23 hours);
        vm.roll(block.number + 1);
        _cvmQuoteRegister(account, agent, AGENT_M, stranger);
        vm.warp(block.timestamp + 2 hours);
        vm.roll(block.number + 1);
        Assay(d.assay).registerReceiptKey(hex"0102", hex"02", block.number - 1, RECEIPT_KEY);
        uint256 before = account.tradeCount();
        _execute(account, agent, 1e6);
        assertEq(account.tradeCount(), before + 1, "key traded 25h after its first admission");
    }

    /// Control: without the renewal the same trade at hour 25 is refused.
    function test_F2_control_withoutRenewal_expires() public forked {
        vm.warp(block.timestamp + 25 hours);
        vm.roll(block.number + 1);
        Assay(d.assay).registerReceiptKey(hex"0102", hex"02", block.number - 1, RECEIPT_KEY);
        _receipt(keccak256("q-exp"), keccak256("r-exp"));
        AgentAccount.Trade memory t = _buy(1e6);
        vm.prank(agent);
        vm.expectRevert(AgentAccount.AgentExpired.selector);
        account.execute(t, AgentAccount.Receipt(RECEIPT_KEY, "", ""));
    }

    // ------------------------------------------------------------- F-3 stranger swaps the live agent

    /// With two approved measurements (the contract allows a set), a stranger switches the live
    /// agent to the other CVM; the pending proposal of the first can no longer be approved.
    function test_F3_strangerSwapsAgent_strandsPendingProposal() public forked {
        vm.prank(deployer);
        account.setMeasurement(AGENT_M2, true);
        (uint256 id, AgentAccount.Trade memory t) = _propose();

        _cvmQuoteRegister(account, agent2, AGENT_M2, stranger);
        assertEq(account.agent(), agent2);
        vm.prank(deployer);
        vm.expectRevert(AgentAccount.ProposerNotCurrentAgent.selector);
        account.approveTrade(id, t);
    }

    /// Control: with no swap the owner approves the same proposal.
    function test_F3_control_noSwap_ownerApproves() public forked {
        (uint256 id, AgentAccount.Trade memory t) = _propose();
        vm.prank(deployer);
        account.approveTrade(id, t);
        assertEq(account.tradeCount(), 1);
    }

    function _propose() internal returns (uint256 id, AgentAccount.Trade memory t) {
        t = _buy(3e6);
        _receipt(keccak256("q-prop"), keccak256("r-prop"));
        vm.prank(agent);
        id = account.propose(t, AgentAccount.Receipt(RECEIPT_KEY, "", ""));
    }

    // ------------------------------------------------------------- F-4 one receipt, two accounts

    /// The receipt is consumed per account and is not bound to the trade, the account or a time:
    /// one inference backs a TradeExecuted on two different accounts.
    function test_F4_oneReceipt_backsTradesOnTwoAccounts() public forked {
        AgentAccount b = _secondAccount();
        bytes32 req = keccak256("one-inference-request");
        bytes32 resp = keccak256("one-inference-response");

        _receipt(req, resp);
        vm.prank(agent);
        account.execute(_buy(1e6), AgentAccount.Receipt(RECEIPT_KEY, "", ""));
        _receipt(req, resp);
        vm.prank(agent);
        b.execute(_buy(1e6), AgentAccount.Receipt(RECEIPT_KEY, "", ""));
        assertEq(account.tradeCount(), 1);
        assertEq(b.tradeCount(), 1);
        assertTrue(account.usedReceipt(keccak256(abi.encode(req, resp))));
        assertTrue(b.usedReceipt(keccak256(abi.encode(req, resp))));
    }

    /// Control: the same receipt twice on one account is refused.
    function test_F4_control_sameAccountReplay_refused() public forked {
        bytes32 req = keccak256("one-inference-request");
        bytes32 resp = keccak256("one-inference-response");
        _receipt(req, resp);
        vm.prank(agent);
        account.execute(_buy(1e6), AgentAccount.Receipt(RECEIPT_KEY, "", ""));
        _receipt(req, resp);
        AgentAccount.Trade memory t = _buy(1e6);
        vm.prank(agent);
        vm.expectRevert(AgentAccount.ReceiptAlreadyUsed.selector);
        account.execute(t, AgentAccount.Receipt(RECEIPT_KEY, "", ""));
    }

    function _secondAccount() internal returns (AgentAccount b) {
        address owner2 = makeAddr("owner-2");
        b = AgentAccount(AgentAccountFactory(d.factory).createAccount(owner2));
        bytes32 model = keccak256(bytes(MODEL_ID));
        bytes32 served = keccak256(bytes(SERVED_ID));
        vm.startPrank(owner2);
        b.setLimits(d.usdg, AgentAccount.Limits(true, 10e6, 5e6, 2e6));
        b.setLimits(RHCVenue.TSLA, AgentAccount.Limits(true, 0.1e18, 0.05e18, 0.01e18));
        b.setPool(key, true);
        b.setModel(model, [served, model, bytes32(0), bytes32(0)], GATEWAY_M);
        b.setMeasurement(AGENT_M, true);
        vm.stopPrank();
        deal(d.usdg, address(b), 10e6);
        _cvmQuoteRegister(b, agent, AGENT_M, stranger);
    }
}
