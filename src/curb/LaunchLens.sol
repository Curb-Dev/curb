// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {LaunchRegistry} from "./LaunchRegistry.sol";
import {Graduator} from "./Graduator.sol";
import {IHolderSharingSource} from "./sharing/ICurbSharing.sol";

interface ICurveView {
    function graduated() external view returns (bool);
    function readyToGraduate() external view returns (bool);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function realQuoteReserve() external view returns (uint256);
    function graduationThreshold() external view returns (uint256);
}

/**
 * @title LaunchLens
 * @notice One call that tells an interface which of three things is true about
 *         a launch, and gives it the numbers to draw.
 *
 * READ-ONLY, AND DERIVED
 *   It holds no state, no authority and no funds. In particular it does NOT
 *   keep its own copy of the status: a second variable that has to be updated
 *   is a second thing that can be wrong, and the moment it disagrees with the
 *   curve the interface is lying to somebody. Everything here is computed from
 *   what the registry, the curve and the graduator already say.
 *
 * THE THREE STATES, AND WHAT IS NOT ONE
 *   Selling     not graduated, the threshold is not reached
 *   Waiting     not graduated, the curve says it is ready
 *   Graduated   graduation completed
 *
 *   NotFound is the fourth answer and it is not a state of a launch - it means
 *   this contract has never heard of the token. An interface must not render
 *   it as "Selling": an unregistered address would then look like a live launch
 *   with a zero price.
 *
 *   AutoGraduationFailed is NOT a state. It is an event, and a launch that
 *   graduated perfectly well on a later attempt still carries it in its log.
 *   Nothing here reads events, deliberately.
 *
 * WHY WAITING MATTERS ENOUGH TO HAVE A NAME
 *   In that state BOTH sides of the curve are shut - sell() refuses once the
 *   curve is ready, and there is no allocation left to buy - while the pool
 *   does not exist yet. A holder can reach nothing. Graduation is
 *   permissionless precisely so anyone can end it, so an interface showing
 *   this state should offer the button and say who pays for it.
 */
contract LaunchLens {
    enum LaunchStatus {
        NotFound,
        Selling,
        Waiting,
        Graduated
    }

    struct LaunchView {
        LaunchStatus status;
        address curve;
        address quoteToken;
        address beneficiary;
        /// The curve's TRADEABLE reserves - what its price is quoted against.
        /// Once graduated the quote side is the curve's virtual phantomQuote
        /// and the token side zero - not a price anyone can trade at; gate on
        /// status, not on these.
        uint256 quoteReserve;
        uint256 tokenReserve;
        /// Progress towards graduation, both in the quote asset's units.
        uint256 realQuoteReserve;
        uint256 graduationThreshold;
        /// Current supply. Falls at graduation, when the remainder is burned.
        uint256 totalSupply;
        /// Meaningful once Graduated; the pool the launch trades in.
        PoolKey poolKey;
        /// WORD 14: when the launch was registered, by the registry's clock.
        /// APPENDED, like the next one: everything before it stays where a
        /// positional reader already finds it.
        uint64 launchedAt;
        /// WORD 15: the distributor this launch's creator income goes to once
        /// its holder sharing is on; zero while it is off.
        address holderDistributor;
    }

    LaunchRegistry public immutable registry;
    Graduator public immutable graduator;

    constructor(LaunchRegistry registry_, Graduator graduator_) {
        registry = registry_;
        graduator = graduator_;
    }

    function launchState(address launchToken) external view returns (LaunchView memory view_) {
        if (!registry.isRegistered(launchToken)) {
            // Everything else stays zero. NotFound is not a launch in an early
            // state - it is no launch at all, and must not be drawn as one.
            return view_;
        }

        LaunchRegistry.Launch memory rec = registry.launchOf(launchToken);
        ICurveView curve = ICurveView(rec.curve);

        view_.curve = rec.curve;
        view_.quoteToken = rec.quoteToken;
        view_.beneficiary = rec.beneficiary;
        view_.launchedAt = rec.launchedAt;
        view_.holderDistributor = IHolderSharingSource(address(graduator)).holderDistributorOf(launchToken);
        view_.totalSupply = IERC20(launchToken).totalSupply();
        view_.realQuoteReserve = curve.realQuoteReserve();
        view_.graduationThreshold = curve.graduationThreshold();
        (view_.quoteReserve, view_.tokenReserve) = curve.getReserves();

        bool launchIsCurrency0 = launchToken < rec.quoteToken;
        view_.poolKey = PoolKey({
            currency0: Currency.wrap(launchIsCurrency0 ? launchToken : rec.quoteToken),
            currency1: Currency.wrap(launchIsCurrency0 ? rec.quoteToken : launchToken),
            fee: rec.fee,
            tickSpacing: rec.tickSpacing,
            hooks: rec.hooks
        });

        // ORDER MATTERS. readyToGraduate() returns FALSE once the curve has
        // graduated, so asking it first would report a finished launch as
        // Selling. Both flags are asked, defensively: the graduator sets its
        // own and the curve's in the same transaction, so they cannot disagree
        // today, and asking both costs one call.
        if (graduator.hasGraduated(launchToken) || curve.graduated()) {
            view_.status = LaunchStatus.Graduated;
        } else if (curve.readyToGraduate()) {
            view_.status = LaunchStatus.Waiting;
        } else {
            view_.status = LaunchStatus.Selling;
        }
    }

    /// @notice Convenience for an interface that only needs the one answer.
    function statusOf(address launchToken) external view returns (LaunchStatus) {
        return this.launchState(launchToken).status;
    }

    /// @notice The most launches one call will describe.
    ///
    /// @dev NOT A LIMIT ON THE REGISTRY, only on how much work a single public
    ///      read may be asked to do.
    uint256 public constant MAX_PAGE = 50;

    /// @notice One page of launches, oldest first, each with its full state.
    /// @dev WITHOUT THIS A BROWSER MAKES ONE REQUEST PER LAUNCH. The registry
    ///      can be sliced, but turning a slice into something displayable
    ///      needs a state read for every token in it, so a list of fifty costs
    ///      fifty round trips and a list of five hundred is not a page anyone
    ///      waits for. This is the same reads, done once.
    ///
    ///      Short at the end rather than reverting, for the same reason
    ///      launchSlice is: a caller paging a list that is still growing
    ///      should get the tail it asked for.
    ///
    ///      A PAGE HAS A CEILING NOW. Each entry costs several external reads
    ///      and `count` was the caller's to choose, so one eth_call could be
    ///      made to walk the whole registry and do all of that work.
    ///
    ///      ASKING FOR MORE RETURNS MAX_PAGE RATHER THAN REVERTING. A pager
    ///      that asks for too much should get a page, not an error, and the
    ///      array it gets back already says how many it received.
    function launchPage(uint256 start, uint256 count)
        external
        view
        returns (address[] memory tokens, LaunchView[] memory views)
    {
        if (count > MAX_PAGE) count = MAX_PAGE;
        tokens = registry.launchSlice(start, count);
        views = new LaunchView[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            views[i] = this.launchState(tokens[i]);
        }
    }
}
