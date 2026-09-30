// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITransferHook {
    function onTokenTransfer(address from, address to, uint256 amount) external;
}

/// 18-decimal stand-in for a Stock Token in unit tests (the fork test uses the real TSLA).
/// `hook`, when set, is called on every transfer: it models the ERC-777-style token the spec
/// says is never allowlisted, so the reentrancy guards can be exercised.
contract TestStockToken is ERC20 {
    address public hook;

    constructor() ERC20("Test Stock", "tSTOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address h) external {
        hook = h;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hook != address(0)) ITransferHook(hook).onTokenTransfer(from, to, value);
    }
}
