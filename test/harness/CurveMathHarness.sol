// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PonsV2BondingCurveMath as Curve} from "../../src/vendor/PonsV2BondingCurveMath.sol";

/// @notice External wrapper around the internal curve library.
/// @dev Internal library calls are inlined into the caller, so a revert has no
/// call frame of its own and vm.expectRevert cannot see it. Routing through
/// these external functions gives the reverts a frame to be caught in.
contract CurveMathHarness {
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        external
        pure
        returns (uint256)
    {
        return Curve.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        external
        pure
        returns (uint256)
    {
        return Curve.getAmountIn(amountOut, reserveIn, reserveOut, feeBps);
    }
}
