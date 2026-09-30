// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// A PoolManager test double that lies: it reports `reportedOut` owed to the swapper but
/// `take` delivers `short` less, and it reports `extraIn` more input owed than the trade's
/// amountIn. Used only to prove AgentAccount trusts balance deltas, not the pool's report.
contract ShortPoolManager {
    uint128 public reportedOut;
    uint128 public short;
    uint128 public extraIn;

    function configure(uint128 reportedOut_, uint128 short_, uint128 extraIn_) external {
        reportedOut = reportedOut_;
        short = short_;
        extraIn = extraIn_;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey memory, IPoolManager.SwapParams memory params, bytes calldata)
        external
        view
        returns (BalanceDelta)
    {
        int128 inDelta = int128(params.amountSpecified) - int128(extraIn);
        int128 outDelta = int128(reportedOut);
        return params.zeroForOne ? toBalanceDelta(inDelta, outDelta) : toBalanceDelta(outDelta, inDelta);
    }

    function sync(Currency) external {}

    function settle() external payable returns (uint256) {
        return 0;
    }

    function take(Currency currency, address to, uint256 amount) external {
        IERC20(Currency.unwrap(currency)).transfer(to, amount - short);
    }
}
