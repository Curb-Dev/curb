// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";

import {PoolHarness, MemeToken} from "./B20UniswapV4.t.sol";
import {ExactInputSingleLegacy} from "./B20HookedPool.t.sol";
import {B20ForkTest} from "./B20ForkTest.sol";
import {FeeHook} from "../../src/curb/FeeHook.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/**
 * @title B20FeeHookForkTest
 * @notice Does the pool charge a launch's OWN tax, on the NVDAc side, in both
 *         directions - and does it refuse everything it should?
 *
 * WHAT CHANGED, AND WHY THESE TESTS ARE NOT THE OLD ONES
 *   The hook used to take a flat 1% of whatever the swap paid OUT. That meant
 *   a buy was charged in the memecoin, a sell in NVDAc, the two directions were
 *   charged on amounts that are not comparable, and every launch paid the same
 *   rate no matter what its creator chose. The policy is now ONE tax per
 *   launch, 1% to 5%, charged on the NVDAc side both ways. The platform's
 *   share of it is the one frozen into that launch's registry record when the
 *   launch was created (50 bps at deployment; the owner can move it for LATER
 *   launches through an announcement and a delay), and the rest goes to that
 *   launch's creator. This said "a fixed 50 bps" from before the share could
 *   be announced; what is fixed is each launch's own copy.
 *
 * THE CRITERIA, AS TESTS
 *   1. the rate and the creator are written ONCE, by the graduator, out of the
 *      registry record - and nobody else can write them, no key but that
 *      launch's own is accepted, and a pool with no record cannot be traded
 *   2. a BUY is charged on the trader's whole NVDAc input, and the pool
 *      receives the input MINUS the tax - asserted on the PoolManager's own
 *      balance, which is where "what reached the pool" actually is
 *   3. a SELL is charged on the gross NVDAc the swap produced
 *   4. at 1%, 3% and 5%, both directions: the platform is paid the SAME
 *      integer on the same base, and only the creator's leg moves
 *   5. rounding is a floor on each leg independently, and the trader keeps
 *      both remainders
 *   6. exact-output is refused, by its own selector
 *
 * NOT HERE, ON PURPOSE. A minimum-output failure rolling the fees back, and a
 * graduation failing mid-way and taking the hook's record with it, both need
 * the real stack and a real router - they are in B20Graduation.t.sol against a
 * pool an actual graduation created.
 *
 * WHAT THESE TESTS DO NOT SHOW: that the revenue can be spent. It lands
 * directly in the recipients' balances here, or as a debt in the hook's
 * `owed` when the leg could not be delivered, and the curve's share lands in
 * the fee escrow. Withdrawing is tested where it lives: claim() in
 * B20Graduation.t.sol and claimToken() in B20FeeEscrow.t.sol. PRE_MAINNET.txt
 * A2 ("fees accrue and have nowhere to go") is CLOSED on the fork; this used
 * to call it an open question.
 */
contract B20FeeHookForkTest is B20ForkTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IUniversalRouter internal constant ROUTER = IUniversalRouter(0x6fF5693b99212Da76ad316178A184AB56D299b43);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    int256 internal constant LIQUIDITY = 1e8;
    uint128 internal constant SWAP_IN = 1e6;

    uint256 internal constant BPS = 10_000;
    uint16 internal constant PLATFORM_BPS = 50;
    /// This fixture's launch. Mid-band, so both legs are non-zero and neither
    /// is at an edge the other tests cover.
    uint16 internal constant TAX_BPS = 300;

    address internal user = makeAddr("fee-hook-user");
    address internal platform = makeAddr("platform");
    address internal creator = makeAddr("creator");

    LaunchRegistry internal registryContract;
    FeeHook internal hook;
    MemeToken internal meme;
    PoolHarness internal harness;
    PoolKey internal key;

    /// THIS TEST CONTRACT STANDS IN FOR THE GRADUATOR, and the registry checks
    /// that claim rather than taking it: wire() asks the launcher for its
    /// graduator, the graduator for its registry and pool manager, and the hook
    /// for its own opener and manager. All four have to agree, so these three
    /// views are what make the scaffolding honest instead of a mock.
    function graduator() external view returns (address) { return address(this); }
    /// AND AN ESCROW, because wire() now asks the launcher to name one: the
    /// hook asks every admitted launcher for it whenever a platform recipient
    /// moves, so a launcher that cannot answer is refused. No curve here pays
    /// it; any non-zero address that is not the platform recipient will do.
    function feeEscrow() external pure returns (address) { return address(0xE5C0); }
    function registry() external view returns (address) { return address(registryContract); }
    function poolManager() external pure returns (address) { return address(POOL_MANAGER); }

    function setUp() public {
        if (!_forkGuard()) return;

        harness = new PoolHarness(POOL_MANAGER);
        meme = new MemeToken(address(harness), 1_000_000e18);
        registryContract = new LaunchRegistry(address(this));

        hook = _mineHook();
        registryContract.wire(address(this), address(hook));

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(harness), 5e8);

        key = _keyFor(address(meme));
        _registerAndConfigure(address(meme), key, TAX_BPS);

        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);
        harness.addLiquidity(
            key,
            (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING,
            (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING,
            LIQUIDITY
        );

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(user, 1e8);
        vm.prank(address(harness));
        meme.transfer(user, 1e18);
    }

    // ================================================================
    // 1. who may bind a pool to a launch, and on what terms
    // ================================================================

    function test_hookClaimsExactlyTheFeePermissions() public onlyFork {
        uint160 permissions = uint160(address(hook)) & Hooks.ALL_HOOK_MASK;
        uint160 expected = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        assertEq(permissions, expected, "hook claims a different permission set than the fee design needs");
    }

    /// The terms come from the RECORD, not from the caller. Reading them back
    /// off the hook is what shows the caller had no say.
    function test_theBoundTermsAreTheRecordsOwn() public onlyFork {
        FeeHook.LaunchFee memory cfg = hook.feeOf(key);
        assertTrue(cfg.configured, "the pool was never bound to its launch");
        assertEq(cfg.totalTaxBps, TAX_BPS, "the pool carries a different tax than the record");
        assertEq(cfg.creator, creator, "the pool pays a different creator than the record names");
        assertEq(cfg.quoteIsCurrency0, NVDAC < address(meme), "the hook has NVDAc on the wrong side");
        assertEq(hook.platformFeeBps(), PLATFORM_BPS, "the hook's platform leg is not the registry's");
    }

    function test_onlyTheGraduatorCanBindAPool() public onlyFork {
        MemeToken other = new MemeToken(address(harness), 1_000e18);
        PoolKey memory k = _keyFor(address(other));
        _register(address(other), k, TAX_BPS);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FeeHook.NotThePoolOpener.selector, stranger));
        hook.configureLaunch(address(other), k);
    }

    /// A caller could otherwise name a real launch and hand over somebody
    /// else's key, and that other pool would inherit this launch's tax.
    function test_aKeyThatIsNotTheLaunchsPoolIsRefused() public onlyFork {
        MemeToken other = new MemeToken(address(harness), 1_000e18);
        PoolKey memory k = _keyFor(address(other));
        _register(address(other), k, TAX_BPS);

        PoolKey memory wrong = k;
        wrong.fee = 500; // a tier the record does not name
        vm.expectRevert(abi.encodeWithSelector(FeeHook.KeyIsNotThisLaunchsPool.selector, address(other)));
        hook.configureLaunch(address(other), wrong);

        // And a key for a DIFFERENT pair entirely.
        vm.expectRevert(abi.encodeWithSelector(FeeHook.KeyIsNotThisLaunchsPool.selector, address(other)));
        hook.configureLaunch(address(other), key);
    }

    /// Write-once in substance: the record cannot change, so a second call can
    /// only ever carry the same values and is a no-op. Nothing about a pool's
    /// economics can be revised once it exists.
    function test_bindingAgainIsANoOpAndCannotChangeTheTerms() public onlyFork {
        hook.configureLaunch(address(meme), key);

        FeeHook.LaunchFee memory cfg = hook.feeOf(key);
        assertEq(cfg.totalTaxBps, TAX_BPS, "a second binding changed the tax");
        assertEq(cfg.creator, creator, "a second binding changed the creator");
    }

    /// FAIL CLOSED. A pool the hook has no record for must not trade free of
    /// charge - it must not trade.
    function test_anUnboundPoolCannotBeTradedAtAll() public onlyFork {
        MemeToken other = new MemeToken(address(harness), 1_000_000e18);
        PoolKey memory k = _keyFor(address(other));
        POOL_MANAGER.initialize(k, SQRT_PRICE_1_1);

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(harness), 5e8);
        harness.addLiquidity(
            k, (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING, (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING,
            LIQUIDITY
        );

        // THE EXACT ERROR, NOT MERELY "IT REVERTED". A bare expectRevert here
        // passed even with BOTH fail-closed guards deleted: an unconfigured
        // pool has a zero tax, so the creator's leg underflows and the swap
        // reverts on a panic instead. The test was reporting arithmetic as if
        // it were a guard. A mutation run is what showed it.
        bytes memory err = _swapReverting(k, NVDAC < address(other), -int256(uint256(SWAP_IN)));
        // THE POOL ID TOO. PoolNotConfigured carries one, and a test that
        // ignored it would pass on a revert about some other pool entirely.
        _assertHookReverted(
            err,
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(FeeHook.PoolNotConfigured.selector, k.toId())
        );
    }

    // ================================================================
    // 2 and 3. the base, and what reaches the pool
    // ================================================================

    /// A BUY IS CHARGED ON THE WHOLE INPUT, and the pool trades what is left.
    /// The PoolManager's own NVDAc balance is where "what reached the pool"
    /// actually lives, so that is what this asserts on rather than inferring it
    /// from the output.
    function test_aBuyIsChargedOnTheInputAndThePoolGetsTheRest() public onlyFork {
        (uint256 platformCut, uint256 creatorCut) = _legs(SWAP_IN, TAX_BPS);

        uint256 userBefore = IERC20(NVDAC).balanceOf(user);
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 poolBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        _userSwap(key, true);

        assertEq(userBefore - IERC20(NVDAC).balanceOf(user), SWAP_IN, "the trader paid something other than the input");
        assertEq(IERC20(NVDAC).balanceOf(platform) - platformBefore, platformCut, "the platform's leg is wrong");
        assertEq(IERC20(NVDAC).balanceOf(creator) - creatorBefore, creatorCut, "the creator's leg is wrong");
        assertEq(
            IERC20(NVDAC).balanceOf(address(POOL_MANAGER)) - poolBefore,
            SWAP_IN - platformCut - creatorCut,
            "the pool did not receive the input minus the tax"
        );
        assertEq(hook.collected(NVDAC), platformCut + creatorCut, "the hook's own accounting disagrees");
    }

    /// A SELL IS CHARGED ON THE GROSS NVDAc THE SWAP PRODUCED. The trader keeps
    /// gross minus the tax, and the manager pays out the whole gross.
    function test_aSellIsChargedOnTheGrossOutput() public onlyFork {
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 userBefore = IERC20(NVDAC).balanceOf(user);
        uint256 poolBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        _userSwap(key, false);

        uint256 platformCut = IERC20(NVDAC).balanceOf(platform) - platformBefore;
        uint256 creatorCut = IERC20(NVDAC).balanceOf(creator) - creatorBefore;
        uint256 net = IERC20(NVDAC).balanceOf(user) - userBefore;
        uint256 gross = poolBefore - IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        // The gross is measured from the pool, and the legs are then checked
        // AGAINST it by the policy's own arithmetic - not the other way round.
        (uint256 expectedPlatform, uint256 expectedCreator) = _legs(gross, TAX_BPS);
        assertEq(platformCut, expectedPlatform, "the platform's leg is not 50 bps of the gross output");
        assertEq(creatorCut, expectedCreator, "the creator's leg is not the rest of the tax");
        assertEq(net, gross - platformCut - creatorCut, "the trader did not keep the remainder");
    }

    // ================================================================
    // 4. the platform's leg does not move with the tax
    // ================================================================

    /// THE DECISION'S WHOLE POINT, at three taxes and in both directions. Same
    /// NVDAc base, same integer to the platform; only the creator's leg moves.
    function test_thePlatformIsPaidTheSameAtEveryTax() public onlyFork {
        uint16[3] memory taxes = [uint16(100), 300, 500];

        uint256[3] memory buyPlatform;
        uint256[3] memory buyCreator;
        for (uint256 i = 0; i < 3; i++) {
            (buyPlatform[i], buyCreator[i]) = _freshPoolSwap(taxes[i], true);
        }
        // The BUY base is the input, which is the same SWAP_IN every time - so
        // this is a like-for-like comparison by construction.
        assertEq(buyPlatform[0], (uint256(SWAP_IN) * PLATFORM_BPS) / BPS, "the platform is not on a fixed 50 bps");
        assertEq(buyPlatform[1], buyPlatform[0], "the platform's take moved between 1% and 3%");
        assertEq(buyPlatform[2], buyPlatform[0], "the platform's take moved between 1% and 5%");
        assertGt(buyCreator[1], buyCreator[0], "raising the tax did not raise the creator's leg");
        assertGt(buyCreator[2], buyCreator[1], "raising the tax did not raise the creator's leg");

        uint256[3] memory sellPlatform;
        uint256[3] memory sellCreator;
        uint256[3] memory sellGross;
        for (uint256 i = 0; i < 3; i++) {
            (sellPlatform[i], sellCreator[i], sellGross[i]) = _freshPoolSell(taxes[i]);
        }
        // The SELL base is the gross output, so the pools must be identical for
        // this to be like-for-like. They are - same liquidity, same price, same
        // input - and the assertion states it rather than assuming it.
        assertEq(sellGross[1], sellGross[0], "the sell fixtures are not comparable");
        assertEq(sellGross[2], sellGross[0], "the sell fixtures are not comparable");
        assertEq(sellPlatform[0], (sellGross[0] * PLATFORM_BPS) / BPS, "the platform is not on a fixed 50 bps");
        assertEq(sellPlatform[1], sellPlatform[0], "the platform's take moved between 1% and 3%");
        assertEq(sellPlatform[2], sellPlatform[0], "the platform's take moved between 1% and 5%");
        assertGt(sellCreator[2], sellCreator[0], "raising the tax did not raise the creator's leg");
    }

    // ================================================================
    // 5 and 6. rounding, and the swap kind
    // ================================================================

    /// EACH LEG IS AN INDEPENDENT FLOOR - MEASURED THROUGH THE HOOK.
    ///
    /// This used to loop over the test's own _legs helper and never swap, so
    /// it checked the file against itself; and the buy tests use 1e6, where a
    /// floor and a ceiling are the same number. These are real buys at bases
    /// where they differ: 199 (the platform's 0.995 floors to 0), 12345 (61.7
    /// and 308.6) and 1e6+37 (5000.2 and 25000.9). Rounding a leg up, or
    /// splitting a combined total, fails here.
    function test_bothLegsRoundDownAndNeverOvercharge() public onlyFork {
        uint256[4] memory bases = [uint256(7), 199, 12345, uint256(SWAP_IN) + 37];
        for (uint256 b = 0; b < bases.length; b++) {
            uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
            uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
            _userBuyExact(key, bases[b]);
            uint256 pl = IERC20(NVDAC).balanceOf(platform) - platformBefore;
            uint256 cr = IERC20(NVDAC).balanceOf(creator) - creatorBefore;
            assertEq(pl, (bases[b] * PLATFORM_BPS) / BPS, "the platform leg is not a floor of the base");
            assertEq(cr, (bases[b] * (TAX_BPS - PLATFORM_BPS)) / BPS, "the creator leg is not a floor of the base");
            assertLe(pl + cr, (bases[b] * TAX_BPS) / BPS, "the two legs together exceed the tax");
        }
    }

    /// A buy of exactly `amount` NVDAc through the harness; what it bought
    /// stays in the harness, which no leg is measured against.
    function _userBuyExact(PoolKey memory k, uint256 amount) internal {
        vm.prank(user);
        IERC20(NVDAC).transfer(address(harness), amount);
        bool quoteIsCurrency0 = Currency.unwrap(k.currency0) == NVDAC;
        harness.swap(k, quoteIsCurrency0, -int256(amount));
    }

    function test_exactOutputIsRefused() public onlyFork {
        bytes memory err = _swapReverting(key, NVDAC < address(meme), int256(uint256(SWAP_IN)));
        _assertHookReverted(
            err, IHooks.beforeSwap.selector, abi.encodeWithSelector(FeeHook.ExactOutputNotSupported.selector)
        );
    }

    // ================================================================
    // 7. a buy that does not fill completely
    // ================================================================

    /// THE CASE beforeSwap CANNOT SEE.
    ///
    /// The buy's tax is taken in beforeSwap, out of the amount the trader ASKED
    /// to spend - and at that moment nobody knows whether the pool will take
    /// all of it. A swap carrying a sqrtPriceLimitX96 stops AT the limit and
    /// hands the unspent input back; so does one large enough to run the price
    /// to the range's own bound, with no limit supplied at all.
    ///
    /// Our own interface supplies no limit, which is NOT the same as a
    /// guarantee that swaps through it always fill. And the pool is open to
    /// anyone besides: an arbitrageur bounding their price is an ordinary
    /// caller.
    ///
    /// THIS HOOK DOES NOT SUPPORT PARTIAL FILLS - it reverts the whole
    /// transaction - and what this measures is that nothing was taken when it
    /// did. A refund would need the fee to be taken somewhere other than
    /// beforeSwap, because afterSwap is the first point a partial fill is
    /// visible and it may only return a delta on the output side. That is a
    /// different design, not a missing line.
    function test_aBuyThatCannotFillCompletelyIsRefusedAndCostsNothing() public onlyFork {
        (uint160 startPrice,,,) = POOL_MANAGER.getSlot0(key.toId());
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == NVDAC;

        // A limit a hair away from the current price, in the direction the buy
        // moves it. The swap can only take a sliver of the input before it
        // arrives there.
        uint160 limit = quoteIsCurrency0 ? startPrice - (startPrice / 1000) : startPrice + (startPrice / 1000);

        uint256 userBefore = IERC20(NVDAC).balanceOf(user);
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 collectedBefore = hook.collected(NVDAC);

        vm.prank(user);
        IERC20(NVDAC).transfer(address(harness), SWAP_IN);

        bytes memory err = _swapRevertingToLimit(key, quoteIsCurrency0, -int256(uint256(SWAP_IN)), limit);

        // THE REQUESTED INPUT, WHAT THE TAX WOULD HAVE BEEN, AND WHAT THE POOL
        // WOULD HAVE TAKEN - all three named by the error itself, so the
        // amounts are the contract's own rather than this test's arithmetic.
        (uint256 wouldPlatform, uint256 wouldCreator) = _legs(SWAP_IN, TAX_BPS);
        uint256 offered = uint256(SWAP_IN) - wouldPlatform - wouldCreator;

        bytes memory body = new bytes(err.length - 4);
        for (uint256 i = 0; i < body.length; i++) body[i] = err[i + 4];
        (,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
        bytes memory innerBody = new bytes(reason.length - 4);
        for (uint256 i = 0; i < innerBody.length; i++) innerBody[i] = reason[i + 4];
        (uint256 reportedOffered, uint256 spent) = abi.decode(innerBody, (uint256, uint256));

        _assertHookReverted(
            err,
            IHooks.afterSwap.selector,
            abi.encodeWithSelector(FeeHook.PartialFillNotSupported.selector, reportedOffered, spent)
        );

        emit log_named_uint("NVDAc the trader asked to spend  ", SWAP_IN);
        emit log_named_uint("NVDAc the pool would have taken  ", spent);
        emit log_named_uint("NVDAc left unspent               ", uint256(SWAP_IN) - wouldPlatform - wouldCreator - spent);
        emit log_named_uint("platform leg that was not charged", wouldPlatform);
        emit log_named_uint("creator leg that was not charged ", wouldCreator);

        assertEq(reportedOffered, offered, "the hook offered the pool something other than the post-tax amount");
        assertLt(spent, offered, "this fixture did not actually produce a partial fill");
        assertGt(spent, 0, "the swap took nothing at all - the limit is too tight to test anything");

        // AND NOTHING MOVED. Not the trader's NVDAc, not either recipient's,
        // not the hook's own accounting.
        assertEq(IERC20(NVDAC).balanceOf(user), userBefore - SWAP_IN, "the trader's NVDAc moved beyond the funding");
        assertEq(IERC20(NVDAC).balanceOf(platform), platformBefore, "the platform was paid on a refused swap");
        assertEq(IERC20(NVDAC).balanceOf(creator), creatorBefore, "the creator was paid on a refused swap");
        assertEq(hook.collected(NVDAC), collectedBefore, "the hook recorded a fee for a refused swap");
    }

    /// AND A LIMIT THAT IS NOT BINDING STILL TRADES. Otherwise the check above
    /// would be satisfied by a hook that refused every swap carrying a limit at
    /// all, which is a different and much worse contract.
    function test_aBuyWithARoomyPriceLimitStillWorks() public onlyFork {
        (uint160 startPrice,,,) = POOL_MANAGER.getSlot0(key.toId());
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == NVDAC;
        uint160 limit = quoteIsCurrency0 ? startPrice / 2 : startPrice * 3 / 2;

        (uint256 platformCut, uint256 creatorCut) = _legs(SWAP_IN, TAX_BPS);
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);

        vm.prank(user);
        IERC20(NVDAC).transfer(address(harness), SWAP_IN);
        harness.swapToLimit(key, quoteIsCurrency0, -int256(uint256(SWAP_IN)), limit);

        assertEq(IERC20(NVDAC).balanceOf(platform) - platformBefore, platformCut, "the platform's leg is wrong");
        assertEq(IERC20(NVDAC).balanceOf(creator) - creatorBefore, creatorCut, "the creator's leg is wrong");
    }

    /// A SELL NEEDS NO SUCH REFUSAL, and saying why is worth a test. Its tax is
    /// taken in afterSwap from the NVDAc that actually came out, so a partial
    /// fill is already charged on exactly what happened.
    function test_aSellThatFillsPartiallyIsStillChargedOnWhatCameOut() public onlyFork {
        (uint160 startPrice,,,) = POOL_MANAGER.getSlot0(key.toId());
        bool quoteIsCurrency0 = Currency.unwrap(key.currency0) == NVDAC;
        bool sellDirection = !quoteIsCurrency0;
        uint160 limit = sellDirection ? startPrice - (startPrice / 1000) : startPrice + (startPrice / 1000);

        uint256 memeIn = 1e16;
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 poolBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        uint256 memeHeldBefore = meme.balanceOf(address(harness));

        vm.prank(user);
        meme.transfer(address(harness), memeIn);
        harness.swapToLimit(key, sellDirection, -int256(memeIn), limit);

        uint256 memeSpent = memeHeldBefore + memeIn - meme.balanceOf(address(harness));
        uint256 gross = poolBefore - IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        (uint256 expectedPlatform, uint256 expectedCreator) = _legs(gross, TAX_BPS);

        emit log_named_uint("MEME offered ", memeIn);
        emit log_named_uint("MEME spent   ", memeSpent);

        assertLt(memeSpent, memeIn, "this fixture did not produce a partial fill on the sell either");
        assertEq(
            IERC20(NVDAC).balanceOf(platform) - platformBefore, expectedPlatform,
            "the sell's platform leg is not 50 bps of what actually came out"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(creator) - creatorBefore, expectedCreator,
            "the sell's creator leg is not the rest of the tax on what came out"
        );
    }

    // ================================================================
    // helpers
    // ================================================================

    /// A swap that must revert, with the revert data kept so the REASON can be
    /// asserted.
    function _swapReverting(PoolKey memory k, bool zeroForOne, int256 amount) internal returns (bytes memory) {
        return _swapRevertingToLimit(k, zeroForOne, amount, 0);
    }

    function _swapRevertingToLimit(PoolKey memory k, bool zeroForOne, int256 amount, uint160 limit)
        internal
        returns (bytes memory)
    {
        (bool ok, bytes memory err) = address(harness).call(
            abi.encodeWithSelector(PoolHarness.swapToLimit.selector, k, zeroForOne, amount, limit)
        );
        require(!ok, "the swap was supposed to revert and did not");
        return err;
    }

    /// THE WRAPPER, DECODED - NOT SCANNED FOR FOUR BYTES.
    ///
    /// The first version of this searched the whole revert blob for the
    /// expected selector. Four bytes appearing SOMEWHERE is not the same claim
    /// as the hook having reverted with them: they could as easily be part of
    /// an address, an amount, or a pool id. v4 wraps a failing hook callback in
    /// CustomRevert.WrappedError(target, selector, reason, details), so this
    /// takes it apart and checks every field - WHICH contract failed, WHICH
    /// callback it failed in, and the inner error with its arguments.
    function _assertHookReverted(bytes memory data, bytes4 callback, bytes memory expectedInner) internal view {
        require(data.length >= 4, "no revert data at all");
        bytes4 outer;
        assembly ("memory-safe") {
            outer := mload(add(data, 0x20))
        }
        assertEq(
            bytes32(outer), bytes32(CustomRevert.WrappedError.selector),
            "the revert is not v4's WrappedError - the reason below was never checked"
        );

        bytes memory body = new bytes(data.length - 4);
        for (uint256 i = 0; i < body.length; i++) body[i] = data[i + 4];
        (address target, bytes4 selector, bytes memory reason,) =
            abi.decode(body, (address, bytes4, bytes, bytes));

        assertEq(target, address(hook), "a contract other than the hook produced this revert");
        assertEq(bytes32(selector), bytes32(callback), "the hook failed in a different callback");
        assertEq(keccak256(reason), keccak256(expectedInner), "the hook's own error is not the expected one");
    }

    function _mineHook() internal returns (FeeHook) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this), flags, type(FeeHook).creationCode,
            abi.encode(POOL_MANAGER, platform, registryContract, address(this), address(this))
        );
        FeeHook mined = new FeeHook{salt: salt}(POOL_MANAGER, platform, registryContract, address(this), address(this));
        require(address(mined) == hookAddress, "hook did not deploy to the mined address");
        return mined;
    }

    function _keyFor(address token) internal view returns (PoolKey memory) {
        bool nvdacIsCurrency0 = NVDAC < token;
        return PoolKey({
            currency0: Currency.wrap(nvdacIsCurrency0 ? NVDAC : token),
            currency1: Currency.wrap(nvdacIsCurrency0 ? token : NVDAC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function _register(address token, PoolKey memory k, uint16 tax) internal {
        registryContract.register(
            token,
            LaunchRegistry.Launch({
                // A CURVE OF ITS OWN THAT SAYS THE RECORD IS ITS OWN: the
                // registry refuses a curve that does not, and one that
                // another record already names. This contract is still the
                // graduator the curve answers to.
                curve: _recordCurve(token, NVDAC, address(this)),
                quoteToken: NVDAC,
                beneficiary: creator,
                refundTo: creator,
                reservedZero: 0,
                fee: k.fee,
                tickSpacing: k.tickSpacing,
                hooks: IHooks(address(hook)),
                totalTaxBps: tax,
                // THE SNAPSHOT THE HOOK WILL READ. A real launch takes these
                // off the hook once, at creation; these fixtures write the
                // record by hand, so they write what the hook says now.
                platformBps: hook.platformFeeBps(),
                platformRecipient: hook.platformRecipient(),
                launchedAt: 0
            })
        );
    }

    function _registerAndConfigure(address token, PoolKey memory k, uint16 tax) internal {
        _register(token, k, tax);
        hook.configureLaunch(token, k);
    }

    /// The policy's arithmetic, written once so no test can drift from it.
    function _legs(uint256 base, uint16 tax) internal pure returns (uint256 platformCut, uint256 creatorCut) {
        platformCut = (base * PLATFORM_BPS) / BPS;
        creatorCut = (base * (tax - PLATFORM_BPS)) / BPS;
    }

    function _userSwap(PoolKey memory k, bool buyingMeme) internal {
        address tokenIn = buyingMeme ? NVDAC : address(meme);
        uint256 amount = buyingMeme ? SWAP_IN : 1e16;
        vm.prank(user);
        IERC20(tokenIn).transfer(address(harness), amount);
        bool quoteIsCurrency0 = Currency.unwrap(k.currency0) == NVDAC;
        bool zeroForOne = buyingMeme ? quoteIsCurrency0 : !quoteIsCurrency0;
        address outToken = buyingMeme ? address(meme) : NVDAC;
        // ONLY WHAT THE SWAP PRODUCED. The harness still holds the unspent half
        // of its seeding capital, and handing over its whole balance made the
        // trader look 4e8 NVDAc richer than the trade had made them.
        uint256 harnessOutBefore = IERC20(outToken).balanceOf(address(harness));
        harness.swap(k, zeroForOne, -int256(amount));
        // The harness holds what came back; hand it to the trader so the
        // balances this test reads are the trader's own.
        //
        // READ THE BALANCE BEFORE THE PRANK. An external call inside the
        // arguments of a pranked call IS the call the prank applies to, so
        // balanceOf() consumed it and the transfer then came from this test
        // contract, which holds nothing. The repo has this trap written down
        // twice already and it still caught me a third time.
        uint256 back = IERC20(outToken).balanceOf(address(harness)) - harnessOutBefore;
        vm.prank(address(harness));
        IERC20(outToken).transfer(user, back);
    }

    /// A whole new pool at `tax`, one buy or sell through it, and what each
    /// side was paid. Fresh every time so the price is identical across taxes.
    function _freshPoolSwap(uint16 tax, bool buyingMeme) internal returns (uint256 platformCut, uint256 creatorCut) {
        (platformCut, creatorCut,) = _freshPool(tax, buyingMeme);
    }

    function _freshPoolSell(uint16 tax) internal returns (uint256 platformCut, uint256 creatorCut, uint256 gross) {
        return _freshPool(tax, false);
    }

    function _freshPool(uint16 tax, bool buyingMeme)
        internal
        returns (uint256 platformCut, uint256 creatorCut, uint256 gross)
    {
        PoolHarness h = new PoolHarness(POOL_MANAGER);
        MemeToken m = new MemeToken(address(h), 1_000_000e18);
        PoolKey memory k = _keyFor(address(m));
        _registerAndConfigure(address(m), k, tax);

        // ENOUGH FOR THE LIQUIDITY AND NO MORE. Six of these run in one test
        // and the holder is not bottomless - funding each like the main
        // fixture emptied it half way through.
        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(h), 12e7);
        POOL_MANAGER.initialize(k, SQRT_PRICE_1_1);
        h.addLiquidity(
            k, (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING, (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING,
            LIQUIDITY
        );

        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
        uint256 creatorBefore = IERC20(NVDAC).balanceOf(creator);
        uint256 poolBefore = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        bool quoteIsCurrency0 = Currency.unwrap(k.currency0) == NVDAC;
        if (buyingMeme) {
            vm.prank(NVDAC_HOLDER);
            IERC20(NVDAC).transfer(address(h), SWAP_IN);
            h.swap(k, quoteIsCurrency0, -int256(uint256(SWAP_IN)));
        } else {
            h.swap(k, !quoteIsCurrency0, -int256(uint256(1e16)));
            gross = IERC20(NVDAC).balanceOf(address(POOL_MANAGER)) < poolBefore
                ? poolBefore - IERC20(NVDAC).balanceOf(address(POOL_MANAGER))
                : 0;
        }

        platformCut = IERC20(NVDAC).balanceOf(platform) - platformBefore;
        creatorCut = IERC20(NVDAC).balanceOf(creator) - creatorBefore;
    }
}
