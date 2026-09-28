// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";
import {IAssayVerifier} from "../src/IAssayVerifier.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Re-review 2026-09-28 regressions. Each test asserted the safe property and failed
/// against Assay.sol at 6e35b45 (RR-1, RR-2, RR-3, RR-4b), or pins an accepted,
/// disclosed behaviour (RR-4 for ERC-1271 agents).

/// Stands in for the Stylus verifier but, unlike MockVerifier, enforces the nonce the
/// way verifier/src/lib.rs:765 does: the quote only verifies for the one nonce it was
/// "fetched" with.
contract NonceBoundVerifier is IAssayVerifier {
    bytes32 public quotedNonce;
    address public signer;
    bytes32 public measurement;

    function fetchQuote(bytes32 nonce, address signer_, bytes32 measurement_) external {
        quotedNonce = nonce;
        signer = signer_;
        measurement = measurement_;
    }

    function verify(bytes calldata, bytes32 nonce) external view returns (address, bytes32) {
        require(nonce == quotedNonce, "NonceMismatch");
        return (signer, measurement);
    }

    function verifyKeyset(bytes calldata, bytes calldata, bytes32 nonce, bytes32) external view returns (bytes32) {
        require(nonce == quotedNonce, "NonceMismatch");
        return measurement;
    }
}

/// ArbSys stand-in that reverts for every block number, exactly what Arbitrum Sepolia
/// returned live at block 313636375 for arbBlockHash(0) and arbBlockHash(N-300):
/// `InvalidBlockNumber(requested, current)`.
contract RevertingArbSys {
    function arbBlockHash(uint256) external pure returns (bytes32) {
        revert("InvalidBlockNumber");
    }
}

/// A 1-of-1 smart account whose owner can be rotated, like every Safe/Kernel.
contract RotatableWallet is IERC1271 {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function rotate(address newOwner) external {
        require(msg.sender == owner);
        owner = newOwner;
    }

    function isValidSignature(bytes32 digest, bytes memory signature) external view returns (bytes4) {
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(digest, signature);
        return (e == ECDSA.RecoverError.NoError && r == owner) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract ReReviewTest is AssayTestBase {
    address internal constant ARBSYS = 0x0000000000000000000000000000000000000064;

    // RR-1 (High). A channel opened with a pinned model can still be paid through the
    // legacy redeem(), which never reads requestedModelHash. The provider picks the
    // path, so the model-swap refusal binds only a provider who volunteers for it.
    function test_RR1_modelPinnedChannel_legacyRedeemMustRevert() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 id = _openChannel(1_000e6, APPROVED_MEASUREMENT, REQUESTED_MODEL_HASH);
        bytes32 req = keccak256("req-swapped-model");
        bytes32 resp = keccak256("resp-from-cheaper-model");
        (bytes memory payerSig, bytes memory enclaveSig) = _redeemArgs(id, 100e6, req, resp);

        vm.prank(provider);
        vm.expectRevert(); // safe behaviour: a pinned channel refuses the model-blind path
        assay.redeem(id, 100e6, req, resp, payerSig, enclaveSig);
    }

    // RR-2 (Medium). _refBlockHash returns 0 whenever refBlock is outside both windows
    // (ArbSys reverts, native blockhash returns 0), so nextRegisterNonce(p, 0) is a
    // constant that can be computed, and a Phala quote fetched for it, at any time.
    // A quote fetched a year earlier still registers.
    function test_RR2_zeroRefBlockHash_quoteStockpiledForAYear_mustNotRegister() public {
        vm.etch(ARBSYS, address(new RevertingArbSys()).code);
        NonceBoundVerifier nv = new NonceBoundVerifier();
        bytes32[] memory approved = new bytes32[](1);
        approved[0] = APPROVED_MEASUREMENT;
        Assay a = new Assay(
            address(usdg), address(nv), address(receiptVerifier), approved, ATTESTATION_VALIDITY, CHANNEL_TIMEOUT, CHALLENGE_WINDOW
        );
        address stockpiler = makeAddr("stockpiler");

        vm.roll(1_000);
        // Computable offline, before any block that matters exists.
        bytes32 nonceAtFetch = keccak256(abi.encode(block.chainid, address(a), stockpiler, uint256(0), bytes32(0)));
        nv.fetchQuote(nonceAtFetch, signerAddr, APPROVED_MEASUREMENT);

        vm.roll(block.number + 100_000_000);
        vm.warp(block.timestamp + 365 days);

        vm.prank(stockpiler);
        vm.expectRevert(); // safe behaviour: a zero refBlock hash must never form a nonce
        a.register(hex"c0ffee", 0);
    }

    // RR-3 (Medium). The receipt path's replay key is (provider, requestHash,
    // responseHash), but the receipt only binds responseHash; requestHash is free.
    // One genuine Phala receipt pays twice on the same channel, contradicting the
    // NatSpec at Assay.sol:431-434 ("a receipt cannot be paid twice").
    function test_RR3_sameReceiptPaysTwiceWithDifferentRequestHash_mustRevert() public {
        _registerReceiptKey(APPROVED_MEASUREMENT);
        uint256 id = _openChannel(1_000e6, APPROVED_MEASUREMENT, REQUESTED_MODEL_HASH);
        bytes32 resp = keccak256("one-genuine-response");
        // The receipt a real verifier would return: its request.received hash is req-A.
        receiptVerifier.setNext(true, REQUESTED_MODEL_HASH, REQUESTED_MODEL_HASH, keccak256("req-A"), resp);
        bytes memory receipt = hex"7b7d";
        bytes memory sig = new bytes(64);

        vm.startPrank(provider);
        assay.redeemWithReceipt(
            id, 100e6, keccak256("req-A"), resp, _receiptPayerSig(id, 100e6, keccak256("req-A"), resp), receiptPubkey, receipt, sig
        );
        bytes memory payer2 = _receiptPayerSig(id, 200e6, keccak256("req-B"), resp);
        vm.expectRevert(Assay.RequestHashMismatch.selector);
        assay.redeemWithReceipt(id, 200e6, keccak256("req-B"), resp, payer2, receiptPubkey, receipt, sig);
        vm.stopPrank();
    }

    // RR-4 (Medium, accepted and disclosed). ERC-1271 validity is evaluated at redeem
    // time. A smart-account agent that rotates its owner after being served voids the
    // vouchers it has not had redeemed. Assay.sol _payerSigValid() documents this;
    // providers serving a contract agent redeem each voucher as it arrives. This test
    // pins the behaviour so a change to it is a deliberate one.
    function test_RR4_erc1271AgentRotatesOwner_voidsUnredeemedVouchers() public {
        uint256 ownerPk = 0xC0FFEE;
        RotatableWallet w = new RotatableWallet(vm.addr(ownerPk));
        usdg.mint(address(w), 1_000e6);
        _register(signerAddr, APPROVED_MEASUREMENT);
        vm.startPrank(address(w));
        usdg.approve(address(assay), 1_000e6);
        uint256 id = assay.openChannel(provider, 1_000e6, APPROVED_MEASUREMENT, bytes32(0));
        vm.stopPrank();

        bytes32 req = keccak256("served-req");
        bytes32 resp = keccak256("served-resp");
        bytes memory payerSig = _signVoucher(ownerPk, id, 500e6, req, resp);
        bytes memory enclaveSig = _signEnclave(signerPk, req, resp);

        vm.prank(vm.addr(ownerPk));
        w.rotate(makeAddr("new-owner"));

        vm.prank(provider);
        vm.expectRevert(Assay.PayerNotAgent.selector);
        assay.redeem(id, 500e6, req, resp, payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }

    // RR-4b. OZ 5.7 SignatureChecker picks ECDSA XOR ERC-1271 by signer.code.length
    // (SignatureChecker.sol isValidSignatureNow), contrary to Assay.sol:392-396's
    // "tries ECDSA first, then falls back". An EOA agent that gains code after signing
    // (EIP-7702 delegation, modelled here with vm.etch) voids every voucher it issued.
    function test_RR4b_eoaAgentGainsCodeAfterSigning_providerMustStillBePaid() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 id = _openChannel(1_000e6);
        bytes32 req = keccak256("served-req");
        bytes32 resp = keccak256("served-resp");
        (bytes memory payerSig, bytes memory enclaveSig) = _redeemArgs(id, 500e6, req, resp);

        vm.etch(agent, address(new RotatableWallet(makeAddr("delegate-owner"))).code);

        vm.prank(provider);
        assay.redeem(id, 500e6, req, resp, payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 500e6);
    }
}
