// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {MemeToken} from "./B20UniswapV4.t.sol";
import {FeeHook} from "../../src/curb/FeeHook.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

interface IPositionManagerLike {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function poolManager() external view returns (address);
    function permit2() external view returns (address);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/**
 * @title B20PositionManagerForkTest
 * @notice Can a real LP position be minted on a B20 pool through the OFFICIAL
 *         PositionManager, using the real Permit2 flow?
 *
 * Everything so far added liquidity through our own unlock/unlockCallback
 * harness. That proved v4 core accepts a B20 asset. It says nothing about
 * PositionManager, which is a different contract with a different settlement
 * path, its own ERC-721 accounting, and a Permit2 dependency we had not
 * exercised for liquidity at all.
 *
 * It matters because the launchpad's liquidity has to be a POSITION - an NFT
 * that can be held, locked and pointed at - not an anonymous balance inside a
 * harness. A lock is only meaningful if there is a transferable thing to lock.
 *
 * WHY THIS IS NOT ASSUMED FROM THE ROUTER WORK. The live UniversalRouter
 * rejected the calldata layout in our vendored v4-periphery 1.0.4
 * (ROUTER_ACCESS.txt). PositionManager is from the same vendored tree, so its
 * layout is equally unverified until a transaction says otherwise.
 *
 * ACCEPTANCE CRITERIA
 *   1. the deployed PositionManager is the one bound to the PoolManager and
 *      Permit2 we already use - asserted, not assumed from an address
 *   2. a mint through the real two-step Permit2 flow produces an NFT the
 *      caller owns, with EXACTLY the liquidity requested
 *   3. the tokens actually moved, in amounts that match an independent
 *      computation from the price and the range - not from the measurement
 *   4. the same works on a pool carrying our fee hook, since that is the pool
 *      the product will actually create
 */
contract B20PositionManagerForkTest is B20ForkTest {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IPositionManagerLike internal constant POSM = IPositionManagerLike(0x7C5f5A4bBd8fD63184577525326123B519429bDc);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint256 internal constant MINT_LIQUIDITY = 1e8;

    address internal lp = makeAddr("liquidity-provider");

    MemeToken internal meme;
    PoolKey internal key;
    int24 internal tickLower;
    int24 internal tickUpper;

    function setUp() public {
        if (!_forkGuard()) return;

        meme = new MemeToken(lp, 1_000_000e18);

        bool nvdacIsCurrency0 = NVDAC < address(meme);
        key = PoolKey({
            currency0: Currency.wrap(nvdacIsCurrency0 ? NVDAC : address(meme)),
            currency1: Currency.wrap(nvdacIsCurrency0 ? address(meme) : NVDAC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);

        tickLower = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        tickUpper = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(lp, 5e8);
    }

    /// Criterion 1. An address is not an identity. If this PositionManager were
    /// bound to a different PoolManager, every later assertion would be about
    /// some other pool.
    function test_positionManagerIsBoundToTheSameCoreContracts() public onlyFork {
        assertEq(POSM.poolManager(), address(POOL_MANAGER), "PositionManager points at a different PoolManager");
        assertEq(POSM.permit2(), address(PERMIT2), "PositionManager points at a different Permit2");
        assertGt(address(POSM).code.length, 0, "no PositionManager deployed at this address");
    }

    /// Criteria 2 and 3.
    function test_mintPositionOnB20Pool() public onlyFork {
        (uint256 expected0, uint256 expected1) = _expectedAmounts(MINT_LIQUIDITY);

        uint256 tokenId = POSM.nextTokenId();
        uint256 nvdacBefore = IERC20(NVDAC).balanceOf(lp);
        uint256 memeBefore = meme.balanceOf(lp);

        _mint(key, MINT_LIQUIDITY, lp);

        assertEq(IERC721(address(POSM)).ownerOf(tokenId), lp, "the minted position is not owned by the caller");
        assertEq(POSM.getPositionLiquidity(tokenId), uint128(MINT_LIQUIDITY), "position liquidity is not what we asked");

        uint256 nvdacPaid = nvdacBefore - IERC20(NVDAC).balanceOf(lp);
        uint256 memePaid = memeBefore - meme.balanceOf(lp);
        (uint256 paid0, uint256 paid1) =
            Currency.unwrap(key.currency0) == NVDAC ? (nvdacPaid, memePaid) : (memePaid, nvdacPaid);

        emit log_named_uint("currency0 paid", paid0);
        emit log_named_uint("currency1 paid", paid1);

        // Independent of the measurement: computed from the price and the
        // range with the same rounding the pool uses (UP, in the pool's
        // favour). Exact equality, not a tolerance - a tolerance here would
        // hide precisely the kind of unit error this test exists to catch.
        assertEq(paid0, expected0, "currency0 charged is not the amount the range and price imply");
        assertEq(paid1, expected1, "currency1 charged is not the amount the range and price imply");

        // And the tokens are really in the PoolManager, not stranded in POSM.
        assertEq(IERC20(NVDAC).balanceOf(address(POSM)), 0, "PositionManager kept NVDAc");
        assertEq(meme.balanceOf(address(POSM)), 0, "PositionManager kept MEME");
    }

    /// Criterion 4. The product's pools carry the fee hook, so a mint that only
    /// works on a hookless pool would not be a result about our product.
    function test_mintPositionOnHookedB20Pool() public onlyFork {
        PoolKey memory hookedKey = _hookedPoolKey();

        assertGt(address(hookedKey.hooks).code.length, 0, "the hooked pool's hook has no code");

        uint256 tokenId = POSM.nextTokenId();
        _mint(hookedKey, MINT_LIQUIDITY, lp);

        assertEq(IERC721(address(POSM)).ownerOf(tokenId), lp, "hooked-pool position is not owned by the caller");
        assertEq(
            POSM.getPositionLiquidity(tokenId), uint128(MINT_LIQUIDITY), "hooked-pool position liquidity is wrong"
        );
    }

    // ------------------------------------------------------------------

    function _mint(PoolKey memory poolKey, uint256 liquidity, address owner) internal {
        address token0 = Currency.unwrap(poolKey.currency0);
        address token1 = Currency.unwrap(poolKey.currency1);

        // The real two-step flow. Nothing is impersonated and no approval is
        // shortcut: the token approves Permit2, then Permit2 approves POSM.
        vm.startPrank(owner);
        IERC20(token0).approve(address(PERMIT2), type(uint256).max);
        IERC20(token1).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token0, address(POSM), type(uint160).max, uint48(block.timestamp + 3600));
        PERMIT2.approve(token1, address(POSM), type(uint160).max, uint48(block.timestamp + 3600));

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            poolKey, tickLower, tickUpper, liquidity, type(uint128).max, type(uint128).max, owner, bytes("")
        );
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1);

        POSM.modifyLiquidities(abi.encode(actions, params), block.timestamp + 60);
        vm.stopPrank();
    }

    /// The price sits inside the range, so BOTH sides are owed: currency0 for
    /// the span above the current price and currency1 for the span below.
    /// roundUp is true because that is what the pool does when it charges.
    function _expectedAmounts(uint256 liquidity) internal view returns (uint256 amount0, uint256 amount1) {
        amount0 = SqrtPriceMath.getAmount0Delta(
            SQRT_PRICE_1_1, TickMath.getSqrtPriceAtTick(tickUpper), uint128(liquidity), true
        );
        amount1 = SqrtPriceMath.getAmount1Delta(
            TickMath.getSqrtPriceAtTick(tickLower), SQRT_PRICE_1_1, uint128(liquidity), true
        );
    }

    /// The REAL fee hook, deployed to a mined address, not a stand-in. A pool
    /// keyed to a hook with no permission bits would test nothing: v4 would
    /// never call it, so the mint could not be affected by it either way.
    function _hookedPoolKey() internal returns (PoolKey memory hookedKey) {
        // The hook takes a REGISTRY now rather than a rate - it charges each
        // pool the tax that pool's own launch recorded. Nothing here swaps, so
        // no record is needed; what matters is that the permissions on the
        // address are the real ones.
        LaunchRegistry reg = new LaunchRegistry(address(this));
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        // THE PLATFORM RECIPIENT IS NOT THIS CONTRACT, which is also the
        // hook's poolOpener here: the hook refuses a recipient that is one of
        // the contracts it is built on, and the pool opener is one of them.
        address platform = makeAddr("platform");
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this), flags, type(FeeHook).creationCode,
            abi.encode(POOL_MANAGER, platform, reg, address(this), address(this))
        );
        FeeHook hook = new FeeHook{salt: salt}(POOL_MANAGER, platform, reg, address(this), address(this));
        require(address(hook) == hookAddress, "hook did not deploy to the mined address");

        hookedKey = key;
        hookedKey.hooks = IHooks(address(hook));
        POOL_MANAGER.initialize(hookedKey, SQRT_PRICE_1_1);
    }
}
