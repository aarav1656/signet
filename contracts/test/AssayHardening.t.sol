// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";

/// A stand-in for the real ArbSys precompile, installed at 0x64 via vm.etch so a test
/// can prove register()'s nonce derivation actually calls out to it when present, and
/// falls back to native blockhash() when it is not (see Assay.sol _refBlockHash()).
/// Storage lives at the etched address (0x64), not at this template's own address --
/// vm.etch copies code only -- so tests call `set` on FakeArbSys(0x64) after etching.
contract FakeArbSys {
    mapping(uint256 => bytes32) public hashFor;

    function set(uint256 blockNum, bytes32 h) external {
        hashFor[blockNum] = h;
    }

    /// Mirrors the real precompile's revert-on-unknown-block shape (Offchain Labs,
    /// nitro-precompile-interfaces ArbSys.sol: reverts unless the block is in window).
    function arbBlockHash(uint256 blockNum) external view returns (bytes32) {
        bytes32 h = hashFor[blockNum];
        require(h != bytes32(0), "FakeArbSys: block not set (simulates out-of-window revert)");
        return h;
    }
}

/// Item 4 hardening: tests that kill the five mutants the judging report's mutation
/// table found surviving (requestClose/finalizeClose NotAgent, CloseAlreadyRequested,
/// the dead :265 approvedMeasurement recheck -- now removed and replaced by the real
/// measurement-pinning check below -- and redeem()'s non-fork lastActivityAt write),
/// plus the new measurement-pinning (4a) and ArbSys-nonce (4c) behaviour.
contract AssayHardeningTest is AssayTestBase {
    address private constant ARBSYS = 0x0000000000000000000000000000000000000064;

    // ---- mutant: requestClose()'s `if (msg.sender != c.agent) revert NotAgent();` ----
    function test_attack_requestClose_byNonAgent_reverts() public {
        uint256 channelId = _openChannel(1_000e6);
        vm.warp(block.timestamp + CHANNEL_TIMEOUT + 1);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(Assay.NotAgent.selector);
        assay.requestClose(channelId);
    }

    // ---- mutant: finalizeClose()'s `if (msg.sender != c.agent) revert NotAgent();` ----
    function test_attack_finalizeClose_byNonAgent_reverts() public {
        uint256 channelId = _openChannel(1_000e6);
        vm.warp(block.timestamp + CHANNEL_TIMEOUT + 1);
        vm.prank(agent);
        assay.requestClose(channelId);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(Assay.NotAgent.selector);
        assay.finalizeClose(channelId);
    }

    // ---- mutant: requestClose()'s `if (c.closeRequestedAt != 0) revert CloseAlreadyRequested();` ----
    function test_attack_requestClose_twice_reverts() public {
        uint256 channelId = _openChannel(1_000e6);
        vm.warp(block.timestamp + CHANNEL_TIMEOUT + 1);
        vm.prank(agent);
        assay.requestClose(channelId);

        vm.prank(agent);
        vm.expectRevert(Assay.CloseAlreadyRequested.selector);
        assay.requestClose(channelId);
    }

    // ---- mutant: redeem()'s `c.lastActivityAt = uint64(block.timestamp);` (non-fork) ----
    // Deleting that write is invisible to every OTHER test in this suite because
    // requestClose()'s `lastActivity` falls back to openedAt when lastActivityAt is
    // still zero -- exactly what the mutant produces on a channel's FIRST redeem. This
    // test forces the fallback and the real write down two different, distinguishable
    // paths: redeem when timeout-from-openedAt has almost, but not quite, elapsed, then
    // check requestClose is still blocked shortly after -- true only if lastActivityAt
    // was really bumped to the redeem's own timestamp.
    function test_redeem_resetsLastActivityAt_delaysRequestCloseEligibility() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        vm.warp(block.timestamp + CHANNEL_TIMEOUT - 1);
        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);

        // Now CHANNEL_TIMEOUT+1 since openedAt, but only 2s since the redeem that just
        // happened. If lastActivityAt were never written (the mutant), requestClose would
        // wrongly succeed here because it would fall back to openedAt.
        vm.warp(block.timestamp + 2);
        vm.prank(agent);
        vm.expectRevert(Assay.TimeoutNotElapsed.selector);
        assay.requestClose(channelId);

        // Once CHANNEL_TIMEOUT has genuinely elapsed since the redeem, it succeeds.
        vm.warp(block.timestamp + CHANNEL_TIMEOUT);
        vm.prank(agent);
        assay.requestClose(channelId);
    }

    // ---- Item 4a: openChannel() must refuse a measurement not on the allowlist ----
    function test_openChannel_measurementNotOnAllowlist_reverts() public {
        vm.startPrank(agent);
        usdg.approve(address(assay), 1_000e6);
        vm.expectRevert(Assay.MeasurementNotApproved.selector);
        assay.openChannel(provider, 1_000e6, OTHER_MEASUREMENT, bytes32(0));
        vm.stopPrank();
    }

    // ---- Item 4a: redeem() must require the enclave signer's CURRENT measurement to
    // match the one the channel was pinned to at open(), not merely be on the
    // allowlist. Both measurements here are allowlisted; they are just different. ----
    function test_redeem_measurementMismatch_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT_2);
        uint256 channelId = _openChannel(1_000e6, APPROVED_MEASUREMENT);

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        vm.expectRevert(Assay.MeasurementMismatch.selector);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }

    // ---- Item 4a: matching measurements still redeem normally. ----
    function test_redeem_measurementMatch_succeeds() public {
        _register(signerAddr, APPROVED_MEASUREMENT_2);
        uint256 channelId = _openChannel(1_000e6, APPROVED_MEASUREMENT_2);

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 100e6);
    }

    // ---- Item 4c: on a chain with no ArbSys precompile deployed (this default forge
    // test chain: no bytecode at 0x64), nextRegisterNonce() falls back to native
    // blockhash(refBlock) instead of reverting or silently using zero. ----
    function test_nextRegisterNonce_fallsBackToBlockhash_whenNoArbSysPrecompile() public {
        vm.roll(10);
        bytes32 nonce = assay.nextRegisterNonce(provider, 5);
        bytes32 expected = keccak256(
            abi.encode(block.chainid, address(assay), provider, assay.registerNonce(provider), blockhash(5))
        );
        assertEq(nonce, expected);
    }

    // ---- Item 4c: when ArbSys IS present (etched at 0x64), its arbBlockHash() return
    // value drives the nonce, not blockhash(); and when ArbSys reverts for a refBlock
    // outside its window (the real precompile's shape), nextRegisterNonce() reverts
    // StaleRefBlock instead of falling back to blockhash(), which on Arbitrum reads
    // L1-numbered blocks and would open a second, longer window (re-review RR-2). ----
    function test_nextRegisterNonce_usesArbSysWhenPresent_revertsOnArbSysRevert() public {
        FakeArbSys template = new FakeArbSys();
        vm.etch(ARBSYS, address(template).code);
        FakeArbSys(ARBSYS).set(42, bytes32(uint256(0xABCDEF)));

        bytes32 nonceFromArbSys = assay.nextRegisterNonce(provider, 42);
        bytes32 expectedFromArbSys = keccak256(
            abi.encode(block.chainid, address(assay), provider, assay.registerNonce(provider), bytes32(uint256(0xABCDEF)))
        );
        assertEq(nonceFromArbSys, expectedFromArbSys, "must use ArbSys.arbBlockHash's value when the precompile answers");

        // refBlock 99 was never `set` on the fake, so arbBlockHash(99) reverts, exactly
        // like the real precompile does for an out-of-window block, even though native
        // blockhash(99) is nonzero here.
        assertTrue(blockhash(99) != bytes32(0));
        vm.expectRevert(Assay.StaleRefBlock.selector);
        assay.nextRegisterNonce(provider, 99);
    }

    // ---- RR-2: off Arbitrum, a refBlock whose blockhash() is zero (0, the current
    // block, or older than 256 blocks) reverts instead of forming a constant nonce. ----
    function test_nextRegisterNonce_zeroBlockhash_reverts() public {
        vm.roll(1_000);
        assertTrue(assay.nextRegisterNonce(provider, block.number - 1) != bytes32(0));
        vm.expectRevert(Assay.StaleRefBlock.selector);
        assay.nextRegisterNonce(provider, 0);
        vm.expectRevert(Assay.StaleRefBlock.selector);
        assay.nextRegisterNonce(provider, block.number - 300);
        vm.expectRevert(Assay.StaleRefBlock.selector);
        assay.nextRegisterNonce(provider, block.number);
    }

    // ---- Item 4c end to end: register() itself still succeeds through the ArbSys path
    // (MockVerifier ignores the nonce's exact value, but the call must not revert). ----
    function test_register_succeedsWithArbSysPrecompilePresent() public {
        FakeArbSys template = new FakeArbSys();
        vm.etch(ARBSYS, address(template).code);
        FakeArbSys(ARBSYS).set(7, bytes32(uint256(0x1234)));

        verifier.setNext(signerAddr, APPROVED_MEASUREMENT);
        assay.register(hex"1234", 7);
        (bytes32 measurement,) = assay.signers(signerAddr);
        assertEq(measurement, APPROVED_MEASUREMENT);
    }
}
