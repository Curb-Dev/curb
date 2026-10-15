// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {FeeHook} from "../../src/curb/FeeHook.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {MemeToken} from "./B20UniswapV4.t.sol";
import {ExactInputSingleLegacy} from "./B20HookedPool.t.sol";
import {B20ForkTest} from "./B20ForkTest.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPositionManagerLike {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/**
 * @title B20EthRouteForkTest
 * @notice PAYING WITH ETH FOR A TOKEN THAT IS NOT PRICED IN ETH, and getting
 *         ETH back out, in one transaction through the REAL UniversalRouter.
 *
 * WHY THIS EXISTS
 *   A graduated launch trades as MEME/NVDAc. Nobody holds NVDAc, and "go and
 *   acquire the quote asset first" is not a product. Every launchpad of this
 *   shape solves it the same way: the FRONT END routes, the pool stays as it
 *   is. So the question is not whether the design permits it - it is whether
 *   the deployed router will actually execute it, and on what terms.
 *
 *   The claim that it would, made from reading two command bytes, is not
 *   evidence. This is the evidence, or it is not.
 *
 * THE ROUTE, AND WHERE THE BOUND GOES
 *   ETH -> MEME   WRAP_ETH to the router, V3 WETH->NVDAc paying from the
 *                 ROUTER's balance, then V4 NVDAc->MEME taking to the user.
 *   MEME -> ETH   V4 MEME->NVDAc taking to the ROUTER, V3 NVDAc->WETH, then
 *                 UNWRAP_WETH to the user.
 *
 *   THE MINIMUM IS ON THE LAST LEG, NEVER ON THE INTERMEDIATE. A bound on the
 *   NVDAc in the middle would be a promise about a balance the user never sees
 *   and cannot spend: the second leg could still deliver anything. Buying, the
 *   bound is the v4 swap's own amountOutMinimum, which the hook's fee is taken
 *   before - so it bounds what ARRIVES. Selling, it is UNWRAP_WETH's
 *   amountMinimum, which is the ETH.
 *
 * WHAT THIS POOL IS, AND WHAT IT IS NOT
 *   A hand-opened pool at a raw 1:1 price with a small mint - not the output of
 *   a real graduation. It is enough to answer the question this file asks,
 *   which is whether the DEPLOYED ROUTER executes the route and where it
 *   enforces the bound. It says nothing about what the route costs to execute
 *   against a pool seeded by the 60/60 parameters, or about the prices a user
 *   would actually see there. Those are a different measurement.
 *
 * THE INTERMEDIATE IS THE ROUTER'S, NOT THE USER'S
 *   The first leg pays out to the router and the second spends the router's own
 *   balance. Nothing pulls NVDAc from the user, which is the whole point: they
 *   have none. CONTRACT_BALANCE and OPEN_DELTA are how that is said.
 */
contract B20EthRouteForkTest is B20ForkTest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IPositionManagerLike internal constant POSM = IPositionManagerLike(0x7C5f5A4bBd8fD63184577525326123B519429bDc);
    IUniversalRouter internal constant ROUTER = IUniversalRouter(0x6fF5693b99212Da76ad316178A184AB56D299b43);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant NVDAC_HOLDER = 0x4446Adc0B8136Ffc55DdB7a488Ba5509Ace2A5ef;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    /// The Uniswap v3 pool that actually holds NVDAc against WETH on Base, at
    /// the pinned block. Measured, not assumed: fee 3000 is the only tier with
    /// liquidity, and the route has nowhere else to go.
    uint24 internal constant V3_FEE = 3000;
    /// THE OTHER SIX ASSETS DO NOT HAVE THAT POOL, which is the whole of F2.
    /// USDC is the leg that does exist for them - MULTI_RWA.txt 2.2.
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant METAC = 0xb2000000000000000000008bC8786B856E61707C;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    // UniversalRouter commands.
    uint8 internal constant V3_SWAP_EXACT_IN = 0x00;
    uint8 internal constant SWEEP = 0x04;
    uint8 internal constant WRAP_ETH = 0x0b;
    uint8 internal constant UNWRAP_WETH = 0x0c;
    uint8 internal constant V4_SWAP = 0x10;

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint256 internal constant MINT_LIQUIDITY = 1e8;
    /// This fixture's launch tax, and the platform's fixed leg of it.
    uint16 internal constant TAX_BPS = 300;
    uint16 internal constant PLATFORM_BPS = 50;
    uint256 internal constant BPS = 10_000;

    address internal launcher = makeAddr("launcher");
    address internal platform = makeAddr("platform-fee-recipient");
    address internal user = makeAddr("eth-only-user");
    address internal creatorRecipient = makeAddr("creator-fee-recipient");

    MemeToken internal meme;
    FeeHook internal hook;
    PoolKey internal key;
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
                beneficiary: creatorRecipient,
                refundTo: creatorRecipient,
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
        // refuses a pool it has no record for rather than charging nothing, so
        // this is not setup decoration - an unbound pool is an untradeable one.
        registryContract.wire(address(this), address(hook));
        _bindLaunch(address(meme), key, TAX_BPS);

        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);

        tickLower = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        tickUpper = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;

        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(launcher, 5e8);
        _mint(MINT_LIQUIDITY, launcher);

        // THE USER HOLDS ETH AND NOTHING ELSE. That is the premise.
        vm.deal(user, 10 ether);
    }

    // ---------------------------------------------------------------- ETH in

    function test_ethBuysAToken_itIsNotPricedIn() public onlyFork {
        uint256 ethIn = 0.02 ether;
        uint256 minOut = 1; // the shape first; the bound has its own test

        uint256 ethBefore = user.balance;
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
        assertEq(IERC20(NVDAC).balanceOf(user), 0, "the user starts with no NVDAc");

        vm.prank(user);
        ROUTER.execute{value: ethIn}(_buyCommands(), _buyInputs(ethIn, minOut), block.timestamp + 60);

        assertEq(ethBefore - user.balance, ethIn, "more ETH left than was offered");
        assertGt(meme.balanceOf(user), 0, "no tokens arrived");

        // NOTHING WAS TAKEN FROM THE USER IN THE MIDDLE, and nothing was left
        // stranded there either.
        assertEq(IERC20(NVDAC).balanceOf(user), 0, "NVDAc was pulled from or left with the user");
        assertEq(IERC20(NVDAC).balanceOf(address(ROUTER)), 0, "NVDAc was left in the router");
        assertEq(IERC20(WETH).balanceOf(address(ROUTER)), 0, "WETH was left in the router");
        assertEq(address(ROUTER).balance, 0, "native ETH was left in the router");

        // AND THE HOOK STILL CHARGED - IN NVDAc, ON THE NVDAc LEG. A route
        // that bypassed the pool's own rules would be a different pool.
        //
        // THE TOKEN CHANGED WITH THE POLICY. This used to assert the platform's
        // MEME balance grew, because the hook took 1% of the swap's output. The
        // tax is on the NVDAc side both ways now, so on the ETH route it lands
        // on the NVDAc the v3 leg produced - and the memecoin balance staying
        // at zero is the half of this worth asserting.
        assertGt(IERC20(NVDAC).balanceOf(platform) - platformBefore, 0, "the hook took nothing");
        assertEq(meme.balanceOf(platform), 0, "the hook charged in the memecoin");
        assertGt(IERC20(NVDAC).balanceOf(creatorRecipient), 0, "the creator's leg was not paid");
    }


    // ------------------------------------------------- ETH in, the LONG way

    /// F2. THE ONE-HOP ROUTE IS NVDAc's AND NOBODY ELSE's.
    ///
    /// Of the thirteen B20 equities, only NVDAc has a WETH pool holding
    /// anything; every other one trades against USDC [MULTI_RWA.txt 2.2]. So
    /// "ETH buys this coin" was true of one asset and false of the six this
    /// deployment enables. The fix is a SECOND HOP - and UniversalRouter takes
    /// it as the same v3 command with a longer packed path, so the whole route
    /// still unwinds as one transaction if any leg fails.
    ///
    /// CRITERIA, before measuring:
    ///   R1  METAc genuinely has no usable WETH pool - or this proves nothing
    ///   R2  the tiers are DISCOVERED by what each pool holds, the way the page
    ///       discovers them, not hardcoded
    ///   R3  ETH in, METAc out, through the deployed router in one call
    ///   R4  the amount that ARRIVES is measured from balances, not inferred
    ///       from the minimum that was asked for
    ///   R5  nothing is stranded in the router, and the middle asset never
    ///       touches the user
    function test_ethReachesAnAssetWithNoWethPool_throughUsdc() public onlyFork {
        // ---- R1
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        for (uint256 i = 0; i < tiers.length; i++) {
            address direct = _v3Pool(WETH, METAC, tiers[i]);
            if (direct != address(0)) {
                assertEq(
                    IERC20(METAC).balanceOf(direct), 0,
                    "R1: METAc has a WETH pool with something in it - the one-hop route may exist"
                );
            }
        }

        // ---- R2. Whichever pool holds more is the one a buyer can use.
        uint24 firstLeg = _deepestTier(WETH, USDC, USDC);
        uint24 secondLeg = _deepestTier(USDC, METAC, METAC);
        assertTrue(firstLeg != 0, "R2: no WETH/USDC pool holds USDC");
        assertTrue(secondLeg != 0, "R2: no USDC/METAc pool holds METAc");

        // ---- R3
        address buyer = makeAddr("f2-two-hop-buyer");
        vm.deal(buyer, 1 ether);
        uint256 ethIn = 0.05 ether;
        uint256 before = IERC20(METAC).balanceOf(buyer);
        assertEq(before, 0, "R3: the buyer starts with METAc");

        bytes memory commands = abi.encodePacked(WRAP_ETH, V3_SWAP_EXACT_IN, SWEEP);
        bytes[] memory inputs = new bytes[](3);
        inputs[0] = abi.encode(ActionConstants.ADDRESS_THIS, ethIn);
        // ONE COMMAND, TWO HOPS. The path is what carries the second leg.
        inputs[1] = abi.encode(
            ActionConstants.MSG_SENDER, ethIn, uint256(1),
            abi.encodePacked(WETH, firstLeg, USDC, secondLeg, METAC), false
        );
        inputs[2] = abi.encode(USDC, ActionConstants.MSG_SENDER, uint256(0));

        vm.prank(buyer);
        ROUTER.execute{value: ethIn}(commands, inputs, block.timestamp + 60);

        // ---- R4. What ARRIVED, read off the chain.
        uint256 arrived = IERC20(METAC).balanceOf(buyer) - before;
        assertGt(arrived, 0, "R4: the two-hop route delivered nothing");
        emit log_named_uint("  METAc delivered for 0.05 ETH, raw units", arrived);

        // ---- R5
        assertEq(IERC20(USDC).balanceOf(address(ROUTER)), 0, "R5: USDC left in the router");
        assertEq(IERC20(WETH).balanceOf(address(ROUTER)), 0, "R5: WETH left in the router");
        assertEq(IERC20(METAC).balanceOf(address(ROUTER)), 0, "R5: METAc left in the router");
        assertEq(address(ROUTER).balance, 0, "R5: native ETH left in the router");
    }

    /// THE MINIMUM STILL BINDS ACROSS BOTH HOPS. A bound that only covered the
    /// first leg would let the second one deliver anything at all.
    function test_theTwoHopMinimumIsOnWhatArrives() public onlyFork {
        uint24 firstLeg = _deepestTier(WETH, USDC, USDC);
        uint24 secondLeg = _deepestTier(USDC, METAC, METAC);
        address buyer = makeAddr("f2-two-hop-bound");
        vm.deal(buyer, 1 ether);
        uint256 ethIn = 0.05 ether;

        bytes memory commands = abi.encodePacked(WRAP_ETH, V3_SWAP_EXACT_IN, SWEEP);
        bytes[] memory inputs = new bytes[](3);
        inputs[0] = abi.encode(ActionConstants.ADDRESS_THIS, ethIn);
        // An impossible minimum: more METAc than the pool holds at all.
        inputs[1] = abi.encode(
            ActionConstants.MSG_SENDER, ethIn, type(uint128).max,
            abi.encodePacked(WETH, firstLeg, USDC, secondLeg, METAC), false
        );
        inputs[2] = abi.encode(USDC, ActionConstants.MSG_SENDER, uint256(0));

        vm.prank(buyer);
        vm.expectRevert();
        ROUTER.execute{value: ethIn}(commands, inputs, block.timestamp + 60);

        // AND IT UNWOUND WHOLE. The first hop does not stand on its own.
        assertEq(IERC20(METAC).balanceOf(buyer), 0, "the refused route still delivered METAc");
        assertEq(IERC20(USDC).balanceOf(buyer), 0, "the refused route left USDC with the buyer");
        assertEq(buyer.balance, 1 ether, "the refused route still took the ETH");
    }

    function _v3Pool(address a, address b, uint24 fee) internal view returns (address) {
        (bool ok, bytes memory ret) =
            V3_FACTORY.staticcall(abi.encodeWithSignature("getPool(address,address,uint24)", a, b, fee));
        if (!ok || ret.length != 32) return address(0);
        return abi.decode(ret, (address));
    }

    /// The tier whose pool holds the most of `held_`. THE SAME RULE THE PAGE USES:
    /// a pool cannot sell more of an asset than it holds, so the one holding
    /// more is the one to route through. No threshold is chosen by anybody.
    function _deepestTier(address a, address b, address held_) internal view returns (uint24 best) {
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        uint256 most;
        for (uint256 i = 0; i < tiers.length; i++) {
            address pool = _v3Pool(a, b, tiers[i]);
            if (pool == address(0)) continue;
            uint256 held = IERC20(held_).balanceOf(pool);
            if (held > most) { most = held; best = tiers[i]; }
        }
    }

    function test_theBoundIsOnTheTokenThatArrives_notTheMiddle() public onlyFork {
        uint256 ethIn = 0.02 ether;

        // What the route delivers, measured once.
        uint256 snap = vm.snapshotState();
        vm.prank(user);
        ROUTER.execute{value: ethIn}(_buyCommands(), _buyInputs(ethIn, 1), block.timestamp + 60);
        uint256 delivered = meme.balanceOf(user);
        vm.revertToState(snap);

        assertGt(delivered, 0, "nothing to bound");

        // One wei above what it delivers must fail, ON THE V4 LEG, with the
        // slippage error - and the amount it reports as received must be THE
        // MEME THE USER WOULD HAVE GOT, not the NVDAc in the middle. That last
        // equality is the whole claim: the bound is on the final output.
        bytes memory err = _routeMustFail(_buyCommands(), _buyInputs(ethIn, delivered + 1), ethIn);
        assertEq(
            _selectorOf(err),
            bytes4(keccak256("V4TooLittleReceived(uint256,uint256)")),
            "the route failed for a reason that is not the minimum"
        );
        (uint256 wanted, uint256 got) = _tooLittle(err);
        assertEq(wanted, delivered + 1, "the bound the router enforced is not the one that was asked for");
        assertEq(got, delivered, "the bound was measured against something other than the token that arrives");

        // And the user is untouched by the attempt: the first leg went back too.
        assertEq(user.balance, 10 ether, "ETH was spent by a reverted route");
        assertEq(meme.balanceOf(user), 0, "tokens arrived from a reverted route");
        assertEq(IERC20(NVDAC).balanceOf(user), 0, "NVDAc was left behind by a reverted route");

        // Exactly what it delivers must pass.
        vm.prank(user);
        ROUTER.execute{value: ethIn}(_buyCommands(), _buyInputs(ethIn, delivered), block.timestamp + 60);
        assertEq(meme.balanceOf(user), delivered, "the route stopped being deterministic");
    }

    function test_aSecondLegThatFailsUndoesTheFirst() public onlyFork {
        uint256 ethIn = 0.02 ether;
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);
        uint256 nvdacInV3Before = IERC20(NVDAC).balanceOf(_v3Pool());
        // FIRST, SHOW THERE IS SOMETHING TO UNDO. A test that only asserts
        // "nothing moved" passes just as well when the route died at its first
        // command and the first leg never ran - which would make this a test of
        // an encoding mistake. So the same route is run to completion once, and
        // what the first leg and the hook actually do is measured.
        uint256 snap = vm.snapshotState();
        vm.prank(user);
        ROUTER.execute{value: ethIn}(_buyCommands(), _buyInputs(ethIn, 1), block.timestamp + 60);
        assertLt(IERC20(NVDAC).balanceOf(_v3Pool()), nvdacInV3Before, "the first leg does not move the v3 pool");
        assertGt(IERC20(NVDAC).balanceOf(platform), platformBefore, "the hook does not charge on this route");
        vm.revertToState(snap);

        // NOW the same route with an impossible bound on the LAST leg. The v3
        // swap and the hook's payment have both happened by the time it fails.
        Reserves memory before = _reserves();
        bytes memory err = _routeMustFail(_buyCommands(), _buyInputs(ethIn, type(uint128).max), ethIn);
        assertEq(
            _selectorOf(err),
            bytes4(keccak256("V4TooLittleReceived(uint256,uint256)")),
            "the route failed for a reason that is not the minimum"
        );
        _assertUnchanged(before, "a reverted buy");
    }

    // --------------------------------------------------------------- ETH out

    function test_aTokenSellsBackToEth() public onlyFork {
        // Buy first, so the tokens being sold came from this route rather than
        // from a transfer the route would never have made.
        vm.prank(user);
        ROUTER.execute{value: 0.05 ether}(_buyCommands(), _buyInputs(0.05 ether, 1), block.timestamp + 60);
        uint256 held = meme.balanceOf(user);
        assertGt(held, 0, "nothing to sell");

        uint128 sell = uint128(held / 2);
        vm.startPrank(user);
        meme.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(meme), address(ROUTER), type(uint160).max, uint48(block.timestamp + 3600));
        vm.stopPrank();

        uint256 ethBefore = user.balance;
        uint256 platformBefore = IERC20(NVDAC).balanceOf(platform);

        vm.prank(user);
        ROUTER.execute(_sellCommands(), _sellInputs(sell, 1), block.timestamp + 60);

        assertGt(user.balance, ethBefore, "no ETH came back");
        assertEq(meme.balanceOf(user), held - sell, "the wrong amount was sold");
        assertEq(IERC20(NVDAC).balanceOf(user), 0, "NVDAc was left with the user");
        assertEq(IERC20(NVDAC).balanceOf(address(ROUTER)), 0, "NVDAc was left in the router");
        assertEq(IERC20(WETH).balanceOf(address(ROUTER)), 0, "WETH was left in the router");
        assertEq(address(ROUTER).balance, 0, "native ETH was left in the router");

        // SELLING, THE TAX IS IN NVDAc - the output side of the v4 leg. Buying
        // it is in NVDAc too, on the input side. Same token both ways now,
        // which is the change: it used to follow the output and so switched.
        assertGt(IERC20(NVDAC).balanceOf(platform) - platformBefore, 0, "the hook took nothing on the way out");
    }

    function test_theBoundOnTheWayOutIsTheEth() public onlyFork {
        vm.prank(user);
        ROUTER.execute{value: 0.05 ether}(_buyCommands(), _buyInputs(0.05 ether, 1), block.timestamp + 60);
        uint256 held = meme.balanceOf(user);
        uint128 sell = uint128(held / 2);

        vm.startPrank(user);
        meme.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(meme), address(ROUTER), type(uint160).max, uint48(block.timestamp + 3600));
        vm.stopPrank();

        // Everything the failing attempt must leave untouched, read once.
        Reserves memory before = _reserves();

        uint256 snap = vm.snapshotState();
        uint256 ethBefore = user.balance;
        vm.prank(user);
        ROUTER.execute(_sellCommands(), _sellInputs(sell, 1), block.timestamp + 60);
        uint256 got = user.balance - ethBefore;
        vm.revertToState(snap);
        assertGt(got, 0, "nothing to bound");

        // ONE WEI ABOVE FAILS, on the unwrap, with the router's own
        // InsufficientETH rather than a slippage error from a leg in the middle.
        snap = vm.snapshotState();
        bytes memory err = _routeMustFail(_sellCommands(), _sellInputs(sell, got + 1), 0);
        assertEq(
            _selectorOf(err),
            bytes4(keccak256("InsufficientETH()")),
            "the bound was enforced somewhere other than the unwrap to ETH"
        );

        // AND THE WHOLE ROUTE WENT BACK, not just the user's tokens. The v4 leg
        // and its hook payment happen before the unwrap ever runs, so a revert
        // that left either standing would be the failure this checks for.
        assertEq(meme.balanceOf(user), held, "tokens were spent by a reverted route");
        _assertUnchanged(before, "a reverted sell");

        // THE EQUALITY SIDE, from the same starting state. A bound that only
        // ever rejects is satisfied by a route that always fails.
        vm.revertToState(snap);
        ethBefore = user.balance;
        vm.prank(user);
        ROUTER.execute(_sellCommands(), _sellInputs(sell, got), block.timestamp + 60);
        assertEq(user.balance - ethBefore, got, "exactly the bound was asked for and something else arrived");
    }

    // ------------------------------------------------------ what comes back

    function test_anExistingRouterBalanceIsConsumedToo_whichIsNotARefund() public onlyFork {
        // WHAT "LEFTOVERS ARE REFUNDED" ACTUALLY TURNED OUT TO MEAN HERE.
        //
        // The routes end with SWEEP, and this test was first written to show it
        // handing a leftover back. It does not, and cannot: every SETTLE takes
        // the router's WHOLE balance (CONTRACT_BALANCE) and every swap spends
        // the whole open delta, so there is never anything for SWEEP to find.
        //   MEASURED, not assumed: removing SWEEP from both routes changes
        //   nothing - all six tests still pass. It is dead in these two routes
        //   and is kept only because an encoding that ever names a fixed amount
        //   instead would need it. Nothing here tests it, and this file does not
        //   claim otherwise.
        //
        // AND THIS IS NOT A REFUND, WHICH IS WHAT IT WAS FIRST CALLED. Spending
        // a balance that was already on the router on behalf of whoever happens
        // to be routing is not returning it to whoever left it. The router is
        // not a vault and dust on it is anybody's; this route takes it.
        //   The narrow true claim is the one below: in this route an existing
        //   NVDAc balance is consumed along with the leg's own output. An
        //   interface must therefore never read the router's balance as part of
        //   the user's input or of what they are owed - the quote comes from
        //   what the USER put in, and nothing else.
        uint256 planted = 1e7;                       // 0.1 NVDAc
        vm.prank(NVDAC_HOLDER);
        IERC20(NVDAC).transfer(address(ROUTER), planted);
        assertEq(IERC20(NVDAC).balanceOf(address(ROUTER)), planted, "nothing was planted");

        uint256 userNvdacBefore = IERC20(NVDAC).balanceOf(user);
        uint256 snap = vm.snapshotState();
        vm.prank(user);
        ROUTER.execute{value: 0.02 ether}(_buyCommands(), _buyInputs(0.02 ether, 1), block.timestamp + 60);
        uint256 withPlanted = meme.balanceOf(user);

        assertEq(IERC20(NVDAC).balanceOf(address(ROUTER)), 0, "NVDAc was left in the router");
        assertEq(IERC20(NVDAC).balanceOf(user), userNvdacBefore, "NVDAc reached the user, which this route never intends");
        assertEq(address(ROUTER).balance, 0, "native ETH was left in the router");
        assertEq(IERC20(WETH).balanceOf(address(ROUTER)), 0, "WETH was left in the router");

        // AND IT WAS SPENT RATHER THAN IGNORED: the same route without the
        // planted NVDAc delivers strictly less. Without this the assertions
        // above are satisfied by a route that never touched it.
        vm.revertToState(snap);
        vm.prank(address(ROUTER));
        IERC20(NVDAC).transfer(address(0xdead), planted);
        vm.prank(user);
        ROUTER.execute{value: 0.02 ether}(_buyCommands(), _buyInputs(0.02 ether, 1), block.timestamp + 60);
        assertLt(meme.balanceOf(user), withPlanted, "the planted NVDAc made no difference, so it was not spent");
    }

    function test_theRevertAllowedBitDoesNotMakeTheV4LegSwallowable() public onlyFork {
        // WHAT THIS WAS WRITTEN TO SHOW, AND WHAT IT SHOWS INSTEAD.
        //
        // "The whole route reverted" is trivially true while every command must
        // succeed, which would make the reserve comparison a check that can
        // never fail. UniversalRouter's commands carry a bit (0x80) saying a
        // failure is ALLOWED, and the intent here was to set it on the v4 leg,
        // produce a route that carries on with the ETH spent and no tokens
        // delivered, and watch the comparison catch it.
        //
        // IT DOES NOT CARRY ON. With the bit set and an impossible bound, this
        // router still reverts the whole call with V4TooLittleReceived.
        //
        // WHAT THAT DOES AND DOES NOT COVER. One router, at one address, with
        // the bit on ONE command (V4_SWAP), failing down ONE path (the v4
        // swap's own minimum). It is not a statement about how this router
        // treats the bit on other commands, or about other failures inside the
        // same command. The explanation that suggests itself - that the v4 leg
        // runs inside the PoolManager's unlock callback and its revert is not
        // something the dispatcher catches - is a reading of the code, not
        // something measured here.
        //
        // What follows for this file: the reserve comparisons elsewhere in it
        // are guards against a failure mode that did not occur in this one
        // attempt. They have not been seen failing. Said here rather than left
        // for someone to assume otherwise.
        uint256 ethIn = 0.02 ether;
        Reserves memory before = _reserves();

        bytes memory commands = abi.encodePacked(WRAP_ETH, V3_SWAP_EXACT_IN, uint8(V4_SWAP | 0x80), SWEEP);
        vm.prank(user);
        (bool ok, bytes memory err) = address(ROUTER).call{value: ethIn}(
            abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)", commands, _buyInputs(ethIn, type(uint128).max), block.timestamp + 60
            )
        );
        assertFalse(ok, "the revert-allowed bit let the v4 leg be swallowed");
        assertEq(
            _selectorOf(err),
            bytes4(keccak256("V4TooLittleReceived(uint256,uint256)")),
            "it failed, but not on the bound"
        );
        _assertUnchanged(before, "a route with the revert-allowed bit set");
    }

    // --------------------------------------------------------------- encoding

    function _buyCommands() internal pure returns (bytes memory) {
        // SWEEP is last and, as encoded here, it RUNS ON A ZERO BALANCE - the
        // command executes, finds nothing to move, and returns. It is not
        // unreachable, which is what this comment first said; it is reached and
        // has no work. The SETTLE before it takes the router's whole NVDAc
        // balance, so nothing is ever left. Removing it changes no test, so
        // nothing here demonstrates it moving anything. It stays for the
        // encoding that names a fixed amount one day.
        return abi.encodePacked(WRAP_ETH, V3_SWAP_EXACT_IN, V4_SWAP, SWEEP);
    }

    function _buyInputs(uint256 ethIn, uint256 minOut) internal view returns (bytes[] memory inputs) {
        inputs = new bytes[](4);
        // 1. ETH becomes the ROUTER's WETH.
        inputs[0] = abi.encode(ActionConstants.ADDRESS_THIS, ethIn);
        // 2. WETH -> NVDAc, paid from the router's own balance, landing there.
        //    No bound here: the only bound that means anything is on the token
        //    the user ends up holding.
        inputs[1] = abi.encode(
            ActionConstants.ADDRESS_THIS, ethIn, uint256(0), abi.encodePacked(WETH, V3_FEE, NVDAC), false
        );
        // 3. NVDAc -> MEME, spending what the router now holds, to the user.
        inputs[2] = _v4BuyInput(minOut);
        // 4. Anything the route could not use goes back.
        inputs[3] = abi.encode(NVDAC, ActionConstants.MSG_SENDER, uint256(0));
    }

    function _v4BuyInput(uint256 minOut) internal view returns (bytes memory) {
        bytes memory actions = abi.encodePacked(uint8(Actions.SETTLE), uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.TAKE));
        bytes[] memory params = new bytes[](3);
        // The router pays its WHOLE NVDAc balance in - that balance is the
        // first leg's output, and naming it any other way would mean predicting
        // a swap that has not happened yet.
        params[0] = abi.encode(Currency.wrap(NVDAC), ActionConstants.CONTRACT_BALANCE, false);
        params[1] = abi.encode(
            ExactInputSingleLegacy({
                poolKey: key,
                zeroForOne: NVDAC == Currency.unwrap(key.currency0),
                amountIn: ActionConstants.OPEN_DELTA,
                amountOutMinimum: uint128(minOut),
                hookData: ""
            })
        );
        params[2] = abi.encode(Currency.wrap(address(meme)), ActionConstants.MSG_SENDER, ActionConstants.OPEN_DELTA);
        return abi.encode(actions, params);
    }

    function _sellCommands() internal pure returns (bytes memory) {
        return abi.encodePacked(V4_SWAP, V3_SWAP_EXACT_IN, UNWRAP_WETH, SWEEP);
    }

    function _sellInputs(uint128 amountIn, uint256 minEthOut) internal view returns (bytes[] memory inputs) {
        inputs = new bytes[](4);
        inputs[0] = _v4SellInput(amountIn);
        // NVDAc -> WETH with whatever the v4 leg produced, staying on the
        // router so UNWRAP_WETH can turn it into the user's ETH.
        inputs[1] = abi.encode(
            ActionConstants.ADDRESS_THIS,
            ActionConstants.CONTRACT_BALANCE,
            uint256(0),
            abi.encodePacked(NVDAC, V3_FEE, WETH),
            false
        );
        // THE BOUND, on the ETH. Everything before this is plumbing.
        inputs[2] = abi.encode(ActionConstants.MSG_SENDER, minEthOut);
        inputs[3] = abi.encode(NVDAC, ActionConstants.MSG_SENDER, uint256(0));
    }

    function _v4SellInput(uint128 amountIn) internal view returns (bytes memory) {
        bytes memory actions = abi.encodePacked(uint8(Actions.SETTLE), uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.TAKE));
        bytes[] memory params = new bytes[](3);
        // payerIsUser: the MEME is the user's, and Permit2 moves it.
        params[0] = abi.encode(Currency.wrap(address(meme)), uint256(amountIn), true);
        params[1] = abi.encode(
            ExactInputSingleLegacy({
                poolKey: key,
                zeroForOne: address(meme) == Currency.unwrap(key.currency0),
                amountIn: ActionConstants.OPEN_DELTA,
                amountOutMinimum: uint128(0),
                hookData: ""
            })
        );
        // The NVDAc stays with the ROUTER: it is the next leg's input, never
        // the user's to receive.
        params[2] = abi.encode(Currency.wrap(NVDAC), ActionConstants.ADDRESS_THIS, ActionConstants.OPEN_DELTA);
        return abi.encode(actions, params);
    }

    // ------------------------------------------------- reading a real failure

    /// WHY IT FAILED, not just that it did. A bare expectRevert passes when the
    /// route falls over for a reason with nothing to do with the bound - a
    /// wrong path, an unsupported action, a pool that is not there - which
    /// would make "the minimum is on the last leg" a claim proved by an
    /// encoding mistake.
    ///
    /// THE DEPLOYED ROUTER BUBBLES THE INNER ERROR RATHER THAN WRAPPING IT.
    /// The vendored periphery's own mock wraps failures in
    /// ExecutionFailed(commandIndex, message), and asserting that is how this
    /// was first written - it failed, and the revert data said why. So there is
    /// no command index to read; the error's IDENTITY is what names the leg,
    /// and it is enough: V4TooLittleReceived belongs to the v4 swap and
    /// InsufficientETH to UNWRAP_WETH, and nothing else raises either.
    function _routeMustFail(bytes memory commands, bytes[] memory inputs, uint256 value)
        internal
        returns (bytes memory err)
    {
        vm.prank(user);
        bool ok;
        (ok, err) = address(ROUTER).call{value: value}(
            abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp + 60)
        );
        assertFalse(ok, "the route was expected to fail and did not");
        assertGe(err.length, 4, "the route reverted with nothing to read");
    }

    function _selectorOf(bytes memory err) internal pure returns (bytes4) {
        return bytes4(err);
    }

    /// V4TooLittleReceived(minAmountOutReceived, amountReceived) - and the
    /// second field is the whole point of this exercise.
    function _tooLittle(bytes memory err) internal pure returns (uint256 wanted, uint256 got) {
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i = 0; i < body.length; i++) body[i] = err[i + 4];
        (wanted, got) = abi.decode(body, (uint256, uint256));
    }

    // ------------------------------------------------ everything a revert must undo

    /// WHAT EACH OF THESE IS, said exactly, because two of them were first
    /// described as "the v4 pool's reserves" and are nothing of the kind: the
    /// PoolManager is a singleton holding every pool's tokens at once, so its
    /// balance moves when any pool anywhere trades. It is a useful thing to
    /// find unchanged after a revert; it is not this pool's state.
    /// sqrtPriceX96, tick and liquidity ARE this pool's state, and they are
    /// read separately for exactly that reason.
    struct Reserves {
        uint256 userEth;
        uint256 userNvdac;
        uint256 routerEth;
        uint256 routerNvdac;
        uint256 routerWeth;
        uint256 v3Nvdac;
        uint256 v3Weth;
        uint256 poolManagerNvdacTotal;
        uint256 poolManagerMemeTotal;
        uint160 poolSqrtPriceX96;
        int24 poolTick;
        uint128 poolLiquidity;
        uint256 platformNvdac;
        uint256 platformMeme;
    }

    function _reserves() internal view returns (Reserves memory r) {
        r.userEth = user.balance;
        r.userNvdac = IERC20(NVDAC).balanceOf(user);
        r.routerEth = address(ROUTER).balance;
        r.routerNvdac = IERC20(NVDAC).balanceOf(address(ROUTER));
        r.routerWeth = IERC20(WETH).balanceOf(address(ROUTER));
        r.v3Nvdac = IERC20(NVDAC).balanceOf(_v3Pool());
        r.v3Weth = IERC20(WETH).balanceOf(_v3Pool());
        r.poolManagerNvdacTotal = IERC20(NVDAC).balanceOf(address(POOL_MANAGER));
        r.poolManagerMemeTotal = meme.balanceOf(address(POOL_MANAGER));
        (r.poolSqrtPriceX96, r.poolTick,,) = POOL_MANAGER.getSlot0(key.toId());
        r.poolLiquidity = POOL_MANAGER.getLiquidity(key.toId());
        r.platformNvdac = IERC20(NVDAC).balanceOf(platform);
        r.platformMeme = meme.balanceOf(platform);
    }

    function _assertUnchanged(Reserves memory before, string memory what) internal view {
        Reserves memory now_ = _reserves();
        assertEq(now_.userEth, before.userEth, string.concat(what, " spent the user's ETH"));
        assertEq(now_.userNvdac, before.userNvdac, string.concat(what, " left the user NVDAc"));
        assertEq(now_.routerEth, before.routerEth, string.concat(what, " left ETH in the router"));
        assertEq(now_.routerNvdac, before.routerNvdac, string.concat(what, " left NVDAc in the router"));
        assertEq(now_.routerWeth, before.routerWeth, string.concat(what, " left WETH in the router"));
        assertEq(now_.v3Nvdac, before.v3Nvdac, string.concat(what, " moved the v3 pool's NVDAc"));
        assertEq(now_.v3Weth, before.v3Weth, string.concat(what, " moved the v3 pool's WETH"));
        assertEq(
            now_.poolManagerNvdacTotal,
            before.poolManagerNvdacTotal,
            string.concat(what, " moved the PoolManager's total NVDAc")
        );
        assertEq(
            now_.poolManagerMemeTotal,
            before.poolManagerMemeTotal,
            string.concat(what, " moved the PoolManager's total MEME")
        );
        assertEq(now_.poolSqrtPriceX96, before.poolSqrtPriceX96, string.concat(what, " moved THIS pool's price"));
        assertEq(now_.poolTick, before.poolTick, string.concat(what, " moved THIS pool's tick"));
        assertEq(now_.poolLiquidity, before.poolLiquidity, string.concat(what, " moved THIS pool's liquidity"));
        assertEq(now_.platformNvdac, before.platformNvdac, string.concat(what, " paid the hook in NVDAc"));
        assertEq(now_.platformMeme, before.platformMeme, string.concat(what, " paid the hook in MEME"));
    }

    // ---------------------------------------------------------------- helpers

    function _v3Pool() internal pure returns (address) {
        // The measured NVDAc/WETH pool on Base. Held as a constant because the
        // factory lookup is a read this test does not need to repeat.
        return 0x8e740D5Fa742B763cD82159894b9919eD57E4f70;
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
}
