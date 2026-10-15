// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/IERC6093.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {CurbLaunchFactory} from "../../src/curb/CurbLaunchFactory.sol";
import {CurbLaunchToken} from "../../src/curb/CurbLaunchToken.sol";
// THE ROUTER THROUGH ITS INTERFACE, deployed from its artifact - never
// imported. A file that imports CurbRouter.sol joins the router's compiler
// profile with everything it imports (see foundry.toml and ICurbRouter).
// The alias keeps every CurbRouter.X below reading as the contract it is.
import {ICurbRouter as CurbRouter} from "../../src/curb/ICurbRouter.sol";
import {IWETH} from "../../src/curb/IWETH.sol";
import {DeployRouter} from "../../script/DeployRouter.s.sol";

import {B20ForkTest} from "./B20ForkTest.sol";

interface IV3FactoryLike {
    function getPool(address a, address b, uint24 fee) external view returns (address);
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IV3PoolLike {
    function initialize(uint160 sqrtPriceX96) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256, uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// The record LaunchRegistry keeps, as the router reads it (CurbRouter.sol
/// declares the same tuple; this file does not import it).
interface ILaunchBook {
    struct LaunchRecord {
        address curve;
        address quoteToken;
        address beneficiary;
        address refundTo;
        uint256 reservedZero;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        uint16 totalTaxBps;
        uint16 platformBps;
        address platformRecipient;
    }
}

/// Uniswap's SwapRouter02, for the long way round.
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// A recipient with no receive() and no fallback: every ETH send to it fails.
contract EthRefuser {}

/// The part of a Coinbase FiatToken (cbBTC, cbXRP) these tests use.
interface IFiatTokenLike {
    function blacklister() external view returns (address);
    function isBlacklisted(address account) external view returns (bool);
    function blacklist(address account) external;
}

/// AN ANSWER THAT NEVER COMES: put in place of a token's isBlacklisted with
/// vm.mockFunction, it loops until the gas it was handed is gone - as WETH9's
/// fallback does when it is asked in a static call.
contract GasBurner {
    fallback() external {
        while (true) {}
    }
}

/// A CALLER that cannot take ETH back, for the refund's fallback. It holds ETH
/// (vm.deal) and spends it through the router; it just cannot be paid any.
contract RefusingBuyer {
    function buy(CurbRouter r, address registry, address token, uint256 value) external returns (uint256) {
        return r.buyWithEth{value: value}(registry, token, "", 0, 0, address(this), block.timestamp);
    }
}

/// A CONTRACT WALLET WHOSE receive() DOES REAL WORK, as a smart wallet's does:
/// twenty fresh storage writes, about 440k gas - far past a 2300 stipend or a
/// 100k cap. It buys through the router itself, so it is also the CALLER.
contract HeavyWallet {
    uint256[20] internal slots;
    uint256 public received;

    function buy(CurbRouter r, address registry, address token, uint256 value) external returns (uint256) {
        return r.buyWithEth{value: value}(registry, token, "", 0, 0, address(this), block.timestamp);
    }

    receive() external payable {
        for (uint256 i = 0; i < slots.length; i++) {
            slots[i] = i + 1;
        }
        received += msg.value;
    }
}

/// DeployRouter with other pins, to show run() refusing a build that does not
/// match them. The script itself has no way to change its pins.
contract DeployRouterExpecting is DeployRouter {
    address internal immutable at;
    bytes32 internal immutable codehash;

    constructor(address at_, bytes32 codehash_) {
        at = at_;
        codehash = codehash_;
    }

    function _expected() internal view override returns (address, bytes32) {
        return (at, codehash);
    }
}

/// RUNS IN THE DEPLOYMENT PROXY'S PLACE for one call (vm.mockFunction runs
/// this code in the proxy's own context): it deploys what it is given with
/// CREATE2 as the proxy does - from the same address, so to the same address -
/// and then makes the router answer one of its constants with another address.
/// Only a test can do that; the point is that the script asks the router it
/// deployed instead of assuming.
contract MeddlingDeployer {
    Vm internal constant VM = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    bytes4 internal immutable getter;

    constructor(bytes4 getter_) {
        getter = getter_;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        bytes32 salt = bytes32(data[:32]);
        bytes memory init = data[32:];
        address at;
        assembly ("memory-safe") {
            at := create2(0, add(init, 0x20), mload(init), salt)
        }
        require(at != address(0), "the CREATE2 failed");
        VM.mockCall(at, abi.encodeWithSelector(getter), abi.encode(address(0xBEEF)));
        return abi.encodePacked(at);
    }
}

/// RUNS IN THE DEPLOYMENT PROXY'S PLACE for one call, like MeddlingDeployer,
/// but deploys nothing: it puts OTHER code at the router's address and answers
/// with that address, as a proxy that created something else there would. The
/// code it puts there is the router's own with one byte changed - as long as
/// the router's, and it even answers the four constants right - so only a
/// comparison of the whole code can tell it apart.
contract ForeignCodeDeployer {
    Vm internal constant VM = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address internal immutable at;
    // Running as the proxy, this code reads the PROXY's storage - so the code
    // to put there is asked of this contract itself, at its own address.
    ForeignCodeDeployer internal immutable self;
    bytes internal code;

    constructor(address at_, bytes memory code_) {
        at = at_;
        self = this;
        code = code_;
    }

    function foreign() external view returns (bytes memory) {
        return code;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        VM.etch(at, self.foreign());
        return abi.encodePacked(at);
    }
}

/// A recipient whose receive() tries to come back into the router while the
/// router is still paying it, and keeps what the attempt said.
contract Reenterer {
    CurbRouter internal immutable router;
    address internal immutable registry;
    address internal immutable token;
    bool public tried;
    bytes public lastError;

    constructor(CurbRouter r, address reg, address tok) {
        router = r;
        registry = reg;
        token = tok;
    }

    receive() external payable {
        if (tried) return;
        tried = true;
        try router.buyWithEth{value: 0}(registry, token, "", 0, 0, address(this), block.timestamp) {
            lastError = hex"00";
        } catch (bytes memory err) {
            lastError = err;
        }
    }
}

/// A REGISTRY THAT SAYS YES TO EVERYTHING and names a curve that does nothing:
/// the worst a caller can do to themselves by naming the wrong registry.
contract LyingRegistry {
    address internal immutable curve;
    address internal immutable quote;

    constructor(address curve_, address quote_) {
        curve = curve_;
        quote = quote_;
    }

    function isRegistered(address) external pure returns (bool) {
        return true;
    }

    function launchOf(address) external view returns (ILaunchBook.LaunchRecord memory r) {
        r.curve = curve;
        r.quoteToken = quote;
    }
}

/// Takes no allowance it is given. Its buy delivers nothing; its sale pays a
/// token amount of WETH it was handed, so a sale through it gets past the
/// router's ETH minimum and the allowance it never used can be looked at.
contract LazyCurve {
    uint256 internal constant PAYS = 1e9;

    function buy(uint256, uint256, address) external payable returns (uint256) {
        return 0;
    }

    function sell(uint256, uint256, address to) external returns (uint256) {
        require(IERC20(0x4200000000000000000000000000000000000006).transfer(to, PAYS), "pay");
        return PAYS;
    }
}

/// Mints a v3 position and pays for it in the callback.
contract V3MintHelper {
    function mint(address pool, int24 lo, int24 hi, uint128 liquidity) external {
        IV3PoolLike(pool).mint(address(this), lo, hi, liquidity, "");
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        if (owed0 != 0) require(IERC20(IV3PoolLike(msg.sender).token0()).transfer(msg.sender, owed0), "pay0");
        if (owed1 != 0) require(IERC20(IV3PoolLike(msg.sender).token1()).transfer(msg.sender, owed1), "pay1");
    }
}

/**
 * @title B20RouterForkTest
 * @notice CurbRouter against the REAL curve, the REAL registry and Uniswap's
 *         REAL SwapRouter02 on the fork of Base: one confirmation for an ETH
 *         buy on every kind of pair, and one for an ETH sale.
 *
 * THE FIXTURE IS ONE DEPLOYMENT, AS DeployCurb BUILDS IT: one registry, one
 * graduator, one hook, and a factory, escrow, policy and vault per asset -
 * here five of them, one of each shape the router has to handle:
 *   WETH    no swap at all, and no issuer
 *   NVDAc   one v3 hop, WETH -> NVDAc, the pool the page already prices
 *   SPCXc   two hops, WETH -> USDC -> SPCXc, because SPCXc has no WETH pool
 *   cbBTC   one hop, and NOT A B20: a Coinbase token with its own blacklist
 *   cbXRP   the same, with six decimals
 * and a sixth, GOOGLc (two hops through USDC, like SPCXc), admitted to the same
 * registry only by the tests that trade it - see _googlLaunch.
 *
 * THE STACK IS DEPLOYED FROM ITS BUILT ARTIFACTS (vm.deployCode), not with
 * `new`. The bytecode is the same; what differs is that this file then does
 * not carry every contract of the stack inside its own, so changing the
 * router - which is what a mutation run does, again and again - recompiles
 * this file in a minute instead of re-generating the whole stack through the
 * IR pipeline.
 *
 * THE ROUTER TOO, and that one is not only about speed: this file must not
 * import CurbRouter.sol at all, or it would join the router's compiler
 * profile (foundry.toml) and pull its whole import tree in with it. It talks
 * to the router through ICurbRouter, so a router edit now recompiles the
 * router alone and this file not at all.
 *
 * WHAT "THE ROUTER HOLDS NOTHING" MEANS HERE: no ETH, no WETH, no quote asset,
 * no USDC, no launch token, and no allowance to the curve or to SwapRouter02 -
 * checked after every successful call, by _assertRouterEmpty.
 *
 * EVERY AMOUNT IS COMPARED WITH THE LONG WAY ROUND. Where the router claims to
 * do in one transaction what took three, the three are done first on a
 * snapshot and measured, and the router has to land on exactly the same
 * numbers - so "it worked" means "it cost the user nothing extra", not "some
 * tokens arrived".
 */
contract B20RouterForkTest is B20ForkTest {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address internal constant POSM = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant SWAP_ROUTER02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant SPCXC = 0xb2000000000000000000007b9fcbd005511aCBd5;
    /// Held 5,797 NVDAc at the pinned block (DeployCurb.NVDAC_WHALE).
    address internal constant NVDAC_WHALE = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;

    /// The only WETH/NVDAc tier holding anything at the pinned block
    /// (154 NVDAc); B20EthRoute routes through the same pool.
    uint24 internal constant NVDAC_TIER = 3000;
    /// A WETH/NVDAc tier with NO pool at the pinned block. Created by the
    /// thin-route tests, with a spacing of 200 so a swap that runs out of
    /// liquidity reaches the end of the price range in a few dozen steps.
    uint24 internal constant THIN_TIER = 10000;
    int24 internal constant THIN_TICK = -206000;
    uint128 internal constant THIN_LIQUIDITY = 1e13;
    /// A USDC/NVDAc tier with NO pool at the pinned block (500 and 10000 hold
    /// a few hundred units, 3000 is the deep one). Created by the later-hop
    /// tests as the thin SECOND hop of WETH -> USDC -> NVDAc.
    uint24 internal constant THIN_USDC_TIER = 100;

    address internal constant B20_FACTORY = 0xB20f000000000000000000000000000000000000;
    address internal constant POLICY_REGISTRY = 0x8453000000000000000000000000000000000002;

    // DeployCurb's phantoms and thresholds (the 2026-10-03 shape, about $4K
    // to $55K, at the prices of 2026-10-15); B20MultiAsset holds its fixtures
    // to the same. USDC, VIRTUAL and AERO are traded through this router in
    // B20NewQuoteAssets.
    uint256 internal constant WETH_PHANTOM = 1.65e18;
    uint256 internal constant WETH_THRESHOLD = 4.47e18;
    uint256 internal constant NVDAC_PHANTOM = 18.5e8;
    uint256 internal constant NVDAC_THRESHOLD = 50e8;
    uint256 internal constant SPCXC_PHANTOM = 27.5e8;
    uint256 internal constant SPCXC_THRESHOLD = 74.5e8;
    uint256 internal constant CBBTC_PHANTOM = 0.0487e8;
    uint256 internal constant CBBTC_THRESHOLD = 0.132e8;
    uint256 internal constant CBXRP_PHANTOM = 3010e6;
    uint256 internal constant CBXRP_THRESHOLD = 8150e6;
    uint256 internal constant GOOGLC_PHANTOM = 11.5e8;
    uint256 internal constant GOOGLC_THRESHOLD = 31.1e8;

    /// GOOGLc, on the proposed list (DeployCurb.quoteAssets). A B20 like NVDAc
    /// and SPCXc, under the same issuer policy, and with no WETH pool worth the
    /// name - its WETH/1% pool held one raw unit at the pinned block - so its
    /// ETH route is two hops through USDC, as SPCXc's is.
    address internal constant GOOGLC = 0xb2000000000000000000002D0BA3164cc74f58B7;

    /// THE COINS THAT ARE NOT B20s: Coinbase FiatToken proxies, each with a
    /// blacklist its blacklister keeps (DeployCurb.quoteAssets lists both).
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant CBXRP = 0xcb585250f852C6c6bf90434AB21A00f02833a4af;
    /// Where their proxy (FiatToken's AdminUpgradeabilityProxy) keeps the
    /// implementation address.
    bytes32 internal constant FIAT_TOKEN_IMPLEMENTATION_SLOT =
        0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint24 internal constant POOL_FEE = 500;
    int24 internal constant TICK_SPACING = 10;
    uint16 internal constant TAX_BPS = 300;
    uint16 internal constant MAX_IMPACT_BPS = 500;

    /// EVERY ACTOR HAS A LABEL OF ITS OWN. forge's "alice" is a public key, and
    /// on Base somebody has put an EIP-7702 delegation on it: it has code, and
    /// the router - correctly - paid it WETH instead of ETH. A test that means
    /// "an ordinary wallet" has to be sure it is holding one; setUp checks.
    address internal creator = makeAddr("curb-router-creator");
    address internal protocolRecipient = makeAddr("curb-router-protocol");
    address internal buyer = makeAddr("curb-router-buyer");
    address internal seller = makeAddr("curb-router-seller");
    address internal recipient = makeAddr("curb-router-recipient");
    address internal trader = makeAddr("curb-router-curve-filler");
    address internal alice = makeAddr("curb-router-alice");
    address internal bob = makeAddr("curb-router-bob");
    address internal stranger = makeAddr("curb-router-stranger");

    struct Pair {
        address token;
        address curve;
        address quote;
    }

    CurbRouter internal router;
    LaunchRegistry internal registry;
    Pair internal wethL;
    Pair internal nvdaL;
    Pair internal spcxL;
    Pair internal cbbtcL;
    Pair internal cbxrpL;
    /// Kept so a test can admit one more asset to the same deployment, as
    /// GOOGLc's tests do (see _googlLaunch).
    address internal graduatorAt;
    address internal hookAt;

    function setUp() public {
        if (!_forkGuard()) return;

        address[9] memory actors = [creator, protocolRecipient, buyer, seller, recipient, trader, alice, bob, stranger];
        for (uint256 i = 0; i < actors.length; i++) {
            require(actors[i].code.length == 0, "an actor has code on the fork - give it another label");
        }

        router = CurbRouter(payable(vm.deployCode("CurbRouter.sol:CurbRouter")));

        registry = LaunchRegistry(vm.deployCode("LaunchRegistry.sol:LaunchRegistry", abi.encode(address(this))));
        address graduator =
            vm.deployCode("Graduator.sol:Graduator", abi.encode(POOL_MANAGER, POSM, PERMIT2, address(registry), vm.deployCode("SharingCatalog.sol:SharingCatalog", abi.encode(address(this), address(this)))));
        address hook = _mineHook(graduator);
        (graduatorAt, hookAt) = (graduator, hook);

        address fWeth = _factory(graduator, hook, WETH, 18, WETH_PHANTOM, WETH_THRESHOLD);
        address fNvda = _factory(graduator, hook, NVDAC, 8, NVDAC_PHANTOM, NVDAC_THRESHOLD);
        address fSpcx = _factory(graduator, hook, SPCXC, 8, SPCXC_PHANTOM, SPCXC_THRESHOLD);
        address fCbbtc = _factory(graduator, hook, CBBTC, 8, CBBTC_PHANTOM, CBBTC_THRESHOLD);
        address fCbxrp = _factory(graduator, hook, CBXRP, 6, CBXRP_PHANTOM, CBXRP_THRESHOLD);
        registry.wire(fWeth, hook);
        registry.addLauncher(fNvda);
        registry.addLauncher(fSpcx);
        registry.addLauncher(fCbbtc);
        registry.addLauncher(fCbxrp);

        wethL = _launch(fWeth, WETH, "RWETH");
        nvdaL = _launch(fNvda, NVDAC, "RNVDA");
        spcxL = _launch(fSpcx, SPCXC, "RSPCX");
        cbbtcL = _launch(fCbbtc, CBBTC, "RCBBTC");
        cbxrpL = _launch(fCbxrp, CBXRP, "RCBXRP");

        // THE BUYER HOLDS ETH AND NOTHING ELSE. That is the premise.
        vm.deal(buyer, 100 ether);
    }

    // ================================================================
    // ETH -> launch token
    // ================================================================

    /// THE WETH PAIR: no swap, and exactly what wrap + approve + buy delivers.
    function test_buy_wethLaunch_noSwap_sameAsTheLongWay() public onlyFork {
        Pair memory p = wethL;
        uint256 ethIn = 0.5 ether;

        uint256 snap = vm.snapshotState();
        uint256 g0 = gasleft();
        vm.startPrank(buyer);
        IWETH(WETH).deposit{value: ethIn}();
        IERC20(WETH).approve(p.curve, ethIn);
        uint256 longWay = PonsV2BondingCurve(p.curve).buy(ethIn, 0, recipient);
        vm.stopPrank();
        emit log_named_uint("gas: the long way, wrap + approve + buy (three transactions)", g0 - gasleft());
        vm.revertToState(snap);
        assertGt(longWay, 0, "the long way delivered nothing - nothing to compare");

        uint256 ethBefore = buyer.balance;
        uint256 curveBefore = IERC20(WETH).balanceOf(p.curve);
        vm.expectEmit(true, true, true, true, address(router));
        emit CurbRouter.BoughtWithEth(buyer, p.token, recipient, address(registry), ethIn, ethIn, longWay, 0, 0);
        uint256 g = gasleft();
        vm.prank(buyer);
        uint256 out = router.buyWithEth{value: ethIn}(address(registry), p.token, "", 0, longWay, recipient, block.timestamp);
        emit log_named_uint("gas: buyWithEth, WETH pair (one transaction)", g - gasleft());

        assertEq(out, longWay, "the router delivered a different amount than the long way");
        assertEq(IERC20(p.token).balanceOf(recipient), longWay, "the recipient did not receive the tokens");
        assertEq(IERC20(p.token).balanceOf(buyer), 0, "the tokens went to the caller, not the recipient");
        assertEq(ethBefore - buyer.balance, ethIn, "the buyer paid something other than the ETH sent");
        assertEq(IERC20(WETH).balanceOf(p.curve) - curveBefore, ethIn, "the curve did not receive all of it as WETH");
        _assertRouterEmpty(p);
    }

    /// ONE HOP: WETH -> NVDAc through the pool the page prices, then the curve.
    function test_buy_nvdacLaunch_oneHop_sameAsTheLongWay() public onlyFork {
        _buyThroughARoute(nvdaL, 0.2 ether, "gas: buyWithEth, NVDAc pair, one v3 hop");
    }

    /// TWO HOPS: SPCXc has no WETH pool at all, so the route goes through USDC.
    function test_buy_spcxLaunch_twoHopsViaUsdc_sameAsTheLongWay() public onlyFork {
        assertEq(_buyPath(spcxL).length, 20 + 23 * 2, "the SPCXc route is not two hops");
        _buyThroughARoute(spcxL, 0.2 ether, "gas: buyWithEth, SPCXc pair, two v3 hops");
        assertEq(IERC20(USDC).balanceOf(buyer), 0, "the middle asset reached the buyer");
    }

    function _buyThroughARoute(Pair memory p, uint256 ethIn, string memory gasLabel) internal {
        bytes memory path = _buyPath(p);

        // THE LONG WAY: swap ETH for the asset, then buy with exactly what
        // arrived. Two of the three confirmations the router replaces.
        uint256 snap = vm.snapshotState();
        uint256 g0 = gasleft();
        vm.startPrank(buyer);
        uint256 swapped = ISwapRouter02(SWAP_ROUTER02).exactInput{value: ethIn}(
            ISwapRouter02.ExactInputParams({path: path, recipient: buyer, amountIn: ethIn, amountOutMinimum: 0})
        );
        IERC20(p.quote).approve(p.curve, swapped);
        uint256 longWay = PonsV2BondingCurve(p.curve).buy(swapped, 0, recipient);
        vm.stopPrank();
        emit log_named_uint("gas: the long way, swap + approve + buy (three transactions)", g0 - gasleft());
        vm.revertToState(snap);
        assertGt(swapped, 0, "the route delivered none of the asset");
        assertGt(longWay, 0, "the long way delivered no tokens");

        uint256 ethBefore = buyer.balance;
        uint256 curveBefore = IERC20(p.quote).balanceOf(p.curve);
        // THE EXACT MINIMUMS ARE PASSED, so this also shows each bound
        // accepting its own boundary.
        vm.expectEmit(true, true, true, true, address(router));
        emit CurbRouter.BoughtWithEth(buyer, p.token, recipient, address(registry), ethIn, swapped, longWay, 0, 0);
        uint256 g = gasleft();
        vm.prank(buyer);
        uint256 out =
            router.buyWithEth{value: ethIn}(address(registry), p.token, path, swapped, longWay, recipient, block.timestamp);
        emit log_named_uint(gasLabel, g - gasleft());

        assertEq(out, longWay, "the router delivered a different amount than the long way");
        assertEq(IERC20(p.token).balanceOf(recipient), longWay, "the recipient did not receive the tokens");
        assertEq(ethBefore - buyer.balance, ethIn, "the buyer paid something other than the ETH sent");
        assertEq(IERC20(p.quote).balanceOf(p.curve) - curveBefore, swapped, "the curve was not offered all of the swap");
        assertEq(IERC20(p.quote).balanceOf(buyer), 0, "the asset was left with the buyer");
        _assertRouterEmpty(p);
    }

    // ---------------------------------------------------- past the threshold

    /// THE BUY THAT FILLS A WETH LAUNCH: the curve takes what it needs and
    /// refunds the rest to the router, and the router hands it to the CALLER
    /// as ETH.
    function test_buyPastTheThreshold_wethLaunch_refundsEthToTheCaller() public onlyFork {
        Pair memory p = wethL;
        PonsV2BondingCurve c = PonsV2BondingCurve(p.curve);
        _fillDirectly(p, WETH_THRESHOLD * 23 / 24); // most of the way: 4.28 of 4.47 WETH
        uint256 sellable = c.sellableTokens();
        assertGt(sellable, 0, "the fill graduated the launch - nothing left to cross with");

        uint256 ethIn = 2 ether;
        uint256 ethBefore = buyer.balance;
        vm.recordLogs();
        vm.prank(buyer);
        uint256 out = router.buyWithEth{value: ethIn}(address(registry), p.token, "", 0, 0, recipient, block.timestamp);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 refund = _curveRefund(logs, p.curve);
        assertGt(refund, 0, "the curve refunded nothing - this buy was not past the threshold");
        assertEq(out, sellable, "the buy did not take the rest of the curve");
        (,, uint256 routerQuoteRefund, uint256 routerEthRefund) = _boughtEvent(logs);
        assertEq(routerEthRefund, refund, "the router reported a different ETH refund than the curve made");
        assertEq(routerQuoteRefund, 0, "a WETH launch reported an asset refund");

        assertEq(ethBefore - buyer.balance, ethIn - refund, "the refund did not come back to the caller as ETH");
        assertEq(IERC20(WETH).balanceOf(buyer), 0, "the refund came back as WETH to a caller that takes ETH");
        assertEq(IERC20(WETH).balanceOf(recipient), 0, "the refund went to the recipient, not the caller");
        assertEq(recipient.balance, 0, "the refund went to the recipient, not the caller");
        assertTrue(c.graduated(), "the crossing buy did not graduate the launch");
        _assertRouterEmpty(p);
    }

    /// THE SAME ON A STOCK PAIR: the refund is the ASSET, because that is what
    /// the curve refunded - and no ETH comes back, since the swap spent it all.
    function test_buyPastTheThreshold_stockLaunch_refundsTheAssetToTheCaller() public onlyFork {
        Pair memory p = nvdaL;
        PonsV2BondingCurve c = PonsV2BondingCurve(p.curve);
        _fillDirectly(p, NVDAC_THRESHOLD * 29 / 30); // most of the way: 48.3 of 50 NVDAc
        uint256 sellable = c.sellableTokens();
        assertGt(sellable, 0, "the fill graduated the launch - nothing left to cross with");

        uint256 ethIn = 1 ether;
        uint256 ethBefore = buyer.balance;
        vm.recordLogs();
        vm.prank(buyer);
        uint256 out =
            router.buyWithEth{value: ethIn}(address(registry), p.token, _buyPath(p), 1, 0, recipient, block.timestamp);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 refund = _curveRefund(logs, p.curve);
        assertGt(refund, 0, "the curve refunded nothing - this buy was not past the threshold");
        assertEq(out, sellable, "the buy did not take the rest of the curve");
        (,, uint256 routerQuoteRefund, uint256 routerEthRefund) = _boughtEvent(logs);
        assertEq(routerQuoteRefund, refund, "the router reported a different asset refund than the curve made");
        assertEq(routerEthRefund, 0, "ETH came back although the swap spent all of it");

        assertEq(IERC20(NVDAC).balanceOf(buyer), refund, "the refund did not reach the caller as the asset");
        assertEq(IERC20(NVDAC).balanceOf(recipient), 0, "the refund went to the recipient, not the caller");
        assertEq(ethBefore - buyer.balance, ethIn, "the buyer paid something other than the ETH sent");
        assertTrue(c.graduated(), "the crossing buy did not graduate the launch");
        _assertRouterEmpty(p);
    }

    /// A CALLER THAT CANNOT TAKE ETH still gets its refund - as WETH.
    function test_buyPastTheThreshold_aCallerThatRefusesEth_isRefundedInWeth() public onlyFork {
        Pair memory p = wethL;
        _fillDirectly(p, WETH_THRESHOLD * 23 / 24); // most of the way: 4.28 of 4.47 WETH
        RefusingBuyer rb = new RefusingBuyer();
        vm.deal(address(rb), 3 ether);

        vm.recordLogs();
        rb.buy(router, address(registry), p.token, 2 ether);
        uint256 refund = _curveRefund(vm.getRecordedLogs(), p.curve);

        assertGt(refund, 0, "nothing was refunded - the buy was not past the threshold");
        assertEq(IERC20(WETH).balanceOf(address(rb)), refund, "the refund did not arrive as WETH");
        assertEq(address(rb).balance, 1 ether, "ETH moved other than the 2 ETH sent");
        _assertRouterEmpty(p);
    }

    // ================================================================
    // launch token -> ETH
    // ================================================================

    /// THE WETH PAIR: sell, and the recipient is paid ETH - the unwrap that
    /// used to be its own confirmation happens inside the same call.
    function test_sell_wethLaunch_paysEthToTheRecipient() public onlyFork {
        Pair memory p = wethL;
        uint256 held = _hold(p, seller, 0.5 ether);
        uint256 amount = held / 2;

        uint256 snap = vm.snapshotState();
        uint256 g0 = gasleft();
        vm.startPrank(seller);
        IERC20(p.token).approve(p.curve, amount);
        uint256 longWay = PonsV2BondingCurve(p.curve).sell(amount, 0, seller);
        IWETH(WETH).withdraw(longWay);
        vm.stopPrank();
        emit log_named_uint("gas: the long way, approve + sell + unwrap (three transactions)", g0 - gasleft());
        vm.revertToState(snap);
        assertGt(longWay, 0, "the long way paid nothing");

        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);
        uint256 ethBefore = recipient.balance;
        vm.expectEmit(true, true, true, true, address(router));
        emit CurbRouter.SoldForEth(seller, p.token, recipient, address(registry), amount, longWay, longWay, false);
        uint256 g = gasleft();
        vm.prank(seller);
        uint256 out =
            router.sellForEth(address(registry), p.token, amount, longWay, "", longWay, recipient, block.timestamp);
        emit log_named_uint("gas: sellForEth, WETH pair (after one approve)", g - gasleft());

        assertEq(out, longWay, "the router paid a different amount than the curve would");
        assertEq(recipient.balance - ethBefore, longWay, "the recipient was not paid in ETH");
        assertEq(IERC20(WETH).balanceOf(recipient), 0, "WETH was paid to a recipient that takes ETH");
        assertEq(IERC20(p.token).balanceOf(seller), held - amount, "the wrong amount was sold");
        assertEq(IERC20(p.token).allowance(seller, address(router)), 0, "the seller's approval was not spent exactly");
        _assertRouterEmpty(p);
    }

    /// A STOCK PAIR'S SALE PAYS ETH - which it could not do at all before.
    function test_sell_nvdacLaunch_oneHop_paysEth() public onlyFork {
        _sellThroughARoute(nvdaL, "gas: sellForEth, NVDAc pair, one v3 hop");
    }

    function test_sell_spcxLaunch_twoHopsViaUsdc_paysEth() public onlyFork {
        _sellThroughARoute(spcxL, "gas: sellForEth, SPCXc pair, two v3 hops");
        assertEq(IERC20(USDC).balanceOf(recipient), 0, "the middle asset reached the recipient");
    }

    // ---------------------------------------------------------------- GOOGLc

    /// GOOGLc'S ETH BUY, END TO END, exactly as the long way does it. The
    /// route is the page's: no WETH pool holds as much GOOGLc as the deepest
    /// USDC pool (B20EthRoute's rule, checked here so a WETH pool that filled
    /// up would say so), so it is two hops, WETH -> USDC -> GOOGLc.
    function test_buy_googlcLaunch_twoHopsViaUsdc_sameAsTheLongWay() public onlyFork {
        Pair memory p = _googlLaunch();
        assertLt(_mostHeld(WETH, GOOGLC), _mostHeld(USDC, GOOGLC), "a WETH pool now holds the most GOOGLc - the page would route one hop");
        bytes memory path = _buyPath(p);
        assertEq(path.length, 20 + 23 * 2, "the GOOGLc route is not two hops");
        assertEq(_addrAt(path, 23), USDC, "the GOOGLc route does not pass through USDC");
        _buyThroughARoute(p, 0.2 ether, "gas: buyWithEth, GOOGLc pair, two v3 hops");
        assertEq(IERC20(USDC).balanceOf(buyer), 0, "the middle asset reached the buyer");
    }

    /// AND ITS SALE PAYS ETH, GOOGLc -> USDC -> WETH, exactly as the long way.
    function test_sell_googlcLaunch_twoHopsViaUsdc_paysEth() public onlyFork {
        Pair memory p = _googlLaunch();
        _sellThroughARoute(p, "gas: sellForEth, GOOGLc pair, two v3 hops");
        assertEq(IERC20(USDC).balanceOf(recipient), 0, "the middle asset reached the recipient");
    }

    /// GOOGLc'S ISSUER IS ASKED AS NVDAc'S IS, of the caller and of the
    /// recipient, on the buy and on the sale. GOOGLc names its own policies -
    /// read from GOOGLc here, never assumed from NVDAc - and an account the
    /// issuer refuses is refused by name with nothing moved: not the caller's
    /// ETH, not the tokens it bought before the entry, not an allowed seller's
    /// tokens bound for it. The WETH pair still pays it, and an account the
    /// issuer allows still trades GOOGLc both ways.
    function test_googlc_anAccountTheIssuerBlocks_isRefusedAsCallerAndRecipient() public onlyFork {
        Pair memory p = _googlLaunch();
        assertTrue(_isB20(GOOGLC), "GOOGLc is not a B20 now - this no longer covers an issuer's pair");
        address blocked = makeAddr("curb-router-googlc-blocked");
        vm.deal(blocked, 5 ether);
        uint256 held = _hold(p, blocked, 0.2 ether); // bought before the entry
        uint256 sold = _hold(p, seller, 0.2 ether);
        uint256 heldWeth = _hold(wethL, blocked, 0.1 ether);
        bytes memory buyPath = _buyPath(p); // before any prank: it asks the v3 factory
        bytes memory sellPath = _sellPath(p);
        _issuerBlocksOn(GOOGLC, blocked);
        (bytes32 sendScope, uint64 sendPolicy) = _policyOf(GOOGLC, "TRANSFER_SENDER_POLICY()");
        bytes memory refusal = abi.encodeWithSelector(CurbRouter.IssuerForbids.selector, blocked, sendScope, sendPolicy);
        uint256 ethBefore = blocked.balance;

        // AS THE CALLER, paying an allowed recipient: neither trade.
        vm.prank(blocked);
        vm.expectRevert(refusal);
        router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, recipient, block.timestamp);
        vm.startPrank(blocked);
        IERC20(p.token).approve(address(router), held);
        vm.expectRevert(refusal);
        router.sellForEth(address(registry), p.token, held, 0, sellPath, 1, recipient, block.timestamp);
        vm.stopPrank();

        // AS THE RECIPIENT of an allowed caller: neither trade.
        vm.prank(buyer);
        vm.expectRevert(refusal);
        router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, blocked, block.timestamp);
        vm.startPrank(seller);
        IERC20(p.token).approve(address(router), sold);
        vm.expectRevert(refusal);
        router.sellForEth(address(registry), p.token, sold, 0, sellPath, 1, blocked, block.timestamp);
        vm.stopPrank();

        assertEq(blocked.balance, ethBefore, "a refused trade moved the blocked account's ETH");
        assertEq(IERC20(p.token).balanceOf(blocked), held, "the refused sale took the blocked account's tokens");
        assertEq(IERC20(p.token).balanceOf(seller), sold, "the refused sale took the allowed seller's tokens");
        assertEq(IERC20(p.token).balanceOf(recipient), 0, "the refused buy delivered tokens");
        _assertRouterEmpty(p);

        // THE WETH PAIR, WHICH HAS NO ISSUER, STILL PAYS THE BLOCKED ACCOUNT...
        vm.startPrank(blocked);
        IERC20(wethL.token).approve(address(router), heldWeth);
        uint256 paid = router.sellForEth(address(registry), wethL.token, heldWeth, 0, "", 1, blocked, block.timestamp);
        vm.stopPrank();
        assertGt(paid, 0, "the WETH pair, which has no issuer, refused the blocked account");

        // ...AND AN ACCOUNT THE ISSUER ALLOWS STILL TRADES GOOGLc BOTH WAYS.
        vm.prank(buyer);
        assertGt(
            router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, recipient, block.timestamp),
            0,
            "a caller the issuer allows could not buy GOOGLc's launch"
        );
        vm.prank(seller);
        assertGt(
            router.sellForEth(address(registry), p.token, sold, 0, sellPath, 1, seller, block.timestamp),
            0,
            "a seller the issuer allows could not sell GOOGLc's launch"
        );
        _assertRouterEmpty(p);
    }

    function _sellThroughARoute(Pair memory p, string memory gasLabel) internal {
        uint256 held = _hold(p, seller, 0.3 ether);
        uint256 amount = held / 2;
        bytes memory path = _sellPath(p);

        // THE LONG WAY: sell for the asset, then swap it for WETH.
        uint256 snap = vm.snapshotState();
        uint256 g0 = gasleft();
        vm.startPrank(seller);
        IERC20(p.token).approve(p.curve, amount);
        uint256 quoteOut = PonsV2BondingCurve(p.curve).sell(amount, 0, seller);
        IERC20(p.quote).approve(SWAP_ROUTER02, quoteOut);
        uint256 wethOut = ISwapRouter02(SWAP_ROUTER02).exactInput(
            ISwapRouter02.ExactInputParams({path: path, recipient: seller, amountIn: quoteOut, amountOutMinimum: 0})
        );
        IWETH(WETH).withdraw(wethOut);
        vm.stopPrank();
        emit log_named_uint(
            "gas: the long way, approve + sell + approve + swap + unwrap (five transactions)", g0 - gasleft()
        );
        vm.revertToState(snap);
        assertGt(wethOut, 0, "the long way paid no WETH");

        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);
        uint256 ethBefore = recipient.balance;
        vm.expectEmit(true, true, true, true, address(router));
        emit CurbRouter.SoldForEth(seller, p.token, recipient, address(registry), amount, quoteOut, wethOut, false);
        uint256 g = gasleft();
        vm.prank(seller);
        uint256 out =
            router.sellForEth(address(registry), p.token, amount, quoteOut, path, wethOut, recipient, block.timestamp);
        emit log_named_uint(gasLabel, g - gasleft());

        assertEq(out, wethOut, "the router paid a different amount than the long way");
        assertEq(recipient.balance - ethBefore, wethOut, "the recipient was not paid in ETH");
        assertEq(IERC20(WETH).balanceOf(recipient), 0, "WETH was paid to a recipient that takes ETH");
        assertEq(IERC20(p.quote).balanceOf(recipient), 0, "the asset reached the recipient");
        assertEq(IERC20(p.token).balanceOf(seller), held - amount, "the wrong amount was sold");
        assertEq(IERC20(p.token).allowance(seller, address(router)), 0, "the seller's approval was not spent exactly");
        _assertRouterEmpty(p);
    }

    /// A RECIPIENT THAT REFUSES ETH IS PAID IN WETH, and the sale still goes
    /// through. The EOA tests above hold the other half: ETH, and no WETH.
    function test_sell_aRecipientThatRefusesEth_isPaidInWeth() public onlyFork {
        Pair memory p = nvdaL;
        address refuser = address(new EthRefuser());
        uint256 amount = _hold(p, seller, 0.3 ether) / 2;
        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);

        vm.recordLogs();
        vm.prank(seller);
        uint256 out = router.sellForEth(address(registry), p.token, amount, 0, _sellPath(p), 1, refuser, block.timestamp);

        assertGt(out, 0, "nothing was paid");
        assertEq(IERC20(WETH).balanceOf(refuser), out, "the recipient was not paid in WETH");
        assertEq(refuser.balance, 0, "ETH reached a recipient that refuses it");
        assertTrue(_soldAsWeth(vm.getRecordedLogs()), "the event did not say it paid WETH");
        _assertRouterEmpty(p);
    }

    // ================================================================
    // every bound, each one failing by one unit and passing at its value
    // ================================================================

    function test_buy_minQuoteOut_boundsWhatTheSwapDelivered() public onlyFork {
        Pair memory p = nvdaL;
        uint256 ethIn = 0.2 ether;
        bytes memory path = _buyPath(p);
        uint256 q = _swapQuote(path, ethIn);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.QuoteBelowMinimum.selector, q, q + 1));
        router.buyWithEth{value: ethIn}(address(registry), p.token, path, q + 1, 0, recipient, block.timestamp);

        vm.prank(buyer);
        router.buyWithEth{value: ethIn}(address(registry), p.token, path, q, 0, recipient, block.timestamp);
    }

    function test_buy_minTokensOut_isTheCurvesOwnBound() public onlyFork {
        Pair memory p = wethL;
        uint256 ethIn = 0.3 ether;
        uint256 snap = vm.snapshotState();
        vm.prank(buyer);
        uint256 out = router.buyWithEth{value: ethIn}(address(registry), p.token, "", 0, 0, recipient, block.timestamp);
        vm.revertToState(snap);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PonsV2BondingCurve.SlippageExceeded.selector, out, out + 1));
        router.buyWithEth{value: ethIn}(address(registry), p.token, "", 0, out + 1, recipient, block.timestamp);

        vm.prank(buyer);
        router.buyWithEth{value: ethIn}(address(registry), p.token, "", 0, out, recipient, block.timestamp);
    }

    function test_sell_minQuoteOut_isTheCurvesOwnBound() public onlyFork {
        Pair memory p = nvdaL;
        uint256 amount = _hold(p, seller, 0.3 ether) / 2;
        uint256 snap = vm.snapshotState();
        vm.startPrank(seller);
        IERC20(p.token).approve(p.curve, amount);
        uint256 q = PonsV2BondingCurve(p.curve).sell(amount, 0, seller);
        vm.stopPrank();
        vm.revertToState(snap);

        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(PonsV2BondingCurve.SlippageExceeded.selector, q, q + 1));
        router.sellForEth(address(registry), p.token, amount, q + 1, _sellPath(p), 1, seller, block.timestamp);

        vm.prank(seller);
        router.sellForEth(address(registry), p.token, amount, q, _sellPath(p), 1, seller, block.timestamp);
    }

    function test_sell_minEthOut_boundsWhatArrives() public onlyFork {
        Pair memory p = nvdaL;
        uint256 amount = _hold(p, seller, 0.3 ether) / 2;
        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);

        uint256 snap = vm.snapshotState();
        vm.prank(seller);
        uint256 e = router.sellForEth(address(registry), p.token, amount, 0, _sellPath(p), 1, recipient, block.timestamp);
        vm.revertToState(snap);
        assertGt(e, 0, "nothing to bound");

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.EthBelowMinimum.selector, e, e + 1));
        router.sellForEth(address(registry), p.token, amount, 0, _sellPath(p), e + 1, recipient, block.timestamp);

        vm.prank(seller);
        router.sellForEth(address(registry), p.token, amount, 0, _sellPath(p), e, recipient, block.timestamp);
    }

    /// ON THE WETH PAIR TOO, where the ETH is the curve's payout itself.
    function test_sell_minEthOut_bindsOnTheWethPairToo() public onlyFork {
        Pair memory p = wethL;
        uint256 amount = _hold(p, seller, 0.3 ether) / 2;
        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);

        uint256 snap = vm.snapshotState();
        vm.prank(seller);
        uint256 e = router.sellForEth(address(registry), p.token, amount, 0, "", 1, recipient, block.timestamp);
        vm.revertToState(snap);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.EthBelowMinimum.selector, e, e + 1));
        router.sellForEth(address(registry), p.token, amount, 0, "", e + 1, recipient, block.timestamp);
    }

    /// THE DEADLINE, one second late, both ways. Every other test passes
    /// block.timestamp itself, which is the boundary being accepted.
    function test_anExpiredDeadline_isRefused() public onlyFork {
        uint256 late = block.timestamp - 1;
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.Expired.selector, late, block.timestamp));
        router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0, 0, recipient, late);

        uint256 amount = _hold(wethL, seller, 0.1 ether);
        vm.prank(seller);
        IERC20(wethL.token).approve(address(router), amount);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.Expired.selector, late, block.timestamp));
        router.sellForEth(address(registry), wethL.token, amount, 0, "", 0, recipient, late);
    }

    // ================================================================
    // what the router refuses to trade
    // ================================================================

    /// A TOKEN THE REGISTRY DOES NOT KNOW - including a real launch, asked of
    /// a registry it is not in. The registry is the authority, not the token.
    function test_aTokenTheRegistryDoesNotKnow_isRefused() public onlyFork {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.NotALaunch.selector, address(registry), USDC));
        router.buyWithEth{value: 0.1 ether}(address(registry), USDC, "", 0, 0, recipient, block.timestamp);

        address other = vm.deployCode("LaunchRegistry.sol:LaunchRegistry", abi.encode(address(this)));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.NotALaunch.selector, other, wethL.token));
        router.buyWithEth{value: 0.1 ether}(other, wethL.token, "", 0, 0, recipient, block.timestamp);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.NotALaunch.selector, address(registry), USDC));
        router.sellForEth(address(registry), USDC, 1, 0, abi.encodePacked(USDC, uint24(500), WETH), 0, seller, block.timestamp);
    }

    function test_buy_aPathThatDoesNotStartAtWeth_isRefused() public onlyFork {
        bytes memory path = abi.encodePacked(USDC, uint24(500), NVDAC);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.PathStartsElsewhere.selector, USDC, WETH));
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, path, 0, 0, recipient, block.timestamp);
    }

    /// A REAL ROUTE, TO THE WRONG ASSET: NVDAc's own route, offered for SPCXc.
    function test_buy_aPathThatDoesNotEndAtTheQuote_isRefused() public onlyFork {
        bytes memory path = _buyPath(nvdaL);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.PathEndsElsewhere.selector, NVDAC, SPCXC));
        router.buyWithEth{value: 0.1 ether}(address(registry), spcxL.token, path, 0, 0, recipient, block.timestamp);
    }

    function test_sell_aPathThatDoesNotStartAtTheQuote_isRefused() public onlyFork {
        uint256 amount = _hold(nvdaL, seller, 0.1 ether);
        vm.prank(seller);
        IERC20(nvdaL.token).approve(address(router), amount);
        bytes memory path = _sellPath(spcxL);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.PathStartsElsewhere.selector, SPCXC, NVDAC));
        router.sellForEth(address(registry), nvdaL.token, amount, 0, path, 0, seller, block.timestamp);
    }

    /// THE ONE THAT WOULD COST MONEY. A sale whose route ends in USDC: without
    /// the check it would pay out zero ETH and leave the USDC in the router for
    /// good. Since the ETH minimum may not be zero, that minimum would refuse
    /// such a sale too; this check names the real fault first, before anything
    /// moves, and is what this test pins.
    function test_sell_aPathThatDoesNotEndAtWeth_isRefused() public onlyFork {
        uint256 amount = _hold(nvdaL, seller, 0.1 ether);
        vm.prank(seller);
        IERC20(nvdaL.token).approve(address(router), amount);
        bytes memory path = abi.encodePacked(NVDAC, NVDAC_TIER, WETH, uint24(500), USDC);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.PathEndsElsewhere.selector, USDC, WETH));
        router.sellForEth(address(registry), nvdaL.token, amount, 0, path, 0, seller, block.timestamp);
    }

    /// A PATH OF THE WRONG LENGTH, built so its last twenty bytes ARE the
    /// right asset. SwapRouter02 reads it as one hop - NVDAc -> USDC on the
    /// sale, WETH -> USDC on the buy - so an end-check that trusted the tail
    /// would pass it. THE SALE IS FIRST because it is the case that costs
    /// money: it would pay nothing and strand the USDC (the ETH minimum, which
    /// may not be zero, now stands behind this check as well). On the buy the
    /// curve would refuse the zero it was offered anyway.
    function test_aPathOfTheWrongShape_isRefused() public onlyFork {
        uint256 amount = _hold(nvdaL, seller, 0.1 ether);
        vm.prank(seller);
        IERC20(nvdaL.token).approve(address(router), amount);
        bytes memory sellPath = abi.encodePacked(NVDAC, NVDAC_TIER, USDC, WETH);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.MalformedPath.selector, sellPath.length));
        router.sellForEth(address(registry), nvdaL.token, amount, 0, sellPath, 0, seller, block.timestamp);

        bytes memory buyPath = abi.encodePacked(WETH, NVDAC_TIER, USDC, NVDAC);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.MalformedPath.selector, buyPath.length));
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, buyPath, 0, 0, recipient, block.timestamp);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.MalformedPath.selector, 0));
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, "", 0, 0, recipient, block.timestamp);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.MalformedPath.selector, 20));
        router.buyWithEth{value: 0.1 ether}(
            address(registry), nvdaL.token, abi.encodePacked(WETH), 0, 0, recipient, block.timestamp
        );
    }

    function test_aPathOnAWethLaunch_isRefused() public onlyFork {
        bytes memory path = _buyPath(nvdaL);
        vm.prank(buyer);
        vm.expectRevert(CurbRouter.PathOnWethLaunch.selector);
        router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, path, 0, 0, recipient, block.timestamp);

        uint256 amount = _hold(wethL, seller, 0.1 ether);
        vm.prank(seller);
        IERC20(wethL.token).approve(address(router), amount);
        vm.prank(seller);
        vm.expectRevert(CurbRouter.PathOnWethLaunch.selector);
        router.sellForEth(address(registry), wethL.token, amount, 0, _sellPath(nvdaL), 0, seller, block.timestamp);
    }

    /// A ZERO RECIPIENT. The sale first, because there it matters: a call to
    /// address zero succeeds, so the ETH would simply be gone. On a buy the
    /// curve refuses a zero recipient by itself.
    ///
    /// THE SALE NAMES AN ETH MINIMUM, so this refusal is the only thing that
    /// stands between the sale and address zero. With a minimum of zero the
    /// sale was refused by NoEthMinimum as well, and a router without this
    /// check still reverted (mutate-router.sh).
    function test_aZeroRecipient_isRefused() public onlyFork {
        uint256 amount = _hold(wethL, seller, 0.1 ether);
        vm.prank(seller);
        IERC20(wethL.token).approve(address(router), amount);
        vm.prank(seller);
        vm.expectRevert(CurbRouter.ZeroRecipient.selector);
        router.sellForEth(address(registry), wethL.token, amount, 0, "", 1, address(0), block.timestamp);

        vm.prank(buyer);
        vm.expectRevert(CurbRouter.ZeroRecipient.selector);
        router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0, 0, address(0), block.timestamp);
    }

    /// NOR THE ROUTER ITSELF: it cannot hand anything on, so a payout to
    /// itself would be stranded for good. The sale names an ETH minimum, so
    /// this refusal is the only one in its way (see the zero recipient above).
    function test_theRouterAsRecipient_isRefused() public onlyFork {
        vm.prank(buyer);
        vm.expectRevert(CurbRouter.RecipientIsTheRouter.selector);
        router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0, 0, address(router), block.timestamp);

        uint256 amount = _hold(wethL, seller, 0.1 ether);
        vm.prank(seller);
        IERC20(wethL.token).approve(address(router), amount);
        vm.prank(seller);
        vm.expectRevert(CurbRouter.RecipientIsTheRouter.selector);
        router.sellForEth(address(registry), wethL.token, amount, 0, "", 1, address(router), block.timestamp);
    }

    function test_noEthAndStrayEth_areRefused() public onlyFork {
        vm.prank(buyer);
        vm.expectRevert(CurbRouter.NoEthSent.selector);
        router.buyWithEth(address(registry), wethL.token, "", 0, 0, recipient, block.timestamp);

        vm.prank(buyer);
        (bool ok, bytes memory err) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "the router accepted ETH sent to it directly");
        assertEq(err, abi.encodeWithSelector(CurbRouter.UnexpectedEth.selector, buyer), "refused for another reason");
    }

    // ================================================================
    // whose money it can move
    // ================================================================

    /// AN APPROVAL IS SPENDABLE BY THE ONE WHO GAVE IT, THROUGH THEIR OWN CALL.
    /// Alice approves the router; Bob, holding tokens of his own, asks it to
    /// sell Alice's amount. There is no argument naming Alice, so the router
    /// pulls from Bob - who approved nothing - and the call fails.
    function test_nobodyCanSpendAnotherCallersApproval() public onlyFork {
        Pair memory p = nvdaL;
        uint256 aliceHeld = _hold(p, alice, 0.2 ether);
        uint256 bobHeld = _hold(p, bob, 0.2 ether);
        vm.prank(alice);
        IERC20(p.token).approve(address(router), aliceHeld);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, aliceHeld)
        );
        router.sellForEth(address(registry), p.token, aliceHeld, 0, _sellPath(p), 1, bob, block.timestamp);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, aliceHeld)
        );
        router.sellForEth(address(registry), p.token, aliceHeld, 0, _sellPath(p), 1, stranger, block.timestamp);

        assertEq(IERC20(p.token).balanceOf(alice), aliceHeld, "Alice's tokens moved");
        assertEq(IERC20(p.token).allowance(alice, address(router)), aliceHeld, "Alice's approval was touched");
        assertEq(IERC20(p.token).balanceOf(bob), bobHeld, "Bob's tokens moved");

        // AND ALICE'S OWN CALL SPENDS IT - so the refusal above was about who
        // called, not a router that cannot sell.
        vm.prank(alice);
        router.sellForEth(address(registry), p.token, aliceHeld, 0, _sellPath(p), 1, alice, block.timestamp);
        assertEq(IERC20(p.token).balanceOf(alice), 0, "Alice's sale did not happen");
        assertGt(alice.balance, 0, "Alice was not paid in ETH");
        assertEq(IERC20(p.token).balanceOf(bob), bobHeld, "Bob's tokens moved");
        _assertRouterEmpty(p);
    }

    /// A BALANCE ALREADY IN THE ROUTER IS NOBODY'S TO SPEND AND NOBODY'S TO
    /// TAKE. Anyone can transfer tokens to any address, so the router can hold
    /// some; every amount it moves is a delta, so a caller's buy is offered
    /// exactly what their own ETH produced and their sale pays exactly what
    /// their own tokens produced - and the donation is still there, to the wei.
    function test_aBalanceAlreadyInTheRouter_isNeitherSpentNorHandedOut() public onlyFork {
        Pair memory p = nvdaL;
        bytes memory path = _buyPath(p);
        uint256 ethIn = 0.2 ether;
        uint256 swapped = _swapQuote(path, ethIn);

        uint256 dustQuote = 1e8;
        uint256 dustWeth = 0.05 ether;
        vm.prank(NVDAC_WHALE);
        require(IERC20(NVDAC).transfer(address(router), dustQuote), "plant NVDAc");
        _giveWeth(stranger, dustWeth);
        vm.prank(stranger);
        require(IERC20(WETH).transfer(address(router), dustWeth), "plant WETH");

        // ---- the buy: offered what the swap produced, refunded nothing
        uint256 snap = vm.snapshotState();
        uint256 ethBefore = buyer.balance;
        vm.recordLogs();
        vm.prank(buyer);
        router.buyWithEth{value: ethIn}(address(registry), p.token, path, swapped, 0, seller, block.timestamp);
        (, uint256 quoteIn, uint256 quoteRefund, uint256 ethRefund) = _boughtEvent(vm.getRecordedLogs());
        assertEq(quoteIn, swapped, "the curve was offered more than the caller's own swap produced");
        assertEq(quoteRefund, 0, "the router handed the caller an asset balance that was not theirs");
        assertEq(ethRefund, 0, "the router handed the caller WETH that was not theirs");
        assertEq(ethBefore - buyer.balance, ethIn, "the buyer's ETH moved by other than what was sent");
        assertEq(IERC20(NVDAC).balanceOf(buyer), 0, "the buyer was handed the planted asset");
        assertEq(IERC20(NVDAC).balanceOf(address(router)), dustQuote, "the planted asset moved");
        assertEq(IERC20(WETH).balanceOf(address(router)), dustWeth, "the planted WETH moved");
        vm.revertToState(snap);

        // ---- the sale: pays exactly what the caller's own tokens produced
        uint256 amount = _hold(p, seller, 0.3 ether) / 2;
        bytes memory back = _sellPath(p);
        snap = vm.snapshotState();
        vm.startPrank(seller);
        IERC20(p.token).approve(p.curve, amount);
        uint256 quoteOut = PonsV2BondingCurve(p.curve).sell(amount, 0, seller);
        IERC20(p.quote).approve(SWAP_ROUTER02, quoteOut);
        uint256 wethOut = ISwapRouter02(SWAP_ROUTER02).exactInput(
            ISwapRouter02.ExactInputParams({path: back, recipient: seller, amountIn: quoteOut, amountOutMinimum: 0})
        );
        vm.stopPrank();
        vm.revertToState(snap);

        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);
        uint256 recipientBefore = recipient.balance;
        vm.prank(seller);
        uint256 out = router.sellForEth(address(registry), p.token, amount, 0, back, 1, recipient, block.timestamp);
        assertEq(out, wethOut, "the sale paid other than what the caller's own tokens produced");
        assertEq(recipient.balance - recipientBefore, wethOut, "the recipient was paid other than the sale");
        assertEq(IERC20(NVDAC).balanceOf(address(router)), dustQuote, "the planted asset moved");
        assertEq(IERC20(WETH).balanceOf(address(router)), dustWeth, "the planted WETH moved");
    }

    /// A REGISTRY THAT LIES can cost its caller their own money, and that is
    /// all. Here its curve takes nothing it is offered: the buyer's ETH comes
    /// straight back, and neither the WETH nor the launch-token allowance is
    /// left standing for that curve to use later.
    function test_aRegistryThatLies_leavesNoAllowanceStanding() public onlyFork {
        LazyCurve lazy = new LazyCurve();
        address liar = address(new LyingRegistry(address(lazy), WETH));

        uint256 ethBefore = buyer.balance;
        vm.prank(buyer);
        router.buyWithEth{value: 0.3 ether}(liar, wethL.token, "", 0, 0, recipient, block.timestamp);
        assertEq(IERC20(WETH).allowance(address(router), address(lazy)), 0, "a WETH allowance was left standing");
        assertEq(buyer.balance, ethBefore, "the ETH the curve did not take did not come back");
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "WETH was left in the router");

        uint256 amount = _hold(wethL, seller, 0.1 ether);
        _giveWeth(address(lazy), 1 ether);
        vm.prank(seller);
        IERC20(wethL.token).approve(address(router), amount);
        vm.prank(seller);
        router.sellForEth(liar, wethL.token, amount, 0, "", 1, seller, block.timestamp);
        assertEq(
            IERC20(wethL.token).allowance(address(router), address(lazy)), 0, "a token allowance was left standing"
        );
    }

    /// NOTHING CAN COME BACK IN WHILE THE ROUTER IS PAYING. The recipient's
    /// receive() calls the router again; that call is refused by the guard.
    function test_reentryDuringThePayout_isRefused() public onlyFork {
        Pair memory p = wethL;
        Reenterer r = new Reenterer(router, address(registry), p.token);
        uint256 amount = _hold(p, seller, 0.2 ether);
        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);

        vm.prank(seller);
        uint256 out = router.sellForEth(address(registry), p.token, amount, 0, "", 1, address(r), block.timestamp);

        assertTrue(r.tried(), "the recipient's receive() never ran");
        assertEq(
            r.lastError(),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector),
            "the call back into the router was not refused by the guard"
        );
        assertEq(address(r).balance, out, "the recipient was not paid in ETH");
    }

    // ================================================================
    // SwapRouter02's own habits
    // ================================================================

    /// SWAPROUTER02 PAYS A WETH LEG WITH ETH IT ALREADY HOLDS, and then never
    /// pulls the WETH it was approved for. Stray ETH on it is anybody's, so
    /// this is a state it can really be in. The router must take its approval
    /// back and return the WETH that was never spent.
    function test_strayEthOnSwapRouter02_leavesNoAllowanceAndTheEthComesBack() public onlyFork {
        Pair memory p = nvdaL;
        vm.deal(SWAP_ROUTER02, 5 ether);
        uint256 ethIn = 0.2 ether;
        uint256 ethBefore = buyer.balance;

        vm.recordLogs();
        vm.prank(buyer);
        uint256 out =
            router.buyWithEth{value: ethIn}(address(registry), p.token, _buyPath(p), 1, 0, recipient, block.timestamp);
        (,, uint256 quoteRefund, uint256 ethRefund) = _boughtEvent(vm.getRecordedLogs());

        // THE HABIT REALLY FIRED: its own balance paid the pool.
        assertEq(SWAP_ROUTER02.balance, 5 ether - ethIn, "SwapRouter02 did not pay with its own ETH");
        assertGt(out, 0, "no tokens were bought");
        assertEq(ethRefund, ethIn, "the unspent WETH was not refunded");
        assertEq(quoteRefund, 0, "an asset refund appeared from nowhere");
        assertEq(buyer.balance, ethBefore, "the buyer's ETH did not come back");
        _assertRouterEmpty(p);
    }

    /// A ROUTE THAT CANNOT TAKE THE WHOLE SALE IS REFUSED. A v3 pool that runs
    /// out of range takes only part of its input, and SwapRouter02 returns
    /// without complaint; the router must not pay out half the sale as ETH and
    /// strand the rest.
    function test_aRouteThatCannotTakeTheWholeSale_isRefused() public onlyFork {
        Pair memory p = nvdaL;
        _thinPool();
        uint256 held = _hold(p, seller, 0.3 ether);
        uint256 amount = held / 2;
        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);

        // THE SAME SALE THROUGH THE DEEP POOL WORKS, so what is refused below
        // is the route, not the sale.
        uint256 snap = vm.snapshotState();
        vm.prank(seller);
        router.sellForEth(address(registry), p.token, amount, 0, _sellPath(p), 1, recipient, block.timestamp);
        vm.revertToState(snap);

        vm.prank(seller);
        (bool ok, bytes memory err) = address(router).call(
            abi.encodeCall(
                CurbRouter.sellForEth,
                (
                    address(registry),
                    p.token,
                    amount,
                    0,
                    abi.encodePacked(NVDAC, THIN_TIER, WETH),
                    1,
                    recipient,
                    block.timestamp
                )
            )
        );
        assertFalse(ok, "a sale the route could only partly take went through");
        assertEq(bytes4(err), CurbRouter.RouteLeftInput.selector, "refused, but not for the unspent input");
        uint256 unspent = abi.decode(_tail(err), (uint256));
        assertGt(unspent, 0, "it reported nothing unspent");
        assertEq(IERC20(p.token).balanceOf(seller), held, "the refused sale still took tokens");
    }

    /// AND ON A BUY THE REMAINDER IS JUST THE CALLER'S ETH, which comes back.
    function test_aRouteThatCannotTakeTheWholeBuy_refundsTheRest() public onlyFork {
        Pair memory p = nvdaL;
        _thinPool();
        uint256 ethIn = 0.1 ether;
        uint256 ethBefore = buyer.balance;

        vm.recordLogs();
        vm.prank(buyer);
        uint256 out = router.buyWithEth{value: ethIn}(
            address(registry), p.token, abi.encodePacked(WETH, THIN_TIER, NVDAC), 1, 0, recipient, block.timestamp
        );
        (, uint256 quoteIn,, uint256 ethRefund) = _boughtEvent(vm.getRecordedLogs());

        assertGt(out, 0, "no tokens were bought");
        assertGt(quoteIn, 0, "the thin route delivered nothing");
        assertGt(ethRefund, 0, "the route took the whole buy - the pool is not thin enough to test this");
        assertLt(ethRefund, ethIn, "the route took none of the buy");
        assertEq(ethBefore - buyer.balance, ethIn - ethRefund, "the unspent ETH did not come back");
        _assertRouterEmpty(p);
    }

    // ================================================================
    // every hop of the route takes all it is given
    // ================================================================

    /// A LATER HOP THAT STOPS SHORT REVERTS THE BUY. WETH -> USDC through the
    /// deepest pool, then USDC -> NVDAc through a pool too thin to take it:
    /// SwapRouter02 hands the second pool all the USDC, the pool takes a
    /// little and returns, and the rest of the USDC would stay on SwapRouter02
    /// for anybody to sweep. The router used to measure only the first hop,
    /// so this went through, refunded nothing, and the buyer paid the whole
    /// ETH for a fraction of the asset.
    function test_aLaterHopThatStopsShort_revertsTheBuy_usdcMidway() public onlyFork {
        Pair memory p = nvdaL;
        _thinUsdcNvdaPool();
        bytes memory path = abi.encodePacked(WETH, _deepestTier(WETH, USDC, USDC), USDC, THIN_USDC_TIER, NVDAC);
        uint256 ethBefore = buyer.balance;

        vm.prank(buyer);
        (bool ok, bytes memory err) = address(router).call{value: 0.05 ether}(
            abi.encodeCall(CurbRouter.buyWithEth, (address(registry), p.token, path, 1, 0, recipient, block.timestamp))
        );
        assertFalse(ok, "a buy whose second hop stopped short went through");
        (address asset, uint256 unspent) = _stoppedMidway(err);
        assertEq(asset, USDC, "it named another asset");
        assertGt(unspent, 0, "it reported nothing left");
        assertEq(buyer.balance, ethBefore, "the refused buy still cost ETH");
        assertEq(IERC20(USDC).balanceOf(SWAP_ROUTER02), 0, "USDC was left on SwapRouter02");
    }

    /// THE SAME WITH WETH IN THE MIDDLE, where SwapRouter02's ether counts
    /// with its WETH: WETH -> NVDAc -> WETH -> (thin) NVDAc.
    function test_aLaterHopThatStopsShort_revertsTheBuy_wethMidway() public onlyFork {
        Pair memory p = nvdaL;
        _thinPool();
        bytes memory path = abi.encodePacked(WETH, NVDAC_TIER, NVDAC, NVDAC_TIER, WETH, THIN_TIER, NVDAC);

        vm.prank(buyer);
        (bool ok, bytes memory err) = address(router).call{value: 0.1 ether}(
            abi.encodeCall(CurbRouter.buyWithEth, (address(registry), p.token, path, 1, 0, recipient, block.timestamp))
        );
        assertFalse(ok, "a buy whose third hop stopped short went through");
        (address asset, uint256 unspent) = _stoppedMidway(err);
        assertEq(asset, WETH, "it named another asset");
        assertGt(unspent, 0, "it reported nothing left");
    }

    /// AND THE SALE. The first hop takes all the NVDAc, so RouteLeftInput sees
    /// nothing; the thin WETH -> NVDAc hop after it is what stops short, and
    /// the seller's proceeds would have stayed on SwapRouter02 as WETH.
    function test_aLaterHopThatStopsShort_revertsTheSale() public onlyFork {
        Pair memory p = nvdaL;
        _thinPool();
        uint256 held = _hold(p, seller, 0.3 ether);
        vm.prank(seller);
        IERC20(p.token).approve(address(router), held);
        bytes memory path = abi.encodePacked(NVDAC, NVDAC_TIER, WETH, THIN_TIER, NVDAC, NVDAC_TIER, WETH);

        vm.prank(seller);
        (bool ok, bytes memory err) = address(router).call(
            abi.encodeCall(
                CurbRouter.sellForEth, (address(registry), p.token, held, 0, path, 1, recipient, block.timestamp)
            )
        );
        assertFalse(ok, "a sale whose second hop stopped short went through");
        (address asset, uint256 unspent) = _stoppedMidway(err);
        assertEq(asset, WETH, "it named another asset");
        assertGt(unspent, 0, "it reported nothing left");
        assertEq(IERC20(p.token).balanceOf(seller), held, "the refused sale still took tokens");
        assertEq(recipient.balance, 0, "the refused sale paid something");
    }

    /// WHAT SWAPROUTER02 ALREADY HOLDS IS NOT A LEFTOVER. Somebody's USDC sits
    /// on it before a two-hop SPCXc buy and sale through USDC; both go through,
    /// and that USDC is still there, untouched.
    function test_aBalanceAlreadyOnSwapRouter02_isNotMistakenForALeftover() public onlyFork {
        deal(USDC, SWAP_ROUTER02, 1000e6);
        uint256 held = _hold(spcxL, seller, 0.2 ether);
        assertEq(IERC20(USDC).balanceOf(SWAP_ROUTER02), 1000e6, "the buy moved USDC already on SwapRouter02");

        // THE PATH FIRST: _sellPath asks the v3 factory, and that call would
        // take the prank meant for the sale.
        bytes memory back = _sellPath(spcxL);
        vm.prank(seller);
        IERC20(spcxL.token).approve(address(router), held);
        vm.prank(seller);
        uint256 out = router.sellForEth(address(registry), spcxL.token, held, 0, back, 1, recipient, block.timestamp);
        assertGt(out, 0, "the sale paid nothing");
        assertEq(IERC20(USDC).balanceOf(SWAP_ROUTER02), 1000e6, "the sale moved USDC already on SwapRouter02");
        _assertRouterEmpty(spcxL);
    }

    /// AND A WETH LEG PAID WITH SWAPROUTER02'S OWN ETHER IS NOT ONE EITHER.
    /// Holding ether, SwapRouter02 pays the third hop's WETH out of it and
    /// keeps the WETH the second hop delivered: its WETH grows by exactly what
    /// its ether shrank. Counted together, nothing was left.
    function test_strayEthOnSwapRouter02_aWethLegMidwayIsNotALeftover() public onlyFork {
        Pair memory p = nvdaL;
        vm.deal(SWAP_ROUTER02, 5 ether);
        bytes memory path = abi.encodePacked(WETH, NVDAC_TIER, NVDAC, NVDAC_TIER, WETH, NVDAC_TIER, NVDAC);
        uint256 wethBefore = IERC20(WETH).balanceOf(SWAP_ROUTER02);

        vm.prank(buyer);
        uint256 out = router.buyWithEth{value: 0.2 ether}(address(registry), p.token, path, 1, 0, recipient, block.timestamp);

        assertGt(out, 0, "no tokens were bought");
        assertGt(IERC20(WETH).balanceOf(SWAP_ROUTER02), wethBefore, "SwapRouter02 did not pay a WETH leg with its ether");
        _assertRouterEmpty(p);
    }

    /// ONE UNIT LEFT MIDWAY IS A LEFTOVER - there is no tolerance, because a
    /// unit left on SwapRouter02 is a unit anybody can sweep. No real pool can
    /// be made to leave exactly one, so SwapRouter02's USDC balance is mocked:
    /// 1,000 USDC when the router reads it before the swap, one unit more
    /// after. The two-hop SPCXc buy and sale through USDC are both refused,
    /// naming USDC and exactly that one unit - the growth, not the balance.
    function test_oneUnitLeftMidway_isRefused() public onlyFork {
        uint256 held = _hold(spcxL, seller, 0.2 ether);
        bytes memory buyPath = _buyPath(spcxL);
        bytes memory sellPath = _sellPath(spcxL);
        vm.prank(seller);
        IERC20(spcxL.token).approve(address(router), held);

        bytes[] memory reads = new bytes[](2);
        reads[0] = abi.encode(uint256(1000e6));
        reads[1] = abi.encode(uint256(1000e6 + 1));
        bytes memory balanceCall = abi.encodeCall(IERC20.balanceOf, (SWAP_ROUTER02));
        bytes memory refusal = abi.encodeWithSelector(CurbRouter.RouteStoppedMidway.selector, USDC, 1);

        vm.mockCalls(USDC, balanceCall, reads);
        vm.prank(buyer);
        vm.expectRevert(refusal);
        router.buyWithEth{value: 0.1 ether}(address(registry), spcxL.token, buyPath, 1, 0, recipient, block.timestamp);

        vm.mockCalls(USDC, balanceCall, reads);
        vm.prank(seller);
        vm.expectRevert(refusal);
        router.sellForEth(address(registry), spcxL.token, held, 0, sellPath, 1, recipient, block.timestamp);
        vm.clearMockedCalls();
    }

    // ================================================================
    // the issuer's policy, asked of the caller, the recipient and the router
    // ================================================================

    /// A CALLER THE ISSUER REFUSES CANNOT BUY a stock pair with ETH - the
    /// trade they could not make by hand - while the WETH pair, which has no
    /// issuer, still works for them, and a caller the issuer has not refused
    /// still buys the stock pair.
    function test_aCallerTheIssuerBlocks_cannotBuyWithEth() public onlyFork {
        address blocked = makeAddr("curb-router-blocked-caller");
        vm.deal(blocked, 5 ether);
        _issuerBlocks(blocked);
        (bytes32 sendScope, uint64 sendPolicy) = _policy("TRANSFER_SENDER_POLICY()");

        bytes memory spcxPath = _buyPath(spcxL); // before the prank: it asks the v3 factory
        uint256 snap = vm.snapshotState();
        vm.prank(blocked);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.IssuerForbids.selector, blocked, sendScope, sendPolicy));
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, recipient, block.timestamp);
        vm.prank(blocked);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.IssuerForbids.selector, blocked, sendScope, sendPolicy));
        router.buyWithEth{value: 0.1 ether}(address(registry), spcxL.token, spcxPath, 1, 0, recipient, block.timestamp);
        vm.revertToState(snap);

        vm.prank(blocked);
        uint256 weth = router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0, 0, blocked, block.timestamp);
        assertGt(weth, 0, "the WETH pair, which has no issuer, refused the caller");

        vm.prank(buyer);
        uint256 out =
            router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, recipient, block.timestamp);
        assertGt(out, 0, "a caller the issuer allows could not buy");
    }

    /// NOR SELL ONE FOR ETH - even tokens bought before the issuer refused
    /// them. The WETH pair's sale still pays them. STRICTER THAN BY HAND, on
    /// purpose (see _checkIssuer), and measured here first: by hand the same
    /// seller can still sell, by having the curve pay SwapRouter02 and
    /// swapping its balance, never holding NVDAc at all.
    function test_aCallerTheIssuerBlocks_cannotSellForEth() public onlyFork {
        address blocked = makeAddr("curb-router-blocked-seller");
        uint256 held = _hold(nvdaL, blocked, 0.2 ether);
        uint256 heldWeth = _hold(wethL, blocked, 0.2 ether);
        _issuerBlocks(blocked);
        (bytes32 sendScope, uint64 sendPolicy) = _policy("TRANSFER_SENDER_POLICY()");

        uint256 snap = vm.snapshotState();
        assertGt(_sellWithoutHolding(nvdaL, blocked, held, _sellPath(nvdaL)), 0, "by hand, the blocked seller was paid nothing");
        vm.revertToState(snap);

        vm.startPrank(blocked);
        IERC20(nvdaL.token).approve(address(router), held);
        IERC20(wethL.token).approve(address(router), heldWeth);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.IssuerForbids.selector, blocked, sendScope, sendPolicy));
        router.sellForEth(address(registry), nvdaL.token, held, 0, _sellPath(nvdaL), 1, recipient, block.timestamp);
        uint256 paid = router.sellForEth(address(registry), wethL.token, heldWeth, 0, "", 1, blocked, block.timestamp);
        vm.stopPrank();

        assertEq(IERC20(nvdaL.token).balanceOf(blocked), held, "the refused sale took tokens");
        assertGt(paid, 0, "the WETH pair, which has no issuer, refused the seller");
    }

    /// A RECIPIENT THE ISSUER REFUSES is refused too, on the buy and on the
    /// sale, when the caller is one the issuer allows - STRICTER THAN BY HAND,
    /// on purpose (see _checkIssuer). By hand the same two trades for the
    /// same recipient succeed, because the recipient never touches the asset:
    /// that half is measured here first, so the NatSpec's claim stays true.
    function test_aRecipientTheIssuerBlocks_isRefused() public onlyFork {
        address blocked = makeAddr("curb-router-blocked-recipient");
        _issuerBlocks(blocked);
        (bytes32 sendScope, uint64 sendPolicy) = _policy("TRANSFER_SENDER_POLICY()");
        bytes memory refusal = abi.encodeWithSelector(CurbRouter.IssuerForbids.selector, blocked, sendScope, sendPolicy);

        // BY HAND, A BUY FOR THEM: swap to self, then curve.buy to them.
        uint256 snap = vm.snapshotState();
        vm.startPrank(buyer);
        uint256 q = ISwapRouter02(SWAP_ROUTER02).exactInput{value: 0.1 ether}(
            ISwapRouter02.ExactInputParams({path: _buyPath(nvdaL), recipient: buyer, amountIn: 0.1 ether, amountOutMinimum: 0})
        );
        IERC20(NVDAC).approve(nvdaL.curve, q);
        uint256 byHand = PonsV2BondingCurve(nvdaL.curve).buy(q, 0, blocked);
        vm.stopPrank();
        assertGt(byHand, 0, "by hand, a buy for the refused recipient failed");
        assertEq(IERC20(nvdaL.token).balanceOf(blocked), byHand, "by hand, the refused recipient got no launch tokens");
        vm.revertToState(snap);

        // BY HAND, A SALE FOR THEM: sell and swap to self, unwrap, pay them ETH.
        snap = vm.snapshotState();
        uint256 sold = _hold(nvdaL, seller, 0.2 ether);
        vm.startPrank(seller);
        IERC20(nvdaL.token).approve(nvdaL.curve, sold);
        uint256 qo = PonsV2BondingCurve(nvdaL.curve).sell(sold, 0, seller);
        IERC20(NVDAC).approve(SWAP_ROUTER02, qo);
        uint256 w = ISwapRouter02(SWAP_ROUTER02).exactInput(
            ISwapRouter02.ExactInputParams({path: _sellPath(nvdaL), recipient: seller, amountIn: qo, amountOutMinimum: 0})
        );
        IWETH(WETH).withdraw(w);
        payable(blocked).transfer(w);
        vm.stopPrank();
        assertGt(w, 0, "by hand, a sale for the refused recipient paid nothing");
        assertEq(blocked.balance, w, "by hand, the refused recipient was not paid");
        vm.revertToState(snap);

        // THROUGH THE ROUTER, BOTH ARE REFUSED.
        vm.prank(buyer);
        vm.expectRevert(refusal);
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, blocked, block.timestamp);

        uint256 held = _hold(nvdaL, seller, 0.2 ether);
        vm.prank(seller);
        IERC20(nvdaL.token).approve(address(router), held);
        vm.prank(seller);
        vm.expectRevert(refusal);
        router.sellForEth(address(registry), nvdaL.token, held, 0, _sellPath(nvdaL), 1, blocked, block.timestamp);
    }

    /// THE ISSUER REFUSES THE ROUTER ITSELF: every stock-pair trade through it
    /// is refused by name before anything moves - not by Uniswap's "TF" from
    /// deep inside a pool - and nothing moves: not the buyer's ETH, not the
    /// seller's tokens or approval, not the recipient's balance.
    function test_aRouterTheIssuerBlocks_refusesByName_andNothingMoves() public onlyFork {
        uint256 held = _hold(nvdaL, seller, 0.2 ether);
        vm.prank(seller);
        IERC20(nvdaL.token).approve(address(router), held);
        _issuerBlocks(address(router));
        (bytes32 sendScope, uint64 sendPolicy) = _policy("TRANSFER_SENDER_POLICY()");
        bytes memory refusal =
            abi.encodeWithSelector(CurbRouter.IssuerForbids.selector, address(router), sendScope, sendPolicy);
        assertEq(sendPolicy, 5, "NVDAc's sender policy is no longer 5 - the measured fact this test leans on moved");

        uint256 ethBefore = buyer.balance;
        vm.prank(buyer);
        (bool ok, bytes memory err) = address(router).call{value: 0.1 ether}(
            abi.encodeCall(
                CurbRouter.buyWithEth, (address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, recipient, block.timestamp)
            )
        );
        assertFalse(ok, "a buy went through a router the issuer refuses");
        assertEq(err, refusal, "the buy was refused, but not by name");
        assertEq(buyer.balance, ethBefore, "the refused buy cost ETH");
        assertEq(IERC20(nvdaL.token).balanceOf(recipient), 0, "the refused buy delivered tokens");

        uint256 recipientBefore = recipient.balance;
        vm.prank(seller);
        (ok, err) = address(router).call(
            abi.encodeCall(
                CurbRouter.sellForEth,
                (address(registry), nvdaL.token, held, 0, _sellPath(nvdaL), 1, recipient, block.timestamp)
            )
        );
        assertFalse(ok, "a sale went through a router the issuer refuses");
        assertEq(err, refusal, "the sale was refused, but not by name");
        assertEq(IERC20(nvdaL.token).balanceOf(seller), held, "the refused sale took tokens");
        assertEq(IERC20(nvdaL.token).allowance(seller, address(router)), held, "the refused sale spent the approval");
        assertEq(recipient.balance, recipientBefore, "the refused sale paid something");
        _assertRouterEmpty(nvdaL);

        // AND THE WETH PAIR, WHICH HAS NO ISSUER, STILL TRADES.
        vm.prank(buyer);
        assertGt(
            router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0, 0, recipient, block.timestamp),
            0,
            "the WETH pair stopped with the stock pairs"
        );
    }

    /// EACH DIRECTION IS ASKED, under its own policy. NVDAc names policy 5 for
    /// both, so a blocklist entry there cannot tell them apart; here the
    /// router is shown a fresh blocklist policy for one direction at a time
    /// (mocked on the token - B20's own transfers still read the real one),
    /// and each refusal names that direction and that policy.
    function test_eachDirectionOfTheIssuersPolicyIsAsked() public onlyFork {
        address who = makeAddr("curb-router-one-direction");
        vm.deal(who, 5 ether);
        uint64 fresh = _freshBlocklist(who);
        (bytes32 sendScope,) = _policy("TRANSFER_SENDER_POLICY()");
        (bytes32 receiveScope,) = _policy("TRANSFER_RECEIVER_POLICY()");

        vm.mockCall(NVDAC, abi.encodeWithSignature("policyId(bytes32)", receiveScope), abi.encode(fresh));
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.IssuerForbids.selector, who, receiveScope, fresh));
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, who, block.timestamp);
        vm.clearMockedCalls();

        vm.mockCall(NVDAC, abi.encodeWithSignature("policyId(bytes32)", sendScope), abi.encode(fresh));
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.IssuerForbids.selector, who, sendScope, fresh));
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, who, block.timestamp);
        vm.clearMockedCalls();

        // NEITHER MOCKED: the fresh policy is not NVDAc's, so it trades.
        vm.prank(who);
        assertGt(
            router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, who, block.timestamp),
            0,
            "an account the issuer allows could not buy"
        );
    }

    /// THE EXECUTOR POLICY IS NOT ASKED, on purpose (see _checkIssuer): by
    /// hand the user is never the executor, so an account refused only as an
    /// executor still trades.
    function test_theExecutorPolicyIsNotAsked() public onlyFork {
        address who = makeAddr("curb-router-executor-only");
        vm.deal(who, 5 ether);
        uint64 fresh = _freshBlocklist(who);
        (bytes32 executorScope,) = _policy("TRANSFER_EXECUTOR_POLICY()");
        vm.mockCall(NVDAC, abi.encodeWithSignature("policyId(bytes32)", executorScope), abi.encode(fresh));
        vm.prank(who);
        assertGt(
            router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, who, block.timestamp),
            0,
            "an account refused only as an executor could not buy"
        );
    }

    /// NO LOOKUP FAILS OPEN. On Base both precompiles always answer; this pins
    /// what happens if one did not. A B20 factory that reverts, or answers
    /// with something that is not a bool, stops the trade - it is not read as
    /// "not a B20". So does a policy registry that reverts or answers nothing
    /// - not read as "authorized". The registry is failed for ONE direction at
    /// a time (the token is shown a policy id nobody uses for it, mocked, and
    /// only that id's question fails), so a check that fails open on either
    /// direction is caught even though the other still answers. Buy and sale.
    function test_whenAnIssuerLookupFails_theTradeReverts() public onlyFork {
        uint256 held = _hold(nvdaL, buyer, 0.2 ether);
        vm.prank(buyer);
        IERC20(nvdaL.token).approve(address(router), held);
        bytes memory down = abi.encodeWithSignature("Error(string)", "lookup down");

        // THE FACTORY: reverts; answers 2 where a bool belongs.
        bytes memory isB20 = abi.encodeWithSignature("isB20(address)", NVDAC);
        vm.mockCallRevert(B20_FACTORY, isB20, down);
        _bothStop(held, down);
        vm.mockCall(B20_FACTORY, isB20, abi.encode(uint256(2)));
        _bothStop(held, "");

        // THE REGISTRY, one direction at a time: reverts; answers nothing.
        bytes32[2] memory scopes;
        (scopes[0],) = _policy("TRANSFER_SENDER_POLICY()");
        (scopes[1],) = _policy("TRANSFER_RECEIVER_POLICY()");
        uint64 unused = 0xdead;
        bytes memory ask = abi.encodeWithSignature("isAuthorized(uint64,address)", unused, buyer);
        for (uint256 d = 0; d < 2; d++) {
            vm.mockCall(NVDAC, abi.encodeWithSignature("policyId(bytes32)", scopes[d]), abi.encode(unused));
            vm.mockCallRevert(POLICY_REGISTRY, ask, down);
            _bothStop(held, down);
            vm.mockCall(NVDAC, abi.encodeWithSignature("policyId(bytes32)", scopes[d]), abi.encode(unused));
            vm.mockCall(POLICY_REGISTRY, ask, hex"");
            _bothStop(held, "");
        }

        // AND WITH EVERY LOOKUP ANSWERING, THE SAME ACCOUNT TRADES.
        vm.prank(buyer);
        assertGt(
            router.sellForEth(address(registry), nvdaL.token, held, 0, _sellPath(nvdaL), 1, buyer, block.timestamp),
            0,
            "the account could not sell once the lookups answered"
        );
    }

    /// A buy and a sale of NVDAc's launch by the buyer, each expected to
    /// revert - with `err` exactly, or with anything when it is empty (a bad
    /// answer reverts in the decoder, with no data) - and nothing to move.
    /// Each runs on a snapshot, and the mocks are cleared after.
    function _bothStop(uint256 held, bytes memory err) internal {
        bytes memory buyPath = _buyPath(nvdaL);
        bytes memory sellPath = _sellPath(nvdaL);
        uint256 ethBefore = buyer.balance;
        uint256 snap = vm.snapshotState();
        vm.prank(buyer);
        if (err.length == 0) vm.expectRevert();
        else vm.expectRevert(err);
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, buyPath, 1, 0, buyer, block.timestamp);
        vm.prank(buyer);
        if (err.length == 0) vm.expectRevert();
        else vm.expectRevert(err);
        router.sellForEth(address(registry), nvdaL.token, held, 0, sellPath, 1, buyer, block.timestamp);
        assertEq(buyer.balance, ethBefore, "a failed lookup let ETH move");
        assertEq(IERC20(nvdaL.token).balanceOf(buyer), held, "a failed lookup let the sale take tokens");
        vm.clearMockedCalls();
        vm.revertToState(snap);
    }

    // ================================================================
    // the coins that are not B20s: cbBTC and cbXRP, and their blacklists
    // ================================================================

    /// cbBTC AND cbXRP TRADE THROUGH THE ROUTER, buy and sale, exactly as the
    /// long way does. They are not B20s (asked of the factory here, so a
    /// fixture that drifted into one would say so), so neither the B20 check
    /// nor any check that excuses only WETH may stand in their way.
    function test_buy_cbBtcLaunch_oneHop_sameAsTheLongWay() public onlyFork {
        assertFalse(_isB20(CBBTC), "cbBTC is a B20 now - this test no longer covers a non-B20 asset");
        _buyThroughARoute(cbbtcL, 0.2 ether, "gas: buyWithEth, cbBTC pair, one v3 hop");
    }

    function test_buy_cbXrpLaunch_oneHop_sameAsTheLongWay() public onlyFork {
        assertFalse(_isB20(CBXRP), "cbXRP is a B20 now - this test no longer covers a non-B20 asset");
        _buyThroughARoute(cbxrpL, 0.2 ether, "gas: buyWithEth, cbXRP pair, one v3 hop");
    }

    function test_sell_cbBtcLaunch_oneHop_paysEth() public onlyFork {
        _sellThroughARoute(cbbtcL, "gas: sellForEth, cbBTC pair, one v3 hop");
    }

    function test_sell_cbXrpLaunch_oneHop_paysEth() public onlyFork {
        _sellThroughARoute(cbxrpL, "gas: sellForEth, cbXRP pair, one v3 hop");
    }

    /// A CALLER THE COIN BLACKLISTS cannot buy or sell its pair with ETH,
    /// refused by name with nothing moved - while the WETH pair still trades
    /// for them, and a caller the coin has not blacklisted still trades the
    /// coin's pair. By hand, measured first: the asset itself stops the buy
    /// (the swap to themselves reverts inside the pool), and does NOT stop
    /// the sale made without holding the asset - which is why the router's
    /// check on a sale is stricter than by hand (see _checkIssuer).
    function test_aCallerCbBtcBlacklists_cannotBuyOrSellForEth() public onlyFork {
        _aBlacklistedCaller(cbbtcL, "cbbtc");
    }

    function test_aCallerCbXrpBlacklists_cannotBuyOrSellForEth() public onlyFork {
        _aBlacklistedCaller(cbxrpL, "cbxrp");
    }

    function _aBlacklistedCaller(Pair memory p, string memory label) internal {
        address blocked = makeAddr(string.concat("curb-router-blacklisted-caller-", label));
        vm.deal(blocked, 5 ether);
        uint256 held = _hold(p, blocked, 0.2 ether); // bought before the entry
        uint256 heldWeth = _hold(wethL, blocked, 0.1 ether);
        bytes memory buyPath = _buyPath(p);
        bytes memory sellPath = _sellPath(p);
        _coinBlacklists(p.quote, blocked);
        bytes memory refusal = abi.encodeWithSelector(CurbRouter.BlacklistedBy.selector, p.quote, blocked);

        // BY HAND, THE BUY IS STOPPED BY THE ASSET: the pool cannot pay them.
        vm.prank(blocked);
        vm.expectRevert(bytes("TF"));
        ISwapRouter02(SWAP_ROUTER02).exactInput{value: 0.1 ether}(
            ISwapRouter02.ExactInputParams({path: buyPath, recipient: blocked, amountIn: 0.1 ether, amountOutMinimum: 0})
        );

        // BY HAND, THE SALE IS NOT, when it never touches the asset.
        uint256 snap = vm.snapshotState();
        assertGt(_sellWithoutHolding(p, blocked, held, sellPath), 0, "by hand, the blacklisted seller was paid nothing");
        vm.revertToState(snap);

        // THROUGH THE ROUTER, BOTH ARE REFUSED BY NAME.
        uint256 ethBefore = blocked.balance;
        vm.prank(blocked);
        vm.expectRevert(refusal);
        router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, recipient, block.timestamp);

        vm.startPrank(blocked);
        IERC20(p.token).approve(address(router), held);
        IERC20(wethL.token).approve(address(router), heldWeth);
        vm.expectRevert(refusal);
        router.sellForEth(address(registry), p.token, held, 0, sellPath, 1, recipient, block.timestamp);
        uint256 paid = router.sellForEth(address(registry), wethL.token, heldWeth, 0, "", 1, blocked, block.timestamp);
        vm.stopPrank();

        assertEq(IERC20(p.token).balanceOf(blocked), held, "the refused sale took tokens");
        assertEq(IERC20(p.token).balanceOf(recipient), 0, "the refused buy delivered tokens");
        assertGt(paid, 0, "the WETH pair, which has no issuer, refused the seller");
        assertEq(blocked.balance, ethBefore + paid, "the refused buy cost ETH");

        // AND A CALLER THE COIN HAS NOT BLACKLISTED STILL TRADES ITS PAIR.
        vm.prank(buyer);
        assertGt(
            router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, recipient, block.timestamp),
            0,
            "a caller the coin allows could not buy"
        );
        _assertRouterEmpty(p);
    }

    /// A RECIPIENT THE COIN BLACKLISTS is refused on the buy and on the sale,
    /// for a caller it allows - stricter than by hand, as on a B20 pair.
    function test_aRecipientTheCoinBlacklists_isRefused() public onlyFork {
        Pair[2] memory coins = [cbbtcL, cbxrpL];
        for (uint256 i = 0; i < coins.length; i++) {
            Pair memory p = coins[i];
            address blocked = makeAddr(string.concat("curb-router-blacklisted-recipient-", vm.toString(i)));
            uint256 held = _hold(p, seller, 0.2 ether);
            _coinBlacklists(p.quote, blocked);
            bytes memory refusal = abi.encodeWithSelector(CurbRouter.BlacklistedBy.selector, p.quote, blocked);
            bytes memory buyPath = _buyPath(p);
            bytes memory sellPath = _sellPath(p);

            vm.prank(buyer);
            vm.expectRevert(refusal);
            router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, blocked, block.timestamp);

            vm.startPrank(seller);
            IERC20(p.token).approve(address(router), held);
            vm.expectRevert(refusal);
            router.sellForEth(address(registry), p.token, held, 0, sellPath, 1, blocked, block.timestamp);
            vm.stopPrank();
            assertEq(IERC20(p.token).balanceOf(seller), held, "the refused sale took tokens");
            assertEq(blocked.balance, 0, "the refused sale paid the recipient");
        }
    }

    /// THE COIN BLACKLISTS THE ROUTER ITSELF: every trade of its pair through
    /// it is refused by name before anything moves - not by Uniswap's "TF"
    /// from inside a pool - and the WETH and stock pairs still trade.
    function test_aRouterTheCoinBlacklists_refusesByName_andNothingMoves() public onlyFork {
        Pair[2] memory coins = [cbbtcL, cbxrpL];
        for (uint256 i = 0; i < coins.length; i++) {
            Pair memory p = coins[i];
            uint256 held = _hold(p, seller, 0.2 ether);
            bytes memory buyPath = _buyPath(p);
            bytes memory sellPath = _sellPath(p);
            vm.prank(seller);
            IERC20(p.token).approve(address(router), held);
            _coinBlacklists(p.quote, address(router));
            bytes memory refusal = abi.encodeWithSelector(CurbRouter.BlacklistedBy.selector, p.quote, address(router));

            uint256 ethBefore = buyer.balance;
            vm.prank(buyer);
            (bool ok, bytes memory err) = address(router).call{value: 0.1 ether}(
                abi.encodeCall(
                    CurbRouter.buyWithEth, (address(registry), p.token, buyPath, 1, 0, recipient, block.timestamp)
                )
            );
            assertFalse(ok, "a buy went through a router the coin blacklists");
            assertEq(err, refusal, "the buy was refused, but not by name");
            assertEq(buyer.balance, ethBefore, "the refused buy cost ETH");
            assertEq(IERC20(p.token).balanceOf(recipient), 0, "the refused buy delivered tokens");

            uint256 recipientBefore = recipient.balance;
            vm.prank(seller);
            (ok, err) = address(router).call(
                abi.encodeCall(
                    CurbRouter.sellForEth,
                    (address(registry), p.token, held, 0, sellPath, 1, recipient, block.timestamp)
                )
            );
            assertFalse(ok, "a sale went through a router the coin blacklists");
            assertEq(err, refusal, "the sale was refused, but not by name");
            assertEq(IERC20(p.token).balanceOf(seller), held, "the refused sale took tokens");
            assertEq(IERC20(p.token).allowance(seller, address(router)), held, "the refused sale spent the approval");
            assertEq(recipient.balance, recipientBefore, "the refused sale paid something");
            _assertRouterEmpty(p);
        }

        vm.startPrank(buyer);
        assertGt(
            router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0, 0, recipient, block.timestamp),
            0,
            "the WETH pair stopped with the coins"
        );
        assertGt(
            router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 1, 0, recipient, block.timestamp),
            0,
            "a stock pair stopped with the coins"
        );
        vm.stopPrank();
    }

    /// A BLACKLIST QUESTION THAT FAILS MEANS NO BLACKLIST - the opposite of
    /// the B20 lookups - because a token without the function keeps no list.
    /// Each failure in turn, on every account the router asks (the mock
    /// matches the selector alone): a revert, no answer, a short answer that
    /// would read as true from stale memory, and a word that is not a bool.
    /// Each time the same buy and sale go through. And the one answer that is
    /// a true bool, longer than one word, is a refusal: what a typed call
    /// would decode as true.
    function test_whenTheBlacklistQuestionFails_theTradeGoesThrough() public onlyFork {
        // THE CALLER IS CHOSEN SO A SHORT ANSWER IS A TRAP: its address puts
        // 0x01 in the one byte of the router's scratch word a 31-byte answer
        // does not overwrite, so a check that skipped the answer's length
        // would read 31 zero bytes as `true` and refuse this caller.
        address caller = address(uint160(1) << 32);
        assertEq(caller.code.length, 0, "the trap caller has code on the fork");
        vm.deal(caller, 5 ether);
        uint256 held = _hold(cbbtcL, caller, 0.3 ether);
        bytes memory buyPath = _buyPath(cbbtcL);
        bytes memory sellPath = _sellPath(cbbtcL);
        vm.prank(caller);
        IERC20(cbbtcL.token).approve(address(router), type(uint256).max);
        bytes memory ask = abi.encodeWithSelector(IFiatTokenLike.isBlacklisted.selector);

        // ONLY A WORD OF EXACTLY 1 REFUSES: 2, an odd 3, and 1 with the top bit
        // set all let the trade through, so a check of the lowest bit alone fails.
        bytes[5] memory answers = [
            bytes(""), new bytes(31), abi.encode(uint256(2)), abi.encode(uint256(3)), abi.encode((uint256(1) << 255) | 1)
        ];
        for (uint256 i = 0; i < answers.length; i++) {
            vm.mockCall(CBBTC, ask, answers[i]);
            _coinPairTrades(caller, held / 8, buyPath, sellPath);
            vm.clearMockedCalls();
        }
        // A REVERT IS NO ANSWER, WHATEVER ITS DATA SAYS: one whose data is the
        // word 1 must not be read as `true`.
        bytes[2] memory reverts = [abi.encodeWithSignature("Error(string)", "lookup down"), abi.encode(uint256(1))];
        for (uint256 i = 0; i < reverts.length; i++) {
            vm.mockCallRevert(CBBTC, ask, reverts[i]);
            _coinPairTrades(caller, held / 8, buyPath, sellPath);
            vm.clearMockedCalls();
        }

        vm.mockCall(CBBTC, ask, abi.encode(true, uint256(7)));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.BlacklistedBy.selector, CBBTC, caller));
        router.buyWithEth{value: 0.1 ether}(address(registry), cbbtcL.token, buyPath, 1, 0, caller, block.timestamp);
        vm.clearMockedCalls();
    }

    /// AN ASSET WHOSE ANSWER BURNS ALL THE GAS IT IS GIVEN - WETH9's fallback
    /// is one - costs the trade at most the cap, on each of the three
    /// questions, and the trade still goes through. Run with a gas limit, so
    /// a question handed everything (no cap) leaves the trade too little to
    /// finish, and the burn ends instead of running for the test's whole
    /// gas. The limit is the trade's own cost measured first, plus three caps
    /// and some room.
    function test_aBlacklistQuestionThatBurnsItsGas_costsAtMostTheCap() public onlyFork {
        uint256 held = _hold(cbbtcL, seller, 0.3 ether);
        bytes memory buyPath = _buyPath(cbbtcL);
        bytes memory sellPath = _sellPath(cbbtcL);
        vm.prank(seller);
        IERC20(cbbtcL.token).approve(address(router), type(uint256).max);

        uint256 snap = vm.snapshotState();
        uint256 g = gasleft();
        vm.prank(buyer);
        router.buyWithEth{value: 0.1 ether}(address(registry), cbbtcL.token, buyPath, 1, 0, recipient, block.timestamp);
        uint256 buyCost = g - gasleft();
        g = gasleft();
        vm.prank(seller);
        router.sellForEth(address(registry), cbbtcL.token, held / 2, 0, sellPath, 1, recipient, block.timestamp);
        uint256 sellCost = g - gasleft();
        vm.revertToState(snap);

        GasBurner burner = new GasBurner();
        vm.mockFunction(CBBTC, address(burner), abi.encodeWithSelector(IFiatTokenLike.isBlacklisted.selector));
        uint256 room = 3 * 100_000 + 200_000;

        vm.prank(buyer);
        uint256 out = router.buyWithEth{value: 0.1 ether, gas: buyCost + room}(
            address(registry), cbbtcL.token, buyPath, 1, 0, recipient, block.timestamp
        );
        assertGt(out, 0, "a burning blacklist question stopped the buy");
        vm.prank(seller);
        uint256 paid = router.sellForEth{gas: sellCost + room}(
            address(registry), cbbtcL.token, held / 2, 0, sellPath, 1, recipient, block.timestamp
        );
        assertGt(paid, 0, "a burning blacklist question stopped the sale");
        vm.clearMockedCalls();
    }

    /// THE CAP COVERS A COLD QUESTION. A forge test is one transaction, so by
    /// the time the router asks, the fixture has long since touched the coin
    /// and its implementation, and every question would be warm (about 1,300
    /// gas inside the cap). Both are made cold again here before the router
    /// asks, so a cap below the cold cost - which would quietly fail open on
    /// every real trade - refuses nobody, and this test fails.
    ///
    /// NOT QUITE AS COLD AS BASE. vm.cool leaves part of the question warm:
    /// here the smallest cap that still answers is about 7,300 gas, while a
    /// real first question in a transaction needs about 9,800 inside the cap
    /// (plus the 2,600 the router pays outside it to reach the cold proxy),
    /// measured by the round-3 review. So this pins "cap above about 7,300";
    /// PROBE_GAS = 100,000 keeps a tenfold margin over the real cold cost,
    /// and lowering it below about 10,000 would fail open on Base without
    /// this test noticing.
    function test_aColdBlacklistQuestion_stillAnswers() public onlyFork {
        Pair[2] memory coins = [cbbtcL, cbxrpL];
        for (uint256 i = 0; i < coins.length; i++) {
            Pair memory p = coins[i];
            address blocked = makeAddr(string.concat("curb-router-cold-blacklisted-", vm.toString(i)));
            vm.deal(blocked, 1 ether);
            bytes memory buyPath = _buyPath(p);
            _coinBlacklists(p.quote, blocked);
            address impl = address(uint160(uint256(vm.load(p.quote, FIAT_TOKEN_IMPLEMENTATION_SLOT))));
            assertGt(impl.code.length, 0, "the coin's proxy names no implementation");
            vm.cool(p.quote);
            vm.cool(impl);
            vm.prank(blocked);
            vm.expectRevert(abi.encodeWithSelector(CurbRouter.BlacklistedBy.selector, p.quote, blocked));
            router.buyWithEth{value: 0.1 ether}(address(registry), p.token, buyPath, 1, 0, recipient, block.timestamp);
        }
    }

    /// NO BLACKLIST QUESTION ON THE WETH PAIR OR A B20 PAIR. WETH9's fallback
    /// would burn the whole cap three times on the main pair, and a B20 has
    /// its issuer's policies asked instead. Buy and sale on both.
    function test_theWethAndB20Pairs_askNoBlacklist() public onlyFork {
        uint256 heldWeth = _hold(wethL, seller, 0.2 ether);
        uint256 heldNvda = _hold(nvdaL, seller, 0.2 ether);
        bytes memory ask = abi.encodeWithSelector(IFiatTokenLike.isBlacklisted.selector);
        bytes memory nvdaBuy = _buyPath(nvdaL);
        bytes memory nvdaSell = _sellPath(nvdaL);
        vm.startPrank(seller);
        IERC20(wethL.token).approve(address(router), heldWeth);
        IERC20(nvdaL.token).approve(address(router), heldNvda);
        vm.stopPrank();

        vm.expectCall(WETH, ask, 0);
        vm.expectCall(NVDAC, ask, 0);
        // AND THE WETH PAIR DOES NOT EVEN ASK THE B20 FACTORY.
        vm.expectCall(B20_FACTORY, abi.encodeWithSignature("isB20(address)", WETH), 0);
        vm.startPrank(buyer);
        router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0, 0, recipient, block.timestamp);
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, nvdaBuy, 1, 0, recipient, block.timestamp);
        vm.stopPrank();
        vm.startPrank(seller);
        router.sellForEth(address(registry), wethL.token, heldWeth, 0, "", 1, recipient, block.timestamp);
        router.sellForEth(address(registry), nvdaL.token, heldNvda, 0, nvdaSell, 1, recipient, block.timestamp);
        vm.stopPrank();
    }

    /// A buy and a sale of cbBTC's launch by `caller`, each expected to go
    /// through, on a snapshot.
    function _coinPairTrades(address caller, uint256 amount, bytes memory buyPath, bytes memory sellPath) internal {
        uint256 snap = vm.snapshotState();
        vm.prank(caller);
        assertGt(
            router.buyWithEth{value: 0.1 ether}(address(registry), cbbtcL.token, buyPath, 1, 0, caller, block.timestamp),
            0,
            "a failed blacklist question stopped the buy"
        );
        vm.prank(caller);
        assertGt(
            router.sellForEth(address(registry), cbbtcL.token, amount, 0, sellPath, 1, caller, block.timestamp),
            0,
            "a failed blacklist question stopped the sale"
        );
        vm.revertToState(snap);
    }

    // ================================================================
    // recipients that would keep the payout, and minimums that may not be zero
    // ================================================================

    /// WETH, SWAPROUTER02, AND THE LAUNCH'S OWN CURVE, TOKEN AND ASSET. A sale
    /// to WETH left the proceeds in the router for good (WETH deposits ether
    /// for its sender); to SwapRouter02 it left WETH anybody could sweep. On a
    /// stock pair, so the WETH refusal is not the quote-asset one.
    function test_recipientsThatCannotBePaid_areRefused() public onlyFork {
        Pair memory p = nvdaL;
        uint256 held = _hold(p, seller, 0.2 ether);
        vm.prank(seller);
        IERC20(p.token).approve(address(router), held);
        address[5] memory bad = [WETH, SWAP_ROUTER02, p.curve, p.token, NVDAC];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(buyer);
            vm.expectRevert(abi.encodeWithSelector(CurbRouter.RecipientCannotBePaid.selector, bad[i]));
            router.buyWithEth{value: 0.1 ether}(address(registry), p.token, _buyPath(p), 1, 0, bad[i], block.timestamp);

            vm.prank(seller);
            vm.expectRevert(abi.encodeWithSelector(CurbRouter.RecipientCannotBePaid.selector, bad[i]));
            router.sellForEth(address(registry), p.token, held, 0, _sellPath(p), 1, bad[i], block.timestamp);
        }
    }

    /// A BUY THAT SWAPS MUST BOUND THE SWAP. minQuoteOut is the only bound on
    /// it - on the crossing buy minTokensOut bounds the curve's price, not the
    /// amount - so zero is refused on every pair that swaps. The WETH pair has
    /// no swap and keeps taking zero (the tests above).
    function test_aSwapBuyWithNoQuoteMinimum_isRefused() public onlyFork {
        vm.prank(buyer);
        vm.expectRevert(CurbRouter.NoQuoteMinimum.selector);
        router.buyWithEth{value: 0.1 ether}(address(registry), nvdaL.token, _buyPath(nvdaL), 0, 1, recipient, block.timestamp);
        bytes memory spcxPath = _buyPath(spcxL); // before the prank: it asks the v3 factory
        vm.prank(buyer);
        vm.expectRevert(CurbRouter.NoQuoteMinimum.selector);
        router.buyWithEth{value: 0.1 ether}(address(registry), spcxL.token, spcxPath, 0, 1, recipient, block.timestamp);
    }

    /// A SALE MUST BOUND WHAT IT PAYS, on every pair.
    function test_aSaleWithNoEthMinimum_isRefused() public onlyFork {
        uint256 held = _hold(nvdaL, seller, 0.2 ether);
        uint256 heldWeth = _hold(wethL, seller, 0.2 ether);
        vm.startPrank(seller);
        IERC20(nvdaL.token).approve(address(router), held);
        IERC20(wethL.token).approve(address(router), heldWeth);
        vm.expectRevert(CurbRouter.NoEthMinimum.selector);
        router.sellForEth(address(registry), nvdaL.token, held, 1, _sellPath(nvdaL), 0, recipient, block.timestamp);
        vm.expectRevert(CurbRouter.NoEthMinimum.selector);
        router.sellForEth(address(registry), wethL.token, heldWeth, 1, "", 0, recipient, block.timestamp);
        vm.stopPrank();
    }

    /// minQuoteOut ON THE WETH PAIR binds on the ETH sent, one wei either way.
    function test_buy_minQuoteOut_bindsOnTheWethPairToo() public onlyFork {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(CurbRouter.QuoteBelowMinimum.selector, 0.1 ether, 0.1 ether + 1));
        router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0.1 ether + 1, 0, recipient, block.timestamp);
        vm.prank(buyer);
        router.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0.1 ether, 0, recipient, block.timestamp);
    }

    // ================================================================
    // the gaps the test review found
    // ================================================================

    /// A BALANCE ALREADY IN THE ROUTER, ON THE WETH PAIR, where the amounts
    /// take other lines than on a stock pair: the curve is offered msg.value,
    /// the sale's start balance is the WETH one, and the refund is WETH.
    function test_aBalanceAlreadyInTheRouter_wethPair() public onlyFork {
        Pair memory p = wethL;
        uint256 dust = 0.05 ether;
        _giveWeth(stranger, dust);
        vm.prank(stranger);
        require(IERC20(WETH).transfer(address(router), dust), "plant WETH");

        uint256 ethIn = 0.3 ether;
        uint256 ethBefore = buyer.balance;
        vm.recordLogs();
        vm.prank(buyer);
        router.buyWithEth{value: ethIn}(address(registry), p.token, "", 0, 0, seller, block.timestamp);
        (, uint256 quoteIn,, uint256 ethRefund) = _boughtEvent(vm.getRecordedLogs());
        assertEq(quoteIn, ethIn, "the curve was offered other than the ETH sent");
        assertEq(ethRefund, 0, "the buyer was handed the planted WETH");
        assertEq(ethBefore - buyer.balance, ethIn, "the buyer's ETH moved by other than what was sent");
        assertEq(IERC20(WETH).balanceOf(address(router)), dust, "the buy moved the planted WETH");

        uint256 amount = IERC20(p.token).balanceOf(seller) / 2;
        uint256 snap = vm.snapshotState();
        vm.startPrank(seller);
        IERC20(p.token).approve(p.curve, amount);
        uint256 longWay = PonsV2BondingCurve(p.curve).sell(amount, 0, seller);
        vm.stopPrank();
        vm.revertToState(snap);

        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);
        uint256 rBefore = recipient.balance;
        vm.prank(seller);
        uint256 out = router.sellForEth(address(registry), p.token, amount, 0, "", 1, recipient, block.timestamp);
        assertEq(out, longWay, "the sale paid other than the curve's own sale");
        assertEq(recipient.balance - rBefore, longWay, "the recipient was handed the planted WETH");
        assertEq(IERC20(WETH).balanceOf(address(router)), dust, "the sale moved the planted WETH");
    }

    /// A STANDING APPROVAL LARGER THAN THE SALE - twice it, and unlimited -
    /// is spent only up to tokensIn. The page may skip the approve step when
    /// an approval already covers the sale.
    function test_aLargerStandingApproval_spendsOnlyTokensIn() public onlyFork {
        Pair memory p = nvdaL;
        uint256 held = _hold(p, seller, 0.3 ether);
        uint256 amount = held / 4;

        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount * 2);
        vm.prank(seller);
        router.sellForEth(address(registry), p.token, amount, 0, _sellPath(p), 1, recipient, block.timestamp);
        assertEq(IERC20(p.token).balanceOf(seller), held - amount, "more than tokensIn left the seller");
        assertEq(IERC20(p.token).allowance(seller, address(router)), amount, "the rest of the approval was spent");
        _assertRouterEmpty(p);

        vm.prank(seller);
        IERC20(p.token).approve(address(router), type(uint256).max);
        vm.prank(seller);
        router.sellForEth(address(registry), p.token, amount, 0, _sellPath(p), 1, recipient, block.timestamp);
        assertEq(IERC20(p.token).balanceOf(seller), held - 2 * amount, "more than tokensIn left the seller");
        _assertRouterEmpty(p);
    }

    /// A CONTRACT WALLET WHOSE receive() DOES REAL WORK - twenty fresh storage
    /// writes, far past any fixed gas stipend - crossing the threshold is
    /// refunded in ETH, not WETH.
    function test_buyPastTheThreshold_aCallerWithAHeavyReceive_isRefundedInEth() public onlyFork {
        Pair memory p = wethL;
        _fillDirectly(p, WETH_THRESHOLD * 23 / 24); // most of the way: 4.28 of 4.47 WETH
        HeavyWallet w = new HeavyWallet();
        vm.deal(address(w), 3 ether);

        vm.recordLogs();
        w.buy(router, address(registry), p.token, 2 ether);
        uint256 refund = _curveRefund(vm.getRecordedLogs(), p.curve);

        assertGt(refund, 0, "nothing was refunded - the buy was not past the threshold");
        assertEq(w.received(), refund, "the refund did not arrive as ETH");
        assertEq(IERC20(WETH).balanceOf(address(w)), 0, "a wallet that takes ETH was refunded WETH");
        _assertRouterEmpty(p);
    }

    /// AND THE SAME WALLET AS A SALE'S RECIPIENT is paid ETH.
    function test_sell_aRecipientWithAHeavyReceive_isPaidInEth() public onlyFork {
        Pair memory p = nvdaL;
        HeavyWallet w = new HeavyWallet();
        uint256 amount = _hold(p, seller, 0.3 ether) / 2;
        vm.prank(seller);
        IERC20(p.token).approve(address(router), amount);

        vm.recordLogs();
        vm.prank(seller);
        uint256 out = router.sellForEth(address(registry), p.token, amount, 0, _sellPath(p), 1, address(w), block.timestamp);

        assertGt(out, 0, "nothing was paid");
        assertEq(w.received(), out, "the recipient was not paid in ETH");
        assertEq(IERC20(WETH).balanceOf(address(w)), 0, "a wallet that takes ETH was paid WETH");
        assertFalse(_soldAsWeth(vm.getRecordedLogs()), "the event said it paid WETH");
    }

    // ================================================================
    // the deployment
    // ================================================================

    /// THE ADDRESS THE PAGE CARRIES, and the hash of the code it finds there.
    /// Literals, not computed from the build: a router edit that moves either
    /// fails here until DeployRouter's constants - and the page - move too.
    address internal constant ROUTER_ADDRESS = 0xEa20C3266229a01cd0f45D9c7921a45d5b359561;
    bytes32 internal constant ROUTER_CODEHASH = 0x25814dde01efddddcc582ba476471c80ce6de85154d1ee6a357f28cb67b37c5e;

    /// THE SCRIPT LANDS WHERE CREATE2 SAYS, through the real proxy on the fork
    /// of Base - the same proxy, at the same address, as on Base - and that is
    /// the pinned address. It refuses other code at that address, and a second
    /// run finds its own and stops.
    function test_theDeployScript_landsAtItsCreate2Address() public onlyFork {
        assertGt(CREATE2_PROXY.code.length, 0, "no deterministic deployment proxy on the fork");
        DeployRouter script = new DeployRouter();
        address expected =
            vm.computeCreate2Address(script.SALT(), keccak256(vm.getCode("CurbRouter.sol:CurbRouter")), CREATE2_PROXY);
        assertEq(script.predictedAddress(), expected, "the script predicts another address");
        assertEq(expected, ROUTER_ADDRESS, "the router as built does not land at the pinned address");
        assertEq(script.EXPECTED_ROUTER(), ROUTER_ADDRESS, "the script pins another address");
        assertEq(script.runtimeCodehash(), ROUTER_CODEHASH, "the router as built has other runtime code");
        assertEq(script.EXPECTED_RUNTIME_CODEHASH(), ROUTER_CODEHASH, "the script pins another code hash");
        assertEq(keccak256(address(router).code), ROUTER_CODEHASH, "the suite tests other code than it pins");
        assertEq(expected.code.length, 0, "something is already at the router's address on the fork");

        // OTHER CODE THERE IS REFUSED, and the refusal is checked before the
        // real deployment, on a snapshot, so the address is clean for it. Of
        // any length: one byte, and the router's own code with one byte
        // changed - as long as the router's, and it runs as the router does.
        bytes[2] memory others = [bytes(hex"00"), _foreignRouterCode()];
        for (uint256 i = 0; i < others.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.etch(expected, others[i]);
            vm.expectRevert(bytes("DeployRouter: other bytecode already lives at the CREATE2 address - refusing"));
            script.run();
            vm.revertToState(snap);
        }

        CurbRouter deployed = script.run();
        assertEq(address(deployed), expected, "the router did not land at its CREATE2 address");
        assertEq(keccak256(expected.code), ROUTER_CODEHASH, "other code landed there");
        emit log_named_address("CurbRouter CREATE2 address", expected);
        emit log_named_bytes32("CurbRouter runtime code hash", keccak256(expected.code));

        assertEq(address(script.run()), expected, "a second run did not find the first deployment");

        // AND IT IS THE ROUTER: a buy through the deployed copy.
        vm.prank(buyer);
        uint256 out = deployed.buyWithEth{value: 0.1 ether}(address(registry), wethL.token, "", 0, 1, recipient, block.timestamp);
        assertGt(out, 0, "the deployed router did not buy");
    }

    /// A BUILD THAT DOES NOT MATCH THE PINS IS NOT DEPLOYED - another address,
    /// or the right address with other runtime code - and nothing is sent.
    function test_theDeployScript_refusesABuildThatIsNotThePinnedOne() public onlyFork {
        DeployRouter elsewhere = new DeployRouterExpecting(address(0xdead), ROUTER_CODEHASH);
        vm.expectRevert(bytes("DeployRouter: the router as built does not land at EXPECTED_ROUTER"));
        elsewhere.run();

        DeployRouter otherCode = new DeployRouterExpecting(ROUTER_ADDRESS, keccak256("other code"));
        vm.expectRevert(bytes("DeployRouter: the router as built does not hash to EXPECTED_RUNTIME_CODEHASH"));
        otherCode.run();
        assertEq(ROUTER_ADDRESS.code.length, 0, "a refused run deployed something");
    }

    /// THE PREFLIGHT REFUSES A CHAIN THE ROUTER CANNOT SERVE: no deployment
    /// proxy, a SwapRouter02 that wraps another WETH, no B20 factory.
    function test_theDeployScript_refusesAChainItCannotServe() public onlyFork {
        DeployRouter script = new DeployRouter();
        uint256 snap = vm.snapshotState();
        vm.etch(CREATE2_PROXY, hex"00");
        vm.expectRevert(bytes("DeployRouter: no deterministic deployment proxy on this chain"));
        script.run();
        vm.revertToState(snap);

        vm.mockCall(SWAP_ROUTER02, abi.encodeWithSignature("WETH9()"), abi.encode(address(0xBEEF)));
        vm.expectRevert(bytes("DeployRouter: SwapRouter02 here does not wrap this WETH"));
        script.run();
        vm.clearMockedCalls();

        vm.mockCall(B20_FACTORY, abi.encodeWithSignature("isB20(address)", WETH), abi.encode(true));
        vm.expectRevert(bytes("DeployRouter: no B20 factory on this chain"));
        script.run();
        vm.clearMockedCalls();
        assertEq(ROUTER_ADDRESS.code.length, 0, "a refused run deployed something");
    }

    /// WHAT LANDED IS CHECKED, NOT ASSUMED. The proxy's answer is mocked:
    /// a revert, another address, the right address with nothing deployed
    /// there, or the right address with other code there that runs and
    /// answers as the router does. Then the real deployment, with the router
    /// answering one of its
    /// four constants with another address (mocked without putting code at
    /// the address first, so the CREATE2 still lands). Each is refused by name.
    function test_theDeployScript_checksWhatLanded() public onlyFork {
        DeployRouter script = new DeployRouter();
        bytes memory deployCall = abi.encodePacked(script.SALT());

        vm.mockCallRevert(CREATE2_PROXY, deployCall, "");
        vm.expectRevert(bytes("DeployRouter: the deployment proxy reverted"));
        script.run();
        vm.clearMockedCalls();

        vm.mockCall(CREATE2_PROXY, deployCall, abi.encodePacked(address(0xBEEF)));
        vm.expectRevert(bytes("DeployRouter: the router landed somewhere else"));
        script.run();
        vm.clearMockedCalls();

        vm.mockCall(CREATE2_PROXY, deployCall, abi.encodePacked(ROUTER_ADDRESS));
        vm.expectRevert(bytes("DeployRouter: the code at the address is not the router's"));
        script.run();
        vm.clearMockedCalls();
        assertEq(ROUTER_ADDRESS.code.length, 0, "a refused run deployed something");

        // The meddlers run as the proxy, and a forked account may not use
        // cheatcodes until it is allowed to.
        vm.allowCheatcodes(CREATE2_PROXY);
        bytes memory fullCall = abi.encodePacked(script.SALT(), vm.getCode("CurbRouter.sol:CurbRouter"));

        // CODE THERE, BUT NOT THE ROUTER'S: the proxy answers the right
        // address, where it put the router's code with one byte changed. That
        // code answers all four constants right, so only the hash refuses it.
        {
            uint256 snap = vm.snapshotState();
            vm.mockFunction(CREATE2_PROXY, address(new ForeignCodeDeployer(ROUTER_ADDRESS, _foreignRouterCode())), fullCall);
            vm.expectRevert(bytes("DeployRouter: the code at the address is not the router's"));
            script.run();
            vm.clearMockedCalls();
            vm.revertToState(snap);
        }

        bytes4[4] memory constants = [
            CurbRouter.WETH.selector,
            CurbRouter.SWAP_ROUTER.selector,
            CurbRouter.B20_FACTORY.selector,
            CurbRouter.POLICY_REGISTRY.selector
        ];
        for (uint256 i = 0; i < constants.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.mockFunction(CREATE2_PROXY, address(new MeddlingDeployer(constants[i])), fullCall);
            vm.expectRevert(bytes("DeployRouter: constants moved"));
            script.run();
            vm.clearMockedCalls();
            vm.revertToState(snap);
        }
    }

    /// THE ROUTER'S RUNTIME CODE WITH ITS LAST BYTE CHANGED. That byte is in
    /// the compiler-version trailer, which never runs, so this code is as long
    /// as the router's and behaves exactly as it does - and is still not it.
    function _foreignRouterCode() internal view returns (bytes memory code) {
        code = address(router).code;
        code[code.length - 1] ^= 0x01;
        assertTrue(keccak256(code) != ROUTER_CODEHASH, "the foreign code is the router's");
    }

    // ================================================================
    // fixture
    // ================================================================

    function _factory(address graduator, address hook, address quote, uint8 decimals, uint256 phantom, uint256 threshold)
        internal
        returns (address)
    {
        address escrow = vm.deployCode("FeeEscrow.sol:FeeEscrow", abi.encode(quote));
        address policy = vm.deployCode("FeePolicy.sol:FeePolicy", abi.encode(protocolRecipient, escrow, MAX_IMPACT_BPS));
        address vault =
            vm.deployCode("PonsV2BuybackVault.sol:PonsV2BuybackVault", abi.encode(address(this), policy, escrow));
        return vm.deployCode(
            "CurbLaunchFactory.sol:CurbLaunchFactory",
            abi.encode(
                address(registry),
                graduator,
                quote,
                policy,
                escrow,
                vault,
                CurbLaunchFactory.Terms({
                    supply: SUPPLY,
                    quoteDecimals: decimals,
                    phantomQuote: phantom,
                    graduationThreshold: threshold,
                    poolFee: POOL_FEE,
                    tickSpacing: TICK_SPACING,
                    hooks: IHooks(hook),
                    protocolFeeRecipient: protocolRecipient,
                    maxInternalPriceImpactBps: MAX_IMPACT_BPS,
                    launchFee: 0
                })
            )
        );
    }

    /// THE HOOK'S SALT, mined against this contract - which is what deploys it
    /// with CREATE2 below. The init code is hashed ONCE rather than on every
    /// attempt, and the one candidate that fits is the only address asked
    /// whether it has code: HookMiner asks every candidate, and on a fork each
    /// question is a round trip to the node.
    function _mineHook(address graduator) internal returns (address hook) {
        bytes memory init = abi.encodePacked(
            vm.getCode("FeeHook.sol:FeeHook"),
            abi.encode(POOL_MANAGER, protocolRecipient, address(registry), graduator, address(this))
        );
        bytes32 initHash = keccak256(init);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        for (uint256 salt; salt < 500_000; salt++) {
            address candidate = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash))))
            );
            if (uint160(candidate) & Hooks.ALL_HOOK_MASK != flags || candidate.code.length != 0) continue;
            assembly ("memory-safe") {
                hook := create2(0, add(init, 0x20), mload(init), salt)
            }
            require(hook == candidate, "the hook did not deploy to the mined address");
            return hook;
        }
        revert("no hook salt found");
    }

    function _launch(address factory, address quote, string memory sym) internal returns (Pair memory p) {
        CurbLaunchFactory f = CurbLaunchFactory(factory);
        (uint16 bps, address to) = f.currentPlatformPolicy();
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = f.launch(
            CurbLaunchFactory.LaunchConfig({
                name: sym,
                symbol: sym,
                tokenUri: "",
                salt: bytes32(uint256(1)),
                quoteRefundTo: creator,
                totalTaxBps: TAX_BPS,
                devBuy: 0,
                creatorWallet: address(0),
                expectedPlatformBps: bps,
                expectedPlatformRecipient: to,
                holderShareFactory: address(0)
            })
        );
        p = Pair(address(token), address(curve), quote);
        assertEq(registry.launchOf(p.token).curve, p.curve, "the record names another curve");
        assertEq(registry.launchOf(p.token).quoteToken, quote, "the record names another asset");
    }

    /// A WETH/NVDAc pool at a tier nobody uses, with one narrow, shallow
    /// position: about 0.003 WETH and 0.034 NVDAc either side of the price.
    function _thinPool() internal returns (address pool) {
        assertEq(
            IV3FactoryLike(V3_FACTORY).getPool(WETH, NVDAC, THIN_TIER),
            address(0),
            "a WETH/NVDAc pool already exists at this tier - pick another for the thin route"
        );
        pool = IV3FactoryLike(V3_FACTORY).createPool(WETH, NVDAC, THIN_TIER);
        IV3PoolLike(pool).initialize(TickMath.getSqrtPriceAtTick(THIN_TICK));
        V3MintHelper h = new V3MintHelper();
        _giveWeth(address(h), 1 ether);
        vm.prank(NVDAC_WHALE);
        require(IERC20(NVDAC).transfer(address(h), 10e8), "fund NVDAc");
        h.mint(pool, THIN_TICK - 200, THIN_TICK + 200, THIN_LIQUIDITY);
    }

    /// A USDC/NVDAc pool at a tier nobody uses, one spacing wide, with one
    /// shallow position around the price: a few USDC either side, so a
    /// second hop handed a hundred USDC takes a few and stops.
    function _thinUsdcNvdaPool() internal returns (address pool) {
        assertEq(
            IV3FactoryLike(V3_FACTORY).getPool(USDC, NVDAC, THIN_USDC_TIER),
            address(0),
            "a USDC/NVDAc pool already exists at this tier - pick another for the thin hop"
        );
        pool = IV3FactoryLike(V3_FACTORY).createPool(USDC, NVDAC, THIN_USDC_TIER);
        int24 tick = -5820;
        IV3PoolLike(pool).initialize(TickMath.getSqrtPriceAtTick(tick));
        V3MintHelper h = new V3MintHelper();
        deal(USDC, address(h), 1000e6);
        vm.prank(NVDAC_WHALE);
        require(IERC20(NVDAC).transfer(address(h), 10e8), "fund NVDAc");
        h.mint(pool, tick - 180, tick + 180, 1e9);
    }

    /// One of NVDAc's policy scopes, and the policy id it names.
    function _policy(string memory scopeName) internal view returns (bytes32 scope, uint64 id) {
        return _policyOf(NVDAC, scopeName);
    }

    /// One of a B20 asset's policy scopes, and the policy id it names - asked
    /// of that asset.
    function _policyOf(address asset, string memory scopeName) internal view returns (bytes32 scope, uint64 id) {
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSignature(scopeName));
        require(ok && ret.length == 32, "the asset did not name the scope");
        scope = abi.decode(ret, (bytes32));
        (ok, ret) = asset.staticcall(abi.encodeWithSignature("policyId(bytes32)", scope));
        require(ok && ret.length == 32, "the asset did not name the policy");
        id = abi.decode(ret, (uint64));
    }

    /// THE ISSUER REFUSES `who`, the way B20Restrictions does it: the policy's
    /// own admin adds it to the blocklist of NVDAc's policy (5 for all three
    /// scopes, and for every equity). Checked in force before returning.
    function _issuerBlocks(address who) internal {
        _issuerBlocksOn(NVDAC, who);
    }

    /// The same for any B20 asset, by the policies THAT asset names: its
    /// receiver policy's blocklist, and its sender policy's when that is
    /// another one, so `who` is refused in both directions either way.
    function _issuerBlocksOn(address asset, address who) internal {
        (, uint64 receiveId) = _policyOf(asset, "TRANSFER_RECEIVER_POLICY()");
        (, uint64 sendId) = _policyOf(asset, "TRANSFER_SENDER_POLICY()");
        _blocklist(receiveId, who);
        if (sendId != receiveId) _blocklist(sendId, who);
    }

    function _blocklist(uint64 id, address who) internal {
        (bool ok, bytes memory ret) = POLICY_REGISTRY.staticcall(abi.encodeWithSignature("policyAdmin(uint64)", id));
        require(ok && ret.length == 32, "policyAdmin() did not answer");
        address admin = abi.decode(ret, (address));
        address[] memory list = new address[](1);
        list[0] = who;
        vm.prank(admin);
        (bool set,) =
            POLICY_REGISTRY.call(abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", id, true, list));
        require(set, "the blocklist update was refused");
        (ok, ret) = POLICY_REGISTRY.staticcall(abi.encodeWithSignature("isAuthorized(uint64,address)", id, who));
        require(ok && !abi.decode(ret, (bool)), "the blocklist entry is not in force");
    }

    /// THE COIN BLACKLISTS `who`, the way Coinbase would: its own blacklister
    /// calls blacklist(). Checked in force before returning.
    function _coinBlacklists(address coin, address who) internal {
        address blacklister = IFiatTokenLike(coin).blacklister();
        assertTrue(blacklister != address(0), "the coin names no blacklister");
        vm.prank(blacklister);
        IFiatTokenLike(coin).blacklist(who);
        require(IFiatTokenLike(coin).isBlacklisted(who), "the blacklist entry is not in force");
    }

    function _isB20(address asset) internal view returns (bool) {
        (bool ok, bytes memory ret) = B20_FACTORY.staticcall(abi.encodeWithSignature("isB20(address)", asset));
        require(ok && ret.length == 32, "the B20 factory did not answer");
        return abi.decode(ret, (bool));
    }

    /// A SALE BY HAND THAT NEVER HOLDS THE ASSET: the curve pays SwapRouter02
    /// directly, and SwapRouter02 swaps its own balance (exactInput's
    /// amountIn of 0 is CONTRACT_BALANCE), paying `who` WETH. What `who` was
    /// paid; checked that `who` held none of the asset at any point after.
    function _sellWithoutHolding(Pair memory p, address who, uint256 amount, bytes memory sellPath)
        internal
        returns (uint256 paid)
    {
        assertEq(IERC20(p.quote).balanceOf(who), 0, "the seller holds the asset already");
        vm.startPrank(who);
        IERC20(p.token).approve(p.curve, amount);
        PonsV2BondingCurve(p.curve).sell(amount, 0, SWAP_ROUTER02);
        paid = ISwapRouter02(SWAP_ROUTER02).exactInput(
            ISwapRouter02.ExactInputParams({path: sellPath, recipient: who, amountIn: 0, amountOutMinimum: 0})
        );
        vm.stopPrank();
        assertEq(IERC20(p.quote).balanceOf(who), 0, "by hand, the seller ended up holding the asset");
        assertEq(IERC20(p.token).balanceOf(who), 0, "by hand, the sale left launch tokens");
    }

    /// A FRESH BLOCKLIST POLICY, administered by this test, refusing `who`.
    function _freshBlocklist(address who) internal returns (uint64 id) {
        (bool ok, bytes memory ret) =
            POLICY_REGISTRY.call(abi.encodeWithSignature("createPolicy(address,uint8)", address(this), uint8(0)));
        require(ok && ret.length == 32, "createPolicy was refused");
        id = abi.decode(ret, (uint64));
        address[] memory list = new address[](1);
        list[0] = who;
        (bool set,) =
            POLICY_REGISTRY.call(abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", id, true, list));
        require(set, "the blocklist update was refused");
        (ok, ret) = POLICY_REGISTRY.staticcall(abi.encodeWithSignature("isAuthorized(uint64,address)", id, who));
        require(ok && !abi.decode(ret, (bool)), "the fresh blocklist entry is not in force");
    }

    function _giveWeth(address who, uint256 amount) internal {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        IWETH(WETH).deposit{value: amount}();
    }

    /// Buys most of a curve DIRECTLY, from a trader funded from a real holder
    /// (NVDAc) or by wrapping (WETH), so the router's buy is the one to cross.
    function _fillDirectly(Pair memory p, uint256 amount) internal {
        if (p.quote == WETH) {
            _giveWeth(trader, amount);
        } else {
            vm.prank(NVDAC_WHALE);
            require(IERC20(NVDAC).transfer(trader, amount), "fund NVDAc");
        }
        vm.startPrank(trader);
        IERC20(p.quote).approve(p.curve, amount);
        PonsV2BondingCurve(p.curve).buy(amount, 0, trader);
        vm.stopPrank();
    }

    /// Puts launch tokens in `who`'s hands the way a user gets them: an ETH
    /// buy through the router.
    function _hold(Pair memory p, address who, uint256 ethIn) internal returns (uint256 held) {
        vm.prank(buyer);
        router.buyWithEth{value: ethIn}(address(registry), p.token, _buyPath(p), 1, 0, who, block.timestamp);
        held = IERC20(p.token).balanceOf(who);
        assertGt(held, 0, "the fixture buy delivered nothing");
    }

    /// What the v3 route delivers for `ethIn`, measured on a snapshot.
    function _swapQuote(bytes memory path, uint256 ethIn) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        vm.prank(buyer);
        out = ISwapRouter02(SWAP_ROUTER02).exactInput{value: ethIn}(
            ISwapRouter02.ExactInputParams({path: path, recipient: buyer, amountIn: ethIn, amountOutMinimum: 0})
        );
        vm.revertToState(snap);
    }

    function _buyPath(Pair memory p) internal view returns (bytes memory) {
        if (p.quote == WETH) return "";
        if (p.quote == NVDAC) return abi.encodePacked(WETH, NVDAC_TIER, NVDAC);
        if (p.quote == CBBTC || p.quote == CBXRP) {
            return abi.encodePacked(WETH, _deepestTier(WETH, p.quote, p.quote), p.quote);
        }
        // SPCXc AND GOOGLc: two hops through USDC.
        return abi.encodePacked(WETH, _deepestTier(WETH, USDC, USDC), USDC, _deepestTier(USDC, p.quote, p.quote), p.quote);
    }

    function _sellPath(Pair memory p) internal view returns (bytes memory) {
        if (p.quote == WETH) return "";
        if (p.quote == NVDAC) return abi.encodePacked(NVDAC, NVDAC_TIER, WETH);
        if (p.quote == CBBTC || p.quote == CBXRP) {
            return abi.encodePacked(p.quote, _deepestTier(WETH, p.quote, WETH), WETH);
        }
        return abi.encodePacked(p.quote, _deepestTier(USDC, p.quote, p.quote), USDC, _deepestTier(WETH, USDC, USDC), WETH);
    }

    /// GOOGLc'S LAUNCH, admitted to this deployment the way any later asset is:
    /// its own factory, escrow, policy and vault against the same registry,
    /// graduator and hook, and the registry's addLauncher. Built by the tests
    /// that trade it rather than in setUp, so every other test - and every
    /// mutant of script/b20/mutate-router.sh - keeps the setUp it had.
    function _googlLaunch() internal returns (Pair memory p) {
        address f = _factory(graduatorAt, hookAt, GOOGLC, 8, GOOGLC_PHANTOM, GOOGLC_THRESHOLD);
        registry.addLauncher(f);
        p = _launch(f, GOOGLC, "RGOOGL");
    }

    /// The most of `asset` any v3 pool against `other` holds, over the four
    /// tiers; zero when there is no pool at all.
    function _mostHeld(address other, address asset) internal view returns (uint256 most) {
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        for (uint256 i = 0; i < tiers.length; i++) {
            address pool = IV3FactoryLike(V3_FACTORY).getPool(other, asset, tiers[i]);
            if (pool == address(0)) continue;
            uint256 held = IERC20(asset).balanceOf(pool);
            if (held > most) most = held;
        }
    }

    /// The twenty bytes of `b` from `at`, as an address.
    function _addrAt(bytes memory b, uint256 at) internal pure returns (address a) {
        require(b.length >= at + 20, "the bytes end before the address");
        assembly ("memory-safe") {
            a := shr(96, mload(add(add(b, 0x20), at)))
        }
    }

    /// THE PAGE'S RULE (B20EthRoute): of the tiers, the pool holding the most
    /// of the asset it would have to hand over.
    function _deepestTier(address a, address b, address held_) internal view returns (uint24 best) {
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        uint256 most;
        for (uint256 i = 0; i < tiers.length; i++) {
            address pool = IV3FactoryLike(V3_FACTORY).getPool(a, b, tiers[i]);
            if (pool == address(0)) continue;
            uint256 held = IERC20(held_).balanceOf(pool);
            if (held > most) {
                most = held;
                best = tiers[i];
            }
        }
        require(best != 0, "no pool holds the asset at any tier");
    }

    function _assertRouterEmpty(Pair memory p) internal view {
        address r = address(router);
        assertEq(r.balance, 0, "ETH was left in the router");
        assertEq(IERC20(WETH).balanceOf(r), 0, "WETH was left in the router");
        assertEq(IERC20(p.quote).balanceOf(r), 0, "the quote asset was left in the router");
        assertEq(IERC20(USDC).balanceOf(r), 0, "USDC was left in the router");
        assertEq(IERC20(p.token).balanceOf(r), 0, "launch tokens were left in the router");
        assertEq(IERC20(WETH).allowance(r, SWAP_ROUTER02), 0, "a WETH allowance to SwapRouter02 was left standing");
        assertEq(IERC20(p.quote).allowance(r, SWAP_ROUTER02), 0, "an asset allowance to SwapRouter02 was left standing");
        assertEq(IERC20(p.quote).allowance(r, p.curve), 0, "an asset allowance to the curve was left standing");
        assertEq(IERC20(p.token).allowance(r, p.curve), 0, "a token allowance to the curve was left standing");
    }

    /// The curve's own record of what it refunded, summed over the call.
    function _curveRefund(Vm.Log[] memory logs, address curve) internal pure returns (uint256 refund) {
        bytes32 sig = keccak256("CurveBuyRefunded(address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == curve && logs[i].topics[0] == sig) refund += abi.decode(logs[i].data, (uint256));
        }
    }

    function _boughtEvent(Vm.Log[] memory logs)
        internal
        view
        returns (uint256 tokensOut, uint256 quoteIn, uint256 quoteRefund, uint256 ethRefund)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == CurbRouter.BoughtWithEth.selector) {
                (,, quoteIn, tokensOut, quoteRefund, ethRefund) =
                    abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256, uint256));
                return (tokensOut, quoteIn, quoteRefund, ethRefund);
            }
        }
        revert("the router emitted no BoughtWithEth");
    }

    function _soldAsWeth(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == CurbRouter.SoldForEth.selector) {
                (,,,, bool asWeth) = abi.decode(logs[i].data, (address, uint256, uint256, uint256, bool));
                return asWeth;
            }
        }
        revert("the router emitted no SoldForEth");
    }

    function _stoppedMidway(bytes memory err) internal pure returns (address asset, uint256 unspent) {
        assertEq(bytes4(err), CurbRouter.RouteStoppedMidway.selector, "refused, but not for a hop that stopped short");
        (asset, unspent) = abi.decode(_tail(err), (address, uint256));
    }

    function _tail(bytes memory err) internal pure returns (bytes memory body) {
        body = new bytes(err.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = err[i + 4];
        }
    }
}
