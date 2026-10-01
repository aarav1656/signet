// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {AgentAccount} from "../../src/AgentAccount.sol";
import {RHCVenue} from "./RHCVenue.sol";

/// Points an existing account at a second quote asset, with no contract change: the account
/// trades any token the owner gave limits and any hookless pool the owner allowed. This creates
/// the hookless 0.3% TSLA/<quote> pool on the canonical PoolManager at a price the owner sets,
/// funds it full range with TSLA taken out of the account, gives the account limits for the
/// quote token and allows the pool, and deposits the quote token into the account.
///
///   ACCOUNT=0x... QUOTE_TOKEN=0x... PRIVATE_KEY=... forge script script/rhc/AddUSDGVenue.s.sol \
///     --rpc-url rhc_testnet --broadcast
///
/// Re-running resumes a partly completed run. Use --gas-estimate-multiplier 150 on this chain.
/// Env (optional): QUOTE_PER_TSLA (raw quote units per 1e18 TSLA, default 250e6, a price the owner
///   chooses), TSLA_LIQUIDITY (default 0.2e18), ACCOUNT_QUOTE (default 5e6), QUOTE_PER_TRADE
///   (default 10e6), QUOTE_DAILY (default 5e6), QUOTE_APPROVAL_ABOVE (default 2e6).
/// The broadcaster must be the account's owner and hold the quote token for the liquidity and deposit.
contract AddUSDGVenue is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        require(block.chainid == RHCVenue.CHAIN_ID, "not RHC testnet");
        require(RHCVenue.POOL_MANAGER.codehash == RHCVenue.POOL_MANAGER_CODEHASH, "PoolManager code changed");
        AgentAccount account = AgentAccount(vm.envAddress("ACCOUNT"));
        address quote = vm.envAddress("QUOTE_TOKEN");
        uint256 quotePerTsla = vm.envOr("QUOTE_PER_TSLA", uint256(250e6));
        uint256 tslaLiquidity = vm.envOr("TSLA_LIQUIDITY", uint256(0.2e18));
        uint256 accountQuote = vm.envOr("ACCOUNT_QUOTE", uint256(5e6));
        uint128 perTrade = uint128(vm.envOr("QUOTE_PER_TRADE", uint256(10e6)));
        uint128 daily = uint128(vm.envOr("QUOTE_DAILY", uint256(5e6)));
        uint128 approvalAbove = uint128(vm.envOr("QUOTE_APPROVAL_ABOVE", uint256(2e6)));
        address owner = account.owner();
        require(quote.code.length != 0, "quote token has no code");
        require(IERC20(RHCVenue.TSLA).balanceOf(address(account)) >= tslaLiquidity, "account lacks TSLA");

        uint256 key = vm.envOr("PRIVATE_KEY", uint256(0));
        if (key != 0) {
            require(vm.addr(key) == owner, "PRIVATE_KEY is not the account owner");
            vm.startBroadcast(key);
        } else {
            vm.startBroadcast(owner);
        }

        // Each step is skipped when its result already stands, so a run cut short by one failed
        // transaction is resumed by running the script again.
        uint256 held = IERC20(RHCVenue.TSLA).balanceOf(owner);
        if (held < tslaLiquidity) account.withdraw(RHCVenue.TSLA, owner, tslaLiquidity - held);
        PoolKey memory pool = RHCVenue.poolKey(quote, RHCVenue.TSLA);
        IPoolManager pm = IPoolManager(RHCVenue.POOL_MANAGER);
        (uint160 sqrtP,,,) = pm.getSlot0(pool.toId());
        if (sqrtP == 0) {
            sqrtP = RHCVenue.sqrtPriceX96(pool, quote, quotePerTsla);
            pm.initialize(pool, sqrtP);
        }
        uint128 liquidity;
        if (pm.getLiquidity(pool.toId()) == 0) {
            uint256 quoteAmount = FullMath.mulDivRoundingUp(tslaLiquidity, quotePerTsla, 1e18) + 1;
            bool quoteIs0 = Currency.unwrap(pool.currency0) == quote;
            (uint256 a0, uint256 a1) = quoteIs0 ? (quoteAmount, tslaLiquidity) : (tslaLiquidity, quoteAmount);
            liquidity = RHCVenue.fullRangeLiquidity(sqrtP, a0, a1);
            RHCVenue.mintFullRange(pool, liquidity, a0, a1, owner);
        }
        account.setLimits(quote, AgentAccount.Limits(true, perTrade, daily, approvalAbove));
        account.setPool(pool, true);
        uint256 deposited = IERC20(quote).balanceOf(address(account));
        if (deposited < accountQuote) IERC20(quote).transfer(address(account), accountQuote - deposited);
        vm.stopBroadcast();

        liquidity = pm.getLiquidity(pool.toId());
        require(liquidity != 0, "pool state");
        (bool allowed, uint128 pt, uint128 d, uint128 aa) = account.limits(quote);
        require(allowed && pt == perTrade && d == daily && aa == approvalAbove, "limits");
        require(account.allowedPool(pool.toId()), "pool not allowed");
        require(IERC20(quote).balanceOf(address(account)) >= accountQuote, "quote deposit");
        console.log("pool", vm.toString(PoolId.unwrap(pool.toId())));
        console.log("liquidity", liquidity);
        console.log("account quote balance", IERC20(quote).balanceOf(address(account)));
    }
}
