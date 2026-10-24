// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {Assay} from "../src/Assay.sol";
import {TestUSDG} from "../src/TestUSDG.sol";
import {AgentQuoteVerifier} from "./mocks/AgentQuoteVerifier.sol";
import {MockReceiptVerifier} from "./mocks/MockReceiptVerifier.sol";
import {TestStockToken} from "./mocks/TestStockToken.sol";

/// Real Uniswap v4 PoolManager (v4-core v4.0.0, built by `FOUNDRY_PROFILE=v4 forge build`),
/// real Assay, real factory; only the two Stylus verifiers are doubles.
abstract contract AgentAccountTestBase is Test {
    bytes32 internal constant AGENT_M = keccak256("chiron-agent-cvm-image");
    bytes32 internal constant OTHER_M = keccak256("some-other-image");
    bytes32 internal constant GATEWAY_M = keccak256("phala-gateway-image");
    bytes32 internal constant MODEL = keccak256("deepseek/deepseek-chat-v3-0324");
    bytes32 internal constant SERVED = keccak256("deepseek-ai/DeepSeek-V3-0324");
    bytes32 internal constant RECEIPT_KEY = keccak256("phala-receipt-ed25519-pubkey");
    uint24 internal constant FEE = 3000;
    int24 internal constant SPACING = 60;

    // limits, raw units
    uint128 internal constant USDG_PER_TRADE = 100e6;
    uint128 internal constant USDG_DAILY = 250e6;
    uint128 internal constant USDG_APPROVAL_ABOVE = 50e6;
    uint128 internal constant TSLA_PER_TRADE = 1e18;
    uint128 internal constant TSLA_DAILY = 3e18;
    uint128 internal constant TSLA_APPROVAL_ABOVE = 0.5e18;

    address internal owner = makeAddr("owner");
    address internal provider = makeAddr("provider");
    address internal stranger = makeAddr("stranger");
    uint256 internal agentPk = 0xA6E47;
    address internal agentAddr;

    TestUSDG internal usdg;
    TestStockToken internal tsla;
    AgentQuoteVerifier internal verifier;
    MockReceiptVerifier internal receiptVerifier;
    Assay internal assay;
    IPoolManager internal manager;
    PoolModifyLiquidityTest internal lp;
    AgentAccountFactory internal factory;
    AgentAccount internal account;
    PoolKey internal key;
    bool internal usdgIs0;
    uint256 internal receiptNonce;

    function setUp() public virtual {
        vm.roll(1000);
        vm.warp(1_790_000_000);
        agentAddr = vm.addr(agentPk);

        usdg = new TestUSDG();
        tsla = new TestStockToken();
        verifier = new AgentQuoteVerifier();
        receiptVerifier = new MockReceiptVerifier();
        bytes32[] memory approved = new bytes32[](1);
        approved[0] = GATEWAY_M;
        assay = new Assay(address(usdg), address(verifier), address(receiptVerifier), approved, 1 days, 1 hours, 1 hours);
        verifier.setKeysetMeasurement(GATEWAY_M);
        assay.registerReceiptKey(hex"01", hex"02", block.number - 1, RECEIPT_KEY);

        manager = IPoolManager(deployCode("out-v4/PoolManager.sol/PoolManager.json", abi.encode(address(this))));
        lp = new PoolModifyLiquidityTest(manager);

        usdgIs0 = address(usdg) < address(tsla);
        key = PoolKey({
            currency0: Currency.wrap(usdgIs0 ? address(usdg) : address(tsla)),
            currency1: Currency.wrap(usdgIs0 ? address(tsla) : address(usdg)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        _initPool(key, 250e6, 1e18, 1e16);

        factory = new AgentAccountFactory(
            address(verifier), address(receiptVerifier), address(assay), address(manager), address(usdg)
        );
        account = AgentAccount(factory.createAccount(owner));
        _configure(account);
        usdg.mint(address(account), 10_000e6);
        tsla.mint(address(account), 10e18);
        _registerAgent(agentAddr, AGENT_M);
    }

    /// Initialise at `usdgPerUnit` raw USDG per `stockUnit` raw stock and add full-range liquidity.
    function _initPool(PoolKey memory k, uint256 usdgPerUnit, uint256 stockUnit, int256 liquidity) internal {
        (uint256 a0, uint256 a1) = Currency.unwrap(k.currency0) == address(usdg)
            ? (usdgPerUnit, stockUnit)
            : (stockUnit, usdgPerUnit);
        uint160 sqrtPriceX96 = uint160(Math.sqrt(FullMath.mulDiv(a1, 1 << 192, a0)));
        manager.initialize(k, sqrtPriceX96);
        usdg.mint(address(this), 1e15);
        tsla.mint(address(this), 1e27);
        usdg.approve(address(lp), type(uint256).max);
        tsla.approve(address(lp), type(uint256).max);
        int24 maxTick = (TickMath.MAX_TICK / SPACING) * SPACING;
        lp.modifyLiquidity(k, IPoolManager.ModifyLiquidityParams(-maxTick, maxTick, liquidity, 0), "");
    }

    function _configure(AgentAccount a) internal {
        vm.startPrank(owner);
        a.setLimits(address(usdg), AgentAccount.Limits(true, USDG_PER_TRADE, USDG_DAILY, USDG_APPROVAL_ABOVE));
        a.setLimits(address(tsla), AgentAccount.Limits(true, TSLA_PER_TRADE, TSLA_DAILY, TSLA_APPROVAL_ABOVE));
        a.setPool(key, true);
        a.setModel(MODEL, [SERVED, MODEL, bytes32(0), bytes32(0)], GATEWAY_M);
        a.setMeasurement(AGENT_M, true);
        vm.stopPrank();
    }

    function _quote(address signer, bytes32 m) internal view returns (bytes memory) {
        return _quoteOn(account, signer, m);
    }

    function _quoteOn(AgentAccount a, address signer, bytes32 m) internal view returns (bytes memory) {
        return abi.encode(signer, m, a.attestNonce(block.number - 1));
    }

    function _registerAgent(address signer, bytes32 m) internal {
        account.registerAgent(_quote(signer, m), block.number - 1);
    }

    /// Replacing a live, unexpired agent with a different key is the owner's call (review F-3).
    function _replaceAgentAsOwner(address signer, bytes32 m) internal {
        bytes memory q = _quote(signer, m);
        vm.prank(owner);
        account.registerAgent(q, block.number - 1);
    }

    function _registerAgentOn(AgentAccount a, address signer, bytes32 m) internal {
        a.registerAgent(_quoteOn(a, signer, m), block.number - 1);
    }

    function _receipt() internal returns (AgentAccount.Receipt memory) {
        return _receiptFor(MODEL, SERVED);
    }

    function _receiptFor(bytes32 requested, bytes32 served) internal returns (AgentAccount.Receipt memory) {
        receiptNonce++;
        receiptVerifier.setNext(
            true, requested, served, keccak256(abi.encode("req", receiptNonce)), keccak256(abi.encode("resp", receiptNonce))
        );
        return AgentAccount.Receipt(RECEIPT_KEY, bytes("jcs-receipt"), bytes("ed25519-sig"));
    }

    function _buy(uint128 usdgIn) internal view returns (AgentAccount.Trade memory) {
        return AgentAccount.Trade(key, usdgIs0, usdgIn, 1, uint64(vm.getBlockTimestamp() + 600));
    }

    function _sell(uint128 tslaIn) internal view returns (AgentAccount.Trade memory) {
        return AgentAccount.Trade(key, !usdgIs0, tslaIn, 1, uint64(vm.getBlockTimestamp() + 600));
    }

    function _exec(AgentAccount.Trade memory t) internal returns (uint256 tradeId, uint256 out) {
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        return account.execute(t, r);
    }

    function _propose(AgentAccount.Trade memory t) internal returns (uint256 id) {
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        return account.propose(t, r);
    }
}
