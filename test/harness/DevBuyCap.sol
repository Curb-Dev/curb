// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";
import {PonsV2BondingCurveMath} from "../../src/vendor/PonsV2BondingCurveMath.sol";

/// WHERE THE FACTORY'S DEV BUY CAP FALLS IN THE QUOTE ASSET, for the tests that
/// put a dev buy on both sides of it.
///
/// The cap is in TOKENS (CurbLaunchFactory.MAX_DEV_BUY_BPS of the supply), so
/// the quote amount at the line depends on the asset, the curve and the tax.
/// These replay PonsV2BondingCurve.buy on an untouched curve with the same
/// terms - the platform fee and the creator tax off the input, then
/// getAmountOut against the starting reserves - and bisect for the largest
/// amount whose tokens stay within the cap. A replay that drifted from the
/// curve fails the tests that use it: they assert the tokens the launch
/// actually delivered, and the exact figure in the refusal, against it.
library DevBuyCap {
    /// What a first buy of `spend` receives on a curve that has not traded.
    function tokensOut(PonsV2BondingCurve fresh, uint256 spend) internal view returns (uint256) {
        (uint256 quoteReserve, uint256 tokenReserve) = fresh.getReserves();
        uint256 net = spend - (spend * fresh.feeBps()) / 10_000 - (spend * fresh.creatorTaxBps()) / 10_000;
        return PonsV2BondingCurveMath.getAmountOut(net, quoteReserve, tokenReserve, 0);
    }

    /// The largest spend below `below` whose tokens are at most `maxTokens`.
    /// Requires that `below` itself would buy more, so the line is inside.
    function largest(PonsV2BondingCurve fresh, uint256 maxTokens, uint256 below) internal view returns (uint256 lo) {
        require(tokensOut(fresh, below) > maxTokens, "DevBuyCap: the cap is not below `below`");
        uint256 hi = below;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (tokensOut(fresh, mid) <= maxTokens) lo = mid;
            else hi = mid;
        }
    }
}
