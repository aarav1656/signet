// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {x402BatchSettlement} from "../../test/vendor/x402/src/x402BatchSettlement.sol";

/// Reproduces x402-foundation/x402's canonical CREATE2 deployment of x402BatchSettlement
/// (contracts/evm/script/DeployBatchSettlement.s.sol, commit a9955ae5): same init code, same
/// salt, same deterministic deployer, so the same address on every chain. On Arbitrum Sepolia
/// the result is the official x402BatchSettlement bytecode, redeployed by us on Arbitrum
/// Sepolia at the same CREATE2 address.
///
/// Must run under the `x402` profile, which carries x402's own compiler settings:
///   FOUNDRY_PROFILE=x402 forge script script/x402/DeployX402BatchSettlement.s.sol
///       --rpc-url arbitrum_sepolia                      (simulation; add --broadcast to send)
///   FOUNDRY_PROFILE=x402 forge script script/x402/DeployX402BatchSettlement.s.sol
///       --sig "compareWithArbitrumOne()"                (byte-for-byte check against the live one)
///
/// run() asserts the computed address equals CANONICAL before it will broadcast anything.
contract DeployX402BatchSettlement is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 constant BATCH_SALT = 0x000000000000000000000000000000000000000000000000e000000005be885c;
    address constant CANONICAL = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;

    function predicted() public pure returns (address addr, bytes32 initCodeHash) {
        initCodeHash = keccak256(type(x402BatchSettlement).creationCode);
        addr = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, BATCH_SALT, initCodeHash))))
        );
    }

    function run() external {
        (address addr, bytes32 initCodeHash) = predicted();
        console2.log("init code hash:");
        console2.logBytes32(initCodeHash);
        console2.log("computed address:", addr);
        require(addr == CANONICAL, "init code does not reproduce the canonical x402BatchSettlement address");

        require(CREATE2_DEPLOYER.code.length > 0, "deterministic deployer missing on this chain");
        if (CANONICAL.code.length > 0) {
            console2.log("already deployed at the canonical address on chain", block.chainid);
            return;
        }

        vm.startBroadcast();
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(BATCH_SALT, type(x402BatchSettlement).creationCode));
        vm.stopBroadcast();
        require(ok && CANONICAL.code.length > 0, "CREATE2 deployment failed");
        console2.log("deployed at", CANONICAL, "on chain", block.chainid);
    }

    /// Forks Arbitrum One, keeps the live runtime at CANONICAL, clears the account, redeploys our
    /// init code through the same deployer and salt (so the constructor sees the same address and
    /// chain id, and every EIP-712 immutable is filled identically), then compares byte for byte.
    function compareWithArbitrumOne() external {
        vm.createSelectFork("arbitrum_one");
        bytes memory live = CANONICAL.code;
        require(live.length > 0, "no code at the canonical address on Arbitrum One");

        vm.etch(CANONICAL, "");
        vm.setNonceUnsafe(CANONICAL, 0);
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(BATCH_SALT, type(x402BatchSettlement).creationCode));
        require(ok, "local CREATE2 redeploy failed");
        bytes memory ours = CANONICAL.code;

        console2.log("chain id", block.chainid, "block", block.number);
        console2.log("live runtime bytes", live.length);
        console2.log("our runtime bytes", ours.length);
        uint256 n = live.length < ours.length ? live.length : ours.length;
        for (uint256 i; i < n; ++i) {
            if (live[i] != ours[i]) {
                console2.log("MISMATCH at byte offset", i);
                revert("runtime bytecode differs from the live Arbitrum One deployment");
            }
        }
        if (live.length != ours.length) {
            console2.log("MISMATCH at byte offset", n);
            revert("runtime bytecode length differs from the live Arbitrum One deployment");
        }
        console2.log("MATCH: runtime identical to the live Arbitrum One deployment");
        console2.logBytes32(keccak256(ours));
    }
}
