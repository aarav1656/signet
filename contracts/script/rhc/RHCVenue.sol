// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
}

/// The RHC testnet venue: canonical Uniswap v4 (addresses from Uniswap's sdk-core
/// ROBINHOOD_ADDRESSES), the official TSLA Stock Token, and a hookless TSLA/testUSDG pool we
/// create and fund. Shared by the deploy script and the fork test so both run the same code.
library RHCVenue {
    uint256 internal constant CHAIN_ID = 46630;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    /// Runtime code hash of the canonical PoolManager, equal on RHC testnet and mainnet.
    bytes32 internal constant POOL_MANAGER_CODEHASH = 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    // v4-periphery src/libraries/Actions.sol
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant SETTLE_PAIR = 0x0d;

    uint256 internal constant Q96 = 1 << 96;

    function poolKey(address usdg, address stock) internal pure returns (PoolKey memory) {
        (address c0, address c1) = usdg < stock ? (usdg, stock) : (stock, usdg);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), FEE, TICK_SPACING, IHooks(address(0)));
    }

    /// sqrt(currency1 / currency0) in Q64.96 for a price of `usdgPerStock` raw USDG per 1e18
    /// raw stock (18-decimal Stock Tokens).
    function sqrtPriceX96(PoolKey memory k, address usdg, uint256 usdgPerStock) internal pure returns (uint160) {
        (uint256 a0, uint256 a1) = Currency.unwrap(k.currency0) == usdg ? (usdgPerStock, uint256(1e18)) : (uint256(1e18), usdgPerStock);
        return uint160(Math.sqrt(FullMath.mulDiv(a1, 1 << 192, a0)));
    }

    function fullRangeTicks() internal pure returns (int24 lower, int24 upper) {
        upper = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        lower = -upper;
    }

    /// Liquidity a full-range position gets from at most amount0 and amount1 at sqrtP
    /// (v4-periphery LiquidityAmounts.getLiquidityForAmounts), less 0.01% for rounding.
    function fullRangeLiquidity(uint160 sqrtP, uint256 amount0, uint256 amount1) internal pure returns (uint128) {
        (int24 lower, int24 upper) = fullRangeTicks();
        uint256 sa = TickMath.getSqrtPriceAtTick(lower);
        uint256 sb = TickMath.getSqrtPriceAtTick(upper);
        uint256 l0 = FullMath.mulDiv(amount0, FullMath.mulDiv(sqrtP, sb, Q96), sb - sqrtP);
        uint256 l1 = FullMath.mulDiv(amount1, Q96, sqrtP - sa);
        uint256 l = (l0 < l1 ? l0 : l1) * 9999 / 10000;
        require(l > 0 && l <= type(uint128).max, "liquidity");
        return uint128(l);
    }

    /// Mint a full-range position through the canonical PositionManager, paying via Permit2.
    function mintFullRange(PoolKey memory k, uint128 liquidity, uint256 amount0Max, uint256 amount1Max, address owner)
        internal
        returns (uint256 tokenId)
    {
        address c0 = Currency.unwrap(k.currency0);
        address c1 = Currency.unwrap(k.currency1);
        IERC20(c0).approve(PERMIT2, amount0Max);
        IERC20(c1).approve(PERMIT2, amount1Max);
        uint48 expiration = uint48(block.timestamp + 1 hours);
        IPermit2Approve(PERMIT2).approve(c0, POSITION_MANAGER, uint160(amount0Max), expiration);
        IPermit2Approve(PERMIT2).approve(c1, POSITION_MANAGER, uint160(amount1Max), expiration);

        (int24 lower, int24 upper) = fullRangeTicks();
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(k, lower, upper, uint256(liquidity), uint128(amount0Max), uint128(amount1Max), owner, bytes(""));
        params[1] = abi.encode(k.currency0, k.currency1);
        tokenId = IPositionManager(POSITION_MANAGER).nextTokenId();
        IPositionManager(POSITION_MANAGER).modifyLiquidities(
            abi.encode(abi.encodePacked(MINT_POSITION, SETTLE_PAIR), params), block.timestamp + 1 hours
        );
    }

    /// Initialise the pool at `usdgPerStock` and add full-range liquidity from `stockAmount`
    /// and the matching USDG. Returns the liquidity minted.
    function createAndFund(address usdg, address stock, uint256 usdgPerStock, uint256 stockAmount, address owner)
        internal
        returns (PoolKey memory k, uint128 liquidity)
    {
        k = poolKey(usdg, stock);
        uint160 sqrtP = sqrtPriceX96(k, usdg, usdgPerStock);
        IPoolManager(POOL_MANAGER).initialize(k, sqrtP);
        uint256 usdgAmount = FullMath.mulDivRoundingUp(stockAmount, usdgPerStock, 1e18) + 1;
        (uint256 a0, uint256 a1) = Currency.unwrap(k.currency0) == usdg ? (usdgAmount, stockAmount) : (stockAmount, usdgAmount);
        liquidity = fullRangeLiquidity(sqrtP, a0, a1);
        mintFullRange(k, liquidity, a0, a1, owner);
    }
}
