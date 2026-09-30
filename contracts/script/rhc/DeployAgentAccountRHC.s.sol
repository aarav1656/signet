// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Assay} from "../../src/Assay.sol";
import {TestUSDG} from "../../src/TestUSDG.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {RHCVenue} from "./RHCVenue.sol";

/// Spec steps 3, 4, 5 and 7 on RHC testnet (46630): testUSDG, Assay, the TSLA/testUSDG pool on
/// the canonical PoolManager, the factory, one account, and the owner's configuration. The
/// Stylus Verifier and ReceiptVerifier (step 2) come first from deploy-stylus.sh.
///
///   forge script script/rhc/DeployAgentAccountRHC.s.sol --rpc-url rhc_testnet --broadcast \
///     --account <keystore-name> --sender <deployer>
///
/// Env (required): VERIFIER, RECEIPT_VERIFIER, GATEWAY_MEASUREMENT (from a fresh gateway quote
///   read through the new Verifier), MODEL_ID, SERVED_MODEL_ID, PROVIDER.
/// Env (optional): DEPLOYER (defaults to the script sender), PRIVATE_KEY (the repo's older
///   pattern, otherwise pass a wallet flag), USDG_PER_TSLA (raw testUSDG per 1e18 TSLA, default
///   250e6: a price we choose, not a market price), TSLA_LIQUIDITY (default 4e18),
///   ACCOUNT_TSLA (default 1e18), ACCOUNT_USDG (default 100e6), CHANNEL_DEPOSIT (default 5e6),
///   AGENT_MEASUREMENT (approve now; otherwise run approveMeasurement() after step 6).
/// The deployer must hold TSLA from the official faucet and a little ETH. It is the owner.
contract DeployAgentAccountRHC is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    struct Deployment {
        address deployer;
        address usdg;
        address assay;
        address factory;
        address account;
        uint256 channelId;
        uint128 liquidity;
        uint160 sqrtPriceX96;
        bytes32 poolId;
        uint256 block;
    }

    // Live-cycle limits, raw units. Band 1 is up to 2 testUSDG, band 2 up to 10, and the
    // agent alone may spend 5 testUSDG per rolling 24 h.
    uint128 internal constant USDG_PER_TRADE = 10e6;
    uint128 internal constant USDG_DAILY = 5e6;
    uint128 internal constant USDG_APPROVAL_ABOVE = 2e6;
    uint128 internal constant TSLA_PER_TRADE = 0.1e18;
    uint128 internal constant TSLA_DAILY = 0.05e18;
    uint128 internal constant TSLA_APPROVAL_ABOVE = 0.01e18;

    function run() external returns (Deployment memory d) {
        d = deploy(msg.sender);
        _record(d);
    }

    function _start(address deployer) internal {
        uint256 key = vm.envOr("PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast(deployer);
    }

    function deploy(address sender) public returns (Deployment memory d) {
        require(block.chainid == RHCVenue.CHAIN_ID, "not RHC testnet");
        require(RHCVenue.POOL_MANAGER.codehash == RHCVenue.POOL_MANAGER_CODEHASH, "PoolManager code changed");
        d.deployer = vm.envOr("DEPLOYER", sender);
        address verifier = vm.envAddress("VERIFIER");
        address receiptVerifier = vm.envAddress("RECEIPT_VERIFIER");
        bytes32 gatewayM = vm.envBytes32("GATEWAY_MEASUREMENT");
        bytes32 model = keccak256(bytes(vm.envString("MODEL_ID")));
        bytes32 served = keccak256(bytes(vm.envString("SERVED_MODEL_ID")));
        address provider = vm.envAddress("PROVIDER");
        uint256 usdgPerTsla = vm.envOr("USDG_PER_TSLA", uint256(250e6));
        uint256 tslaLiquidity = vm.envOr("TSLA_LIQUIDITY", uint256(4e18));
        uint256 accountTsla = vm.envOr("ACCOUNT_TSLA", uint256(1e18));
        uint256 accountUsdg = vm.envOr("ACCOUNT_USDG", uint256(100e6));
        uint128 channelDeposit = uint128(vm.envOr("CHANNEL_DEPOSIT", uint256(5e6)));
        bytes32 agentM = vm.envOr("AGENT_MEASUREMENT", bytes32(0));
        require(verifier.code.length != 0 && receiptVerifier.code.length != 0, "Stylus verifiers not deployed");
        require(IERC20(RHCVenue.TSLA).balanceOf(d.deployer) >= tslaLiquidity + accountTsla, "deployer needs faucet TSLA");

        _start(d.deployer);
        // step 3
        TestUSDG usdg = new TestUSDG();
        // step 4
        bytes32[] memory approved = new bytes32[](1);
        approved[0] = gatewayM;
        Assay assay = new Assay(address(usdg), verifier, receiptVerifier, approved, 86400, 3600, 3600);
        // step 5
        usdg.mint(d.deployer, tslaLiquidity * usdgPerTsla / 1e18 + 1e6 + accountUsdg);
        (PoolKey memory key, uint128 liquidity) =
            RHCVenue.createAndFund(address(usdg), RHCVenue.TSLA, usdgPerTsla, tslaLiquidity, d.deployer);
        // step 7
        AgentAccountFactory factory =
            new AgentAccountFactory(verifier, receiptVerifier, address(assay), RHCVenue.POOL_MANAGER, address(usdg));
        AgentAccount account = AgentAccount(factory.createAccount(d.deployer));
        account.setLimits(address(usdg), AgentAccount.Limits(true, USDG_PER_TRADE, USDG_DAILY, USDG_APPROVAL_ABOVE));
        account.setLimits(RHCVenue.TSLA, AgentAccount.Limits(true, TSLA_PER_TRADE, TSLA_DAILY, TSLA_APPROVAL_ABOVE));
        account.setPool(key, true);
        account.setModel(model, [served, model, bytes32(0), bytes32(0)], gatewayM);
        if (agentM != bytes32(0)) account.setMeasurement(agentM, true);
        usdg.transfer(address(account), accountUsdg);
        if (accountTsla != 0) IERC20(RHCVenue.TSLA).transfer(address(account), accountTsla);
        d.channelId = account.openInferenceChannel(provider, channelDeposit);
        vm.stopBroadcast();

        d.usdg = address(usdg);
        d.assay = address(assay);
        d.factory = address(factory);
        d.account = address(account);
        d.liquidity = liquidity;
        d.poolId = PoolId.unwrap(key.toId());
        d.block = block.number;
        _readBack(d, key, gatewayM, model, accountUsdg - channelDeposit, accountTsla);
    }

    /// Every step's read-back; the script fails rather than record a half-configured deploy.
    function _readBack(
        Deployment memory d,
        PoolKey memory key,
        bytes32 gatewayM,
        bytes32 model,
        uint256 usdgLeft,
        uint256 tslaLeft
    ) internal {
        require(TestUSDG(d.usdg).decimals() == 6, "testUSDG decimals");
        Assay assay = Assay(d.assay);
        require(address(assay.usdg()) == d.usdg && assay.approvedMeasurement(gatewayM), "Assay wiring");
        (uint160 sqrtP,,,) = IPoolManager(RHCVenue.POOL_MANAGER).getSlot0(key.toId());
        uint128 liq = IPoolManager(RHCVenue.POOL_MANAGER).getLiquidity(key.toId());
        require(sqrtP != 0 && liq == d.liquidity, "pool state");
        d.sqrtPriceX96 = sqrtP;
        AgentAccount a = AgentAccount(d.account);
        require(a.owner() == d.deployer && address(a.poolManager()) == RHCVenue.POOL_MANAGER, "account wiring");
        require(a.allowedPool(key.toId()) && a.requestedModelHash() == model && a.gatewayMeasurement() == gatewayM, "policy");
        (bool allowed,,,) = a.limits(d.usdg);
        require(allowed, "limits");
        require(IERC20(d.usdg).balanceOf(d.account) == usdgLeft, "usdg deposit");
        require(IERC20(RHCVenue.TSLA).balanceOf(d.account) == tslaLeft, "tsla deposit");
        require(IERC20(d.usdg).allowance(d.account, d.assay) == 0, "allowance reset");
        (address chAgent,,,,,,,,,) = assay.channels(d.channelId);
        require(chAgent == d.account, "channel agent");
        console.log("testUSDG", d.usdg);
        console.log("Assay", d.assay);
        console.log("AgentAccountFactory", d.factory);
        console.log("AgentAccount", d.account);
        console.log("inference channel", d.channelId);
    }

    function _record(Deployment memory d) internal {
        string memory c = "contracts";
        vm.serializeAddress(c, "TestUSDG", d.usdg);
        vm.serializeAddress(c, "Assay", d.assay);
        vm.serializeAddress(c, "AgentAccountFactory", d.factory);
        vm.serializeAddress(c, "AgentAccount", d.account);
        vm.serializeAddress(c, "PoolManager", RHCVenue.POOL_MANAGER);
        vm.serializeAddress(c, "PositionManager", RHCVenue.POSITION_MANAGER);
        vm.serializeAddress(c, "TSLA", RHCVenue.TSLA);
        vm.serializeAddress(c, "Verifier", vm.envAddress("VERIFIER"));
        c = vm.serializeAddress(c, "ReceiptVerifier", vm.envAddress("RECEIPT_VERIFIER"));
        string memory p = "pool";
        vm.serializeBytes32(p, "poolId", d.poolId);
        vm.serializeUint(p, "sqrtPriceX96", d.sqrtPriceX96);
        p = vm.serializeUint(p, "liquidity", d.liquidity);
        string memory r = "root";
        vm.serializeUint(r, "chainId", RHCVenue.CHAIN_ID);
        vm.serializeAddress(r, "deployer", d.deployer);
        vm.serializeUint(r, "block", d.block);
        vm.serializeUint(r, "inferenceChannelId", d.channelId);
        vm.serializeString(r, "transactions", "broadcast/DeployAgentAccountRHC.s.sol/46630/run-latest.json");
        vm.serializeString(r, "pool", p);
        r = vm.serializeString(r, "contracts", c);
        vm.writeJson(r, "deployments/46630.json");
    }

    /// After step 6: approve the CVM's measurement, read from its first quote.
    function approveMeasurement(address account, bytes32 measurement) external {
        _start(msg.sender);
        AgentAccount(account).setMeasurement(measurement, true);
        vm.stopBroadcast();
        require(AgentAccount(account).approvedMeasurement(measurement), "not approved");
    }
}
