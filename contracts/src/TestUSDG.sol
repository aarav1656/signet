// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// Testnet-only fixture standing in for USDG on Arbitrum Sepolia, where no real USDG
/// deployment is documented in this product's own research
/// (which names only Arbitrum One `0x004B...9bbC` and Robinhood Chain `0x5fc5...1d168`).
/// 6 decimals to match real USDG. Open `mint` so any testnet counterparty can fund
/// itself; this is deliberate for a demo fixture and would never ship this way for a
/// real asset. Not an official USDG deployment, not redeemable, no relation to Paxos
/// or the Global Dollar Network.
contract TestUSDG is ERC20, ERC20Permit {
    constructor() ERC20("Test USDG (Assay testnet fixture)", "testUSDG") ERC20Permit("Test USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
