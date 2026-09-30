// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentAccount} from "./AgentAccount.sol";

/// Deploys AgentAccounts wired to one set of Verifier, ReceiptVerifier, Assay, PoolManager and
/// USDG, so every account ever created can be read from one AccountCreated stream.
contract AgentAccountFactory {
    address public immutable verifier;
    address public immutable receiptVerifier;
    address public immutable assay;
    address public immutable poolManager;
    address public immutable usdg;
    uint256 public accountCount;

    event AccountCreated(address indexed account, address indexed owner, uint256 index);

    constructor(address verifier_, address receiptVerifier_, address assay_, address poolManager_, address usdg_) {
        verifier = verifier_;
        receiptVerifier = receiptVerifier_;
        assay = assay_;
        poolManager = poolManager_;
        usdg = usdg_;
    }

    /// Anyone may create an account for any owner; only that owner controls it.
    function createAccount(address owner) external returns (address account) {
        account = address(new AgentAccount(owner, verifier, receiptVerifier, assay, poolManager, usdg));
        emit AccountCreated(account, owner, accountCount++);
    }
}
