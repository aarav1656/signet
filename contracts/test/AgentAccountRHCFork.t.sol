// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {Assay} from "../src/Assay.sol";
import {DeployAgentAccountRHC} from "../script/rhc/DeployAgentAccountRHC.s.sol";
import {RHCVenue} from "../script/rhc/RHCVenue.sol";
import {AgentQuoteVerifier} from "./mocks/AgentQuoteVerifier.sol";
import {MockReceiptVerifier} from "./mocks/MockReceiptVerifier.sol";
import {ArbSysDouble} from "./mocks/ArbSysDouble.sol";

interface IStock {
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

interface IRegistry {
    function hasRole(bytes32 role, address account) external view returns (bool);
}

/// RHC testnet fork: the real TSLA Stock Token, the canonical v4 PoolManager and
/// PositionManager, the real Stock pause, and the deploy script itself. Doubles only where the
/// fork cannot execute the real thing: the two Stylus verifiers (WASM) and ArbSys (0x64 is a
/// precompile, `0xfe` to the EVM).
///
///   RHC_FORK_URL=https://rpc.testnet.chain.robinhood.com forge test --match-path test/AgentAccountRHCFork.t.sol
contract AgentAccountRHCForkTest is Test {
    /// Holds TOKEN_PAUSER_ROLE in TSLA's registry (RoleGranted at block 295, hasRole true at
    /// 126,554,031 on 2026-09-30); re-checked in the test before use.
    address internal constant PAUSER = 0xE44cD4f96E83a090AE70fe34C3ff2cC05c9e247a;
    bytes32 internal constant AGENT_M = keccak256("chiron-agent-cvm-image");
    bytes32 internal constant GATEWAY_M = keccak256("phala-gateway-image");
    string internal constant MODEL_ID = "deepseek/deepseek-chat-v3-0324";
    string internal constant SERVED_ID = "deepseek-ai/DeepSeek-V3-0324";
    bytes32 internal constant RECEIPT_KEY = keccak256("phala-receipt-ed25519-pubkey");

    address internal deployer = makeAddr("rhc-deployer");
    address internal provider = makeAddr("rhc-provider");
    address internal agent = makeAddr("rhc-agent");
    AgentQuoteVerifier internal verifier;
    MockReceiptVerifier internal receiptVerifier;
    DeployAgentAccountRHC.Deployment internal d;
    AgentAccount internal account;
    PoolKey internal key;
    IERC20 internal tsla = IERC20(RHCVenue.TSLA);
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
        _deployViaScript();
        _;
    }

    function _deployViaScript() internal {
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
        deal(RHCVenue.TSLA, deployer, 5e18); // what one faucet claim gives
        DeployAgentAccountRHC script = new DeployAgentAccountRHC();
        d = script.deploy(deployer);
        account = AgentAccount(d.account);
        usdg = IERC20(d.usdg);
        key = RHCVenue.poolKey(d.usdg, RHCVenue.TSLA);

        verifier.setKeysetMeasurement(GATEWAY_M);
        Assay(d.assay).registerReceiptKey(hex"01", hex"02", block.number - 1, RECEIPT_KEY);
        account.registerAgent(abi.encode(agent, AGENT_M, account.attestNonce(block.number - 1)), block.number - 1);
    }

    function _trade(bool buy, uint128 amountIn, uint128 minOut) internal returns (uint256 out) {
        bool usdgIs0 = Currency.unwrap(key.currency0) == d.usdg;
        AgentAccount.Trade memory t =
            AgentAccount.Trade(key, buy ? usdgIs0 : !usdgIs0, amountIn, minOut, uint64(block.timestamp + 600));
        n++;
        receiptVerifier.setNext(
            true, keccak256(bytes(MODEL_ID)), keccak256(bytes(SERVED_ID)), keccak256(abi.encode("q", n)), keccak256(abi.encode("r", n))
        );
        vm.prank(agent);
        (, out) = account.execute(t, AgentAccount.Receipt(RECEIPT_KEY, "", ""));
    }

    function test_fork_deployScript_readBack() public forked {
        assertEq(account.owner(), deployer);
        assertEq(address(account.poolManager()), RHCVenue.POOL_MANAGER);
        assertEq(account.agent(), agent);
        assertEq(usdg.balanceOf(d.account), 95e6);
        assertEq(tsla.balanceOf(d.account), 1e18);
        assertGt(d.liquidity, 0);
        // 4 TSLA in the pool less the 0.01% rounding margin, 1 in the account
        assertLt(tsla.balanceOf(deployer), 0.001e18);
        assertGt(tsla.balanceOf(RHCVenue.POOL_MANAGER), 3.99e18);
    }

    function test_fork_poolManagerIsCanonicalBuild() public forked {
        assertEq(RHCVenue.POOL_MANAGER.codehash, RHCVenue.POOL_MANAGER_CODEHASH);
        // the vendored v4-core v4.0.0 source, built with its own settings, is byte-identical
        deployCodeTo("out-v4/PoolManager.sol/PoolManager.json", abi.encode(address(1)), RHCVenue.POOL_MANAGER);
        assertEq(RHCVenue.POOL_MANAGER.codehash, RHCVenue.POOL_MANAGER_CODEHASH);
    }

    function test_fork_swapTSLA_throughCanonicalPoolManager() public forked {
        uint256 u0 = usdg.balanceOf(d.account);
        uint256 s0 = tsla.balanceOf(d.account);
        // 1 testUSDG at 250 testUSDG per TSLA, 0.3% fee: just under 0.004 TSLA
        uint256 bought = _trade(true, 1e6, 0.0039e18);
        assertEq(usdg.balanceOf(d.account), u0 - 1e6);
        assertEq(tsla.balanceOf(d.account), s0 + bought);
        assertLt(bought, 0.004e18);

        uint256 sold = _trade(false, uint128(bought), 0.99e6);
        assertEq(tsla.balanceOf(d.account), s0);
        assertEq(usdg.balanceOf(d.account), u0 - 1e6 + sold);
        assertLt(sold, 1e6);
        assertEq(account.tradeCount(), 2);
    }

    function test_fork_stockPaused_revertsTrade_otherTokenWithdrawWorks() public forked {
        IRegistry reg = IRegistry(IStock(RHCVenue.TSLA).ACCESS_CONTROLLED_REGISTRY());
        assertTrue(reg.hasRole(keccak256("TOKEN_PAUSER_ROLE"), PAUSER), "pauser role moved");
        vm.prank(PAUSER);
        IStock(RHCVenue.TSLA).pause();
        assertTrue(IStock(RHCVenue.TSLA).paused());

        uint256 u0 = usdg.balanceOf(d.account);
        uint256 s0 = tsla.balanceOf(d.account);
        bool usdgIs0 = Currency.unwrap(key.currency0) == d.usdg;
        AgentAccount.Trade memory t = AgentAccount.Trade(key, usdgIs0, 1e6, 1, uint64(block.timestamp + 600));
        receiptVerifier.setNext(true, keccak256(bytes(MODEL_ID)), keccak256(bytes(SERVED_ID)), bytes32("q"), bytes32("r"));
        vm.prank(agent);
        try account.execute(t, AgentAccount.Receipt(RECEIPT_KEY, "", "")) {
            fail("a trade in a paused Stock Token went through");
        } catch (bytes memory e) {
            // the Stock's own IsPaused, wrapped by the PoolManager's ERC20TransferFailed
            assertTrue(_contains(e, abi.encodeWithSignature("IsPaused()")), "reverted for another reason");
        }
        assertEq(usdg.balanceOf(d.account), u0);
        assertEq(tsla.balanceOf(d.account), s0);

        vm.startPrank(deployer);
        account.withdraw(d.usdg, deployer, 10e6);
        vm.expectRevert(abi.encodeWithSignature("IsPaused()"));
        account.withdraw(RHCVenue.TSLA, deployer, 1);
        vm.stopPrank();
        assertEq(usdg.balanceOf(d.account), u0 - 10e6);

        vm.prank(PAUSER);
        IStock(RHCVenue.TSLA).unpause();
        _trade(true, 1e6, 1);
    }

    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool m = true;
            for (uint256 j; j < needle.length && m; ++j) {
                m = hay[i + j] == needle[j];
            }
            if (m) return true;
        }
        return false;
    }
}
