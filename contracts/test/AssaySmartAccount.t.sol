// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";
import {ERC1271Wallet} from "./mocks/ERC1271Wallet.sol";

/// Item 6: a channel's agent can be a smart account (Safe, ZeroDev Kernel, or any
/// other ERC-1271 wallet), not only an EOA. `ERC1271Wallet` is a minimal, real
/// 1-of-1-owner ERC-1271 contract (test/mocks/ERC1271Wallet.sol) standing in for
/// one; Assay talks to it only through the standard isValidSignature interface a
/// real Safe/Kernel account also exposes, exactly as SignatureChecker does for
/// any ERC-1271 signer.
contract AssaySmartAccountTest is AssayTestBase {
    uint256 internal constant WALLET_OWNER_PK = 0xC0FFEE;
    address internal walletOwner;
    ERC1271Wallet internal wallet;

    function setUp() public override {
        super.setUp();
        walletOwner = vm.addr(WALLET_OWNER_PK);
        wallet = new ERC1271Wallet(walletOwner);
        usdg.mint(address(wallet), 1_000_000e6);
    }

    function _openChannelForWallet(uint128 amount) internal returns (uint256 channelId) {
        vm.startPrank(address(wallet));
        usdg.approve(address(assay), amount);
        channelId = assay.openChannel(provider, amount, APPROVED_MEASUREMENT, bytes32(0));
        vm.stopPrank();
    }

    /// A voucher signed by the wallet owner's key, validated through the
    /// wallet's isValidSignature, pays the provider exactly like an EOA agent's
    /// voucher would.
    function test_redeem_payerIsERC1271Wallet_ownerSignature_succeeds() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannelForWallet(1_000e6);

        (address a,,,,,,,,,) = assay.channels(channelId);
        assertEq(a, address(wallet), "channel agent must be the smart account, not its owner EOA");

        bytes memory payerSig = _signVoucher(WALLET_OWNER_PK, channelId, 100e6, keccak256("req-1"), keccak256("resp-1"));
        bytes memory enclaveSig = _signEnclave(signerPk, keccak256("req-1"), keccak256("resp-1"));

        vm.prank(provider);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("resp-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 100e6);
    }

    /// A voucher signed by any key other than the wallet's owner is rejected:
    /// ECDSA.recover(digest, sig) != wallet (never true for a contract address),
    /// and the wallet's own isValidSignature also rejects a non-owner signature.
    function test_redeem_payerIsERC1271Wallet_wrongSigner_reverts() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannelForWallet(1_000e6);

        uint256 randoPk = 0xBAD;
        bytes memory payerSig = _signVoucher(randoPk, channelId, 100e6, keccak256("req-1"), keccak256("resp-1"));
        bytes memory enclaveSig = _signEnclave(signerPk, keccak256("req-1"), keccak256("resp-1"));

        vm.prank(provider);
        vm.expectRevert(Assay.PayerNotAgent.selector);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("resp-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 0);
    }

    /// An ordinary EOA agent's voucher still works unchanged after the
    /// SignatureChecker swap (the ECDSA.recover fast path SignatureChecker
    /// tries first).
    function test_redeem_payerIsEOA_stillSucceeds() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 channelId = _openChannel(1_000e6);
        (bytes memory payerSig, bytes memory enclaveSig) =
            _redeemArgs(channelId, 100e6, keccak256("req-1"), keccak256("resp-1"));
        vm.prank(provider);
        assay.redeem(channelId, 100e6, keccak256("req-1"), keccak256("resp-1"), payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 100e6);
    }
}
