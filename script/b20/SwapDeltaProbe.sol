// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title SwapDeltaProbe
 * @notice Reads what ONE swap actually took and actually gave.
 *
 * WHY THIS EXISTS. QuoterV2 does not return the input an exact-input swap
 * consumed - only the output, the ending price, and the ticks crossed. So
 * "77.6% of the input was spent" could not be read off the call it described.
 * The measurement tool bisected for the boundary instead, which is a good
 * ESTIMATE from many simulations of DIFFERENT amounts, and is not the same
 * thing as measuring the swap in front of you.
 *
 * WHAT THIS DOES INSTEAD. The pool's own swap() returns both signed deltas:
 * the amount the payer owes and the amount the recipient receives, for that
 * one swap. This contract calls it and hands both back.
 *
 * HOW IT IS USED, AND NOTHING IS DEPLOYED OR SENT. Its deployed bytecode is
 * installed for the duration of a single eth_call, through that call's state
 * override, at an address that ALREADY HOLDS the input token - NVDAc cannot be
 * minted into a fresh address because it is not an ordinary ERC20 with
 * ordinary storage. Nothing is mined, no transaction exists, and the override
 * disappears with the call.
 *
 * THE CALLBACK PAYS FOR REAL, which is the point: a pool that is not paid
 * reverts, so a swap that returns deltas is a swap that really happened in
 * that call's state. Native ETH is wrapped when the owed token is WETH and the
 * balance is short, so a WETH leg needs only a native balance override rather
 * than somebody else's WETH.
 */
interface IUniV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETHMin {
    function deposit() external payable;
}

contract SwapDeltaProbe {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    error PoolDidNotPay();

    /// @param amountSpecified POSITIVE for an exact-input swap. v3's convention
    ///        is the opposite of v4's, and getting it backwards silently asks a
    ///        different question.
    /// @return amount0 signed delta of token0: positive is owed BY us
    /// @return amount1 signed delta of token1
    /// @return spent the input this swap really consumed
    /// @return received the output this swap really produced
    function probe(address pool, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)
        external
        returns (int256 amount0, int256 amount1, uint256 spent, uint256 received)
    {
        (amount0, amount1) = IUniV3Pool(pool).swap(
            address(this), zeroForOne, amountSpecified, sqrtPriceLimitX96, ""
        );
        // One side is owed by us and the other is paid to us. Which is which
        // follows from the direction, not from the sign alone, so both are
        // returned raw as well.
        if (zeroForOne) {
            spent = amount0 > 0 ? uint256(amount0) : 0;
            received = amount1 < 0 ? uint256(-amount1) : 0;
        } else {
            spent = amount1 > 0 ? uint256(amount1) : 0;
            received = amount0 < 0 ? uint256(-amount0) : 0;
        }
        if (spent == 0 && received == 0) revert PoolDidNotPay();
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        IUniV3Pool pool = IUniV3Pool(msg.sender);
        if (amount0Delta > 0) _pay(pool.token0(), msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) _pay(pool.token1(), msg.sender, uint256(amount1Delta));
    }

    function _pay(address token, address to, uint256 amount) private {
        uint256 held = IERC20Min(token).balanceOf(address(this));
        if (token == WETH && held < amount) {
            IWETHMin(WETH).deposit{value: amount - held}();
        }
        IERC20Min(token).transfer(to, amount);
    }

    receive() external payable {}
}
