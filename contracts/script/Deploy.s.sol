// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Assay} from "../src/Assay.sol";

/// forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast
///
/// Env:
///   VERIFIER              address of the already-deployed Stylus TDX verifier
///   RECEIPT_VERIFIER      address of the already-deployed Stylus Ed25519 receipt
///                         verifier (receipt-verifier/), checked only by
///                         redeemWithReceipt()
///   APPROVED_MEASUREMENT bytes32 measurement from a real verify() call on a live
///                        quote (the sole allowlist entry; construction is immutable)
///   ATTESTATION_VALIDITY seconds a registered signer stays valid (default 1 days)
///   CHANNEL_TIMEOUT      seconds since the channel's last redeem (or openedAt, if
///                        none) before the agent can call requestClose (default 1 hours)
///   CHALLENGE_WINDOW     seconds after requestClose before finalizeClose can pay
///                        out the remainder (default 1 hours)
///   USDG_ADDRESS         required address of the ERC-20 (with EIP-2612 permit, for
///                        openChannelWithPermit) this deploy binds `usdg_` to, e.g.
///                        real Paxos USDG on Arbitrum Sepolia (421614),
///                        0xFFC95faa3d63Cde504a05B567C600B78C0b41892. This script
///                        deploys no token of its own: an internal security review
///                        found the prior optional-env-var shape could silently fall
///                        back to a fresh, open-mint TestUSDG on a real deploy (see
///                        docs/SECURITY.md, H-1); making this required removes that
///                        failure mode entirely instead of relying on a post-deploy
///                        `usdg()` check to catch it.
///   PRIVATE_KEY          optional (otherwise pass --private-key)
contract Deploy is Script {
    function run() external returns (address usdg, address assay) {
        address verifier = vm.envAddress("VERIFIER");
        address receiptVerifier = vm.envAddress("RECEIPT_VERIFIER");
        bytes32 approvedMeasurement = vm.envBytes32("APPROVED_MEASUREMENT");
        uint64 attestationValidity = uint64(vm.envOr("ATTESTATION_VALIDITY", uint256(1 days)));
        uint64 channelTimeout = uint64(vm.envOr("CHANNEL_TIMEOUT", uint256(1 hours)));
        uint64 challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(1 hours)));
        usdg = vm.envAddress("USDG_ADDRESS");

        bytes32[] memory approved = new bytes32[](1);
        approved[0] = approvedMeasurement;

        uint256 key = vm.envOr("PRIVATE_KEY", uint256(0));
        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();

        Assay a =
            new Assay(usdg, verifier, receiptVerifier, approved, attestationValidity, channelTimeout, challengeWindow);
        assay = address(a);

        vm.stopBroadcast();

        console.log("USDG:", usdg);
        console.log("Assay:", assay);
    }
}
