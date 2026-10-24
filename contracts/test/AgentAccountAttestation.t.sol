// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {ICollateralVerifier} from "../src/IAssayVerifier.sol";
import {AgentAccountTestBase} from "./AgentAccountTestBase.sol";
import {AgentQuoteVerifier} from "./mocks/AgentQuoteVerifier.sol";

/// A verifier build that ignores `maxStatus` and `minEvaluation` and reports a fixed status.
/// AgentAccount must hold its own ceiling against it.
contract IgnoringCollateralVerifier is ICollateralVerifier {
    uint8 public status;

    function setStatus(uint8 s) external {
        status = s;
    }

    function verifyWithCollateral(bytes calldata quote, bytes32, bytes calldata, uint8, uint32)
        external
        view
        returns (address signer, bytes32 measurement, uint8)
    {
        (signer, measurement,) = abi.decode(quote, (address, bytes32, bytes32));
        return (signer, measurement, status);
    }
}

/// Admission through Intel collateral: the owner's attestation policy, the ceiling that cannot
/// be raised to Revoked, the evaluation floor, and instant revocation when the policy changes.
contract AgentAccountAttestationTest is AgentAccountTestBase {
    event AgentRegistered(address indexed agent, bytes32 indexed measurement, uint64 expiry, uint256 epoch);
    event AgentTcbStatus(address indexed agent, uint8 status);
    event AttestationPolicySet(bool requireCollateral, uint8 maxTcbStatus, uint32 minTcbEvaluation);

    address internal agent2 = makeAddr("agent2");

    function _collateral(uint8 status, uint32 evaluation, bool authentic) internal pure returns (bytes memory) {
        return abi.encode(status, evaluation, authentic);
    }

    function _policy(bool require_, uint8 maxStatus, uint32 minEval) internal {
        vm.prank(owner);
        account.setAttestationPolicy(require_, maxStatus, minEval);
    }

    function _register(address signer, bytes memory collateral) internal returns (address, bytes32) {
        vm.roll(block.number + 1);
        bytes memory q = _quote(signer, AGENT_M);
        return account.registerAgentWithCollateral(q, block.number - 1, collateral);
    }

    // ------------------------------------------------------------------ admission

    function test_collateral_admitsAnUpToDatePlatform() public {
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, AGENT_M);
        vm.expectEmit(address(account));
        emit AgentRegistered(agent2, AGENT_M, uint64(block.timestamp + 86400), 2);
        vm.expectEmit(address(account));
        emit AgentTcbStatus(agent2, 0);
        (address signer, bytes32 m) = account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, true));
        assertEq(signer, agent2);
        assertEq(m, AGENT_M);
        assertEq(account.agent(), agent2);
        assertEq(account.agentMeasurement(), AGENT_M);
        assertTrue(account.usedQuote(keccak256(q)));
    }

    function test_collateral_defaultPolicyIsUpToDateOnlyAndOptional() public view {
        assertFalse(account.requireCollateral());
        assertEq(account.maxTcbStatus(), 0);
        assertEq(account.minTcbEvaluation(), 0);
    }

    function test_collateral_requiredPolicyClosesThePlainPath() public {
        _policy(true, 0, 0);
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, AGENT_M);
        vm.expectRevert(AgentAccount.CollateralRequired.selector);
        account.registerAgent(q, block.number - 1);
        assertEq(account.agent(), address(0));
        // the same quote goes through with collateral: the revert above left it unused
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, true));
        assertEq(account.agent(), agent2);
    }

    function test_collateral_plainPathStaysOpenWhenNotRequired() public {
        _policy(false, 0, 0);
        vm.roll(block.number + 1);
        account.registerAgent(_quote(agent2, AGENT_M), block.number - 1);
        assertEq(account.agent(), agent2);
    }

    // ------------------------------------------------------------------ the platform status ceiling

    function test_collateral_statusAboveTheCeilingIsRefused() public {
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, AGENT_M);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteVerifier.TcbStatusNotAccepted.selector, uint8(4), uint8(0)));
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(4, 20, true));
        assertEq(account.agent(), agentAddr);

        _policy(true, 4, 0);
        q = _quote(agent2, AGENT_M);
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(4, 20, true));
        assertEq(account.agent(), agent2);
    }

    function test_collateral_theOwnersCeilingAndFloorReachTheVerifier() public {
        _policy(true, 3, 21);
        _register(agent2, _collateral(1, 25, true));
        AgentQuoteVerifier v = AgentQuoteVerifier(address(account.verifier()));
        assertEq(v.lastMaxStatus(), 3);
        assertEq(v.lastMinEvaluation(), 21);
    }

    function test_collateral_revokedPlatformNeverPasses() public {
        // the setter cannot raise the ceiling to Revoked (6) ...
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.BadTcbStatus.selector, uint8(6)));
        account.setAttestationPolicy(true, 6, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.BadTcbStatus.selector, uint8(255)));
        account.setAttestationPolicy(true, 255, 0);
        // ... and at the highest ceiling it accepts, a Revoked report is still refused
        _policy(true, 5, 0);
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, AGENT_M);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteVerifier.TcbStatusNotAccepted.selector, uint8(6), uint8(5)));
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(6, 20, true));
        _register(agent2, _collateral(5, 20, true));
        assertEq(account.agent(), agent2);
    }

    function test_collateral_theAccountHoldsItsCeilingAgainstAVerifierThatIgnoresIt() public {
        IgnoringCollateralVerifier lax = new IgnoringCollateralVerifier();
        AgentAccount a = new AgentAccount(
            owner, address(lax), address(receiptVerifier), address(assay), address(manager), address(usdg)
        );
        vm.startPrank(owner);
        a.setMeasurement(AGENT_M, true);
        a.setAttestationPolicy(true, 1, 0);
        vm.stopPrank();
        bytes memory q = abi.encode(agent2, AGENT_M, a.attestNonce(block.number - 1));

        lax.setStatus(2);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TcbStatusTooHigh.selector, uint8(2), uint8(1)));
        a.registerAgentWithCollateral(q, block.number - 1, "");
        lax.setStatus(6);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.TcbStatusTooHigh.selector, uint8(6), uint8(1)));
        a.registerAgentWithCollateral(q, block.number - 1, "");
        assertEq(a.agent(), address(0));

        lax.setStatus(1); // exactly the ceiling
        a.registerAgentWithCollateral(q, block.number - 1, "");
        assertEq(a.agent(), agent2);
    }

    // ------------------------------------------------------------------ authenticity, freshness, admission rules

    function test_collateral_inauthenticDocumentsAdmitNobodyAndSpendNoQuote() public {
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, AGENT_M);
        vm.expectRevert(AgentQuoteVerifier.CollateralNotAuthentic.selector);
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, false));
        assertEq(account.agent(), agentAddr);
        assertFalse(account.usedQuote(keccak256(q)));
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, true));
        assertEq(account.agent(), agent2);
    }

    function test_collateral_documentsOlderThanTheFloorAreRefused() public {
        _policy(true, 0, 21);
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, AGENT_M);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteVerifier.CollateralEvalTooOld.selector, uint32(20), uint32(21)));
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, true));
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 21, true));
        assertEq(account.agent(), agent2);
    }

    function test_collateral_stillNeedsAnApprovedMeasurement() public {
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, OTHER_M);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.MeasurementNotApproved.selector, OTHER_M));
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, true));
        assertEq(account.agent(), agentAddr);
    }

    function test_collateral_theOwnerKeyCannotBeAdmitted() public {
        vm.roll(block.number + 1);
        bytes memory q = _quote(owner, AGENT_M);
        vm.expectRevert(AgentAccount.AgentIsOwner.selector);
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, true));
    }

    function test_collateral_aQuoteIsSingleUseAcrossBothPaths() public {
        vm.roll(block.number + 1);
        bytes memory q = _quote(agent2, AGENT_M);
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, true));
        vm.expectRevert(AgentAccount.QuoteAlreadyUsed.selector);
        account.registerAgentWithCollateral(q, block.number - 1, _collateral(0, 20, true));
        vm.expectRevert(AgentAccount.QuoteAlreadyUsed.selector);
        account.registerAgent(q, block.number - 1);
    }

    function test_collateral_theQuoteNonceBindingStillApplies() public {
        AgentAccount other = AgentAccount(factory.createAccount(owner));
        vm.prank(owner);
        other.setMeasurement(AGENT_M, true);
        vm.roll(block.number + 1);
        bytes memory forAccount = _quote(agent2, AGENT_M);
        vm.expectPartialRevert(AgentQuoteVerifier.NonceMismatch.selector);
        other.registerAgentWithCollateral(forAccount, block.number - 1, _collateral(0, 20, true));
    }

    // ------------------------------------------------------------------ policy changes revoke at once

    function test_policy_changeRevokesTheCurrentAgentAtOnce() public {
        assertEq(account.agent(), agentAddr);
        uint256 epoch = account.agentEpoch();
        vm.expectEmit(address(account));
        emit AttestationPolicySet(true, 0, 21);
        _policy(true, 0, 21);
        assertEq(account.agent(), address(0));
        assertEq(account.agentEpoch(), epoch + 1);
        assertEq(account.agentMeasurement(), bytes32(0));
        AgentAccount.Trade memory t = _buy(1e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agentAddr);
        vm.expectRevert(AgentAccount.NotAgent.selector);
        account.execute(t, r);
    }

    function test_policy_withNoAgentItJustSets() public {
        vm.prank(owner);
        account.revokeAgent();
        uint256 epoch = account.agentEpoch();
        _policy(true, 2, 7);
        assertEq(account.agentEpoch(), epoch); // nothing to revoke, no epoch burned
        assertTrue(account.requireCollateral());
        assertEq(account.maxTcbStatus(), 2);
        assertEq(account.minTcbEvaluation(), 7);
    }

    function test_policy_onlyTheOwnerSetsIt() public {
        vm.prank(agentAddr);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agentAddr));
        account.setAttestationPolicy(false, 5, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        account.setAttestationPolicy(false, 5, 0);
        assertEq(account.agent(), agentAddr); // a refused call revokes nothing
    }

    // ------------------------------------------------------------------ an agent admitted through collateral trades

    function test_collateral_admittedAgentTradesUnderTheSameLimits() public {
        _policy(true, 0, 20);
        _register(agent2, _collateral(0, 20, true));
        AgentAccount.Trade memory t = _buy(10e6);
        AgentAccount.Receipt memory r = _receipt();
        vm.prank(agent2);
        (uint256 id, uint256 out) = account.execute(t, r);
        assertEq(id, 1);
        assertGt(out, 0);
        AgentAccount.Trade memory big = _buy(USDG_PER_TRADE + 1);
        AgentAccount.Receipt memory r2 = _receipt();
        vm.prank(agent2);
        vm.expectRevert(abi.encodeWithSelector(AgentAccount.ExceedsPerTradeCap.selector, USDG_PER_TRADE + 1, USDG_PER_TRADE));
        account.execute(big, r2);
    }
}
