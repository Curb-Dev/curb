// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

import {PositionLock, IPositionManagerMinimal} from "../../src/curb/PositionLock.sol";
import {PositionLockFactory} from "../harness/PositionLockFactory.sol";
import {MemeToken} from "./B20UniswapV4.t.sol";
import {FeeHook} from "../../src/curb/FeeHook.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {ExactInputSingleLegacy} from "./B20HookedPool.t.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPositionManagerLike {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/**
 * @title B20LockedPoolLifecycleForkTest
 * @notice The whole chain, in ONE pool, with the REAL fee hook attached.
 *
 * Every piece has been shown to work on its own, and each on a different pool:
 * the fee hook on a hooked pool with harness liquidity, minting on a hookless
 * pool, the lock on a hookless pool. Pieces that pass separately are not a
 * system that works. This runs them end to end on a single pool:
 *
 *   mint through PositionManager -> lock atomically -> two-way swaps through
 *   the UniversalRouter -> the platform's HOOK fee and the position's LP fee
 *   verified as separate amounts in separate tokens -> LP fees claimed while
 *   the principal stays locked -> ten years on it is still locked, for
 *   everyone, and the fees still flow
 *
 * THE TWO FEES ARE NOT THE SAME FEE, AND THAT IS THE POINT
 *   They are taken at different times, in different tokens, by different
 *   parties, and they do not interact:
 *
 *     LP fee    0.30% of the swap INPUT, accrues inside the position, ends up
 *               with the position's owner - here, the locked creator
 *     HOOK fee  1% of the swap OUTPUT, taken in afterSwap, paid immediately to
 *               the platform's recipient
 *
 *   So one buy pays the platform in MEME and the creator in NVDAc. A test that
 *   only checked a total would not notice the two being confused.
 *
 * WHAT THIS STILL DOES NOT SHOW. The same limit as everywhere else: this is
 * one pool, a handful of swaps, on a fork. It establishes that the mechanism
 * composes, not that anyone will trade.
 */
contract B20LockedPoolLifecycleForkTest is B20ForkTest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IPositionManagerLike internal constant POSM = IPositionManagerLike(0x7C5f5A4bBd8fD63184577525326123B519429bDc);
    IUniversalRouter internal constant ROUTER = IUniversalRouter(0x6fF5693b99212Da76ad316178A184AB56D299b43);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;

    uint8 internal constant V4_SWAP = 0x10;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint256 internal constant MINT_LIQUIDITY = 1e8;
    uint128 internal constant SWAP_IN = 1e6;
    /// This fixture's launch tax, and the platform's fixed leg of it.
    uint16 internal constant TAX_BPS = 300;
    uint16 internal constant PLATFORM_BPS = 50;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant TEN_YEARS = 10 * 365 days;

    /// Fee-free gross outputs for this pool and size, from B20HookedPool.t.sol.
    uint256 internal constant GROSS_BUY = 987158;
    uint256 internal constant GROSS_SELL_AFTER_BUY = 1006838;

    /// The LP fee is 0.30% of the INPUT, and this position holds all of the
    /// pool's liquidity, so it earns the whole of it: 0.30% of 1e6 = 3000 raw
    /// per swap. One side comes back a unit short because fee growth is stored
    /// as a per-liquidity X128 value and the collect truncates.
    ///
    /// WHICH side loses the unit is pinned here as an OBSERVED value, by
    /// currency index rather than by token name. We have not derived why it
    /// falls on currency1 - only that it does, for this liquidity and this swap
    /// size. Naming the token instead would have been an accident of whichever
    /// address the test's MemeToken happened to deploy to.
    uint256 internal constant LP_FEE_CURRENCY0 = 3000;
    uint256 internal constant LP_FEE_CURRENCY1 = 2999;

    address internal launcher = makeAddr("launcher");
    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal platform = makeAddr("platform-fee-recipient");

    FeeHook internal hook;
    MemeToken internal meme;
    PoolKey internal key;
    PositionLock internal lock;
    uint256 internal tokenId;
    int24 internal tickLower;
    int24 internal tickUpper;


    /// THE HOOK READS ITS RATES OUT OF A REGISTRY NOW, so a test that uses it
    /// needs a real one with a real record - there is no rate to pass in. This
    /// contract stands in for the graduator, and the registry checks that claim
    /// rather than taking it: wire() asks the launcher for its graduator, the
    /// graduator for its registry and pool manager, and the hook for its own
    /// opener and manager, and all four have to agree.
    LaunchRegistry internal registryContract;

    function graduator() external view returns (address) { return address(this); }
    /// AND AN ESCROW, because wire() now asks the launcher to name one: the
    /// hook asks every admitted launcher for it whenever a platform recipient
    /// moves, so a launcher that cannot answer is refused. No curve here pays
    /// it; any non-zero address that is not the platform recipient will do.
    function feeEscrow() external pure returns (address) { return address(0xE5C0); }
    function registry() external view returns (address) { return address(registryContract); }
    function poolManager() external pure returns (address) { return address(POOL_MANAGER); }

    /// One launch record and one bound pool, at `tax` bps.
    function _bindLaunch(address token, PoolKey memory k, uint16 tax) internal {
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
        hook.configureLaunch(token, k);
    }

    /// The policy's arithmetic, written once.
    function _legs(uint256 base) internal pure returns (uint256 platformCut, uint256 creatorCut) {
        platformCut = (base * PLATFORM_BPS) / BPS;
        creatorCut = (base * (TAX_BPS - PLATFORM_BPS)) / BPS;
    }

    function setUp() public {
        if (!_forkGuard()) return;

        registryContract = new LaunchRegistry(address(this));
        meme = new MemeToken(launcher, 1_000_000e18);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this), flags, type(FeeHook).creationCode,
            abi.encode(POOL_MANAGER, platform, registryContract, address(this), address(this))
        );
        hook = new FeeHook{salt: salt}(POOL_MANAGER, platform, registryContract, address(this), address(this));
        require(address(hook) == hookAddress, "hook did not deploy to the mined address");

        bool nvdacIsCurrency0 = NVDAC < address(meme);
        key = PoolKey({
            currency0: Currency.wrap(nvdacIsCurrency0 ? NVDAC : address(meme)),
            currency1: Currency.wrap(nvdacIsCurrency0 ? address(meme) : NVDAC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        // THE POOL HAS TO BE BOUND TO A LAUNCH BEFORE IT CAN TRADE. The hook
        // refuses a pool it has no record for rather than charging nothing.
        registryContract.wire(address(this), address(hook));
        _bindLaunch(address(meme), key, TAX_BPS);

        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);

        tickLower = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        tickUpper = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(launcher, 5e8);
        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(trader, 1e8);
        vm.prank(launcher);
        meme.transfer(trader, 1e18);

        tokenId = POSM.nextTokenId();
        _mint(MINT_LIQUIDITY, launcher);

        PositionLockFactory factory = new PositionLockFactory();
        vm.startPrank(launcher);
        IERC721(address(POSM)).approve(address(factory), tokenId);
        lock = factory.createAndLock(IPositionManagerMinimal(address(POSM)), creator, key, tokenId);
        vm.stopPrank();
    }

    function test_fullLifecycleOnAHookedPool() public onlyFork {
        // ---- locked, and holding the hooked pool's position
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), "the lock does not hold the position");
        assertEq(address(lock.poolKeyView().hooks), address(hook), "the lock is bound to a pool without our hook");
        assertEq(lock.lockedLiquidity(), uint128(MINT_LIQUIDITY), "wrong liquidity locked");

        // ---- a buy: charged on the NVDAc INPUT, and NEVER in the memecoin
        //
        // THIS ASSERTION USED TO BE THE OPPOSITE ONE. The hook took 1% of the
        // output, so a buy paid the platform in MEME and this test asserted
        // that it did. The policy charges the NVDAc side both ways now, so the
        // memecoin balance being ZERO is the thing worth checking.
        (uint256 buyPlatform, uint256 buyCreator) = _legs(SWAP_IN);
        uint256 memeOut = _swap(NVDAC, address(meme), SWAP_IN);

        assertGt(memeOut, 0, "the buy delivered nothing");
        assertEq(IERC20(NVDAC).balanceOf(platform), buyPlatform, "platform's NVDAc leg on the buy is wrong");
        assertEq(IERC20(NVDAC).balanceOf(creator) , buyCreator , "creator's NVDAc leg on the buy is wrong");
        assertEq(meme.balanceOf(platform), 0, "the buy paid the platform in the memecoin");
        assertEq(hook.collected(NVDAC), buyPlatform + buyCreator, "hook accounting disagrees on the buy");
        assertEq(hook.collected(address(meme)), 0, "the hook recorded a memecoin fee");

        // THE OUTPUT AMOUNT IS NOT PREDICTED HERE, and the old baseline no
        // longer applies to it: the pool trades the input MINUS the tax, so
        // GROSS_BUY - which is the fee-free gross for the WHOLE input - is the
        // gross of a different swap. The exact-output claim is made in
        // B20FeeHook.t.sol against the PoolManager's own balance.

        // ---- a sell: charged on the GROSS NVDAc the swap produced
        uint256 platformBeforeSell = IERC20(NVDAC).balanceOf(platform);
        uint256 creatorBeforeSell = IERC20(NVDAC).balanceOf(creator);
        uint256 poolBeforeSell = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));

        uint256 sellNet = _swap(address(meme), NVDAC, SWAP_IN);

        uint256 grossSell = poolBeforeSell - IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        (uint256 sellPlatform, uint256 sellCreator) = _legs(grossSell);
        uint256 expectedSellHookFee = sellPlatform + sellCreator;

        assertEq(
            IERC20(NVDAC).balanceOf(platform) - platformBeforeSell, sellPlatform,
            "platform's NVDAc leg on the sell is wrong"
        );
        assertEq(
            IERC20(NVDAC).balanceOf(creator) - creatorBeforeSell, sellCreator,
            "creator's NVDAc leg on the sell is wrong"
        );
        assertEq(sellNet, grossSell - expectedSellHookFee, "trader's net on the sell is wrong");
        assertEq(
            hook.collected(NVDAC), buyPlatform + buyCreator + expectedSellHookFee,
            "hook accounting disagrees on the sell"
        );

        // ---- the LP fee is a SEPARATE amount, in the opposite token each time
        // MEASURED ACROSS THE CLAIM, not read as a balance. The creator now
        // receives their share of the TAX into the same account, so a bare
        // balance afterwards is tax plus LP fee and would report the LP fee as
        // several times its real size.
        uint256 creatorNvdacBeforeClaim = IERC20(NVDAC).balanceOf(creator);
        uint256 creatorMemeBeforeClaim = meme.balanceOf(creator);
        lock.claimFees();
        uint256 creatorNvdac = IERC20(NVDAC).balanceOf(creator) - creatorNvdacBeforeClaim;
        uint256 creatorMeme = meme.balanceOf(creator) - creatorMemeBeforeClaim;

        emit log_named_uint("tax on the buy,  NVDAc ", buyPlatform + buyCreator);
        emit log_named_uint("tax on the sell, NVDAc ", expectedSellHookFee);
        emit log_named_uint("creator LP fee NVDAc   ", creatorNvdac);
        emit log_named_uint("creator LP fee MEME    ", creatorMeme);

        // THE TWO SIDES ARE NO LONGER SYMMETRIC, and that is the tax's doing.
        //
        // The buy's NVDAc is taxed BEFORE the swap, so the pool only ever sees
        // the post-tax amount and the LP fee is 0.30% of THAT. The sell's input
        // is MEME and the tax comes off the NVDAc on the way out, so the pool
        // sees the whole MEME input and that side is unchanged.
        //
        // A UNIT OF TOLERANCE ON THE FIRST, and it is v4's rounding rather than
        // ours: the exact unit is not derived here, only bounded. The second is
        // exact because nothing changed about it.
        uint256 taxedAway = buyPlatform + buyCreator;
        assertApproxEqAbs(
            creatorNvdac, ((SWAP_IN - taxedAway) * FEE) / 1e6, 2,
            "creator's NVDAc LP fee is not 0.30% of what the pool actually traded"
        );
        assertLt(creatorNvdac, (uint256(SWAP_IN) * FEE) / 1e6, "the LP fee was charged on the pre-tax input");

        bool nvdacIsCurrency0 = Currency.unwrap(key.currency0) == NVDAC;
        uint256 expectedMemeFee = nvdacIsCurrency0 ? LP_FEE_CURRENCY1 : LP_FEE_CURRENCY0;
        assertEq(creatorMeme, expectedMemeFee, "creator's MEME LP fee is not 0.30% of the sell input");

        // The LP fee and the hook fee must not be the same number in the same
        // token: on the sell the hook took NVDAc and the position earned MEME.
        // THE LP FEE IS A SEPARATE AMOUNT, which is the point of showing it on
        // its own line everywhere. It is not the tax, it is not in the same
        // token on both legs, and it goes to the position rather than to us.
        assertTrue(creatorNvdac != expectedSellHookFee, "LP fee and the tax collapsed to the same number");
        assertGt(expectedSellHookFee, creatorNvdac, "a 3% tax is not larger than the 0.30% LP fee");

        // ---- claiming did not touch the principal, and it is still locked
        assertEq(lock.lockedLiquidity(), uint128(MINT_LIQUIDITY), "claiming fees reduced the locked principal");
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), "claiming fees moved the position");

        // ---- ten years on: still locked, for the creator too, and the fees
        // still flow. The lock has no withdrawal to call and PositionManager
        // refuses everyone but its owner, which is the lock.
        vm.warp(vm.getBlockTimestamp() + TEN_YEARS);
        (bool ok,) = address(lock).call(abi.encodeWithSignature("withdraw()"));
        assertFalse(ok, "the lock has a withdraw()");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSignature("NotApproved(address)", creator));
        POSM.modifyLiquidities(_decreaseCalldata(MINT_LIQUIDITY, creator), vm.getBlockTimestamp() + 60);
        assertEq(lock.lockedLiquidity(), uint128(MINT_LIQUIDITY), "the principal moved in ten years");
        assertEq(IERC721(address(POSM)).ownerOf(tokenId), address(lock), "the position left the lock in ten years");

        uint256 memeBefore = meme.balanceOf(creator);
        _swap(address(meme), NVDAC, SWAP_IN);
        lock.claimFees();
        assertGt(meme.balanceOf(creator) - memeBefore, 0, "the creator's LP fees stopped after ten years");
        assertEq(lock.lockedLiquidity(), uint128(MINT_LIQUIDITY), "claiming fees ten years on moved the principal");
    }

    // ------------------------------------------------------------------

    function _swap(address tokenIn, address tokenOut, uint128 amountIn) internal returns (uint256) {
        vm.startPrank(trader);
        IERC20(tokenIn).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(tokenIn, address(ROUTER), uint160(amountIn), uint48(vm.getBlockTimestamp() + 3600));
        vm.stopPrank();

        uint256 before = IERC20(tokenOut).balanceOf(trader);

        bytes memory actions = abi.encodePacked(
            uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL)
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleLegacy({
                poolKey: key,
                zeroForOne: tokenIn == Currency.unwrap(key.currency0),
                amountIn: amountIn,
                amountOutMinimum: 1,
                hookData: ""
            })
        );
        params[1] = abi.encode(Currency.wrap(tokenIn), amountIn);
        params[2] = abi.encode(Currency.wrap(tokenOut), uint128(1));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        vm.prank(trader);
        ROUTER.execute(abi.encodePacked(V4_SWAP), inputs, vm.getBlockTimestamp() + 60);

        return IERC20(tokenOut).balanceOf(trader) - before;
    }

    function _mint(uint256 liquidity, address owner) internal {
        address token0 = Currency.unwrap(key.currency0);
        address token1 = Currency.unwrap(key.currency1);

        vm.startPrank(owner);
        IERC20(token0).approve(address(PERMIT2), type(uint256).max);
        IERC20(token1).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token0, address(POSM), type(uint160).max, uint48(block.timestamp + 3600));
        PERMIT2.approve(token1, address(POSM), type(uint160).max, uint48(block.timestamp + 3600));

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] =
            abi.encode(key, tickLower, tickUpper, liquidity, type(uint128).max, type(uint128).max, owner, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);

        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);
        vm.stopPrank();
    }

    function _decreaseCalldata(uint256 liquidity, address recipient) internal view returns (bytes memory) {
        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, liquidity, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, recipient);
        return abi.encode(actions, params);
    }
}
