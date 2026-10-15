// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";

import {PoolHarness, MemeToken} from "./B20UniswapV4.t.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
    function poolManager() external view returns (address);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// The layout the DEPLOYED router expects, which is not necessarily the one in
/// our vendored v4-periphery. Ours (1.0.4) carries an extra minHopPriceX36
/// field; if the deployment predates it, encoding ours shifts every field
/// after poolKey and the router reverts inside its own unlockCallback.
/// Both layouts are tried, and the test records which one the live contract
/// actually accepts.
struct ExactInputSingleLegacy {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/**
 * @title B20UniversalRouterForkTest
 * @notice Q1 from ROUTER_ACCESS.txt, answered with a transaction: can a swap
 * against a B20 pool be executed through the official UniversalRouter, using
 * the real permission flow a user would go through?
 *
 * The payment path is NOT shortcut. The user approves Permit2 on the token,
 * then Permit2 approves the router, and the router pulls through Permit2 -
 * impersonating the router and moving tokens by hand would prove nothing
 * about whether a real user's swap works.
 *
 * PROVENANCE, at fork block 51171034:
 *   UniversalRouter 0x6ff5693b99212da76ad316178a184ab56d299b43
 *     codesize 19499
 *     codehash 0x27713951fb0660a1422b710122022d90723d883dc7b72949be79cb2957d234e0
 *     poolManager() == 0x498581fF718922c3f8e6A244956aF099B2652b2b
 *   Permit2         0x000000000022D473030F116dDEE9F6B43aC78BA3, codesize 9152
 *
 * SCOPE. This covers the HOOKLESS pool. A hooked pool is a DIFFERENT pool -
 * the hook address is a field of PoolKey, so it is part of pool identity and
 * cannot be attached to an existing one. That case needs its own pool and is
 * still open.
 *
 * Also note UniversalRouter is a CHOICE. Our own interface could call
 * PoolManager through our own contract instead, which B20UniswapV4.t.sol
 * already shows works. A failure here would narrow our options rather than
 * prove we cannot transact.
 */
contract B20UniversalRouterForkTest is B20ForkTest {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IUniversalRouter internal constant ROUTER = IUniversalRouter(0x6fF5693b99212Da76ad316178A184AB56D299b43);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;

    /// UniversalRouter command byte for a v4 swap. Not vendored in this repo,
    /// so it is asserted by the test: a wrong value makes the router revert
    /// rather than silently do something else.
    uint8 internal constant V4_SWAP = 0x10;

    /// Recorded at fork block 51171034 and asserted, not just documented.
    bytes32 internal constant ROUTER_CODEHASH = 0x27713951fb0660a1422b710122022d90723d883dc7b72949be79cb2957d234e0;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    int256 internal constant LIQUIDITY = 1e8;
    uint128 internal constant SWAP_IN = 1e6;

    address internal user = makeAddr("router-user");

    /// Which params layout the deployed router accepts.
    /// DETERMINED EMPIRICALLY, not assumed: see
    /// test_whichParamsLayoutTheLiveRouterAccepts. The router deployed on Base
    /// REJECTS our vendored v4-periphery 1.0.4 struct and accepts the one
    /// without minHopPriceX36. Building a front end against the vendored ABI
    /// would have failed every swap.
    bool internal legacyLayout = true;

    MemeToken internal meme;
    PoolHarness internal harness;
    PoolKey internal key;
    bool internal nvdacIsCurrency0;

    function setUp() public {
        if (!_forkGuard()) return;

        harness = new PoolHarness(POOL_MANAGER);
        meme = new MemeToken(address(harness), 1_000_000e18);

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(harness), 5e8);

        nvdacIsCurrency0 = NVDAC < address(meme);
        key = PoolKey({
            currency0: Currency.wrap(nvdacIsCurrency0 ? NVDAC : address(meme)),
            currency1: Currency.wrap(nvdacIsCurrency0 ? address(meme) : NVDAC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });

        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);
        harness.addLiquidity(
            key,
            (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING,
            (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING,
            LIQUIDITY
        );

        // Fund the user with real NVDAc and with meme, as a trader would hold.
        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(user, 1e8);
        vm.prank(address(harness));
        meme.transfer(user, 1e18);
    }

    /// The router is the one we recorded, and it points at the same
    /// PoolManager the pool lives in.
    function test_routerIsTheExpectedDeployment() public onlyFork {
        // Code LENGTH is not identity - two different contracts can share it.
        // The hash is, so it is asserted rather than left in a comment.
        assertEq(address(ROUTER).codehash, ROUTER_CODEHASH, "UniversalRouter is not the recorded deployment");
        assertEq(address(ROUTER).code.length, 19499, "UniversalRouter code size changed");
        assertEq(ROUTER.poolManager(), address(POOL_MANAGER), "router points at a different PoolManager");
    }

    /// Which calldata layout does the LIVE router accept? Recorded rather than
    /// assumed, because our vendored periphery version need not match it.
    function test_whichParamsLayoutTheLiveRouterAccepts() public onlyFork {
        _approveThroughPermit2(NVDAC, SWAP_IN);

        uint256 snap = vm.snapshotState();

        legacyLayout = false;
        bool modernWorks = _trySwap();

        vm.revertToState(snap);
        _approveThroughPermit2(NVDAC, SWAP_IN);
        legacyLayout = true;
        bool legacyWorks = _trySwap();

        emit log_named_string("periphery 1.0.4 layout (minHopPriceX36)", modernWorks ? "ACCEPTED" : "rejected");
        emit log_named_string("legacy layout (no minHopPriceX36)      ", legacyWorks ? "ACCEPTED" : "rejected");

        // While this was research, "either one works" was the right question.
        // It is now a REGRESSION expectation for this address at this version:
        // if the deployment ever starts accepting the 1.0.4 layout, that is a
        // change we need to hear about, not one to pass over in silence.
        assertTrue(legacyWorks, "the live router stopped accepting the layout we build");
        assertFalse(modernWorks, "the live router now accepts the 1.0.4 layout - re-check which we should send");
    }

    function _trySwap() internal returns (bool ok) {
        (bytes memory commands, bytes[] memory inputs) = _buildSwap(NVDAC, address(meme), SWAP_IN, 1);
        vm.prank(user);
        try ROUTER.execute(commands, inputs, block.timestamp + 60) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    /// The fixture is fixed - pinned fork block, fixed liquidity, fixed input -
    /// so the output is deterministic and is asserted exactly. "Greater than
    /// zero" would pass on a swap that returned almost nothing.
    uint256 internal constant EXPECTED_OUT = 987158;

    function test_swap_NVDAcToMeme_throughUniversalRouter() public onlyFork {
        _swapThroughRouter(NVDAC, address(meme), SWAP_IN, EXPECTED_OUT);
    }

    function test_swap_memeToNVDAc_throughUniversalRouter() public onlyFork {
        _swapThroughRouter(address(meme), NVDAC, SWAP_IN, EXPECTED_OUT);
    }

    /// A minimum-output bound that cannot be met must make the whole swap
    /// revert, not settle for less - AND revert for that reason.
    ///
    /// A bare vm.expectRevert() would have passed here even while the params
    /// layout was wrong and every swap was reverting on decoding. So the
    /// slippage error is matched specifically, and the user's balances are
    /// checked to be untouched.
    function test_swap_respectsMinimumOutput() public onlyFork {
        _approveThroughPermit2(NVDAC, SWAP_IN);
        (bytes memory commands, bytes[] memory inputs) = _buildSwap(NVDAC, address(meme), SWAP_IN, type(uint128).max);

        uint256 nvdacBefore = IERC20(NVDAC).balanceOf(user);
        uint256 memeBefore = meme.balanceOf(user);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("V4TooLittleReceived(uint256,uint256)")), uint256(type(uint128).max), uint256(987158)
            )
        );
        ROUTER.execute(commands, inputs, block.timestamp + 60);

        assertEq(IERC20(NVDAC).balanceOf(user), nvdacBefore, "a reverted swap still moved NVDAc");
        assertEq(meme.balanceOf(user), memeBefore, "a reverted swap still moved MEME");
    }

    // ------------------------------------------------------------------

    function _swapThroughRouter(address tokenIn, address tokenOut, uint128 amountIn, uint256 expectedOut) internal {
        _approveThroughPermit2(tokenIn, amountIn);

        uint256 inBefore = IERC20(tokenIn).balanceOf(user);
        uint256 outBefore = IERC20(tokenOut).balanceOf(user);

        (bytes memory commands, bytes[] memory inputs) = _buildSwap(tokenIn, tokenOut, amountIn, 1);

        vm.prank(user);
        ROUTER.execute(commands, inputs, block.timestamp + 60);

        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(user);
        uint256 received = IERC20(tokenOut).balanceOf(user) - outBefore;

        emit log_named_uint("router swap: raw in ", spent);
        emit log_named_uint("router swap: raw out", received);

        // The user's NET balances are what matter - the router must not be
        // left holding anything of theirs.
        assertEq(spent, amountIn, "router took something other than the exact input");
        assertEq(received, expectedOut, "router returned a different amount than this fixture should produce");
        assertEq(IERC20(tokenIn).balanceOf(address(ROUTER)), 0, "router kept input tokens");
        assertEq(IERC20(tokenOut).balanceOf(address(ROUTER)), 0, "router kept output tokens");
    }

    /// The real two-step permission flow: token -> Permit2, Permit2 -> router.
    function _approveThroughPermit2(address token, uint128 amount) internal {
        vm.startPrank(user);
        IERC20(token).approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(token, address(ROUTER), uint160(amount), uint48(block.timestamp + 3600));
        vm.stopPrank();
    }

    function _buildSwap(address tokenIn, address tokenOut, uint128 amountIn, uint128 minOut)
        internal
        view
        returns (bytes memory commands, bytes[] memory inputs)
    {
        bool zeroForOne = tokenIn == Currency.unwrap(key.currency0);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));

        bytes[] memory params = new bytes[](3);
        params[0] = legacyLayout
            ? abi.encode(
                ExactInputSingleLegacy({
                    poolKey: key, zeroForOne: zeroForOne, amountIn: amountIn, amountOutMinimum: minOut, hookData: ""
                })
            )
            : abi.encode(
                IV4Router.ExactInputSingleParams({
                    poolKey: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    minHopPriceX36: 0,
                    hookData: ""
                })
            );
        params[1] = abi.encode(Currency.wrap(tokenIn), amountIn);
        params[2] = abi.encode(Currency.wrap(tokenOut), minOut);

        commands = abi.encodePacked(V4_SWAP);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }
}
