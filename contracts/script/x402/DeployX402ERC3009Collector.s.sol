// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {ERC3009DepositCollector} from "../../test/vendor/x402/src/periphery/ERC3009DepositCollector.sol";

/// Reproduces x402-foundation/x402's canonical CREATE2 deployment of ERC3009DepositCollector
/// (contracts/evm/script/DeployBatchSettlement.s.sol, ERC3009_SALT): same init code, same salt,
/// same deterministic deployer. The collector's only constructor argument is the
/// x402BatchSettlement address, which is the same on every chain, so the address and the runtime
/// match the Arbitrum One deployment. On Arbitrum Sepolia the result is the official
/// ERC3009DepositCollector bytecode, redeployed by us at the same CREATE2 address.
///
///   FOUNDRY_PROFILE=x402 forge script script/x402/DeployX402ERC3009Collector.s.sol --rpc-url <rpc>
///   FOUNDRY_PROFILE=x402 forge script script/x402/DeployX402ERC3009Collector.s.sol --sig "compareWithArbitrumOne()"
contract DeployX402ERC3009Collector is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant ERC3009_SALT = 0x0000000000000000000000000000000000000000000000001800000007a95284;
    address constant BATCH = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
    address constant CANONICAL = 0x4020806089470a89826cB9fB1f4059150b550004;

    function _initCode() internal pure returns (bytes memory) {
        return abi.encodePacked(type(ERC3009DepositCollector).creationCode, abi.encode(BATCH));
    }

    function _computed() internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, ERC3009_SALT, keccak256(_initCode())))))
        );
    }

    function run() external {
        address addr = _computed();
        console2.log("computed address:", addr);
        require(addr == CANONICAL, "init code does not reproduce the canonical ERC3009DepositCollector address");
        require(BATCH.code.length > 0, "x402BatchSettlement not deployed on this chain");
        require(CREATE2_DEPLOYER.code.length > 0, "deterministic deployer missing on this chain");
        if (CANONICAL.code.length > 0) {
            console2.log("already deployed at the canonical address on chain", block.chainid);
            return;
        }
        vm.startBroadcast();
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(ERC3009_SALT, _initCode()));
        vm.stopBroadcast();
        require(ok && CANONICAL.code.length > 0, "CREATE2 deployment failed");
        console2.log("deployed at", CANONICAL, "on chain", block.chainid);
    }

    /// Byte-for-byte comparison of our runtime with the live Arbitrum One deployment.
    function compareWithArbitrumOne() external {
        vm.createSelectFork("https://arb1.arbitrum.io/rpc");
        bytes memory live = CANONICAL.code;
        require(live.length > 0, "no code at the canonical address on Arbitrum One");
        vm.etch(CANONICAL, "");
        vm.resetNonce(CANONICAL);
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(ERC3009_SALT, _initCode()));
        require(ok, "CREATE2 on fork failed");
        bytes memory ours = CANONICAL.code;
        console2.log("live runtime bytes", live.length);
        console2.log("our runtime bytes", ours.length);
        require(keccak256(live) == keccak256(ours), "MISMATCH with the live Arbitrum One runtime");
        console2.log("MATCH: runtime identical to the live Arbitrum One deployment");
    }
}
