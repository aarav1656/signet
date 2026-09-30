// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Etched at 0x64 in unit tests. arbBlockHash follows ArbSys's shape: it reverts outside
/// [block.number - 256, block.number) and otherwise returns a hash, which a test can force to
/// zero to exercise the RR-2 check.
contract ArbSysDouble {
    mapping(uint256 => bool) public zeroed;
    mapping(uint256 => bool) public reverts;

    function setZero(uint256 n) external {
        zeroed[n] = true;
    }

    /// Makes arbBlockHash(n) revert even inside the window: Arbitrum's L2 block window and
    /// the EVM's blockhash() window differ, and only ArbSys's answer may count.
    function setRevert(uint256 n) external {
        reverts[n] = true;
    }

    function arbBlockHash(uint256 n) external view returns (bytes32) {
        require(n < block.number && n + 256 >= block.number && !reverts[n], "InvalidBlockNumber");
        return zeroed[n] ? bytes32(0) : keccak256(abi.encode("arb", n));
    }
}
