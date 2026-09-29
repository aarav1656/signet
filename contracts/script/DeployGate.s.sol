// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ChironGate, IReceiptKeyRegistry} from "../src/ChironGate.sol";
import {IX402BatchSettlement} from "../src/IX402BatchSettlement.sol";

/// forge script script/DeployGate.s.sol --rpc-url arbitrum_sepolia   (add --broadcast to send)
///
/// Env (both optional):
///   X402   x402BatchSettlement address, default the canonical CREATE2 address. On Arbitrum
///          Sepolia that is the official x402BatchSettlement bytecode, redeployed by us on
///          Arbitrum Sepolia at the same CREATE2 address (script/x402/DeployX402BatchSettlement.s.sol).
///   ASSAY  the Assay receipt-key registry, default the Arbitrum Sepolia deployment.
///
/// Refuses to deploy unless X402 is the canonical address and holds code: a CREATE2 address
/// commits to keccak256(init code), so code there can only be the canonical x402 init code.
contract DeployGate is Script {
    address constant CANONICAL_X402 = 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003;
    address constant ASSAY_ARB_SEPOLIA = 0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC;

    function run() external returns (ChironGate gate) {
        address x402 = vm.envOr("X402", CANONICAL_X402);
        address assay = vm.envOr("ASSAY", ASSAY_ARB_SEPOLIA);
        require(x402 == CANONICAL_X402, "X402 is not the canonical x402BatchSettlement address");
        require(x402.code.length > 0, "x402BatchSettlement not deployed on this chain; run script/x402 first");
        require(assay.code.length > 0, "no Assay registry at ASSAY");

        vm.startBroadcast();
        gate = new ChironGate(IX402BatchSettlement(x402), IReceiptKeyRegistry(assay));
        vm.stopBroadcast();

        console.log("ChironGate:", address(gate));
        console.log("x402BatchSettlement:", x402);
        console.log("Assay registry:", assay);
        console.log("receipt verifier (read from Assay):", address(gate.receiptVerifier()));
    }
}
