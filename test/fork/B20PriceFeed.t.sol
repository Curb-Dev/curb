// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256, uint256, uint256, uint80);
}

interface IV3PoolSlot0 {
    function token0() external view returns (address);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// THE PRICE REFERENCE WE DECIDED NOT TO USE  (B2 / ROADMAP 7.2)
///
/// DECIDED 2026-09-19: no price oracle anywhere in this system, and no
/// reference-deviation guard. Nothing is closed at the weekend, and nothing is
/// checked against an off-chain price. The reason is what the venues doing this
/// already do:
///   PONS      "no price oracle anywhere in the system" - its own README. It
///             quotes against native ETH, which never closes, so it has no
///             weekend to handle at all.
///   vvveity   Base, same NVDAc, the nearest thing to us: "Prices in the UI are
///             a snapshot; wire an oracle before relying on them for anything
///             but display."
///   StonkFun  Solana, against xStocks. Traded straight through the weekend of
///             5-6 Sep 2026 with no separate state.
///
/// A PriceAdapter was written and is deleted in the same change. It is in the
/// history at 8a1984d5 if the decision is ever revisited.
///
/// THIS FILE STAYS because the decision should be reversible against evidence
/// rather than against memory. It measures what a reference WOULD have given
/// us, and in particular the thing that makes this hard - the feed is correct
/// and still unusable for most of a weekend. If the guard is ever wanted, the
/// numbers are here and they are on chain, not from a vendor page.
///
/// Everything here is a reading of somebody else's contract at one block. None
/// of it is our behaviour, and none of it is a guarantee about theirs.
contract B20PriceFeedForkTest is B20ForkTest {
    /// Chainlink's Coinbase NVDA feed on Base. Found in Chainlink's own feed
    /// directory and then CONFIRMED HERE: an address from a web page is a lead,
    /// not a fact.
    address internal constant NVDA_FEED = 0x04689a41629776563E6822F76f2e57D148d28513;
    /// ETH/USD, used only to put the pool's NVDAc price into dollars so it can
    /// be compared with the equity feed.
    ///
    /// THIS ADDRESS CAME FROM CHAINLINK'S OWN DIRECTORY. A first version used
    /// 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70, which answers "ETH / USD"
    /// on chain and returns the same answer and timestamp as this one - but is
    /// NOT in the directory, and was in the test because it was remembered
    /// rather than looked up. Same number, unverifiable provenance.
    address internal constant ETH_USD_FEED = 0x50015f8b17fb2C290Dde41fDc246ed0dcEE93a8b;
    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    /// The NVDAc/WETH v3 pool - the only tier with liquidity, per B20EthRoute.
    address internal constant V3_NVDAC_WETH = 0x8e740D5Fa742B763cD82159894b9919eD57E4f70;

    /// The feed's published heartbeat: 86,400 seconds.
    uint256 internal constant FEED_HEARTBEAT = 86_400;

    function setUp() public {
        _forkGuard();
    }

    /// THE SOURCE EXISTS AND IS THE RIGHT ONE.
    function test_theFeedIsThere() public onlyFork {
        IAggregatorV3 feed = IAggregatorV3(NVDA_FEED);
        assertEq(feed.description(), "Coinbase NVDA", "not the feed this file is about");
        assertEq(feed.decimals(), 8, "the feed's decimals moved");

        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertGt(answer, 0, "the feed published a non-positive price");
        assertGt(updatedAt, 0, "the feed has never been updated");
        emit log_named_int("  NVDA, 8dp", answer);
        emit log_named_uint("  seconds stale at the pinned block", block.timestamp - updatedAt);
    }

    /// AT THE PINNED BLOCK THE FEED IS FRESH. Friday 2026-09-11, 12:54 UTC -
    /// a trading hour - and it had been updated 152 seconds earlier. This is
    /// the easy case, and it is recorded so the hard ones below have something
    /// to be compared against.
    function test_atThePinnedBlockTheMarketIsOpen() public onlyFork {
        (,,, uint256 updatedAt,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        uint256 stale = block.timestamp - updatedAt;
        assertLt(stale, 600, "the pinned block is not in a trading window after all");
        emit log_named_uint("  stale, seconds", stale);
    }

    /// THE WEEKEND GAP IS LONGER THAN THE HEARTBEAT, AND THAT IS THE PROBLEM.
    ///
    /// Read off the feed's own history rather than from the vendor's page:
    ///   round 255 -> 256   53.2 hours   Fri 2026-08-28 18:50 -> Mon 00:00 UTC
    ///   round 313 -> 314   77.9 hours   Fri 2026-09-04 18:04 -> Tue 00:00 UTC
    /// The second is a long weekend - the Monday was a US holiday.
    ///
    /// The heartbeat is 24 hours. So a staleness rule written the usual way -
    /// "refuse if updatedAt + heartbeat < now" - refuses this feed for most of
    /// every weekend. That is not a fault in the feed: an equity feed with
    /// nothing to report is behaving correctly. It is the reason 7.2 asks what
    /// the weekend reference should be, and it is why that question cannot be
    /// answered by tuning a staleness constant.
    function test_theWeekendGapExceedsTheHeartbeat() public onlyFork {
        IAggregatorV3 feed = IAggregatorV3(NVDA_FEED);

        // THE PHASE IS READ, NOT ASSUMED. Chainlink round ids carry the
        // aggregator phase in their high 64 bits, and the round numbers below
        // are phase 2's. Written as a constant, a feed that had moved to a new
        // aggregator would return zeroed rounds here and the subtraction would
        // underflow - the test would fail, but for the wrong reason and with
        // nothing saying which.
        (uint80 latestId,,,,) = feed.latestRoundData();
        uint80 phase = uint80(uint256(latestId) >> 64);
        assertEq(phase, 2, "the feed is on a different aggregator phase; these round numbers are phase 2's");
        uint80 base = uint80(uint256(phase) << 64);

        (,,, uint256 friday,) = feed.getRoundData(base + 255);
        (,,, uint256 monday,) = feed.getRoundData(base + 256);
        // A round that was never written reads as zero, and two zeros would
        // make a gap of nothing look like agreement.
        assertGt(friday, 0, "round 255 has no timestamp");
        assertGt(monday, 0, "round 256 has no timestamp");
        uint256 weekend = monday - friday;
        assertGt(weekend, FEED_HEARTBEAT, "the ordinary weekend gap no longer exceeds the heartbeat");
        emit log_named_uint("  ordinary weekend, seconds with no update", weekend);

        (,,, uint256 friLong,) = feed.getRoundData(base + 313);
        (,,, uint256 tueLong,) = feed.getRoundData(base + 314);
        assertGt(friLong, 0, "round 313 has no timestamp");
        assertGt(tueLong, 0, "round 314 has no timestamp");
        uint256 longWeekend = tueLong - friLong;
        assertGt(longWeekend, weekend, "the holiday weekend is no longer the longer one");
        emit log_named_uint("  holiday weekend, seconds with no update", longWeekend);

        // AND THE PRICE DOES NOT MOVE ACROSS THE GAP - it is the same close,
        // held. Whatever is shown to a user on a Saturday, it cannot be called
        // a live price.
        (, int256 before_,,,) = feed.getRoundData(base + 255);
        (, int256 after_,,,) = feed.getRoundData(base + 256);
        emit log_named_int("  last close before the weekend, 8dp", before_);
        emit log_named_int("  first print after it, 8dp", after_);
    }

    /// THE OTHER LEG 7.2 ASSUMES - A DEX TWAP - IS NOT AVAILABLE HERE.
    ///
    /// ROADMAP 7.2 lists "Chainlink feed + DEX TWAP" as the shape of the
    /// adapter. The v3 pool that actually holds NVDAc keeps ONE observation:
    /// cardinality 1, and observe() over any window reverts with OLD. A TWAP
    /// off this pool is not a thing that can be read today - it would have to
    /// be switched on with increaseObservationCardinalityNext and then WAIT to
    /// accumulate, which is a decision with a cost and a lead time, not a
    /// library call.
    function test_thereIsNoTwapOnTheNvdacPool() public onlyFork {
        (,,, uint16 cardinality, uint16 cardinalityNext,,) = IV3PoolSlot0(V3_NVDAC_WETH).slot0();
        assertEq(cardinality, 1, "the pool now keeps more than one observation");
        emit log_named_uint("  observationCardinality", cardinality);
        emit log_named_uint("  observationCardinalityNext", cardinalityNext);

        uint32[] memory windows = new uint32[](2);
        windows[0] = 0;
        windows[1] = 1800;
        vm.expectRevert(bytes("OLD"));
        IV3PoolSlot0(V3_NVDAC_WETH).observe(windows);
    }

    /// THE BASIS, WHICH IS WHAT 7.2 WANTS SHOWN TO THE USER.
    ///
    /// "Last close" against "onchain now": the feed's NVDA price against what
    /// the v3 pool prices NVDAc at, converted through ETH/USD. At the pinned
    /// block, with the market open, they are 17 bps apart.
    ///
    /// THE BOUND ASSERTED HERE IS WIDE ON PURPOSE. It is not a product limit -
    /// D4 has not set one - it only says the two are pricing the same asset,
    /// so a wiring mistake that compared unrelated numbers would fail it. The
    /// measured figure is emitted for the record.
    function test_theBasisBetweenTheFeedAndTheChain() public onlyFork {
        // BOTH FEEDS ARE IDENTIFIED BEFORE THEY ARE USED. A basis is a
        // comparison between two named things; two addresses that merely
        // return positive numbers would compute one just as happily.
        assertEq(IAggregatorV3(NVDA_FEED).description(), "Coinbase NVDA", "not the NVDA feed");
        assertEq(IAggregatorV3(ETH_USD_FEED).description(), "ETH / USD", "not the ETH/USD feed");
        assertEq(IAggregatorV3(ETH_USD_FEED).decimals(), 8, "the ETH feed's decimals moved");

        (, int256 nvdaUsd,,,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        (, int256 ethUsd,,,) = IAggregatorV3(ETH_USD_FEED).latestRoundData();
        assertGt(nvdaUsd, 0, "no NVDA price");
        assertGt(ethUsd, 0, "no ETH price");

        (uint160 sq,,,,,,) = IV3PoolSlot0(V3_NVDAC_WETH).slot0();
        // wei of WETH per whole NVDAc, from the pool's own price
        uint256 ratioQ = (uint256(sq) * uint256(sq)) >> 96;
        uint256 weiPerNvdac = IV3PoolSlot0(V3_NVDAC_WETH).token0() == NVDAC
            ? (ratioQ * 1e8) >> 96
            : ((uint256(1) << 96) * 1e8) / ratioQ;

        // onchain USD, 8dp: (wei/1e18) * ethUsd
        uint256 onchainUsd = (weiPerNvdac * uint256(ethUsd)) / 1e18;
        uint256 feedUsd = uint256(nvdaUsd);

        uint256 diff = onchainUsd > feedUsd ? onchainUsd - feedUsd : feedUsd - onchainUsd;
        uint256 basisBps = (diff * 10_000) / feedUsd;

        emit log_named_uint("  feed NVDA, 8dp", feedUsd);
        emit log_named_uint("  onchain NVDAc via ETH/USD, 8dp", onchainUsd);
        emit log_named_uint("  basis, bps", basisBps);
        assertLt(basisBps, 2_000, "the feed and the pool are not pricing the same asset");
    }
}
