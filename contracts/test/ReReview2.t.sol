// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssayTestBase} from "./AssayTestBase.sol";
import {Assay} from "../src/Assay.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Final pre-redeploy review 2026-09-28. Each test asserts the safe property.
/// Run from a copy of contracts/: cp this file to test/ and
/// `forge test --match-contract ReReview2Test`.

/// A MetaMask-style EIP-7702 delegate: ERC-1271 accepts an ECDSA signature by the
/// delegating EOA itself (address(this) is the EOA under delegation).
contract SelfEcdsa1271Delegate is IERC1271 {
    function isValidSignature(bytes32 digest, bytes memory signature) external view returns (bytes4) {
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(digest, signature);
        return (e == ECDSA.RecoverError.NoError && r == address(this)) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

/// A plain EIP-7702 batch-executor delegate with no ERC-1271 support.
contract BatchOnlyDelegate {
    function execute(address to, bytes calldata data) external {
        require(msg.sender == address(this));
        (bool ok,) = to.call(data);
        require(ok);
    }
}

/// A smart account that opens its channel from its own constructor (a factory
/// "deploy and fund" flow), then signs vouchers through ERC-1271 like any Safe.
contract ConstructorOpener is IERC1271 {
    address public immutable owner;
    uint256 public immutable channelId;

    constructor(Assay assay, IERC20 usdg, address provider, uint128 amount, bytes32 measurement, address owner_) {
        owner = owner_;
        usdg.approve(address(assay), amount);
        channelId = assay.openChannel(provider, amount, measurement, bytes32(0));
    }

    function isValidSignature(bytes32 digest, bytes memory signature) external view returns (bytes4) {
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(digest, signature);
        return (e == ECDSA.RecoverError.NoError && r == owner) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract ReReview2Test is AssayTestBase {
    function _delegate(address eoa, address impl) internal {
        vm.etch(eoa, abi.encodePacked(hex"ef0100", impl));
    }

    // F-1 (Medium). An EOA that is already 7702-delegated when it opens is
    // (fixed) recorded as a contract at open by the earlier snapshot, so its plain ECDSA vouchers were then
    // checked ONLY through whatever delegate it points at when the provider
    // redeems. Revoking the delegation (a 7702 authorization to address(0))
    // voids every unredeemed voucher. This is exactly the RR-4b threat
    // ("an EOA cannot void vouchers it already signed") for the other ordering.
    function test_F1_delegatedAtOpen_revokesDelegation_providerMustStillBePaid() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        _delegate(agent, address(new SelfEcdsa1271Delegate()));
        uint256 id = _openChannel(1_000e6);
        assertTrue(agent.code.length != 0, "fixture: agent is 7702-delegated at open");

        bytes32 req = keccak256("served-req");
        bytes32 resp = keccak256("served-resp");
        // The voucher is an ordinary ECDSA signature by the agent's EOA key, and it
        // verifies at serve time (ECDSA and 1271 both accept it).
        (bytes memory payerSig, bytes memory enclaveSig) = _redeemArgs(id, 500e6, req, resp);

        vm.etch(agent, ""); // agent revokes its 7702 delegation after being served

        vm.prank(provider);
        assay.redeem(id, 500e6, req, resp, payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 500e6);
    }

    // F-1 (same root cause). An honest agent whose wallet delegate implements no
    // ERC-1271 (a batch executor) opens a channel it can never pay: its ECDSA
    // vouchers are valid signatures by c.agent, but only 1271 is consulted.
    function test_F1_delegatedAtOpen_delegateWithout1271_providerMustBePaid() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        _delegate(agent, address(new BatchOnlyDelegate()));
        uint256 id = _openChannel(1_000e6);

        bytes32 req = keccak256("served-req-2");
        bytes32 resp = keccak256("served-resp-2");
        (bytes memory payerSig, bytes memory enclaveSig) = _redeemArgs(id, 300e6, req, resp);

        vm.prank(provider);
        assay.redeem(id, 300e6, req, resp, payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 300e6);
    }

    // F-2 (Low). A contract agent that opens from its constructor has no code at
    // that moment. Assay reads the agent's code at redeem time, not at open, so its
    // owner-signed vouchers still redeem through ERC-1271.
    function test_F2_contractOpenedFromConstructor_providerMustBePaid() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 ownerPk = 0xB0B;
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        usdg.mint(predicted, 1_000e6);
        ConstructorOpener w = new ConstructorOpener(assay, IERC20(address(usdg)), provider, 1_000e6, APPROVED_MEASUREMENT, vm.addr(ownerPk));
        assertEq(address(w), predicted);
        uint256 id = w.channelId();

        bytes32 req = keccak256("served-req-3");
        bytes32 resp = keccak256("served-resp-3");
        bytes memory payerSig = _signVoucher(ownerPk, id, 400e6, req, resp);
        bytes memory enclaveSig = _signEnclave(signerPk, req, resp);

        vm.prank(provider);
        assay.redeem(id, 400e6, req, resp, payerSig, enclaveSig);
        assertEq(usdg.balanceOf(provider), 400e6);
    }

    // Guard for the recommended fix: accepting ECDSA-by-c.agent first must not let a
    // stranger's signature pay a contract agent's channel.
    function test_fixGuard_contractAgent_strangerEcdsaStillRejected() public {
        _register(signerAddr, APPROVED_MEASUREMENT);
        uint256 ownerPk = 0xB0B;
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        usdg.mint(predicted, 1_000e6);
        ConstructorOpener w = new ConstructorOpener(assay, IERC20(address(usdg)), provider, 1_000e6, APPROVED_MEASUREMENT, vm.addr(ownerPk));
        uint256 id = w.channelId();
        bytes32 req = keccak256("r");
        bytes32 resp = keccak256("s");
        bytes memory strangerSig = _signVoucher(0xBAD, id, 400e6, req, resp);
        bytes memory enclaveSig = _signEnclave(signerPk, req, resp);
        vm.prank(provider);
        vm.expectRevert(Assay.PayerNotAgent.selector);
        assay.redeem(id, 400e6, req, resp, strangerSig, enclaveSig);
    }
}
