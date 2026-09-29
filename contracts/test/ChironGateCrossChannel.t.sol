// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ChironGate} from "../src/ChironGate.sol";
import {ChironGateTest} from "./ChironGate.t.sol";

contract CrossChannelTest is ChironGateTest {
    /// Same payer, two channels to the same provider. The payer acked (REQ1, RESP1) on A only.
    /// The provider must not get the same receipt paid on B.
    function test_X_oneReceiptCannotPayTwoChannelsOfSamePayer() public {
        (ChironGate.Pin memory pa, bytes32 cidA) = _openA(100e6);
        ChironGate.Pin memory pb = _pin(payoutA, bytes32(uint256(2)));
        bytes32 cidB = _open(_config(pb, address(usdg)), 100e6);

        _receipt(REQ1, RESP1);
        assertEq(_submit(_honest(pa, address(usdg), 30e6, REQ1, RESP1)), 30e6);

        // B's voucher is genuine (payer signed vouchers on B), but the ack presented is A's.
        Claim memory onB = _honest(pb, address(usdg), 30e6, REQ1, RESP1);
        onB.ack = _sign(authPk, _ackDigest(cidA, 30e6, REQ1, RESP1));
        _receipt(REQ1, RESP1);
        vm.expectRevert(ChironGate.BadCallAck.selector);
        _submit(onB);

        // Provider-signed ack for B.
        onB.ack = _sign(providerPk, _ackDigest(cidB, 30e6, REQ1, RESP1));
        vm.expectRevert(ChironGate.BadCallAck.selector);
        _submit(onB);

        assertEq(usdg.balanceOf(payoutA), 30e6);
        assertTrue(gate.consumed(cidA, keccak256(abi.encode(REQ1, RESP1))));
        assertFalse(gate.consumed(cidB, keccak256(abi.encode(REQ1, RESP1))));
    }
}
