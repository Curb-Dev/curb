// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {PoolHarness, MemeToken} from "./B20UniswapV4.t.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// See B20UniversalRouter.t.sol: the deployed router rejects v4-periphery
/// 1.0.4's struct, which carries an extra minHopPriceX36 after
/// amountOutMinimum. This is the layout the live contract accepts.
struct ExactInputSingleLegacy {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/**
 * @notice The smallest hook that can prove it ran. It counts calls and records
 * the last swapper, so "the callback fired" is an observable fact rather than
 * an inference from the swap having succeeded.
 *
 * It takes no fee and returns no delta. Fee collection is a separate question
 * and a separate test - this one only asks whether a hooked pool is reachable.
 */
contract CountingHook is IHooks {
    IPoolManager public immutable poolManager;

    uint256 public beforeSwapCalls;
    uint256 public afterSwapCalls;
    address public lastSwapSender;

    error NotPoolManager();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        beforeSwapCalls++;
        lastSwapSender = sender;
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        afterSwapCalls++;
        return (IHooks.afterSwap.selector, int128(0));
    }

    // Everything else is unused. The address's permission bits say so, and v4
    // validates that claim, so these can never be reached.
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    error HookNotImplemented();
}

/**
 * @title B20HookedPoolForkTest
 * @notice The hooked half of Q1. A pool with a hook is a DIFFERENT pool - the
 * hook address is a field of PoolKey - so this creates its own, and nothing
 * here is shared with the hookless pool beyond the tokens.
 *
 * Three things have to hold together, and finding HookMiner in the repo proves
 * none of them:
 *   1. the mined address really carries the permission bits we claim
 *   2. the hook actually deploys there
 *   3. the callbacks actually fire on a real swap
 *
 * SCOPE. The hook takes no fee. Whether OUR fee-taking hook collects correctly
 * is a separate question and needs its own test.
 */
contract B20HookedPoolForkTest is B20ForkTest {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IUniversalRouter internal constant ROUTER = IUniversalRouter(0x6fF5693b99212Da76ad316178A184AB56D299b43);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;

    uint8 internal constant V4_SWAP = 0x10;
    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    int256 internal constant LIQUIDITY = 1e8;
    uint128 internal constant SWAP_IN = 1e6;

    address internal user = makeAddr("hooked-router-user");

    CountingHook internal hook;
    MemeToken internal meme;
    PoolHarness internal harness;
    PoolKey internal key;

    function setUp() public {
        if (!_forkGuard()) return;

        harness = new PoolHarness(POOL_MANAGER);
        meme = new MemeToken(address(harness), 1_000_000e18);

        // v4 reads a hook's permissions out of its ADDRESS, so the address has
        // to be mined to carry exactly the flags the hook implements.
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        // Mine for THIS contract as the deployer: `new X{salt:}` is CREATE2
        // with the calling contract as deployer, so mining against the shared
        // CREATE2 factory address produces an address we could never reach.
        // The require below is what caught that.
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(CountingHook).creationCode, abi.encode(POOL_MANAGER));
        hook = new CountingHook{salt: salt}(POOL_MANAGER);
        require(address(hook) == hookAddress, "hook did not deploy to the mined address");

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(harness), 5e8);

        bool nvdacIsCurrency0 = NVDAC < address(meme);
        key = PoolKey({
            currency0: Currency.wrap(nvdacIsCurrency0 ? NVDAC : address(meme)),
            currency1: Currency.wrap(nvdacIsCurrency0 ? address(meme) : NVDAC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

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

    /// Step 1 of the three: the address itself carries the permissions.
    function test_hookAddressCarriesTheClaimedPermissions() public onlyFork {
        uint160 permissions = uint160(address(hook)) & Hooks.ALL_HOOK_MASK;
        uint160 expected = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);

        // Equality, not "these two bits are set". An address can carry extra
        // permission bits by accident of mining, and v4 would then call
        // callbacks this hook does not implement.
        assertEq(permissions, expected, "hook address claims a different permission set than intended");
        assertGt(address(hook).code.length, 0, "hook did not deploy");
    }

    /// A hooked pool is a different pool: same tokens, same fee, same spacing,
    /// different id, because the hook is part of the key.
    function test_hookedPoolIsADifferentPool() public onlyFork {
        assertEq(address(key.hooks), address(hook), "pool key does not carry the hook");
        assertTrue(address(key.hooks) != address(0), "this is the hookless pool");
    }

    /// Step 3, and the one that matters: a real user's swap through the
    /// official router actually enters the hook.
    /// This hook charges nothing, so a swap through it must produce EXACTLY
    /// what the hookless pool produces from the same starting state.
    /// B20UniversalRouter.t.sol measures that as 987158 on a fresh pool.
    uint256 internal constant EXPECTED_OUT_FIRST_SWAP = 987158;
    /// The reverse swap runs AFTER the first one has moved the price, so it is
    /// not symmetric with it and must not be checked against the fresh-pool
    /// figure. This is what the hookless direct test produced in the same
    /// sequence.
    uint256 internal constant EXPECTED_OUT_SECOND_SWAP = 1006838;

    function test_swapThroughRouterFiresTheHook() public onlyFork {
        uint256 before_ = hook.beforeSwapCalls();
        uint256 after_ = hook.afterSwapCalls();

        uint256 received = _swapThroughRouter(NVDAC, address(meme), SWAP_IN);

        assertEq(hook.beforeSwapCalls(), before_ + 1, "beforeSwap did not fire");
        assertEq(hook.afterSwapCalls(), after_ + 1, "afterSwap did not fire");
        assertEq(received, EXPECTED_OUT_FIRST_SWAP, "a fee-free hook changed the amount received");

        // Assert, not just log. This is what shows the swap arrived through
        // the router rather than from some other caller.
        assertEq(hook.lastSwapSender(), address(ROUTER), "the hook was not entered via the UniversalRouter");
    }

    function test_swapBothDirectionsThroughRouter() public onlyFork {
        uint256 out1 = _swapThroughRouter(NVDAC, address(meme), SWAP_IN);
        uint256 out2 = _swapThroughRouter(address(meme), NVDAC, SWAP_IN);

        assertEq(hook.beforeSwapCalls(), 2, "hook should have seen both swaps");
        assertEq(hook.afterSwapCalls(), 2, "hook should have seen both swaps");
        assertEq(out1, EXPECTED_OUT_FIRST_SWAP, "forward swap differed from the fee-free expectation");
        assertEq(out2, EXPECTED_OUT_SECOND_SWAP, "reverse swap differed from the fee-free expectation");
        assertEq(hook.lastSwapSender(), address(ROUTER), "the hook was not entered via the UniversalRouter");
    }

    // ------------------------------------------------------------------

    function _swapThroughRouter(address tokenIn, address tokenOut, uint128 amountIn) internal returns (uint256) {
        vm.startPrank(user);
        IERC20(tokenIn).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(tokenIn, address(ROUTER), uint160(amountIn), uint48(block.timestamp + 3600));
        vm.stopPrank();

        uint256 inBefore = IERC20(tokenIn).balanceOf(user);
        uint256 outBefore = IERC20(tokenOut).balanceOf(user);

        bool zeroForOne = tokenIn == Currency.unwrap(key.currency0);
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleLegacy({
                poolKey: key, zeroForOne: zeroForOne, amountIn: amountIn, amountOutMinimum: 1, hookData: ""
            })
        );
        params[1] = abi.encode(Currency.wrap(tokenIn), amountIn);
        params[2] = abi.encode(Currency.wrap(tokenOut), uint128(1));

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        vm.prank(user);
        ROUTER.execute(abi.encodePacked(V4_SWAP), inputs, block.timestamp + 60);

        assertEq(inBefore - IERC20(tokenIn).balanceOf(user), amountIn, "router took a different input");
        return IERC20(tokenOut).balanceOf(user) - outBefore;
    }
}
