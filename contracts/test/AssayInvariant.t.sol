// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {Assay} from "../src/Assay.sol";
import {TestUSDG} from "../src/TestUSDG.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockReceiptVerifier} from "./mocks/MockReceiptVerifier.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// Drives Assay through randomized, in-bounds open/redeem/close sequences. Every
/// action either reverts harmlessly (invalid channel index, nothing to redeem yet) or
/// moves real USDG, so the invariant below is exercised by genuine state transitions,
/// not vacuously by an empty run.
contract AssayHandler is Test {
    Assay public assay;
    TestUSDG public usdg;
    MockVerifier public verifier;
    bytes32 public immutable measurement;

    uint256 internal constant AGENT_PK = 0xA6E47;
    uint256 internal constant SIGNER_PK = 0xA11CE;
    address public agent;
    address public signerAddr;
    address public provider = address(0xBEEF01);

    uint256 public opens;
    uint256 public redeems;
    uint256 public closes;
    uint256 internal receiptNonce;

    constructor(Assay assay_, TestUSDG usdg_, MockVerifier verifier_, bytes32 measurement_) {
        assay = assay_;
        usdg = usdg_;
        verifier = verifier_;
        measurement = measurement_;
        agent = vm.addr(AGENT_PK);
        signerAddr = vm.addr(SIGNER_PK);
        usdg.mint(agent, 100_000_000e6);
        verifier.setNext(signerAddr, measurement);
        assay.register(hex"01", block.number - 1);
    }

    function open(uint128 amountSeed) external {
        uint128 amount = uint128(bound(amountSeed, 1, 1_000_000e6));
        vm.startPrank(agent);
        usdg.approve(address(assay), amount);
        assay.openChannel(provider, amount, measurement, bytes32(0));
        vm.stopPrank();
        opens++;
    }

    function redeem(uint256 channelSeed, uint256 bumpSeed) external {
        uint256 n = assay.channelCount();
        if (n == 0) return;
        uint256 id = channelSeed % n;
        (,, uint128 deposit, uint128 paid,,,, bool closed,,,) = assay.channels(id);
        if (closed || paid >= deposit) return;

        uint256 bump = bound(bumpSeed, 1, uint256(deposit - paid));
        uint256 cum = uint256(paid) + bump;
        receiptNonce++;
        bytes32 rq = keccak256(abi.encode("rq", receiptNonce));
        bytes32 rs = keccak256(abi.encode("rs", receiptNonce));

        bytes memory payerSig = _signVoucher(id, cum, rq, rs);
        bytes memory enclaveSig = _signEnclave(rq, rs);
        vm.prank(provider);
        assay.redeem(id, cum, rq, rs, payerSig, enclaveSig);
        redeems++;
    }

    function close(uint256 channelSeed) external {
        uint256 n = assay.channelCount();
        if (n == 0) return;
        uint256 id = channelSeed % n;
        (,,,, uint64 openedAt, uint64 lastActivityAt, uint64 closeRequestedAt, bool closed,,,) = assay.channels(id);
        if (closed) return;

        if (closeRequestedAt == 0) {
            uint64 lastActivity = lastActivityAt != 0 ? lastActivityAt : openedAt;
            uint64 timeout = assay.channelTimeout();
            if (block.timestamp < uint256(lastActivity) + timeout) {
                vm.warp(uint256(lastActivity) + timeout + 1);
            }
            vm.prank(agent);
            assay.requestClose(id);
        } else {
            uint64 window = assay.challengeWindow();
            if (block.timestamp < uint256(closeRequestedAt) + window) {
                vm.warp(uint256(closeRequestedAt) + window + 1);
            }
            vm.prank(agent);
            assay.finalizeClose(id);
            closes++;
        }
    }

    // ---- signing helpers, matching AssayTestBase's exactly ----

    function _hex64(bytes32 x) internal pure returns (bytes memory out) {
        bytes memory withPrefix = bytes(Strings.toHexString(uint256(x), 32));
        out = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            out[i] = withPrefix[i + 2];
        }
    }

    function _signVoucher(uint256 channelId, uint256 cumulativeAmount, bytes32 requestHash, bytes32 responseHash)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typeHash =
            keccak256("Voucher(uint256 channelId,uint256 cumulativeAmount,bytes32 requestHash,bytes32 responseHash)");
        bytes32 structHash = keccak256(abi.encode(typeHash, channelId, cumulativeAmount, requestHash, responseHash));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Assay")),
                keccak256(bytes("1")),
                block.chainid,
                address(assay)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signEnclave(bytes32 requestHash, bytes32 responseHash) internal returns (bytes memory) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            bytes.concat(_hex64(requestHash), ":", _hex64(responseHash))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, digest);
        return abi.encodePacked(r, s, v);
    }
}

/// Item 4e stateful invariant: the escrow the contract actually holds always equals
/// the sum, over every channel ever opened, of (deposit - paid). This is exactly
/// "deposit minus paid minus refunded": a refund at finalizeClose sets deposit = paid
/// for that channel (see Assay.sol finalizeClose()), so a refunded channel's own term
/// collapses to zero and stops contributing, which is what makes this hold as pure
/// conservation rather than needing a separate refunded-tracking ledger.
contract AssayInvariantTest is StdInvariant, Test {
    bytes32 internal constant MEASUREMENT = keccak256("phala-gateway-image-v1");
    uint64 internal constant ATTESTATION_VALIDITY = 1 days;
    uint64 internal constant CHANNEL_TIMEOUT = 1 hours;
    uint64 internal constant CHALLENGE_WINDOW = 1 hours;

    Assay internal assay;
    TestUSDG internal usdg;
    MockVerifier internal verifier;
    AssayHandler internal handler;

    function setUp() public {
        vm.roll(100);
        usdg = new TestUSDG();
        verifier = new MockVerifier();
        MockReceiptVerifier receiptVerifier = new MockReceiptVerifier();
        bytes32[] memory approved = new bytes32[](1);
        approved[0] = MEASUREMENT;
        assay = new Assay(
            address(usdg),
            address(verifier),
            address(receiptVerifier),
            approved,
            ATTESTATION_VALIDITY,
            CHANNEL_TIMEOUT,
            CHALLENGE_WINDOW
        );

        handler = new AssayHandler(assay, usdg, verifier, MEASUREMENT);
        targetContract(address(handler));
    }

    /// Foundry checks every invariant once immediately after setUp(), before any
    /// handler call has run, so a companion "did anything happen" invariant would
    /// fail at that t=0 baseline regardless of the campaign that follows -- it cannot
    /// be expressed as a second invariant function here. Non-vacuousness instead comes
    /// from `forge test -vv`'s per-suite call summary table (AssayHandler open / redeem
    /// / close call and revert counts), which the run report below quotes verbatim.
    function invariant_escrowEqualsSumOfDepositMinusPaid() public view {
        uint256 n = assay.channelCount();
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            (,, uint128 deposit, uint128 paid,,,,,,,) = assay.channels(i);
            total += uint256(deposit) - uint256(paid);
        }
        assertEq(usdg.balanceOf(address(assay)), total, "assay's USDG balance must equal sum(deposit - paid) across all channels");
    }
}
