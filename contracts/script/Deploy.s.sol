// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Assay} from "../src/Assay.sol";
import {TestUSDG} from "../src/TestUSDG.sol";

/// forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast
///
/// Env:
///   VERIFIER             address of the already-deployed Stylus TDX verifier
///   APPROVED_MEASUREMENT bytes32 measurement from a real verify() call on a live
///                        quote (the sole allowlist entry; construction is immutable)
///   ATTESTATION_VALIDITY seconds a registered signer stays valid (default 1 days)
///   CHANNEL_TIMEOUT      seconds since the channel's last redeem (or openedAt, if
///                        none) before the agent can call requestClose (default 1 hours)
///   CHALLENGE_WINDOW     seconds after requestClose before finalizeClose can pay
///                        out the remainder (default 1 hours)
///   USDG_ADDRESS         optional address of a real USDG token already deployed on
///                        this chain (e.g. Paxos USDG on Arbitrum Seponia 421614,
///                        0xFFC95faa3d63Cde504a05B567C600B78C0b41892). When set, this
///                        script binds `usdg_` to it and deploys no TestUSDG. When
///                        unset, it deploys TestUSDG as before (see
///                        an internal security review, H-1).
///   MINT_TO              optional address to mint 1,000,000 testUSDG (6dp) to;
///                        ignored when USDG_ADDRESS is set (nothing to mint)
///   PRIVATE_KEY          optional (otherwise pass --private-key)
contract Deploy is Script {
    function run() external returns (address usdg, address assay) {
        address verifier = vm.envAddress("VERIFIER");
        bytes32 approvedMeasurement = vm.envBytes32("APPROVED_MEASUREMENT");
        uint64 attestationValidity = uint64(vm.envOr("ATTESTATION_VALIDITY", uint256(1 days)));
        uint64 channelTimeout = uint64(vm.envOr("CHANNEL_TIMEOUT", uint256(1 hours)));
        uint64 challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1 hours)));
        address existingUsdg = vm.envOr("USDG_ADDRESS", address(0));
        address mintTo = vm.envOr("MINT_TO", address(0));

        bytes32[] memory approved = new bytes32[](1);
        approved[0] = approvedMeasurement;

        uint256 key = vm.envOr("PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();

        if (existingUsdg != address(0)) {
            usdg = existingUsdg;
        } else {
            TestUSDG token = new TestUSDG();
            usdg = address(token);
            if (mintTo != address(0)) token.mint(mintTo, 1_000_000e6);
        }

        Assay a = new Assay(usdg, verifier, approved, attestationValidity, channelTimeout, challengeWindow);
        assay = address(a);

        vm.stopBroadcast();

        console.log("USDG:", usdg);
        console.log("Assay:", assay);
    }
}
