// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

/// @notice The meme side of the pair. Plain 18-decimal ERC-20 so that the only
/// unusual token in the test is the B20 one.
contract MemeToken is ERC20 {
    constructor(address to, uint256 supply) ERC20("Curb Test Meme", "CURBTEST") {
        _mint(to, supply);
    }
}

/**
 * @notice Talks to the real PoolManager through unlock/unlockCallback.
 *
 * Deliberately minimal. It exists to test whether a B20 asset can be paid into
 * and taken out of v4 core, so it does the settlement by hand:
 *   owed to the pool   sync(currency) -> transfer to the manager -> settle()
 *   owed to us         take(currency, recipient, amount)
 * PositionManager and Permit2 are NOT used, so nothing here says anything
 * about their compatibility.
 */
contract PoolHarness is IUnlockCallback {
    IPoolManager public immutable poolManager;

    enum Action {
        AddLiquidity,
        Swap
    }

    error NotPoolManager();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// The callback must only ever be entered by the manager we unlocked.
    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidityDelta)
        external
        returns (BalanceDelta delta)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(Action.AddLiquidity, key, tickLower, tickUpper, liquidityDelta, false, int256(0), uint160(0))
        );
        delta = abi.decode(result, (BalanceDelta));
    }

    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified) external returns (BalanceDelta delta) {
        return swapToLimit(key, zeroForOne, amountSpecified, 0);
    }

    /// @notice The same swap with a price limit the pool can actually reach.
    /// @dev A limit of 0 means "no limit" and takes the wide bound below. A
    ///      near limit is how a PARTIAL FILL is produced: an exact-input swap
    ///      stops at the limit and leaves part of the input unspent. Nothing in
    ///      our own interface sets one, which is exactly why a test needs to be
    ///      able to.
    function swapToLimit(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 limit)
        public
        returns (BalanceDelta delta)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(Action.Swap, key, int24(0), int24(0), int256(0), zeroForOne, amountSpecified, limit)
        );
        delta = abi.decode(result, (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (
            Action action,
            PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            int256 liquidityDelta,
            bool zeroForOne,
            int256 amountSpecified,
            uint160 limit
        ) = abi.decode(data, (Action, PoolKey, int24, int24, int256, bool, int256, uint160));

        BalanceDelta delta;
        if (action == Action.AddLiquidity) {
            (delta,) = poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(0)
                }),
                ""
            );
        } else {
            delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: amountSpecified,
                    sqrtPriceLimitX96: limit != 0
                        ? limit
                        : (zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
                }),
                ""
            );
        }

        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    /// Negative delta is owed to the pool, positive is owed to us.
    function _settle(Currency currency, int128 amount) private {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            // sync BEFORE the transfer: the manager measures what arrived as a
            // balance delta against the value it recorded at sync.
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).transfer(address(poolManager), owed);
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(currency, address(this), uint256(uint128(amount)));
        }
    }
}

/**
 * @title B20UniswapV4ForkTest
 * @notice Does a B20 asset work in Uniswap v4 core?
 *
 * Runs against the local base-anvil fork, which serves real B20 behaviour. See
 * B20_ENVIRONMENT.txt. It uses the PoolManager already deployed on Base at the
 * forked block rather than deploying one, so the result speaks about the live
 * contract and not about some other version of it.
 *
 * SCOPE. This exercises PoolManager only: initialize, modifyLiquidity, swap,
 * and manual sync/settle/take. It says NOTHING about PositionManager, Permit2,
 * or locking an LP position NFT, none of which are touched. If graduation ends
 * up using those, they need their own proof.
 */
contract B20UniswapV4ForkTest is B20ForkTest {
    /// The live Base deployment, verified on chain: codesize 24009, and its
    /// PositionManager points back at it.
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    /// 1:1 in raw units. The two sides have different decimals, so this is not
    /// an economically meaningful price - it only has to be a valid one.
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    /// Full range at a 1:1 raw price needs roughly this many raw units of each
    /// side, so it is bounded by the NVDAc we actually hold (5e8 = 5.0 NVDAc).
    int256 internal constant LIQUIDITY = 1e8;
    /// One percent of the position, so the swap moves the pool without
    /// exhausting it.
    int256 internal constant SWAP_IN = 1e6;

    int24 internal tickLower;
    int24 internal tickUpper;

    MemeToken internal meme;
    PoolHarness internal harness;
    PoolKey internal key;
    bool internal nvdacIsCurrency0;

    /// Without this every test below used to `return` on a non-fork chain and
    /// be reported as PASS - three green results proving nothing. A normal
    /// `forge test` must show them SKIPPED, and a run that MEANT to be a fork
    /// run must FAIL loudly rather than skip.
    function setUp() public {
        if (!_forkGuard()) return;

        harness = new PoolHarness(POOL_MANAGER);
        meme = new MemeToken(address(harness), 1_000_000e18);

        // Real NVDAc, moved from a real holder.
        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(harness), 5e8); // 5.0 NVDAc

        nvdacIsCurrency0 = NVDAC < address(meme);
        key = PoolKey({
            currency0: Currency.wrap(nvdacIsCurrency0 ? NVDAC : address(meme)),
            currency1: Currency.wrap(nvdacIsCurrency0 ? address(meme) : NVDAC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });

        tickLower = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        tickUpper = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);
    }

    function test_step3_poolWithB20Initializes() public onlyFork {
        assertEq(IERC20(NVDAC).balanceOf(address(harness)), 5e8, "harness did not receive real NVDAc");
        // The pool exists: initialize() in setUp would have reverted otherwise.
        assertTrue(Currency.unwrap(key.currency0) != address(0), "pool key not built");
        assertTrue(
            Currency.unwrap(key.currency0) < Currency.unwrap(key.currency1), "currencies are not in canonical order"
        );
    }

    /// Helper: what the delta says about NVDAc and MEME, signed from the
    /// harness's point of view (negative = paid in).
    function _split(BalanceDelta delta) internal view returns (int128 nvdac, int128 memeAmt) {
        if (nvdacIsCurrency0) {
            return (delta.amount0(), delta.amount1());
        }
        return (delta.amount1(), delta.amount0());
    }

    function test_step4_addLiquidityWithB20() public onlyFork {
        uint256 hN0 = IERC20(NVDAC).balanceOf(address(harness));
        uint256 hM0 = meme.balanceOf(address(harness));
        uint256 pN0 = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        uint256 pM0 = meme.balanceOf(address(POOL_MANAGER));

        BalanceDelta delta = harness.addLiquidity(key, tickLower, tickUpper, LIQUIDITY);
        (int128 dN, int128 dM) = _split(delta);

        emit log_named_int("liquidity delta NVDAc", dN);
        emit log_named_int("liquidity delta MEME ", dM);

        // Adding liquidity can only cost the provider.
        assertLt(dN, 0, "NVDAc delta should be negative when adding liquidity");
        assertLt(dM, 0, "MEME delta should be negative when adding liquidity");

        uint256 nOwed = uint256(uint128(-dN));
        uint256 mOwed = uint256(uint128(-dM));

        // The harness paid exactly what the delta said, on BOTH tokens.
        assertEq(hN0 - IERC20(NVDAC).balanceOf(address(harness)), nOwed, "harness NVDAc does not match the delta");
        assertEq(hM0 - meme.balanceOf(address(harness)), mOwed, "harness MEME does not match the delta");

        // And the PoolManager received exactly that, on BOTH tokens. Checking
        // only the payer would miss value going somewhere else.
        assertEq(IERC20(NVDAC).balanceOf(address(POOL_MANAGER)) - pN0, nOwed, "PoolManager NVDAc does not mirror");
        assertEq(meme.balanceOf(address(POOL_MANAGER)) - pM0, mOwed, "PoolManager MEME does not mirror");
    }

    function test_step5_swapBothDirections() public onlyFork {
        harness.addLiquidity(key, tickLower, tickUpper, LIQUIDITY);

        _assertSwapMirrors(nvdacIsCurrency0, "NVDAc -> MEME");
        _assertSwapMirrors(!nvdacIsCurrency0, "MEME -> NVDAc");
    }

    /// One swap, with every movement checked against the returned delta:
    /// exact input, exact output, and the PoolManager mirroring both.
    function _assertSwapMirrors(bool zeroForOne, string memory label) internal {
        uint256 hN0 = IERC20(NVDAC).balanceOf(address(harness));
        uint256 hM0 = meme.balanceOf(address(harness));
        uint256 pN0 = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        uint256 pM0 = meme.balanceOf(address(POOL_MANAGER));

        BalanceDelta delta = harness.swap(key, zeroForOne, -SWAP_IN);
        (int128 dN, int128 dM) = _split(delta);

        emit log_named_string("swap", label);
        emit log_named_int("  delta NVDAc", dN);
        emit log_named_int("  delta MEME ", dM);

        // Exactly one side is paid in and one is received.
        assertTrue((dN < 0 && dM > 0) || (dM < 0 && dN > 0), "a swap must move the two sides in opposite directions");

        // The paid side must equal the exact input that was requested.
        int128 paid = dN < 0 ? dN : dM;
        assertEq(uint256(uint128(-paid)), uint256(SWAP_IN), "swap did not take exactly the requested input");

        _assertMirror(IERC20(NVDAC), dN, hN0, pN0, "NVDAc");
        _assertMirror(IERC20(address(meme)), dM, hM0, pM0, "MEME");
    }

    /// The harness moves by the delta and the PoolManager moves by its exact
    /// opposite. Asserting the output side is the part that was missing: it
    /// was previously only checked to have gone up.
    function _assertMirror(IERC20 token, int128 d, uint256 h0, uint256 p0, string memory name) internal view {
        uint256 h1 = token.balanceOf(address(harness));
        uint256 p1 = token.balanceOf(address(POOL_MANAGER));
        if (d < 0) {
            uint256 amt = uint256(uint128(-d));
            assertEq(h0 - h1, amt, string.concat(name, ": harness did not pay the delta amount"));
            assertEq(p1 - p0, amt, string.concat(name, ": PoolManager did not receive the delta amount"));
        } else {
            uint256 amt = uint256(uint128(d));
            assertEq(h1 - h0, amt, string.concat(name, ": harness did not receive the delta amount"));
            assertEq(p0 - p1, amt, string.concat(name, ": PoolManager did not pay the delta amount"));
        }
    }
}
