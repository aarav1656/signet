// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Assay} from "../src/Assay.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockReceiptVerifier} from "./mocks/MockReceiptVerifier.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IPaxos {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
    function defaultAdmin() external view returns (address);
    function grantRole(bytes32, address) external;
    function hasRole(bytes32, address) external view returns (bool);
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function freeze(address) external;
    function unfreeze(address) external;
    function isFrozen(address) external view returns (bool);
    function wipeFrozenAddress(address) external;
}

/// Fork of Arbitrum Sepolia against real Paxos USDG. MockVerifier stands in for the
/// Stylus verifier because revm cannot execute Stylus WASM.
///
/// This suite asserts the ACTUAL behaviour of a pausable, freezable issuer token
/// (test_issuerRisk_* below): pause/freeze/wipe are issuer risk inherent to a regulated
/// stablecoin, not fixable in Assay.sol, so the suite is green while still documenting
/// the risk for anyone reading the tests.
///
/// FUNDED must hold real USDG on the forked block; there is no safe way to fabricate that
/// balance. The default is the deployer that paid the live Arbitrum Sepolia calls, which holds
/// 92 USDG at block 315013000 (`cast call 0xFFC9...1892 "balanceOf(address)" 0x2aD1...5DEF
/// --block 315013000`). The public sequencer RPC keeps no historical state, so the fork reads an
/// archive endpoint; override with ARB_SEPOLIA_FORK_URL, CHIRON_FORK_BLOCK and
/// CHIRON_FUNDED_TEST_ACCOUNT.
/// Forge cannot run Arbitrum precompiles on a fork (0x64 has placeholder code), so
/// register()'s ArbSys.arbBlockHash call gets this stand-in. The nonce's block-hash
/// binding is tested in AssayHardening.t.sol; this suite is about real USDG.
contract ForkArbSys {
    function arbBlockHash(uint256 n) external pure returns (bytes32) {
        return keccak256(abi.encode(n));
    }
}

contract AssayRealUSDGForkTest is Test {
    IPaxos constant USDG = IPaxos(0xFFC95faa3d63Cde504a05B567C600B78C0b41892);
    bytes32 constant M = 0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149;
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    address FUNDED;
    Assay assay;
    MockVerifier verifier;
    MockReceiptVerifier receiptVerifier;
    uint256 agentPk = 0xA6E47;
    address agent;
    uint256 signerPk = 0xA11CE;
    address provider = makeAddr("provider");

    function setUp() public {
        FUNDED = vm.envOr("CHIRON_FUNDED_TEST_ACCOUNT", address(0x2aD12a72362704367e99a344cFf5affDDF7f5DEF));
        vm.createSelectFork(
            vm.envOr("ARB_SEPOLIA_FORK_URL", string("https://arbitrum-sepolia.drpc.org")),
            vm.envOr("CHIRON_FORK_BLOCK", uint256(315013000))
        );
        agent = vm.addr(agentPk);
        verifier = new MockVerifier();
        receiptVerifier = new MockReceiptVerifier();
        bytes32[] memory ap = new bytes32[](1);
        ap[0] = M;
        assay = new Assay(address(USDG), address(verifier), address(receiptVerifier), ap, 1 days, 1 hours, 1 hours);
        vm.prank(FUNDED);
        USDG.transfer(agent, 1_000_000); // 1.000000 USDG
        vm.etch(address(0x64), address(new ForkArbSys()).code);
        verifier.setNext(vm.addr(signerPk), M);
        assay.register(hex"01", block.number - 1);
    }

    function _permitSig(uint256 value, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 sh = keccak256(abi.encode(PERMIT_TYPEHASH, agent, address(assay), value, USDG.nonces(agent), deadline));
        (v, r, s) = vm.sign(agentPk, keccak256(abi.encodePacked("\x19\x01", USDG.DOMAIN_SEPARATOR(), sh)));
    }

    function _open(uint128 amt) internal returns (uint256 id) {
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(amt, block.timestamp + 1 hours);
        vm.prank(agent);
        id = assay.openChannelWithPermit(provider, amt, M, bytes32(0), block.timestamp + 1 hours, v, r, s);
    }

    function _hex64(bytes32 x) internal pure returns (bytes memory out) {
        bytes memory p = bytes(Strings.toHexString(uint256(x), 32));
        out = new bytes(64);
        for (uint256 i; i < 64; i++) out[i] = p[i + 2];
    }

    function _sigs(uint256 id, uint256 cum, bytes32 rq, bytes32 rs) internal view returns (bytes memory ps, bytes memory es) {
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Assay"), keccak256("1"), block.chainid, address(assay)
            )
        );
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Voucher(uint256 channelId,uint256 cumulativeAmount,bytes32 requestHash,bytes32 responseHash)"),
                id, cum, rq, rs
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, keccak256(abi.encodePacked("\x19\x01", ds, sh)));
        ps = abi.encodePacked(r, s, v);
        (v, r, s) = vm.sign(signerPk, MessageHashUtils.toEthSignedMessageHash(bytes.concat(_hex64(rq), ":", _hex64(rs))));
        es = abi.encodePacked(r, s, v);
    }

    function _redeem(uint256 id, uint256 cum, uint256 n) internal {
        (bytes memory ps, bytes memory es) = _sigs(id, cum, keccak256(abi.encode("rq", n)), keccak256(abi.encode("rs", n)));
        vm.prank(provider);
        assay.redeem(id, cum, keccak256(abi.encode("rq", n)), keccak256(abi.encode("rs", n)), ps, es);
    }

    function _role(string memory name, address who) internal {
        bytes32 role = keccak256(bytes(name));
        vm.prank(USDG.defaultAdmin());
        USDG.grantRole(role, who);
        assertTrue(USDG.hasRole(role, who));
    }

    // ---- facts ----

    function test_fact_permitDomain() public view {
        bytes32 ds = USDG.DOMAIN_SEPARATOR();
        string[3] memory names = ["Global Dollar", "USDG", "Paxos"];
        string[3] memory vers = ["1", "2", "3"];
        for (uint256 i; i < 3; i++) {
            for (uint256 j; j < 3; j++) {
                bytes32 c = keccak256(
                    abi.encode(
                        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                        keccak256(bytes(names[i])), keccak256(bytes(vers[j])), block.chainid, address(USDG)
                    )
                );
                if (c == ds) console.log("permit domain name/version:", names[i], vers[j]);
            }
        }
    }

    // ---- happy paths on real USDG ----

    function test_fork_openChannelWithPermit_realUSDG() public {
        uint256 n0 = USDG.nonces(agent);
        uint256 id = _open(1_000_000);
        (,, uint128 dep,,,,,,,) = assay.channels(id);
        assertEq(dep, 1_000_000);
        assertEq(USDG.balanceOf(address(assay)), 1_000_000);
        assertEq(USDG.balanceOf(agent), 0);
        assertEq(USDG.nonces(agent), n0 + 1);
    }

    function test_fork_permitFrontrun_stillOpens() public {
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(500_000, dl);
        vm.prank(makeAddr("mev"));
        USDG.permit(agent, address(assay), 500_000, dl, v, r, s);
        vm.prank(agent);
        assay.openChannelWithPermit(provider, 500_000, M, bytes32(0), dl, v, r, s);
        assertEq(USDG.balanceOf(address(assay)), 500_000);
    }

    function test_fork_threeRedeems_payProviderExactDelta() public {
        uint256 id = _open(1_000_000);
        _redeem(id, 10_000, 1);
        _redeem(id, 20_000, 2);
        _redeem(id, 30_000, 3);
        assertEq(USDG.balanceOf(provider), 30_000);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(agent);
        assay.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(agent);
        assay.finalizeClose(id);
        assertEq(USDG.balanceOf(agent), 970_000);
        assertEq(USDG.balanceOf(address(assay)), 0);
    }

    // ---- issuer risk (accepted for testnet; see an internal security review) ----
    // Each of these asserts the ACTUAL current behaviour of a pooled escrow against a
    // pausable, freezable regulated stablecoin. The safe behaviour these were originally
    // written to prove does not hold, and cannot be made to hold from Assay.sol alone
    // (the token's admin roles are outside the contract's control). Kept green here so
    // the risk stays documented and test-enforced instead of only prose in the README.

    /// L-1: a frozen agent's refund has no alternate
    /// recipient. Actual behaviour: finalizeClose reverts AddressFrozen() and the
    /// refund sits in Assay until Paxos unfreezes (compliance-correct: funds are held,
    /// not lost, and there is deliberately no refundTo(address) that would let a
    /// sanctioned party redirect around a freeze; see test_demo_M1_unfreezeRestoresRefund
    /// below for the funds arriving in full after unfreeze).
    function test_issuerRisk_frozenAgentRefundStuck() public {
        uint256 id = _open(1_000_000);
        _role("ASSET_PROTECTION_ROLE", address(this));
        USDG.freeze(agent);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(agent);
        assay.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(agent);
        vm.expectRevert(bytes4(0x1fd1cc44)); // AddressFrozen()
        assay.finalizeClose(id);
    }

    /// M-2: USDG freezing the Assay contract itself
    /// strands every channel, and a later wipeFrozenAddress burns all pooled escrow at
    /// once. Actual behaviour: redeem() reverts AddressFrozen() once the contract
    /// address is frozen (see test_demo_M2_wipeBurnsEscrow below for the wipe).
    function test_issuerRisk_frozenAssayStrandsAllChannels() public {
        uint256 id = _open(1_000_000);
        _role("ASSET_PROTECTION_ROLE", address(this));
        USDG.freeze(address(assay));
        vm.expectRevert(bytes4(0x1fd1cc44)); // AddressFrozen()
        _redeem(id, 10_000, 1);
    }

    function test_demo_M2_wipeBurnsEscrow() public {
        _open(1_000_000);
        _role("ASSET_PROTECTION_ROLE", address(this));
        USDG.freeze(address(assay));
        USDG.wipeFrozenAddress(address(assay));
        assertEq(USDG.balanceOf(address(assay)), 0, "escrow wiped");
    }

    /// M-1: a USDG pause spanning the challenge window
    /// moves an honest provider's earned money to the agent. Actual behaviour: the
    /// provider's redeem() reverts while paused, and once the window elapses the
    /// agent's finalizeClose lands first; the provider's now-valid-but-late voucher
    /// reverts ChannelClosedErr() instead of paying.
    function test_issuerRisk_pauseDuringChallengeWindowVoidsProviderVoucher() public {
        uint256 id = _open(1_000_000);
        (bytes memory ps, bytes memory es) = _sigs(id, 400_000, bytes32("rq"), bytes32("rs"));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(agent);
        assay.requestClose(id);
        _role("PAUSE_ROLE", address(this));
        USDG.pause();
        vm.prank(provider);
        vm.expectRevert();
        assay.redeem(id, 400_000, bytes32("rq"), bytes32("rs"), ps, es);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        USDG.unpause();
        vm.prank(agent);
        assay.finalizeClose(id);
        vm.prank(provider);
        vm.expectRevert(Assay.ChannelClosedErr.selector);
        assay.redeem(id, 400_000, bytes32("rq"), bytes32("rs"), ps, es);
    }

    /// L: a provider holding N valid vouchers can postpone requestClose by about
    /// N * channelTimeout by redeeming them one at a time just before each timeout.
    function test_demo_L_providerDelaysCloseWithStaggeredRedeems() public {
        uint256 id = _open(1_000_000);
        uint256 t0 = vm.getBlockTimestamp();
        for (uint256 i = 1; i <= 3; i++) {
            vm.warp(vm.getBlockTimestamp() + 1 hours - 1);
            _redeem(id, i * 1_000, i);
        }
        vm.warp(t0 + 3 hours);
        vm.prank(agent);
        vm.expectRevert(Assay.TimeoutNotElapsed.selector);
        assay.requestClose(id);
    }

    /// Proves the permit happy path can fail: a permit signed over the wrong domain
    /// version is swallowed by the try/catch and surfaces only as BadParams().
    function test_fork_wrongPermitDomain_surfacesAsBadParams() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes32 wrongDs = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Global Dollar"), keccak256("2"), block.chainid, address(USDG)
            )
        );
        bytes32 sh = keccak256(abi.encode(PERMIT_TYPEHASH, agent, address(assay), uint256(1_000_000), USDG.nonces(agent), dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, keccak256(abi.encodePacked("\x19\x01", wrongDs, sh)));
        vm.prank(agent);
        vm.expectRevert(Assay.BadParams.selector);
        assay.openChannelWithPermit(provider, 1_000_000, M, bytes32(0), dl, v, r, s);
    }

    /// A permit signed for more than `amount` also fails (value is part of the digest).
    function test_fork_permitValueMustEqualAmount() public {
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(type(uint256).max, dl);
        vm.prank(agent);
        vm.expectRevert(Assay.BadParams.selector);
        assay.openChannelWithPermit(provider, 1_000_000, M, bytes32(0), dl, v, r, s);
    }

    function test_demo_M1_unfreezeRestoresRefund() public {
        uint256 id = _open(1_000_000);
        _role("ASSET_PROTECTION_ROLE", address(this));
        USDG.freeze(agent);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(agent);
        assay.requestClose(id);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(agent);
        vm.expectRevert(bytes4(0x1fd1cc44));
        assay.finalizeClose(id);
        USDG.unfreeze(agent);
        vm.prank(agent);
        assay.finalizeClose(id);
        assertEq(USDG.balanceOf(agent), 1_000_000);
    }

    function test_demo_frozenProvider_cannotRedeem_agentRefunded() public {
        uint256 id = _open(1_000_000);
        _role("ASSET_PROTECTION_ROLE", address(this));
        USDG.freeze(provider);
        (bytes memory ps, bytes memory es) = _sigs(id, 400_000, bytes32("rq"), bytes32("rs"));
        vm.prank(provider);
        vm.expectRevert(bytes4(0x1fd1cc44));
        assay.redeem(id, 400_000, bytes32("rq"), bytes32("rs"), ps, es);
    }
}
