// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";

contract AssayTest is AssayTestBase {
    function test_register_storesApprovedSigner() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        (bytes32 measurement, uint64 expiry) = assay.signers(signerAddr);
        assertEq(measurement, APPROVED_MEASUREMENT);
        assertEq(expiry, uint64(block.timestamp) + ATTESTATION_VALIDITY);
    }

    function test_openChannel_pullsDeposit() public {
        uint256 before = usdg.balanceOf(agent);
        uint256 channelId = _openChannel(1_000e6);
        assertEq(usdg.balanceOf(agent), before - 1_000e6);
        assertEq(usdg.balanceOf(address(assay)), 1_000e6);

        (address a, address p, uint128 deposit, uint128 paid,,,,,,) = assay.channels(channelId);
        assertEq(a, agent);
        assertEq(p, provider);
        assertEq(deposit, 1_000e6);
        assertEq(paid, 0);
    }

    function test_redeem_paysDeltaToProvider() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        (bytes memory payerSig1, bytes memory enclaveSig1) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("call-1"), payerSig1, enclaveSig1);
        assertEq(usdg.balanceOf(provider), 100e6);

        (bytes memory payerSig2, bytes memory enclaveSig2) =
            _redeemArgs(channelId, 250e6, keccak256("req-2"), keccak256("call-2"));
        vm.prank(provider);
        assay.redeem(channelId, 250e6, keccak256("req-2"), keccak256("call-2"), payerSig2, enclaveSig2);
        assertEq(usdg.balanceOf(provider), 250e6);

        (,, uint128 deposit, uint128 paid,,,,,,) = assay.channels(channelId);
        assertEq(deposit, 1_000e6);
        assertEq(paid, 250e6);
    }

    function test_closeChannel_refundsUnredeemedAfterTimeout() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);

        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 300e6, keccak256("req-1"), keccak256("call-1"));
        vm.prank(provider);
        assay.redeem(channelId, 300e6, keccak256("req-1"), keccak256("call-1"), payerSig, enclaveSig);

        vm.warp(block.timestamp + CHANNEL_TIMEOUT + 1);
        vm.prank(agent);
        assay.requestClose(channelId);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        uint256 agentBefore = usdg.balanceOf(agent);
        vm.prank(agent);
        assay.finalizeClose(channelId);
        assertEq(usdg.balanceOf(agent), agentBefore + 700e6);

        (,,, uint128 paid,,,, bool closed,,) = assay.channels(channelId);
        assertEq(paid, 300e6);
        assertTrue(closed);
    }

    function test_reRegister_extendsExpiry() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        (, uint64 expiry1) = assay.signers(signerAddr);

        vm.warp(block.timestamp + 1 hours);
        _registerQuote(hex"5678", signerAddr, APPROVED_MEASUREMENT);
        (, uint64 expiry2) = assay.signers(signerAddr);

        assertGt(expiry2, expiry1);
    }

    /// Proves the enclave-signature format itself, independent of Assay.sol:
    /// build Phala's exact "<requestHash>:<responseHash>" ASCII text (lowercase
    /// hex, no 0x, per Dstack-TEE/private-ai-gateway src/aggregator/service/
    /// helpers.rs `legacy_signature_text`), take its personal_sign digest (per
    /// src/dstack.rs `ethereum_personal_message_hash` + `sign_legacy_message`),
    /// and confirm recovery lands on the signing key. No complete real signed
    /// example with a portable private key exists in Phala's docs or public repo
    /// to hardcode as a fixture (checked; their own regression test at
    /// tests/http.rs `legacy_ecdsa_signature_uses_the_e2ee_signing_address` uses
    /// a fresh test-only key generated at test time, not an exported constant),
    /// so this reproduces their algorithm exactly rather than replaying a value
    /// that does not exist to replay.
    function test_enclaveDigest_matchesPhalaLegacyFormat_andRecovers() public {
        bytes32 requestHash = keccak256("some request body");
        bytes32 responseHash = keccak256("some response body");

        bytes memory text = bytes.concat(_hex64(requestHash), ":", _hex64(responseHash));
        assertEq(text.length, 129); // 64 + 1 + 64, matching one sha256-hex pair either side of ':'

        bytes32 expectedDigest =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n129", text));
        assertEq(_enclaveDigest(requestHash, responseHash), expectedDigest);

        bytes memory sig = _signEnclave(signerPk, requestHash, responseHash);
        (bytes32 r, bytes32 s, uint8 v) = (bytes32(0), bytes32(0), uint8(0));
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        address recovered = ecrecover(expectedDigest, v, r, s);
        assertEq(recovered, signerAddr);
    }
}
