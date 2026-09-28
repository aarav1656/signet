// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Assay} from "../src/Assay.sol";
import {TestUSDG} from "../src/TestUSDG.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockReceiptVerifier} from "./mocks/MockReceiptVerifier.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

abstract contract AssayTestBase is Test {
    bytes32 internal constant APPROVED_MEASUREMENT = keccak256("phala-gateway-image-v1");
    /// A second, distinct measurement also on the allowlist -- lets a test prove
    /// redeem() requires the enclave signer's measurement to match the specific one
    /// the channel was pinned to at open(), not merely "is on the allowlist".
    bytes32 internal constant APPROVED_MEASUREMENT_2 = keccak256("phala-gateway-image-v1-rev2");
    bytes32 internal constant OTHER_MEASUREMENT = keccak256("some-other-image");
    /// Default requestedModelHash pinned by _openChannel()'s single-arg overload,
    /// matching fixtures/receipt_vectors.json's "requested-model" fixture.
    bytes32 internal constant REQUESTED_MODEL_HASH = keccak256("requested-model");

    uint64 internal constant ATTESTATION_VALIDITY = 1 days;
    uint64 internal constant CHANNEL_TIMEOUT = 1 hours;
    uint64 internal constant CHALLENGE_WINDOW = 1 hours;

    Assay internal assay;
    TestUSDG internal usdg;
    MockVerifier internal verifier;
    MockReceiptVerifier internal receiptVerifier;

    address internal provider = makeAddr("provider");

    // The channel's agent: signs payerSig with its own key, always available to it.
    uint256 internal agentPk = 0xA6E47;
    address internal agent;

    // The attested enclave signer registered via register(): signs enclaveSig,
    // exactly Phala's legacy personal_sign over "<requestHash>:<responseHash>".
    uint256 internal signerPk = 0xA11CE;
    address internal signerAddr;

    // The Ed25519 receipt-signing pubkey registered via registerReceiptKey(), used
    // by redeemWithReceipt() tests. A raw 32-byte value, not a secp256k1 key -- no
    // "private key" here, only the public key MockReceiptVerifier is told to accept
    // (real Ed25519 signing is exercised in receipt-verifier's own test suite, see
    // fixtures/receipt_vectors.json).
    bytes32 internal receiptPubkey = keccak256("receipt-pubkey-fixture");

    function setUp() public virtual {
        usdg = new TestUSDG();
        verifier = new MockVerifier();
        receiptVerifier = new MockReceiptVerifier();
        agent = vm.addr(agentPk);
        signerAddr = vm.addr(signerPk);

        bytes32[] memory approved = new bytes32[](2);
        approved[0] = APPROVED_MEASUREMENT;
        approved[1] = APPROVED_MEASUREMENT_2;
        assay = new Assay(
            address(usdg),
            address(verifier),
            address(receiptVerifier),
            approved,
            ATTESTATION_VALIDITY,
            CHANNEL_TIMEOUT,
            CHALLENGE_WINDOW
        );

        usdg.mint(agent, 1_000_000e6);
    }

    function _register(address signer_, bytes32 measurement_) internal returns (bytes32) {
        return _registerQuote(hex"1234", signer_, measurement_);
    }

    /// Same as `_register`, but with an explicit quote so a test can re-register
    /// with a distinct (fresh) quote instead of hitting the QuoteAlreadyUsed guard.
    /// refBlock is 0: MockVerifier ignores the nonce entirely (see MockVerifier.sol),
    /// so its exact value is irrelevant here; the real ArbSys-vs-blockhash nonce
    /// derivation is exercised directly in AssayArbSysNonce.t.sol.
    function _registerQuote(bytes memory quote, address signer_, bytes32 measurement_) internal returns (bytes32) {
        verifier.setNext(signer_, measurement_);
        (, bytes32 m) = assay.register(quote, 0);
        return m;
    }

    function _openChannel(uint128 amount) internal returns (uint256 channelId) {
        channelId = _openChannel(amount, APPROVED_MEASUREMENT);
    }

    function _openChannel(uint128 amount, bytes32 measurement_) internal returns (uint256 channelId) {
        channelId = _openChannel(amount, measurement_, bytes32(0));
    }

    /// For redeemWithReceipt() tests, which need a real (nonzero) pinned model.
    function _openChannel(uint128 amount, bytes32 measurement_, bytes32 requestedModelHash_)
        internal
        returns (uint256 channelId)
    {
        vm.startPrank(agent);
        usdg.approve(address(assay), amount);
        channelId = assay.openChannel(provider, amount, measurement_, requestedModelHash_);
        vm.stopPrank();
    }

    /// Registers `receiptPubkey` to `measurement_` via the mocked
    /// IAssayVerifier.verifyKeyset path (MockVerifier.setNextKeyset), exactly
    /// mirroring how _registerQuote() drives register() through MockVerifier.setNext.
    function _registerReceiptKey(bytes32 measurement_) internal {
        verifier.setNextKeyset(measurement_);
        // Distinct quote bytes from _register()'s default (hex"1234"): usedQuote is a
        // single mapping shared by register() and registerReceiptKey(), so an equal
        // quote would collide (QuoteAlreadyUsed) when a test registers both an ECDSA
        // signer and a receipt pubkey, exactly as two real quotes fetched from
        // Phala's two different attestation endpoints never collide in practice.
        assay.registerReceiptKey(hex"deadbeef", hex"5678", 0, receiptPubkey);
    }

    /// EIP-712 Voucher{channelId,cumulativeAmount,requestHash,responseHash}, signed
    /// by whoever holds `pk`. The contract requires this to recover to the
    /// channel's agent (payer authorization, not attestation evidence).
    function _signVoucher(
        uint256 pk,
        uint256 channelId,
        uint256 cumulativeAmount,
        bytes32 requestHash,
        bytes32 responseHash
    ) internal view returns (bytes memory) {
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// `bytes32` as 64 lowercase ASCII hex chars, no `0x` -- identical to
    /// Assay.sol's own private `_hex64`, and to Rust's `hex::encode`.
    function _hex64(bytes32 x) internal pure returns (bytes memory out) {
        bytes memory withPrefix = bytes(Strings.toHexString(uint256(x), 32));
        out = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            out[i] = withPrefix[i + 2];
        }
    }

    /// Phala's exact legacy receipt-signing digest (Dstack-TEE/private-ai-gateway,
    /// src/dstack.rs `sign_legacy_message` + `ethereum_personal_message_hash`,
    /// src/aggregator/service/helpers.rs `legacy_signature_text`): personal_sign
    /// over ASCII "<requestHash>:<responseHash>", both lowercase hex, no `0x`.
    function _enclaveDigest(bytes32 requestHash, bytes32 responseHash) internal pure returns (bytes32) {
        bytes memory text = bytes.concat(_hex64(requestHash), ":", _hex64(responseHash));
        return MessageHashUtils.toEthSignedMessageHash(text);
    }

    function _signEnclave(uint256 pk, bytes32 requestHash, bytes32 responseHash) internal returns (bytes memory) {
        bytes32 digest = _enclaveDigest(requestHash, responseHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Convenience: a matched pair signed by the channel's agent and the
    /// registered enclave signer, the ordinary two-signature redeem() call.
    function _redeemArgs(uint256 channelId, uint256 cumulativeAmount, bytes32 requestHash, bytes32 responseHash)
        internal
        returns (bytes memory payerSig, bytes memory enclaveSig)
    {
        payerSig = _signVoucher(agentPk, channelId, cumulativeAmount, requestHash, responseHash);
        enclaveSig = _signEnclave(signerPk, requestHash, responseHash);
    }

    /// Convenience: a payerSig for redeemWithReceipt(), whose responseHash must
    /// match the receiptResponseHash MockReceiptVerifier is configured to return
    /// (set separately via receiptVerifier.setNext(...) before calling this).
    function _receiptPayerSig(uint256 channelId, uint256 cumulativeAmount, bytes32 requestHash, bytes32 responseHash)
        internal
        view
        returns (bytes memory)
    {
        return _signVoucher(agentPk, channelId, cumulativeAmount, requestHash, responseHash);
    }
}
