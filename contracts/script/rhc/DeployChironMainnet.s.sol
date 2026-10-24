// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Assay} from "../../src/Assay.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {RHCVenue} from "./RHCVenue.sol";

/// Chiron on Robinhood Chain mainnet (4663): Assay on Paxos USDG, the AgentAccount factory, and one owner
/// account configured to trade TSLA against USDG in the existing hookless 0.3% pool on the canonical
/// PoolManager. The Stylus Verifier and ReceiptVerifier are deployed first (deploy-stylus.sh with
/// RHC_CHAIN_ID=4663) and passed in. No token or pool is created here; deposits are opt-in amounts.
///
///   VERIFIER=0x.. RECEIPT_VERIFIER=0x.. GATEWAY_MEASUREMENT=0x.. \
///   forge script script/rhc/DeployChironMainnet.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --private-key-path <file> --broadcast
contract DeployChironMainnet is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant CHAIN_ID = 4663;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // Paxos USDG, 6 decimals
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d; // Tesla Robinhood Token, 18 decimals
    // Deepest hookless TSLA/USDG pool on the canonical PoolManager (liquidity read 2026-10-02, about 370 USDG per TSLA).
    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant POOL_SPACING = 60;
    bytes32 internal constant POOL_ID = 0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e;

    uint128 internal constant USDG_PER_TRADE = 10e6;
    uint128 internal constant USDG_DAILY = 5e6;
    uint128 internal constant USDG_APPROVAL_ABOVE = 2e6;
    uint128 internal constant TSLA_PER_TRADE = 0.1e18;
    uint128 internal constant TSLA_DAILY = 0.05e18;
    uint128 internal constant TSLA_APPROVAL_ABOVE = 0.01e18;

    struct Deployment {
        address owner;
        address assay;
        address factory;
        address account;
        uint256 channelId;
        uint256 block;
    }

    function poolKey() public pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(TSLA), Currency.wrap(USDG), POOL_FEE, POOL_SPACING, IHooks(address(0)));
    }

    function run() external returns (Deployment memory d) {
        require(block.chainid == CHAIN_ID, "not Robinhood Chain mainnet (4663)");
        require(RHCVenue.POOL_MANAGER.codehash == RHCVenue.POOL_MANAGER_CODEHASH, "PoolManager code changed");
        PoolKey memory key = poolKey();
        require(PoolId.unwrap(key.toId()) == POOL_ID, "pool key does not hash to the pool id");
        (uint160 sqrtP,,,) = IPoolManager(RHCVenue.POOL_MANAGER).getSlot0(key.toId());
        require(sqrtP != 0 && IPoolManager(RHCVenue.POOL_MANAGER).getLiquidity(key.toId()) != 0, "TSLA/USDG pool is empty");

        address verifier = vm.envAddress("VERIFIER");
        address receiptVerifier = vm.envAddress("RECEIPT_VERIFIER");
        require(verifier.code.length != 0 && receiptVerifier.code.length != 0, "Stylus verifiers not deployed");
        bytes32 gatewayM = vm.envBytes32("GATEWAY_MEASUREMENT");
        bytes32 model = keccak256(bytes(vm.envOr("MODEL_ID", string("phala/qwen3.8-27b-uncensored"))));
        bytes32 agentM = vm.envOr("AGENT_MEASUREMENT", bytes32(0));
        uint256 accountUsdg = vm.envOr("ACCOUNT_USDG", uint256(0));
        uint128 channelDeposit = uint128(vm.envOr("CHANNEL_DEPOSIT", uint256(0)));
        address provider = vm.envOr("PROVIDER", address(0));

        vm.startBroadcast();
        (, d.owner,) = vm.readCallers();
        if (accountUsdg + channelDeposit != 0) require(IERC20(USDG).balanceOf(d.owner) >= accountUsdg + channelDeposit, "owner USDG");
        bytes32[] memory approved = new bytes32[](1);
        approved[0] = gatewayM;
        Assay assay = new Assay(USDG, verifier, receiptVerifier, approved, 86400, 3600, 3600);
        AgentAccountFactory factory = new AgentAccountFactory(verifier, receiptVerifier, address(assay), RHCVenue.POOL_MANAGER, USDG);
        AgentAccount account = AgentAccount(factory.createAccount(d.owner));
        account.setLimits(USDG, AgentAccount.Limits(true, USDG_PER_TRADE, USDG_DAILY, USDG_APPROVAL_ABOVE));
        account.setLimits(TSLA, AgentAccount.Limits(true, TSLA_PER_TRADE, TSLA_DAILY, TSLA_APPROVAL_ABOVE));
        account.setPool(key, true);
        account.setModel(model, [model, bytes32(0), bytes32(0), bytes32(0)], gatewayM);
        if (agentM != bytes32(0)) account.setMeasurement(agentM, true);
        if (accountUsdg + channelDeposit != 0) IERC20(USDG).transfer(address(account), accountUsdg + channelDeposit);
        if (channelDeposit != 0) d.channelId = account.openInferenceChannel(provider, channelDeposit);
        vm.stopBroadcast();

        d.assay = address(assay);
        d.factory = address(factory);
        d.account = address(account);
        d.block = block.number;

        require(address(assay.usdg()) == USDG && assay.approvedMeasurement(gatewayM), "Assay wiring");
        require(account.owner() == d.owner && address(account.assay()) == d.assay && account.usdg() == USDG, "account wiring");
        require(account.allowedPool(key.toId()) && account.requestedModelHash() == model, "account policy");
        require(account.CORPORATE_ACTION_COOLDOWN() == 1 days, "corporate-action guard");
        require(agentM == bytes32(0) || account.approvedMeasurement(agentM), "agent measurement");
        require(IERC20(USDG).balanceOf(address(account)) == accountUsdg, "account USDG");
        console.log("Assay", d.assay);
        console.log("AgentAccountFactory", d.factory);
        console.log("AgentAccount", d.account);
        _record(d, verifier, receiptVerifier, gatewayM);
    }

    function _record(Deployment memory d, address verifier, address receiptVerifier, bytes32 gatewayM) internal {
        string memory c = "contracts";
        vm.serializeAddress(c, "Verifier", verifier);
        vm.serializeAddress(c, "ReceiptVerifier", receiptVerifier);
        vm.serializeAddress(c, "Assay", d.assay);
        vm.serializeAddress(c, "AgentAccountFactory", d.factory);
        vm.serializeAddress(c, "AgentAccount", d.account);
        vm.serializeAddress(c, "PoolManager", RHCVenue.POOL_MANAGER);
        vm.serializeAddress(c, "USDG", USDG);
        c = vm.serializeAddress(c, "TSLA", TSLA);
        string memory r = "root";
        vm.serializeUint(r, "chainId", CHAIN_ID);
        vm.serializeAddress(r, "owner", d.owner);
        vm.serializeBytes32(r, "gatewayMeasurement", gatewayM);
        vm.serializeBytes32(r, "poolId", POOL_ID);
        vm.serializeUint(r, "block", d.block);
        r = vm.serializeString(r, "contracts", c);
        vm.writeJson(r, vm.envOr("OUT_JSON", string("deployments/4663.json")));
    }
}
