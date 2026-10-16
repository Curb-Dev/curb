// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";
import {DevBuyCap} from "../harness/DevBuyCap.sol";
import {PonsV2BuybackVault} from "../../src/vendor/PonsV2BuybackVault.sol";
import {IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../../src/vendor/interfaces/ILaunchpadV2.sol";

import {Graduator, IPermit2Minimal} from "../../src/curb/Graduator.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {SharingCatalog} from "../../src/curb/SharingCatalog.sol";
import {ISharingCatalog} from "../../src/curb/sharing/ICurbSharing.sol";
import {CurbLaunchFactory} from "../../src/curb/CurbLaunchFactory.sol";
import {DeployCurb} from "../../script/DeployCurb.s.sol";
import {CurbLaunchToken} from "../../src/curb/CurbLaunchToken.sol";
import {PositionLock, IPositionManagerMinimal} from "../../src/curb/PositionLock.sol";
import {FeeHook} from "../../src/curb/FeeHook.sol";
import {FeeEscrow} from "../../src/curb/FeeEscrow.sol";
import {FeePolicy} from "../../src/curb/FeePolicy.sol";

import {B20ForkTest, ISafe} from "./B20ForkTest.sol";
import {PoolHarness} from "./B20UniswapV4.t.sol";

interface IV3FactoryMinimal {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IDecimalsView {
    function decimals() external view returns (uint8);
}

/// The two views this file reads off the position manager. Kept apart from
/// IPositionManagerMinimal, which is what the Graduator needs to WRITE.
interface IPositionManagerLike {
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function nextTokenId() external view returns (uint256);
}


/// Four decimals: below the floor, and legal ERC-20.
contract CoarseToken {
    function decimals() external pure returns (uint8) { return 4; }
}

/// decimals() is OPTIONAL in ERC-20, so a token may simply not have it.
contract SilentToken {
    function symbol() external pure returns (string memory) { return "QUIET"; }
}

/// ANSWERS THE TWO QUESTIONS DeployCurb ASKS OF A SAFE, and nothing else. A
/// second Safe-shaped address for the run() test, which needs the recipient
/// and the owner to be different Safes (see _eachOptInClearsOnlyItsOwnRefusal).
contract SafeShapedStub {
    function getThreshold() external pure returns (uint256) { return 2; }
    function getOwners() external pure returns (address[] memory o) {
        o = new address[](2);
        o[0] = address(0x5AFE01);
        o[1] = address(0x5AFE02);
    }
}

/// USDT'S SHAPE, which none of the fourteen shipped assets has and nothing stops
/// a future one having: approve, transfer and transferFrom return NOTHING, and
/// approve refuses to write non-zero over non-zero.
///
/// It exists for Graduator._mint's Permit2 approve. A raw approve reverts on the
/// FIRST graduation against it (no return value to decode). The overwrite
/// refusal only bites when an allowance is left standing, which the code never
/// does by itself (the quote is spent to zero), so the test leaves one by hand.
///
/// ITS DECIMALS CAN BE CHANGED, like an upgradeable asset's, for the factory's
/// launch-time decimals check.
contract UsdtShapedToken {
    string public constant name = "Tether-shaped";
    string public constant symbol = "USDTS";
    uint8 public decimals = 6;

    function setDecimals(uint8 d) external {
        decimals = d;
    }
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "USDTS: non-zero over non-zero");
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "USDTS: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "USDTS: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/**
 * @title B20MultiAssetTest
 * @notice The curve-to-pool lifecycle, run against EACH quote asset the
 *         deployment stands up rather than against NVDAc alone.
 *
 * WHY THIS FILE EXISTS.
 *   MULTI_RWA_AUDIT.txt section 5 said, plainly, that seven assets were stood
 *   up and one was exercised - and that "it is a B20 like NVDAc" is not
 *   evidence. This is the evidence, or it is where the assumption breaks.
 *
 *   The audit had already found one defect of exactly that shape: the Graduator
 *   recognised only the first factory, so six assets could be deployed,
 *   admitted and listed while creating zero launches. Eight registry tests
 *   passed with that in place. Registration is not operation.
 *
 * ONE TEST PER ASSET, NOT ONE LOOP.
 *   A loop stops at the first failure and says nothing about the others.
 *   Thirteen named tests - every shipped asset but NVDAc, which B20Graduation
 *   drives end to end - each say which asset failed and let the rest still
 *   report. A
 *   guard below fails when DeployCurb ships an asset with no fixture here, and
 *   names each fixture's test by selector, so deleting one is a compile error.
 *   It used to check only the other direction, and three coins shipped
 *   untested through it.
 *
 * FUNDING IS BY IMPERSONATION, and the source matters.
 *   deal() writes storage slots; a B20 is a precompile and has none. So each
 *   asset is funded from a REAL holder found by script/b20/find-holders.js,
 *   which excludes the v4 PoolManager and every v3/Aerodrome pool - an address
 *   whose balance is somebody else's accounting is not a funding source.
 *   USDC, VIRTUAL and AERO (2026-10-15) are ordinary ERC-20s deal() could
 *   write, and are funded the same way anyway, from code-less holders found
 *   in the 600 blocks (20 for USDC) before the pin.
 *
 * WHAT THIS DOES NOT COVER, said here so it is not taken for covered:
 *   - the ETH route, which for the six EQUITIES here does not exist. That is
 *     asserted rather than assumed: E1 below measures the absence of a usable
 *     WETH pool - for the equities only. For WETH it could not fail, and the
 *     coins have real WETH markets.
 *   - the issuer refusal path. All thirteen equities share policy 5, which is
 *     an argument that C1's mechanism is identical and not a measurement of it.
 */
contract B20MultiAssetTest is B20ForkTest {

    /// A sharing catalog for a Graduator under test: this contract owns it and
    /// may bootstrap it. Nothing is admitted unless a test admits it.
    function _catalog() internal returns (ISharingCatalog) {
        return ISharingCatalog(address(new SharingCatalog(address(this), address(this))));
    }
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address internal constant POSM_ADDR = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    IPositionManagerMinimal internal constant POSM = IPositionManagerMinimal(POSM_ADDR);
    IPositionManagerLike internal constant POSM_VIEW = IPositionManagerLike(POSM_ADDR);
    IPermit2Minimal internal constant PERMIT2 = IPermit2Minimal(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint24 internal constant FEE = 500;
    int24 internal constant TICK_SPACING = 10;
    uint16 internal constant TOTAL_TAX_BPS = 300;
    uint256 internal constant PLATFORM_FEE_BPS = 50;
    uint16 internal constant PROTOCOL_SHARE_BPS = 10_000;
    uint16 internal constant MAX_IMPACT_BPS = 500;

    address internal creator = makeAddr("creator");
    address internal trader = makeAddr("trader");
    address internal refundTo = makeAddr("refund");
    address internal protocolRecipient = makeAddr("protocol");

    /// THE FORK POINT IS CHECKED HERE and the stacks are built per test, not
    /// here: each asset needs its own registry, graduator, hook, escrow and
    /// factory, and building six of them for every test would make five of
    /// them dead weight in each.
    function setUp() public {
        _forkGuard();
    }

    /// An asset, its threshold, and a holder large enough to fund the fixture.
    ///
    /// THE THRESHOLDS ARE THE DEPLOYMENT'S OWN, and a test below holds them to
    /// it. This comment said so long before it was true: five of the six
    /// equities had drifted - SPCXc ran at 44 against a deployment's 88, AAPLc
    /// at 3.4 against 40 - so the lifecycle was proven on numbers no deployment
    /// would use, described by a sentence that was right when it was written.
    ///
    /// Holders and balances were measured at the pinned block by
    /// script/b20/find-holders.js. Funding comes from the holder rather than
    /// the market, which is why an asset whose market is thin is still
    /// testable here.
    struct Asset {
        address quote;
        string sym;
        /// The curve's virtual quote, DeployCurb's own like the threshold.
        uint256 phantom;
        uint256 threshold;
        address holder;
        /// THE SCALE `threshold` IS WRITTEN IN, which the factory checks against
        /// the asset itself. Eighteen here and eight there is exactly the
        /// mistake the check exists for, so it is stated per asset rather than
        /// read off the token - reading it back would compare a number with
        /// itself.
        uint8 decimals;
    }

    /// THE ONE QUOTE ASSET HERE THAT IS NOT A B20, and the product's primary
    /// pair since 2026-09-22.
    ///
    /// EVERYTHING ELSE IN THIS FILE IS AN EQUITY, so the whole stack had only
    /// ever been run against a quote asset with an issuer, a transfer policy
    /// and eight decimals. WETH has no policy at all and eighteen decimals,
    /// which is a different shape of asset reaching the same code - and it was
    /// added to the deployment before anything exercised it.
    ///
    /// The phantom and threshold are DeployCurb's own 1.65 / 4.47 WETH. The holder is the
    /// WETH/USDC 0.3% pool, which held 13,620 WETH at the pinned block; it is
    /// used as a balance to borrow from and nothing in this test trades
    /// against it.
    function _weth() internal pure returns (Asset memory) {
        return Asset(0x4200000000000000000000000000000000000006, "WETH", 1.65e18, 4.47e18,
            0x6c561B446416E1A00E8E93E221854d6eA4171372, 18);
    }

    function _spcx() internal pure returns (Asset memory) {
        // holder held 2,288.58 SPCXc
        return Asset(0xb2000000000000000000007b9fcbd005511aCBd5, "SPCXc", 27.5e8, 74.5e8,
            0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E, 8);
    }
    function _googl() internal pure returns (Asset memory) {
        // holder held 2,921.32 GOOGLc
        return Asset(0xb2000000000000000000002D0BA3164cc74f58B7, "GOOGLc", 11.5e8, 31.1e8,
            0xB1987CAD1682841b4b641d50E520777eC5Ab5542, 8);
    }
    function _amzn() internal pure returns (Asset memory) {
        // holder held 2,038.33 AMZNc
        return Asset(0xb200000000000000000000d9192b6B456483C2E8, "AMZNc", 15.8e8, 42.9e8,
            0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b, 8);
    }
    function _msft() internal pure returns (Asset memory) {
        // holder held 766.06 MSFTc
        return Asset(0xB200000000000000000000Ab99cFa739E253872B, "MSFTc", 7.42e8, 20.1e8,
            0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54, 8);
    }
    function _aapl() internal pure returns (Asset memory) {
        // holder held 1,684.11 AAPLc
        return Asset(0xb200000000000000000000C2e324d24d7eEcd1fb, "AAPLc", 11.6e8, 31.5e8,
            0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0, 8);
    }
    function _meta() internal pure returns (Asset memory) {
        // holder held 764.37 METAc
        return Asset(0xb2000000000000000000008bC8786B856E61707C, "METAc", 5.44e8, 14.7e8,
            0xEAF57753BC382E0324a1D43F72E7027705a2273E, 8);
    }

    /// THE WRAPPED COINS, shipped on 2026-09-23 and never launched here until
    /// the guard below was made to look both ways. Holders found at the pinned
    /// block by script/b20/find-holders.js (ONLY=cbBTC,cbXRP,cbZEC), passing
    /// over Morpho Blue at 0xbbbb...ffcb, whose balance is its markets'.
    ///
    /// cbBTC: the smallest raw threshold shipped, 0.132e8. Holder held 176.13.
    function _cbbtc() internal pure returns (Asset memory) {
        return Asset(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf, "cbBTC", 0.0487e8, 0.132e8,
            0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1, 8);
    }
    /// cbXRP: SIX decimals - the factory's floor exactly. Holder (an EOA) held
    /// 1,112,195.70.
    function _cbxrp() internal pure returns (Asset memory) {
        return Asset(0xcb585250f852C6c6bf90434AB21A00f02833a4af, "cbXRP", 3010e6, 8150e6,
            0x40EbC1Ac8d4Fedd2E144b75fe9C0420BE82750c6, 6);
    }
    /// cbZEC: in the 0xb2 family with the equities, not the 0xcb one. The same
    /// EOA held 22.86, against the 19.41 one lifecycle spent at the 9.20 of
    /// 2026-10-15 16:41 UTC, and less at the 8.74 it was re-priced to at 21:25
    /// - still the tightest holder here, as DEPLOY.txt PREP 1 warns.
    function _cbzec() internal pure returns (Asset memory) {
        return Asset(0xB2000000000000000000008501b13360000cb2EC, "cbZEC", 3.23e8, 8.74e8,
            0x40EbC1Ac8d4Fedd2E144b75fe9C0420BE82750c6, 8);
    }

    /// THE THREE ADDED ON 2026-10-15. Not B20s - no issuer, no policy - so
    /// the stack meets two shapes it had not: Circle's FiatToken with SIX
    /// decimals and its own blacklist (USDC), and plain eighteen-decimal
    /// ERC-20s (VIRTUAL, AERO). Holders are code-less addresses found in the
    /// Transfer logs before the pin (script/b20/find-holders.js), read at the
    /// pin: USDC's held 6,724,492.36, VIRTUAL's 36,544,142.99, AERO's
    /// 26,147,566.44.
    ///
    /// USDC: the largest raw threshold shipped, 10800e6.
    function _usdc() internal pure returns (Asset memory) {
        return Asset(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, "USDC", 4000e6, 10800e6,
            0x943C3B3aEe55aB6cC16c559c48B085cd60167203, 6);
    }
    function _virtual() internal pure returns (Asset memory) {
        return Asset(0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b, "VIRTUAL", 5940e18, 16100e18,
            0x582717501Dec047513EC258458da7834011076DE, 18);
    }
    function _aero() internal pure returns (Asset memory) {
        return Asset(0x940181a94A35A4569E4529A3CDfB74e38FD98631, "AERO", 4290e18, 11600e18,
            0xBaeD383EDE0e5d9d72430661f3285DAa77E9439F, 18);
    }

    /// Every fixture above, by index rather than as one literal - thirteen
    /// struct temporaries in a single expression is more than the stack holds.
    function _fixtures() internal pure returns (Asset[] memory list) {
        list = new Asset[](13);
        list[0] = _weth();
        list[1] = _usdc();
        list[2] = _cbbtc();
        list[3] = _cbxrp();
        list[4] = _cbzec();
        list[5] = _virtual();
        list[6] = _aero();
        list[7] = _googl();
        list[8] = _spcx();
        list[9] = _amzn();
        list[10] = _msft();
        list[11] = _aapl();
        list[12] = _meta();
    }

    /// THE ASSETS E1 IS ABOUT. MULTI_RWA.txt 2.2 measured the equities' WETH
    /// markets as empty; WETH cannot have a WETH pool and the coins have deep
    /// ones, so for them the assertion either cannot fail or must.
    function _ethRouteShouldBeAbsent(address quote) internal pure returns (bool) {
        return quote == _spcx().quote || quote == _googl().quote || quote == _amzn().quote
            || quote == _msft().quote || quote == _aapl().quote || quote == _meta().quote;
    }

    /// One asset's whole stack, exactly as DeployCurb builds it.
    struct Stack {
        LaunchRegistry registry;
        Graduator graduator;
        FeeHook hook;
        FeeEscrow escrow;
        CurbLaunchFactory factory;
    }

    /// EVERYTHING EXCEPT THE FACTORY. Split out because vm.expectRevert arms
    /// the VERY NEXT call: a refusal test that armed it before this would be
    /// watching the registry's constructor, and would fail for the right
    /// reason at the wrong place.
    function _stackWithoutFactory(Asset memory a)
        internal
        returns (Stack memory s, IPonsV2FeePolicy policy, PonsV2BuybackVault vault)
    {
        s.registry = new LaunchRegistry(address(this));
        s.graduator = new Graduator(POOL_MANAGER, POSM, PERMIT2, s.registry, _catalog());
        s.hook = _mineHook(address(s.graduator), s.registry);
        s.escrow = new FeeEscrow(a.quote);
        policy = IPonsV2FeePolicy(
            address(new FeePolicy(protocolRecipient, IPonsV2FeeEscrow(address(s.escrow)), MAX_IMPACT_BPS))
        );
        vault = new PonsV2BuybackVault(
            address(this), policy, IPonsV2FeeEscrow(address(s.escrow))
        );
    }

    function _stackFor(Asset memory a) internal returns (Stack memory s) {
        IPonsV2FeePolicy policy;
        PonsV2BuybackVault vault;
        (s, policy, vault) = _stackWithoutFactory(a);
        s.factory = _factoryOn(s, policy, vault, a);
        s.registry.wire(address(s.factory), address(s.hook));
    }

    /// ONLY the factory, so a refusal can be watched at the constructor that
    /// is supposed to refuse.
    function _factoryOn(
        Stack memory s,
        IPonsV2FeePolicy policy,
        PonsV2BuybackVault vault,
        Asset memory a
    ) internal returns (CurbLaunchFactory) {
        return new CurbLaunchFactory(
            s.registry,
            s.graduator,
            a.quote,
            policy,
            IPonsV2FeeEscrow(address(s.escrow)),
            vault,
            CurbLaunchFactory.Terms({
                supply: SUPPLY,
                quoteDecimals: a.decimals,
                phantomQuote: a.phantom,
                graduationThreshold: a.threshold,
                poolFee: FEE,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(address(s.hook)),
                protocolFeeRecipient: protocolRecipient,
                maxInternalPriceImpactBps: MAX_IMPACT_BPS,
            launchFee: 0
            })
        );
    }

    function _mineHook(address poolOpener, LaunchRegistry reg) internal returns (FeeHook) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address hookAddress, bytes32 salt) = HookMiner.find(
            address(this), flags, type(FeeHook).creationCode,
            abi.encode(POOL_MANAGER, protocolRecipient, reg, poolOpener, address(this))
        );
        FeeHook mined = new FeeHook{salt: salt}(POOL_MANAGER, protocolRecipient, reg, poolOpener, address(this));
        require(address(mined) == hookAddress, "hook did not deploy to the mined address");
        return mined;
    }

    function _fund(Asset memory a, address who, uint256 amount) internal {
        uint256 held = IERC20(a.quote).balanceOf(a.holder);
        require(held >= amount, string.concat(a.sym, ": the recorded holder no longer holds enough"));
        // SafeERC20, because one quote here returns nothing from transfer.
        vm.prank(a.holder);
        SafeERC20.safeTransfer(IERC20(a.quote), who, amount);
    }

    function _taxLegs(uint256 base) internal pure returns (uint256 platformCut, uint256 creatorCut) {
        platformCut = (base * PLATFORM_FEE_BPS) / 10_000;
        creatorCut = (base * (TOTAL_TAX_BPS - PLATFORM_FEE_BPS)) / 10_000;
    }

    // ================================================================
    // THE LIFECYCLE, per asset
    //
    // CRITERIA, stated before measuring:
    //   L1  a launch is created and its record carries THIS asset
    //   L2  a buy accrues exactly 50 bps to the platform and T-50 to the
    //       creator, IN THIS ASSET
    //   L3  a sell accrues the same two legs on the GROSS output
    //   L4  the curve's books close: what it holds is what it owes plus what
    //       is tradeable
    //   L5  the threshold is crossed and the launch graduates
    //   L6  the pool is opened on THIS asset paired with the launch token,
    //       with our hook, our tier and our tick spacing
    //   L7  the LP position is held by a lock that runs the full duration and
    //       pays the creator
    //   L8  the sweep credits both sides in the escrow FOR THIS ASSET, and
    //       each side can claim its own
    //   L9  a buy IN THE POOL pays both legs through the hook, in this asset,
    //       as independent floors of the input - straight out or as a debt
    //   E1  the ETH route does NOT exist: there is no WETH v3 pool at any tier
    // ================================================================

    function _lifecycle(Asset memory a) internal {
        Stack memory s = _stackFor(a);

        // ---- L1
        //
        // READ BEFORE THE PRANK. vm.prank aims at the NEXT call and a struct
        // field expression is one: reading the policy inside the literal spent
        // the prank on that read, so launch() came from this test contract and
        // the lock was made out to it.
        (uint16 expectBps, address expectTo) = s.factory.currentPlatformPolicy();
        vm.prank(creator);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = s.factory.launch(
            CurbLaunchFactory.LaunchConfig({
                name: "Curb Launch",
                symbol: "CURBL",
                tokenUri: "",
                salt: bytes32(uint256(1)),
                quoteRefundTo: refundTo,
                totalTaxBps: TOTAL_TAX_BPS,
                devBuy: 0,
                creatorWallet: address(0),
                expectedPlatformBps: expectBps,
                expectedPlatformRecipient: expectTo,
                holderShareFactory: address(0)
            })
        );
        assertEq(
            s.registry.launchOf(address(token)).quoteToken, a.quote,
            string.concat(a.sym, " L1: the record is on another asset")
        );

        // ---- L2: a buy, and both fee legs in THIS asset
        uint256 spend = a.threshold / 10;
        assertGt(spend, 0, string.concat(a.sym, " L2: the fixture spends nothing"));
        _fund(a, trader, spend);
        vm.startPrank(trader);
        SafeERC20.forceApprove(IERC20(a.quote), address(curve), type(uint256).max);
        curve.buy(spend, 0, trader);
        vm.stopPrank();

        (uint256 expPlatform, uint256 expCreator) = _taxLegs(spend);
        assertEq(curve.quoteFeeBalance(), expPlatform, string.concat(a.sym, " L2: platform leg is not 50 bps"));
        assertEq(curve.creatorTaxBalance(), expCreator, string.concat(a.sym, " L2: creator leg is not T-50"));
        assertGt(token.balanceOf(trader), 0, string.concat(a.sym, " L2: the buy delivered no tokens"));

        // ---- L3: a sell, on the gross output
        uint256 sellAmount = token.balanceOf(trader) / 4;
        uint256 platformBefore = curve.quoteFeeBalance();
        uint256 creatorBefore = curve.creatorTaxBalance();
        vm.startPrank(trader);
        token.approve(address(curve), type(uint256).max);
        uint256 got = curve.sell(sellAmount, 0, trader);
        vm.stopPrank();
        uint256 platformLeg = curve.quoteFeeBalance() - platformBefore;
        uint256 creatorLeg = curve.creatorTaxBalance() - creatorBefore;
        uint256 gross = got + platformLeg + creatorLeg;
        assertEq(platformLeg, (gross * PLATFORM_FEE_BPS) / 10_000,
            string.concat(a.sym, " L3: platform leg is not 50 bps of the gross"));
        assertEq(creatorLeg, (gross * (TOTAL_TAX_BPS - PLATFORM_FEE_BPS)) / 10_000,
            string.concat(a.sym, " L3: creator leg is not T-50 of the gross"));

        // ---- L4: the books close, counted outside the contract
        assertEq(
            IERC20(a.quote).balanceOf(address(curve)),
            curve.quoteFeeBalance() + curve.creatorTaxBalance() + curve.realQuoteReserve(),
            string.concat(a.sym, " L4: the curve holds something it does not account for")
        );

        // ---- L5: cross the threshold
        uint256 topUp = a.threshold * 2;
        _fund(a, trader, topUp);
        vm.prank(trader);
        curve.buy(topUp, 0, trader);
        assertTrue(curve.graduated(), string.concat(a.sym, " L5: the launch did not graduate"));

        // ---- L6: the pool it opened
        LaunchRegistry.Launch memory rec = s.registry.launchOf(address(token));
        bool launchIsC0 = address(token) < a.quote;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(launchIsC0 ? address(token) : a.quote),
            currency1: Currency.wrap(launchIsC0 ? a.quote : address(token)),
            fee: rec.fee,
            tickSpacing: rec.tickSpacing,
            hooks: rec.hooks
        });
        assertEq(rec.fee, FEE, string.concat(a.sym, " L6: the pool tier is not ours"));
        assertEq(rec.tickSpacing, TICK_SPACING, string.concat(a.sym, " L6: the tick spacing is not ours"));
        assertEq(address(rec.hooks), address(s.hook), string.concat(a.sym, " L6: another hook"));
        assertTrue(
            Currency.unwrap(key.currency0) == a.quote || Currency.unwrap(key.currency1) == a.quote,
            string.concat(a.sym, " L6: this asset is not in the pair")
        );
        assertGt(IERC20(a.quote).balanceOf(address(POOL_MANAGER)), 0,
            string.concat(a.sym, " L6: no reserves reached the pool"));

        // ---- L7: the lock
        uint256 tokenId = POSM_VIEW.nextTokenId() - 1;
        address lockAddr = IERC721(address(POSM)).ownerOf(tokenId);
        PositionLock lock = PositionLock(payable(lockAddr));
        assertGt(POSM_VIEW.getPositionLiquidity(tokenId), 0, string.concat(a.sym, " L7: an empty position"));
        assertEq(lock.beneficiary(), creator, string.concat(a.sym, " L7: the lock pays someone else"));

        // ---- L8: the sweep, and both claims. Graduation sweeps on its way
        // through, so the escrow is already credited here.
        uint256 platformOwed = s.escrow.balanceOfToken(protocolRecipient, a.quote);
        uint256 creatorOwed = s.escrow.balanceOfToken(creator, a.quote);
        assertGt(platformOwed, 0, string.concat(a.sym, " L8: the platform was credited nothing"));
        assertGt(creatorOwed, 0, string.concat(a.sym, " L8: the creator was credited nothing"));

        // A WETH ESCROW UNWRAPS AND PAYS ETHER; every other one pays its own
        // token. Both sides are measured across the claim, so whichever one
        // moved is the one checked and the other is held to zero.
        bool paysEther = a.quote == 0x4200000000000000000000000000000000000006;
        uint256 platformEthBefore = protocolRecipient.balance;
        uint256 creatorEthBefore = creator.balance;
        uint256 platformTokBefore = IERC20(a.quote).balanceOf(protocolRecipient);
        uint256 creatorTokBefore = IERC20(a.quote).balanceOf(creator);

        vm.prank(protocolRecipient);
        uint256 platformPaid = s.escrow.claimToken(a.quote);
        vm.prank(creator);
        uint256 creatorPaid = s.escrow.claimToken(a.quote);
        assertEq(platformPaid, platformOwed, string.concat(a.sym, " L8: the platform was underpaid"));
        assertEq(creatorPaid, creatorOwed, string.concat(a.sym, " L8: the creator was underpaid"));
        assertEq(
            paysEther
                ? protocolRecipient.balance - platformEthBefore
                : IERC20(a.quote).balanceOf(protocolRecipient) - platformTokBefore,
            platformOwed,
            string.concat(a.sym, " L8: the platform's claim did not arrive")
        );
        assertEq(
            paysEther ? creator.balance - creatorEthBefore : IERC20(a.quote).balanceOf(creator) - creatorTokBefore,
            creatorOwed,
            string.concat(a.sym, " L8: the creator's claim did not arrive")
        );
        // AND IT ARRIVED ONCE. A payout that moved both balances would pass
        // the check above while paying twice.
        assertEq(
            paysEther
                ? IERC20(a.quote).balanceOf(protocolRecipient) - platformTokBefore
                : protocolRecipient.balance - platformEthBefore,
            0,
            string.concat(a.sym, " L8: the platform was paid in both forms")
        );
        assertEq(
            paysEther ? IERC20(a.quote).balanceOf(creator) - creatorTokBefore : creator.balance - creatorEthBefore,
            0,
            string.concat(a.sym, " L8: the creator was paid in both forms")
        );

        _poolLeg(a, s, address(token));
        _e1(a);
    }

    /// L9, its own function for the same stack reason as E1.
    ///
    /// THE HOOK HAD NEVER RUN ON ANY OF THESE ASSETS. The lifecycle graduated
    /// each one and stopped; the pool fee was only ever charged on NVDAc, in
    /// B20Graduation. A buy here goes through the real PoolManager and the
    /// real hook, and each leg is counted where it can land: straight in the
    /// payee's balance, or as a debt in owed (every leg, on a WETH pool).
    function _poolLeg(Asset memory a, Stack memory s, address token) internal {
        LaunchRegistry.Launch memory rec = s.registry.launchOf(token);
        bool quoteIsC0 = a.quote < token;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(quoteIsC0 ? a.quote : token),
            currency1: Currency.wrap(quoteIsC0 ? token : a.quote),
            fee: rec.fee,
            tickSpacing: rec.tickSpacing,
            hooks: rec.hooks
        });
        uint256 base = a.threshold / 100 + 37; // non-round, so a floor and a ceiling differ
        PoolHarness h = new PoolHarness(POOL_MANAGER);
        _fund(a, address(h), base);

        uint256 platformBefore = IERC20(a.quote).balanceOf(protocolRecipient) + s.hook.owed(protocolRecipient, a.quote);
        uint256 creatorBefore = IERC20(a.quote).balanceOf(creator) + s.hook.owed(creator, a.quote);
        h.swap(key, quoteIsC0, -int256(base));
        uint256 platformGot =
            IERC20(a.quote).balanceOf(protocolRecipient) + s.hook.owed(protocolRecipient, a.quote) - platformBefore;
        uint256 creatorGot = IERC20(a.quote).balanceOf(creator) + s.hook.owed(creator, a.quote) - creatorBefore;

        assertEq(platformGot, (base * rec.platformBps) / 10_000, string.concat(a.sym, " L9: the platform leg is wrong"));
        assertEq(
            creatorGot,
            (base * (rec.totalTaxBps - rec.platformBps)) / 10_000,
            string.concat(a.sym, " L9: the creator leg is wrong")
        );
        assertGt(IERC20(token).balanceOf(address(h)), 0, string.concat(a.sym, " L9: the pool buy delivered nothing"));
    }

    /// E1, its own function: _lifecycle's locals and these would not fit one
    /// stack frame.
    function _e1(Asset memory a) internal {
        // ---- E1: the ETH route's absence, MEASURED rather than assumed.
        // MULTI_RWA.txt 2.2 says only NVDAc has a WETH pool holding anything.
        // If that ever stops being true this fails, and the one-hop route
        // becomes available for this asset - which is a thing to notice.
        // A FIRST VERSION OF THIS ASSERTED ZERO and GOOGLc failed it: its
        // WETH/1% pool exists and holds ONE RAW UNIT - 0.00000001 GOOGLc.
        // MULTI_RWA.txt 2.2 recorded exactly that and called it empty; the
        // assertion did not. "Zero" was the wrong criterion.
        //
        // THE CRITERION THAT MEANS SOMETHING: a route exists if it can supply
        // enough of the asset to enter a launch. A pool holding less than one
        // threshold cannot fill one at any price, so that is the bound - and it
        // is tied to a real quantity rather than to an epsilon somebody picked.
        // AND THE ABSENCE IS COUNTED, not left implicit. Five of these six have
        // no WETH pool at all, so a loop that only asserts inside an existing
        // pool would pass without measuring anything - which is the shape of a
        // test that proves nothing while looking thorough.
        //
        // AND ONLY FOR THE EQUITIES. It ran against WETH too, where
        // getPool(WETH, WETH, fee) is empty at every tier, the loop skipped
        // four times and a zero was logged as a measurement.
        if (!_ethRouteShouldBeAbsent(a.quote)) return;
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        uint256 poolsFound;
        uint256 usable;
        for (uint256 i = 0; i < tiers.length; i++) {
            address pool = IV3FactoryMinimal(V3_FACTORY).getPool(a.quote, WETH, tiers[i]);
            if (pool == address(0)) continue;
            poolsFound++;
            if (IERC20(a.quote).balanceOf(pool) >= a.threshold) usable++;
        }
        assertEq(
            usable, 0,
            string.concat(a.sym, " E1: a WETH pool holds a threshold's worth - the ETH route may exist")
        );
        emit log_named_uint(string.concat(a.sym, " E1: WETH pools that exist at all"), poolsFound);
    }


    /// THE FIXTURE'S THRESHOLDS ARE THE DEPLOYMENT'S, AND STAY THAT WAY.
    ///
    /// Every asset above claims to carry the figure DeployCurb would deploy it
    /// with. Five of six did not when this was written, which meant the whole
    /// lifecycle below - fill, graduate, trade - was proven against numbers
    /// nobody would ship, with a comment saying the opposite.
    ///
    /// COPYING THEM FIXES TODAY. This fixes the next time: a threshold changed
    /// in one file and not the other fails here rather than quietly testing
    /// something else.
    ///
    /// AND IN BOTH DIRECTIONS. It only asked whether each fixture asset was
    /// shipped, so an asset shipped without a fixture passed - which is how
    /// cbBTC, cbXRP and cbZEC went out with no launch, no graduation and no
    /// hook fee ever run against them; the lifecycle below now does all three
    /// (L9 is the hook). NVDAc is the one exception, and named: B20Graduation
    /// is built on it.
    ///
    /// AND EACH FIXTURE'S TEST IS NAMED HERE BY SELECTOR, in _fixtures() order.
    /// Deleting a lifecycle test then fails to compile, and a fixture added
    /// without one fails the count. It cannot check what a test's body passes
    /// to _lifecycle; the one-line bodies are there to be read.
    function test_theFixtureCarriesTheDeploymentsOwnThresholds() public onlyFork {
        DeployCurb.Asset[] memory shipped = new DepthProbe().assets();
        Asset[] memory mine = _fixtures();
        bytes4[13] memory named = [
            this.test_lifecycleOnWETH.selector,
            this.test_lifecycleOnUSDC.selector,
            this.test_lifecycleOnCbBTC.selector,
            this.test_lifecycleOnCbXRP.selector,
            this.test_lifecycleOnCbZEC.selector,
            this.test_lifecycleOnVIRTUAL.selector,
            this.test_lifecycleOnAERO.selector,
            this.test_lifecycleOnGOOGLc.selector,
            this.test_lifecycleOnSPCXc.selector,
            this.test_lifecycleOnAMZNc.selector,
            this.test_lifecycleOnMSFTc.selector,
            this.test_lifecycleOnAAPLc.selector,
            this.test_lifecycleOnMETAc.selector
        ];
        assertEq(named.length, mine.length, "a fixture has no named lifecycle test, or a test no fixture");
        address nvdac = 0xb20000000000000000000078ee7ce2fE4908108C;

        for (uint256 j = 0; j < shipped.length; j++) {
            if (shipped[j].quote == nvdac) continue;
            bool covered;
            for (uint256 i = 0; i < mine.length; i++) {
                if (mine[i].quote != shipped[j].quote) continue;
                covered = true;
                assertEq(
                    mine[i].decimals, shipped[j].decimals,
                    string.concat(shipped[j].label, ": this fixture and DeployCurb disagree on the decimals")
                );
            }
            assertTrue(covered, string.concat(shipped[j].label, ": DeployCurb ships it and nothing here launches it"));
        }

        for (uint256 i = 0; i < mine.length; i++) {
            bool found;
            for (uint256 j = 0; j < shipped.length; j++) {
                if (shipped[j].quote != mine[i].quote) continue;
                found = true;
                assertEq(
                    mine[i].threshold,
                    shipped[j].threshold,
                    string.concat(mine[i].sym, ": this fixture and DeployCurb disagree on the threshold")
                );
                // AND ON THE PHANTOM, which is its own figure since the
                // 2026-10-03 shape: the threshold alone no longer says where a
                // launch starts or what it burns.
                assertEq(
                    mine[i].phantom,
                    shipped[j].phantomQuote,
                    string.concat(mine[i].sym, ": this fixture and DeployCurb disagree on the phantom")
                );
            }
            assertTrue(found, string.concat(mine[i].sym, ": DeployCurb does not list this asset at all"));
        }
    }

    // ================================================================
    // THE DEPLOYMENT'S OWN DEPTH CHECK
    // ================================================================

    /// THE CLAIM IN DeployCurb IS CHECKED AGAINST THE CHAIN, AND AT THIS BLOCK
    /// ONE OF THEM IS WRONG.
    ///
    /// The list has always been sorted by hand into "fillable today: the
    /// deepest pool covers a threshold" and "listed, and short of liquidity",
    /// against measurements taken on the day. SPCXc's note says what that is
    /// worth: "It passed the bar when the table was written and does not now,
    /// which is the whole argument for measuring at deployment rather than
    /// trusting a number in a file."
    ///
    /// SO THE PINNED BLOCK IS THE RIGHT FIXTURE for this, precisely because it
    /// is not today's market. NVDAc can supply a threshold here and cbZEC
    /// cannot - its two pools hold 4.81 and 7.55 against its threshold - and
    /// live Base on 2026-10-15 says the reverse of both: NVDAc's best pool
    /// holds 0.65 of a threshold and cbZEC's 7.46 thresholds, so the file now
    /// calls NVDAc thin and cbZEC fillable. A check that could not tell them
    /// apart would be worth nothing. (The size history: D1's cbZEC threshold
    /// of 8.2 was past both pools here, the 2026-10-03 shape's 6.68 was not -
    /// the 7.55 pool priced it at 3.29 ETH, measured - and the 2026-10-15
    /// price's 9.20 was past them again, as is the 8.74 cbZEC was re-priced
    /// to that evening; its best pool then held 5.50 thresholds of it.)
    function test_theDeploymentPricesOneThresholdWhereTheMarketCan() public onlyFork {
        DepthProbe probe = new DepthProbe();

        uint256 nvdac = probe.cost(0xb20000000000000000000078ee7ce2fE4908108C, probe.thresholdOf("NVDAc"));
        assertGt(nvdac, 0, "no route could price a threshold of NVDAc at the pinned block");

        // AND IT IS A PRICE, NOT A FLAG. Five and a half ether for sixty NVDAc
        // is the order of magnitude the survey measured; a check returning some
        // non-zero token would pass the line above and mean nothing.
        assertGt(nvdac, 1 ether, "the quoted cost is too small to be a real price");
        assertLt(nvdac, 100 ether, "the quoted cost is too large to be a real price");
    }

    function test_theDeploymentFindsNoRouteWhereThereIsNone() public onlyFork {
        DepthProbe probe = new DepthProbe();
        // cbZEC AT ITS SHIPPED 8.74 (re-priced 2026-10-15 21:25 UTC, from the
        // 9.20 of that afternoon), more than either of its pools holds at this
        // block - and at D1's 8.2, which was the size named here while the
        // shipped threshold sat under the line.
        assertEq(probe.thresholdOf("cbZEC"), 8.74e8, "the premise moved: cbZEC does not ship at 8.74");
        assertEq(
            probe.cost(0xB2000000000000000000008501b13360000cb2EC, probe.thresholdOf("cbZEC")),
            0,
            "a route priced cbZEC's shipped 8.74, which its pools cannot supply at this block"
        );
        assertEq(
            probe.cost(0xB2000000000000000000008501b13360000cb2EC, 8.2e8),
            0,
            "a route priced 8.2 cbZEC, which its pools cannot supply at this block"
        );
        // AND UNDER THE LINE IT IS A PRICE: the 2026-10-03 shape's 6.68, which
        // the 7.55 pool can supply. Without this the two zeros above would
        // also pass against a quoter that answered nothing at all.
        assertGt(
            probe.cost(0xB2000000000000000000008501b13360000cb2EC, 6.68e8),
            0,
            "no route priced 6.68 cbZEC, which its deeper pool can supply at this block"
        );
    }

    /// AND A CLAIM THE CHAIN CONTRADICTS STOPS A REAL DEPLOYMENT.
    ///
    /// Not a demo: CURB_DEMO_LAUNCH already means "not a real chain" in that
    /// file, and a pinned fork is a different market from the one a deployment
    /// meets. What must never pass quietly is the file saying an asset is
    /// fillable while the chain it is being deployed to says otherwise.
    function test_aClaimTheChainContradictsStopsTheDeployment() public onlyFork {
        DepthProbe probe = new DepthProbe();
        vm.expectRevert(bytes("cbZEC: this file calls it fillable and no route can price one threshold on this chain"));
        probe.claim(0xB2000000000000000000008501b13360000cb2EC, 8.2e8, "cbZEC", true, false);

        // AND A DEMO DOES NOT EVEN ASK. A pinned fork is a different market
        // from the one a deployment meets, and every quoter call is a
        // simulation that fetches state upstream - with this running on the
        // browser fixture's two deployments the setup went from two minutes to
        // over ten, for an answer about the wrong chain.
        probe.claim(0xB2000000000000000000008501b13360000cb2EC, 8.2e8, "cbZEC", true, true);

        // AND AN ASSET MAKING NO CLAIM IS NOT PRICED AT ALL, which is why a
        // list full of thin assets does not cost a deployment twenty quoter
        // simulations each.
        probe.claim(0xB2000000000000000000008501b13360000cb2EC, 8.2e8, "cbZEC", false, false);
    }

    // ================================================================
    // THE QUOTE ASSET'S SCALE - PONS's floor, and why it is not free
    // ================================================================

    /// PONS refuses a pair token below six decimals because the fee is integer
    /// basis points of the quote leg: on a coarse asset every trade below
    /// 10_000/feeBps base units rounds its fee to zero and one order splits
    /// into fee-free pieces. Our curve does the same arithmetic.
    ///
    /// EVERY B20 EQUITY CARRIES 8, so none of this bites today. That is the
    /// argument for adding it now rather than against it.

    function test_thefactoryTakesASixDecimalAsset() public onlyFork {
        // USDC, a real six-decimal asset - the floor itself, not one above it.
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        assertEq(IDecimalsView(usdc).decimals(), 6, "USDC is not six decimals any more");
        Asset memory a = Asset(usdc, "USDC", 1000e6, 1000e6, address(0), 6);
        Stack memory s = _stackFor(a);
        assertEq(s.factory.quoteToken(), usdc, "the factory did not take a six-decimal asset");
    }

    function test_thefactoryRefusesACoarserAsset() public onlyFork {
        address coarse = address(new CoarseToken());
        Asset memory a = Asset(coarse, "COARSE", 1000, 1000, address(0), 4);
        (Stack memory s2, IPonsV2FeePolicy policy, PonsV2BuybackVault vault) = _stackWithoutFactory(a);
        vm.expectRevert(
            abi.encodeWithSelector(
                CurbLaunchFactory.QuoteDecimalsTooFew.selector, coarse, uint8(4), uint8(6)
            )
        );
        _factoryOn(s2, policy, vault, a);
    }

    /// AND A FIGURE SIZED FOR ANOTHER ASSET IS REFUSED, which is the half of
    /// PONS's guard we did not have until 2026-09-23. setPairTokenEconomics
    /// takes the scale the caller sized its figures against and
    /// _requireDecimals refuses an asset that reports anything else - "the one
    /// guard against reusing an 18-decimal configuration on a 6-decimal asset,
    /// which would otherwise misprice silently by twelve orders of magnitude".
    ///
    /// NEITHER OF THE OTHER TWO CHECKS CAN CATCH THIS. The asset answers, and
    /// it is well above the floor; the only thing wrong with the number beside
    /// it is that it was written for a different token. Eighteen against an
    /// eight-decimal equity is exactly what reusing the WETH row would look
    /// like, and the fourteen thresholds in DeployCurb are hand-sized per asset.
    function test_thefactoryRefusesAThresholdSizedForAnotherAsset() public onlyFork {
        Asset memory a = _googl();
        a.decimals = 18;
        (Stack memory s2, IPonsV2FeePolicy policy, PonsV2BuybackVault vault) = _stackWithoutFactory(a);
        vm.expectRevert(
            abi.encodeWithSelector(
                CurbLaunchFactory.QuoteDecimalsMismatch.selector, a.quote, uint8(18), uint8(8)
            )
        );
        _factoryOn(s2, policy, vault, a);
    }

    function test_thefactoryRefusesAnAssetThatWillNotSayItsScale() public onlyFork {
        address silent = address(new SilentToken());
        Asset memory a = Asset(silent, "QUIET", 1000, 1000, address(0), 18);
        (Stack memory s2, IPonsV2FeePolicy policy, PonsV2BuybackVault vault) = _stackWithoutFactory(a);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.QuoteDecimalsUnreadable.selector, silent));
        _factoryOn(s2, policy, vault, a);
    }

    function test_lifecycleOnWETH() public onlyFork { _lifecycle(_weth()); }
    function test_lifecycleOnUSDC() public onlyFork { _lifecycle(_usdc()); }
    function test_lifecycleOnVIRTUAL() public onlyFork { _lifecycle(_virtual()); }
    function test_lifecycleOnAERO() public onlyFork { _lifecycle(_aero()); }
    function test_lifecycleOnSPCXc() public onlyFork { _lifecycle(_spcx()); }
    function test_lifecycleOnGOOGLc() public onlyFork { _lifecycle(_googl()); }
    function test_lifecycleOnAMZNc() public onlyFork { _lifecycle(_amzn()); }
    function test_lifecycleOnMSFTc() public onlyFork { _lifecycle(_msft()); }
    function test_lifecycleOnAAPLc() public onlyFork { _lifecycle(_aapl()); }
    function test_lifecycleOnMETAc() public onlyFork { _lifecycle(_meta()); }
    function test_lifecycleOnCbBTC() public onlyFork { _lifecycle(_cbbtc()); }

    /// THE DEPLOYMENT'S RECIPIENT CHECK TELLS ONE KEY FROM A CONTRACT - an
    /// EIP-7702-delegated EOA included - and a contract that is not a Safe
    /// needs saying. Both used to pass: the first as "a contract", the second
    /// with a warning nothing enforced.
    function test_theDeploymentsRecipientCheckKnowsAKeyFromASafe() public onlyFork {
        DepthProbe probe = new DepthProbe();
        address delegated = makeAddr("an EOA with a 7702 delegation");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        vm.expectRevert(
            bytes(
                "CURB_PLATFORM_RECIPIENT is one key (no code, or only an EIP-7702 delegation). A6 asks for a Safe. "
                "If that is really intended, set CURB_ALLOW_EOA_RECIPIENT=true."
            )
        );
        probe.recipientKind(delegated, false, false);
        probe.recipientKind(delegated, true, false); // said out loud: accepted

        // A PLAIN KEY is refused the same way, and a REAL SAFE - the kind A6
        // recommends - passes with no override at all. Neither was tested, so a
        // check that refused every Safe stayed green.
        address plainKey = makeAddr("a plain EOA recipient");
        vm.expectRevert(
            bytes(
                "CURB_PLATFORM_RECIPIENT is one key (no code, or only an EIP-7702 delegation). A6 asks for a Safe. "
                "If that is really intended, set CURB_ALLOW_EOA_RECIPIENT=true."
            )
        );
        probe.recipientKind(plainKey, false, false);
        (ISafe safe,,) = _deploySafe();
        probe.recipientKind(address(safe), false, false);

        address notASafe = address(new SilentToken());
        vm.expectRevert(
            bytes(
                "CURB_PLATFORM_RECIPIENT has code but does not answer getOwners/getThreshold. "
                "If that contract is really intended, set CURB_ALLOW_NON_SAFE_RECIPIENT=true."
            )
        );
        probe.recipientKind(notASafe, false, false);
        probe.recipientKind(notASafe, false, true); // said out loud: accepted
    }

    /// THE POLICY OWNER IS CLASSIFIED LIKE THE RECIPIENT. It used to be checked
    /// only for zero and for equality with the recipient, so a typo - a
    /// code-less address nobody controls - became the hook's Ownable2Step owner
    /// with no opt-in, and the platform's share and recipient could never be
    /// moved again. One key, a 7702-delegated key and a contract that is not a
    /// Safe each need saying; a real Safe needs nothing.
    function test_theDeploymentsPolicyOwnerCheckKnowsAKeyFromASafe() public onlyFork {
        DepthProbe probe = new DepthProbe();
        address recipient = makeAddr("some other recipient");
        bytes memory oneKey = bytes(
            "CURB_POLICY_OWNER is one key (no code, or only an EIP-7702 delegation). DEPLOY.txt decision 3 asks for a Safe. "
            "If that is really intended, set CURB_ALLOW_EOA_POLICY_OWNER=true."
        );

        address typo = makeAddr("a mistyped policy owner nobody controls");
        vm.expectRevert(oneKey);
        probe.policyOwnerCheck(typo, recipient, false, false, false);
        probe.policyOwnerCheck(typo, recipient, false, true, false); // said out loud: accepted

        address delegated = makeAddr("a policy owner with a 7702 delegation");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0xBEEF)));
        vm.expectRevert(oneKey);
        probe.policyOwnerCheck(delegated, recipient, false, false, false);

        // THE RECIPIENT'S OPT-INS DO NOT COVER THE OWNER. Two roles, two
        // decisions: a run that allowed an EOA recipient has not said anything
        // about the owner.
        vm.expectRevert(oneKey);
        probe.policyOwnerCheck(typo, recipient, true, false, true);

        (ISafe safe,,) = _deploySafe();
        probe.policyOwnerCheck(address(safe), recipient, false, false, false);

        address notASafe = address(new SilentToken());
        vm.expectRevert(
            bytes(
                "CURB_POLICY_OWNER has code but does not answer getOwners/getThreshold. "
                "If that contract is really intended, set CURB_ALLOW_NON_SAFE_POLICY_OWNER=true."
            )
        );
        probe.policyOwnerCheck(notASafe, recipient, false, false, false);
        probe.policyOwnerCheck(notASafe, recipient, false, false, true); // said out loud: accepted

        vm.expectRevert(bytes("CURB_POLICY_OWNER must not be the zero address"));
        probe.policyOwnerCheck(address(0), recipient, false, true, true);
    }

    /// ONE ADDRESS FOR BOTH ROLES IS REFUSED UNLESS SAID - in the script, not
    /// only in the preflight. The preflight's comparison is bypassed whenever
    /// the script is run directly, and deleting the script's require left
    /// every test green.
    function test_theDeploymentRefusesARecipientThatIsAlsoThePolicyOwnerUnlessSaid() public onlyFork {
        DepthProbe probe = new DepthProbe();
        (ISafe safe,,) = _deploySafe();
        vm.expectRevert(
            bytes("CURB_POLICY_OWNER is the platform recipient. Set CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true if intended.")
        );
        probe.policyOwnerCheck(address(safe), address(safe), false, false, false);
        probe.policyOwnerCheck(address(safe), address(safe), true, false, false); // said out loud: accepted
        // Different addresses need nothing said.
        probe.policyOwnerCheck(address(safe), makeAddr("a separate recipient"), false, false, false);
    }

    /// AND run() ITSELF ASKS, from the environment the operator sets. The two
    /// tests above drive the checks through the probe, so deleting the call
    /// from run() - or reading the wrong variable into it - left both green
    /// while the real entry point asked nothing. This runs the script's own
    /// run() with each mistake and expects the refusal before anything is
    /// deployed.
    ///
    /// THE VARIABLES ARE SET ON THE WHOLE PROCESS, which is why the checks are
    /// otherwise driven with plain arguments. This is the only test that sets
    /// or reads CURB_*: every other one goes through the probe. ONE TEST, NOT
    /// TWO: forge runs a contract's tests in parallel, and a second test
    /// setting an opt-in to "true" could land between this one's setEnv and
    /// its run().
    ///
    /// REFUSALS ALONE COULD NOT SEE A WRONG VARIABLE. With every opt-in
    /// "false", run() reading one opt-in into another's slot still refuses
    /// with the same string; _eachOptInClearsOnlyItsOwnRefusal below is what
    /// catches that.
    function test_theDeploymentsRunAsksTheRecipientAndOwnerQuestionsFromTheEnvironment() public onlyFork {
        (ISafe safe,,) = _deploySafe();
        DeployCurb script = new DeployCurb();
        vm.setEnv("CURB_PLATFORM_RECIPIENT", vm.toString(address(safe)));
        vm.setEnv("CURB_ALLOW_EOA_RECIPIENT", "false");
        vm.setEnv("CURB_ALLOW_NON_SAFE_RECIPIENT", "false");
        vm.setEnv("CURB_ALLOW_EOA_POLICY_OWNER", "false");
        vm.setEnv("CURB_ALLOW_NON_SAFE_POLICY_OWNER", "false");
        vm.setEnv("CURB_ALLOW_SAME_RECIPIENT_AND_OWNER", "false");
        vm.setEnv("CURB_DEMO_LAUNCH", "false");
        // THE HOLDER SHARING ROLES a real run must name, set right here so the
        // cases below stop where they mean to (_eachSharingRoleIsAskedFromItsOwnVariable
        // breaks them one at a time).
        _sharingRoles(SHARING_PUBLISHER, SHARING_KEEPER, vm.toString(SHARING_GUARDIAN));

        // A MISTYPED OWNER, with a correct Safe as the recipient.
        vm.setEnv("CURB_POLICY_OWNER", vm.toString(makeAddr("a mistyped policy owner nobody controls")));
        vm.expectRevert(
            bytes(
                "CURB_POLICY_OWNER is one key (no code, or only an EIP-7702 delegation). DEPLOY.txt decision 3 asks for a Safe. "
                "If that is really intended, set CURB_ALLOW_EOA_POLICY_OWNER=true."
            )
        );
        script.run();

        // ONE ADDRESS FOR BOTH ROLES, nothing said.
        vm.setEnv("CURB_POLICY_OWNER", vm.toString(address(safe)));
        vm.expectRevert(
            bytes("CURB_POLICY_OWNER is the platform recipient. Set CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true if intended.")
        );
        script.run();

        // A MISTYPED RECIPIENT is asked about first, whatever the owner is.
        vm.setEnv("CURB_PLATFORM_RECIPIENT", vm.toString(makeAddr("a mistyped platform recipient")));
        vm.expectRevert(
            bytes(
                "CURB_PLATFORM_RECIPIENT is one key (no code, or only an EIP-7702 delegation). A6 asks for a Safe. "
                "If that is really intended, set CURB_ALLOW_EOA_RECIPIENT=true."
            )
        );
        script.run();

        _eachOptInClearsOnlyItsOwnRefusal(script, address(safe));
        _eachSharingRoleIsAskedFromItsOwnVariable(script, address(safe));
    }

    address internal constant SHARING_PUBLISHER = address(0x5AA1);
    address internal constant SHARING_KEEPER = address(0x5AA2);
    address internal constant SHARING_GUARDIAN = address(0x5AA3);

    /// The three sharing variables run() reads, in one call so no case forgets one.
    function _sharingRoles(address publisher, address keeper, string memory vetoers) internal {
        vm.setEnv("CURB_SHARING_PUBLISHER", vm.toString(publisher));
        vm.setEnv("CURB_SHARING_KEEPER_PAYEE", vm.toString(keeper));
        vm.setEnv("CURB_SHARING_VETOERS", vetoers);
    }

    /// EACH SHARING ROLE IS READ FROM ITS OWN VARIABLE, by run() itself, before
    /// anything is priced or sent. The checks are driven with plain arguments
    /// in test/DeployCurbChecks.t.sol; this is what shows run() asks them, with
    /// the right variable in each slot: a publisher read from the keeper
    /// payee's variable would let the "a vetoer is the publisher" case through,
    /// and a zero in one variable must name that variable.
    ///
    /// "GOT PAST" IS THE SAME MARKER AS ABOVE: the v3 factory's getPool, the
    /// first external call after the checks, mocked to revert.
    function _eachSharingRoleIsAskedFromItsOwnVariable(DeployCurb script, address safe) internal {
        address otherSafe = address(new SafeShapedStub());
        bytes memory past = abi.encodeWithSignature("Error(string)", "run() got past both checks");
        vm.mockCallRevert(V3_FACTORY, abi.encodeWithSelector(IV3FactoryMinimal.getPool.selector), past);
        _optIns(false, false, false, false, false);
        vm.setEnv("CURB_PLATFORM_RECIPIENT", vm.toString(safe));
        vm.setEnv("CURB_POLICY_OWNER", vm.toString(otherSafe));

        // ALL THREE NAMED: past (the control for every case below).
        _sharingRoles(SHARING_PUBLISHER, SHARING_KEEPER, vm.toString(SHARING_GUARDIAN));
        vm.expectRevert(past);
        script.run();

        // A ZERO PUBLISHER, and only the publisher's variable says so.
        _sharingRoles(address(0), SHARING_KEEPER, vm.toString(SHARING_GUARDIAN));
        vm.expectRevert(
            bytes(
                "CURB_SHARING_PUBLISHER is not set (or is the zero address). It is the key that proposes holder payouts; a real deployment names it."
            )
        );
        script.run();

        // A ZERO KEEPER PAYEE.
        _sharingRoles(SHARING_PUBLISHER, address(0), vm.toString(SHARING_GUARDIAN));
        vm.expectRevert(
            bytes(
                "CURB_SHARING_KEEPER_PAYEE is not set (or is the zero address). It receives the keeper's gas fee; a real deployment names it."
            )
        );
        script.run();

        // A VETOER THAT IS THE PUBLISHER - with the keeper payee as the
        // control: the same address as a vetoer and as the payee is allowed.
        _sharingRoles(SHARING_PUBLISHER, SHARING_KEEPER, vm.toString(SHARING_PUBLISHER));
        vm.expectRevert(
            bytes("a CURB_SHARING_VETOERS entry is the publisher. A vetoer is there to stop the publisher's payouts.")
        );
        script.run();
        _sharingRoles(SHARING_PUBLISHER, SHARING_KEEPER, vm.toString(SHARING_KEEPER));
        vm.expectRevert(past);
        script.run();

        // THE POLICY OWNER IN THE LIST: the owner run() read, not another.
        _sharingRoles(
            SHARING_PUBLISHER, SHARING_KEEPER, string.concat(vm.toString(SHARING_GUARDIAN), ",", vm.toString(otherSafe))
        );
        vm.expectRevert(
            bytes(
                "a CURB_SHARING_VETOERS entry is the policy owner, which is a vetoer already. Name the separate vetoers there."
            )
        );
        script.run();

        // TWO VETOERS, comma-separated, are both read: the second one repeated
        // is refused.
        _sharingRoles(
            SHARING_PUBLISHER,
            SHARING_KEEPER,
            string.concat(vm.toString(SHARING_GUARDIAN), ",", vm.toString(SHARING_GUARDIAN))
        );
        vm.expectRevert(bytes("CURB_SHARING_VETOERS names one address twice"));
        script.run();

        // THE UNCHANGED CODE IS ASKED BY run() ITSELF, after the roles and
        // before anything is priced: a script whose escrow pin is wrong stops
        // there, naming the escrow, and never reaches the marker.
        _sharingRoles(SHARING_PUBLISHER, SHARING_KEEPER, vm.toString(SHARING_GUARDIAN));
        WrongEscrowPin wrongPin = new WrongEscrowPin();
        vm.expectRevert(
            bytes(
                string.concat(
                    "FeeEscrow.sol:FeeEscrow builds to code identity ",
                    vm.toString(wrongPin.identityOf(vm.getDeployedCode("FeeEscrow.sol:FeeEscrow"))),
                    ", not the pinned ",
                    vm.toString(bytes32(uint256(1))),
                    ": its code changed. Core v2 leaves it unchanged; if the change is meant, update its IDENTITY_ constant."
                )
            )
        );
        wrongPin.run();
        vm.clearMockedCalls();
    }

    /// EACH OPT-IN CLEARS ITS OWN REFUSAL AND NO OTHER, read by run() itself.
    ///
    /// The refusals above set every opt-in to "false", so run() reading
    /// CURB_ALLOW_EOA_RECIPIENT into the policy owner's EOA slot, swapping two
    /// of the owner's three, or passing a literal false all left the test
    /// green - while its doc said it closed "reading the wrong variable". The
    /// first of those is a live leak: the local runners allow an EOA recipient,
    /// and that would silently allow a one-key policy owner.
    ///
    /// So for each of the five refusals, first EVERY OPT-IN BUT THE RIGHT ONE
    /// is set to "true" (the refusal must stay), then ONLY the right one (run()
    /// must get past both checks).
    ///
    /// "GOT PAST BOTH CHECKS" IS A DISTINCT REVERT, not a deployment. The next
    /// thing run() does after the two checks is the depth check, whose first
    /// external call outside a try is the v3 factory's getPool; mocking that to
    /// revert with a marker stops run() there, before anything is broadcast.
    /// CURB_DEMO_LAUNCH is "false" so the depth check is not skipped.
    function _eachOptInClearsOnlyItsOwnRefusal(DeployCurb script, address safe) internal {
        // A SECOND SAFE-SHAPED OWNER. _deploySafe cannot make a second real
        // one (same initializer, same nonce: the CREATE2 address is taken),
        // and the check asks only getThreshold and getOwners.
        address otherSafe = address(new SafeShapedStub());
        address oneKey = makeAddr("a one-key address");
        address notASafe = address(new SilentToken());
        bytes memory past = abi.encodeWithSignature("Error(string)", "run() got past both checks");
        vm.mockCallRevert(V3_FACTORY, abi.encodeWithSelector(IV3FactoryMinimal.getPool.selector), past);

        // THE MARKER IS REACHABLE: every opt-in "false" and two different
        // Safe-shaped addresses need nothing said. Without this, every "past"
        // below could be a refusal the test cannot see.
        _optIns(false, false, false, false, false);
        vm.setEnv("CURB_PLATFORM_RECIPIENT", vm.toString(safe));
        vm.setEnv("CURB_POLICY_OWNER", vm.toString(otherSafe));
        vm.expectRevert(past);
        script.run();

        // A ONE-KEY POLICY OWNER. No other opt-in covers it - the recipient's EOA
        // opt-in above all, the leak the doc names; the owner's own does.
        vm.setEnv("CURB_POLICY_OWNER", vm.toString(oneKey));
        _optIns(true, true, false, true, true); // everything BUT the owner's EOA opt-in
        vm.expectRevert(
            bytes(
                "CURB_POLICY_OWNER is one key (no code, or only an EIP-7702 delegation). DEPLOY.txt decision 3 asks for a Safe. "
                "If that is really intended, set CURB_ALLOW_EOA_POLICY_OWNER=true."
            )
        );
        script.run();
        _optIns(false, false, true, false, false);
        vm.expectRevert(past);
        script.run();

        // A POLICY OWNER THAT IS NOT SAFE-SHAPED.
        vm.setEnv("CURB_POLICY_OWNER", vm.toString(notASafe));
        _optIns(true, true, true, false, true); // everything BUT the owner's non-Safe opt-in
        vm.expectRevert(
            bytes(
                "CURB_POLICY_OWNER has code but does not answer getOwners/getThreshold. "
                "If that contract is really intended, set CURB_ALLOW_NON_SAFE_POLICY_OWNER=true."
            )
        );
        script.run();
        _optIns(false, false, false, true, false);
        vm.expectRevert(past);
        script.run();

        // ONE ADDRESS FOR BOTH ROLES.
        vm.setEnv("CURB_POLICY_OWNER", vm.toString(safe));
        _optIns(true, true, true, true, false); // everything BUT the same-address opt-in
        vm.expectRevert(
            bytes("CURB_POLICY_OWNER is the platform recipient. Set CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true if intended.")
        );
        script.run();
        _optIns(false, false, false, false, true);
        vm.expectRevert(past);
        script.run();

        // A ONE-KEY RECIPIENT. No other opt-in covers it, the owner's EOA one included.
        vm.setEnv("CURB_POLICY_OWNER", vm.toString(otherSafe));
        vm.setEnv("CURB_PLATFORM_RECIPIENT", vm.toString(oneKey));
        _optIns(false, true, true, true, true); // everything BUT the recipient's EOA opt-in
        vm.expectRevert(
            bytes(
                "CURB_PLATFORM_RECIPIENT is one key (no code, or only an EIP-7702 delegation). A6 asks for a Safe. "
                "If that is really intended, set CURB_ALLOW_EOA_RECIPIENT=true."
            )
        );
        script.run();
        _optIns(true, false, false, false, false);
        vm.expectRevert(past);
        script.run();

        // A RECIPIENT THAT IS NOT SAFE-SHAPED.
        vm.setEnv("CURB_PLATFORM_RECIPIENT", vm.toString(notASafe));
        _optIns(true, false, true, true, true); // everything BUT the recipient's non-Safe opt-in
        vm.expectRevert(
            bytes(
                "CURB_PLATFORM_RECIPIENT has code but does not answer getOwners/getThreshold. "
                "If that contract is really intended, set CURB_ALLOW_NON_SAFE_RECIPIENT=true."
            )
        );
        script.run();
        _optIns(false, true, false, false, false);
        vm.expectRevert(past);
        script.run();

        // NOTHING "true" IS LEFT ON THE PROCESS for whatever runs after.
        _optIns(false, false, false, false, false);
        vm.clearMockedCalls();
    }

    /// The five opt-ins run() reads, in one call so no case forgets one.
    function _optIns(bool eoaRecipient, bool nonSafeRecipient, bool eoaOwner, bool nonSafeOwner, bool same)
        internal
    {
        vm.setEnv("CURB_ALLOW_EOA_RECIPIENT", eoaRecipient ? "true" : "false");
        vm.setEnv("CURB_ALLOW_NON_SAFE_RECIPIENT", nonSafeRecipient ? "true" : "false");
        vm.setEnv("CURB_ALLOW_EOA_POLICY_OWNER", eoaOwner ? "true" : "false");
        vm.setEnv("CURB_ALLOW_NON_SAFE_POLICY_OWNER", nonSafeOwner ? "true" : "false");
        vm.setEnv("CURB_ALLOW_SAME_RECIPIENT_AND_OWNER", same ? "true" : "false");
    }
    function test_lifecycleOnCbXRP() public onlyFork { _lifecycle(_cbxrp()); }

    /// THE DEV BUY CAP IS A FIFTH OF THE SUPPLY ON EVERY ASSET, in tokens: the
    /// largest dev buy whose tokens stay within it goes through, and one unit
    /// of the asset more is refused with what it would have received. WETH
    /// (18 decimals) and cbXRP (6, the factory's floor) here; NVDAc (8) is
    /// B20Graduation's test_devBuy_theCapIsAFifthOfTheSupply.
    function test_devBuyCapOnWETH() public onlyFork { _devBuyCap(_weth()); }
    function test_devBuyCapOnCbXRP() public onlyFork { _devBuyCap(_cbxrp()); }

    /// The line is found by replaying the curve's buy on an untouched curve of
    /// the same stack (DevBuyCap); the launch's own delivery is checked against
    /// the replay, so a replay that drifted fails here. And the quote at the
    /// line is a quarter of the asset's phantom, grossed up by the tax: a net
    /// q buys N * q / (V + q) of the supply, and a fifth of N is q = V / 4.
    function _devBuyCap(Asset memory a) internal {
        Stack memory s = _stackFor(a);
        assertEq(s.factory.MAX_DEV_BUY_BPS(), 2000, "the cap is not a fifth of the supply");
        uint256 cap = (SUPPLY * 2000) / 10_000;

        CurbLaunchFactory.LaunchConfig memory cfg = _configFor(s.factory, 1);
        vm.prank(creator);
        (, PonsV2BondingCurve fresh) = s.factory.launch(cfg);
        uint256 atCap = DevBuyCap.largest(fresh, cap, a.threshold);
        uint256 over = DevBuyCap.tokensOut(fresh, atCap + 1);
        assertGt(over, cap, string.concat(a.sym, ": one unit more does not cross the cap"));
        assertApproxEqRel(
            atCap, (a.phantom * 10_000) / (4 * (10_000 - uint256(TOTAL_TAX_BPS))), 0.001e18,
            string.concat(a.sym, ": the cap does not cost a quarter of the phantom, grossed up by the tax")
        );
        emit log_named_decimal_uint(string.concat(a.sym, ": the largest dev buy"), atCap, a.decimals);

        _fund(a, creator, atCap * 2 + 1);
        cfg = _configFor(s.factory, 2);
        cfg.devBuy = atCap + 1;
        vm.startPrank(creator);
        SafeERC20.forceApprove(IERC20(a.quote), address(s.factory), atCap + 1);
        vm.expectRevert(abi.encodeWithSelector(CurbLaunchFactory.DevBuyAboveShare.selector, over, cap, uint16(2000)));
        s.factory.launch(cfg);

        uint256 before = IERC20(a.quote).balanceOf(creator);
        cfg.devBuy = atCap;
        SafeERC20.forceApprove(IERC20(a.quote), address(s.factory), atCap);
        (CurbLaunchToken token, PonsV2BondingCurve curve) = s.factory.launch(cfg);
        vm.stopPrank();

        uint256 bought = token.balanceOf(creator);
        assertEq(before - IERC20(a.quote).balanceOf(creator), atCap, string.concat(a.sym, ": not spent in full"));
        assertEq(bought, DevBuyCap.tokensOut(fresh, atCap), string.concat(a.sym, ": delivered other than the replay"));
        assertLe(bought, cap, string.concat(a.sym, ": the largest legal dev buy received more than a fifth"));
        assertGe((bought * 10_000) / SUPPLY, 1999, string.concat(a.sym, ": the largest legal dev buy is not about a fifth"));
        assertFalse(curve.graduated(), string.concat(a.sym, ": the largest legal dev buy graduated the launch"));
    }
    function test_lifecycleOnCbZEC() public onlyFork { _lifecycle(_cbzec()); }

    /// TWO GRADUATIONS ON ONE STACK, AGAINST A USDT-SHAPED QUOTE.
    ///
    /// FIRST: a raw approve fails here at once - the token returns nothing to
    /// decode. SECOND: the overwrite. The graduator spends the quote to zero,
    /// so it never leaves an allowance by itself; this used to claim the second
    /// graduation wrote non-zero over non-zero when it wrote over zero. So the
    /// premise is asserted, and then a stale allowance is left by hand - which
    /// only forceApprove's reset gets past.
    function test_twoGraduationsOnOneStackAgainstAUsdtShapedQuote() public onlyFork {
        UsdtShapedToken usdt = new UsdtShapedToken();
        Asset memory a = Asset(address(usdt), "USDTS", 10_000e6, 10_000e6, address(this), 6);
        usdt.mint(address(this), 100_000e6);
        Stack memory s = _stackFor(a);

        assertTrue(_launchAndFill(s, a, 1), "the first graduation on a USDT-shaped quote failed");

        assertEq(
            usdt.allowance(address(s.graduator), address(PERMIT2)), 0,
            "the first graduation left a quote allowance - this test's premise changed, re-read Graduator._mint"
        );
        vm.prank(address(s.graduator));
        usdt.approve(address(PERMIT2), 1);

        assertTrue(_launchAndFill(s, a, 2), "the SECOND graduation, over a stale allowance, failed");
    }

    /// THE ASSET'S DECIMALS ARE CHECKED AT EVERY LAUNCH, NOT ONLY WHEN THE
    /// FACTORY IS BUILT. An upgradeable asset can change them afterwards, and
    /// every curve after that would price against a figure written for the old
    /// scale. PONS re-checks at launch for exactly this; now so does this.
    function test_aLaunchIsRefusedWhenTheAssetsDecimalsChangedAfterTheFactory() public onlyFork {
        UsdtShapedToken t = new UsdtShapedToken();
        Asset memory a = Asset(address(t), "USDTS", 10_000e6, 10_000e6, address(this), 6);
        Stack memory s = _stackFor(a);
        t.setDecimals(18);

        CurbLaunchFactory.LaunchConfig memory cfg = _configFor(s.factory, 1);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(CurbLaunchFactory.QuoteDecimalsMismatch.selector, address(t), uint8(6), uint8(18))
        );
        s.factory.launch(cfg);
    }

    function _configFor(CurbLaunchFactory f, uint256 n)
        internal
        view
        returns (CurbLaunchFactory.LaunchConfig memory cfg)
    {
        (uint16 expectBps, address expectTo) = f.currentPlatformPolicy();
        cfg.name = "Curb Launch";
        cfg.symbol = "CURBL";
        cfg.salt = bytes32(n);
        cfg.quoteRefundTo = refundTo;
        cfg.totalTaxBps = TOTAL_TAX_BPS;
        cfg.expectedPlatformBps = expectBps;
        cfg.expectedPlatformRecipient = expectTo;
    }

    /// One launch on `s`, bought through its threshold. Split out so the
    /// config literal is not on the same stack as the test's own locals.
    function _launchAndFill(Stack memory s, Asset memory a, uint256 n) internal returns (bool) {
        CurbLaunchFactory.LaunchConfig memory cfg = _configFor(s.factory, n);
        vm.prank(creator);
        (, PonsV2BondingCurve curve) = s.factory.launch(cfg);
        _fund(a, trader, a.threshold * 2);
        vm.startPrank(trader);
        SafeERC20.forceApprove(IERC20(a.quote), address(curve), type(uint256).max);
        curve.buy(a.threshold * 2, 0, trader);
        vm.stopPrank();
        return curve.graduated();
    }
}


/// DeployCurb WITH THE ESCROW'S PIN WRONG, so run() can be seen to ask it.
contract WrongEscrowPin is DeployCurb {
    function pinnedCode() internal view override returns (string[5] memory artifacts, bytes32[5] memory ids) {
        (artifacts, ids) = super.pinnedCode();
        ids[1] = bytes32(uint256(1));
    }

    function identityOf(bytes memory runtime) external pure returns (bytes32) {
        return codeIdentity(runtime);
    }
}

/// REACHES DeployCurb's INTERNAL CHECK WITHOUT RUNNING A DEPLOYMENT.
///
/// The check is a script's, and a script's internals are internal - so this
/// inherits it rather than copying it. Copying would test a second
/// implementation and leave the first one unwatched.
contract DepthProbe is DeployCurb {
    /// The threshold this file ships for an asset, by label. Here rather than
    /// in the test contract, which is at the compiler's size limit.
    function thresholdOf(string memory label) external pure returns (uint256) {
        Asset[] memory list = quoteAssets();
        for (uint256 i = 0; i < list.length; i++) {
            if (keccak256(bytes(list[i].label)) == keccak256(bytes(label))) return list[i].threshold;
        }
        revert(string.concat("DeployCurb does not ship ", label));
    }

    function assets() external pure returns (Asset[] memory) {
        return quoteAssets();
    }

    function recipientKind(address who, bool allowEoa, bool allowNonSafe) external view {
        checkRecipientKind(who, allowEoa, allowNonSafe);
    }

    function policyOwnerCheck(address owner_, address platform, bool allowSame, bool allowEoa, bool allowNonSafe)
        external
        view
    {
        checkPolicyOwner(owner_, platform, allowSame, allowEoa, allowNonSafe);
    }

    function cost(address asset, uint256 threshold) external returns (uint256) {
        return costToBuyOneThreshold(asset, threshold);
    }

    function claim(address asset, uint256 threshold, string memory label, bool fillable, bool demo) external {
        requireDepthMatchesClaim(
            Asset({quote: asset, label: label, phantomQuote: threshold, threshold: threshold, fillable: fillable, decimals: 8}), demo
        );
    }
}
