// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";

/// Deploys the factory for the AgentAccount that admits an agent through Intel collateral
/// (registerAgentWithCollateral, setAttestationPolicy, ApprovalTtlSet, ETHTransferFailed) on RHC
/// testnet 46630. It copies the wiring of an existing factory (Assay, ReceiptVerifier,
/// PoolManager, USDG) and swaps in the new Stylus Verifier, the build of verifier/ that exports
/// verifyWithCollateral. Existing accounts and factories are untouched; the new factory's accounts
/// are new addresses. Nothing in deployments/ is rewritten.
///
///   VERIFIER=<new Stylus verifier>  [SOURCE_FACTORY=<factory to copy>]  [ACCOUNT_OWNER=<address>] \
///   forge script script/rhc/DeployAttestedFactory.s.sol --rpc-url rhc_testnet --broadcast \
///     --private-key-path <file>            (or --account <keystore>)
///
/// SOURCE_FACTORY defaults to AgentAccountFactoryGuarded in deployments/46630.json. ACCOUNT_OWNER,
/// when set, also creates one account for that owner. Without --broadcast this is a simulation.
contract DeployAttestedFactory is Script {
    uint256 internal constant CHAIN_ID = 46630;

    function run() external returns (AgentAccountFactory factory, address account) {
        require(block.chainid == CHAIN_ID, "not RHC testnet");
        AgentAccountFactory source = AgentAccountFactory(
            vm.envOr(
                "SOURCE_FACTORY",
                vm.parseJsonAddress(vm.readFile("deployments/46630.json"), ".contracts.AgentAccountFactoryGuarded")
            )
        );
        address verifier = vm.envAddress("VERIFIER");
        require(address(source).code.length != 0, "source factory missing");
        require(verifier.code.length != 0, "VERIFIER has no code");
        require(verifier != source.verifier(), "VERIFIER is the verifier the source factory already uses");

        vm.startBroadcast();
        factory = new AgentAccountFactory(
            verifier, source.receiptVerifier(), source.assay(), source.poolManager(), source.usdg()
        );
        address accountOwner = vm.envOr("ACCOUNT_OWNER", address(0));
        if (accountOwner != address(0)) account = factory.createAccount(accountOwner);
        vm.stopBroadcast();

        require(factory.verifier() == verifier, "verifier wiring");
        require(factory.receiptVerifier() == source.receiptVerifier(), "receipt verifier wiring");
        require(factory.assay() == source.assay(), "assay wiring");
        require(factory.poolManager() == source.poolManager(), "pool manager wiring");
        require(factory.usdg() == source.usdg(), "usdg wiring");
        console.log("AgentAccountFactory (attested)", address(factory));
        if (account != address(0)) {
            AgentAccount a = AgentAccount(account);
            require(a.owner() == accountOwner, "account owner");
            require(address(a.verifier()) == verifier, "account verifier");
            require(!a.requireCollateral() && a.maxTcbStatus() == 0, "default policy");
            console.log("AgentAccount", account);
        }
    }
}
