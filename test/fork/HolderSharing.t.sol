// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";
import {PonsV2BuybackVault} from "../../src/vendor/PonsV2BuybackVault.sol";
import {IPonsV2FeeEscrow, IPonsV2FeePolicy} from "../../src/vendor/interfaces/ILaunchpadV2.sol";
import {Graduator, IPermit2Minimal} from "../../src/curb/Graduator.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {LaunchLens} from "../../src/curb/LaunchLens.sol";
import {CurbLaunchFactory} from "../../src/curb/CurbLaunchFactory.sol";
import {CurbLaunchToken} from "../../src/curb/CurbLaunchToken.sol";
import {PositionLock, IPositionManagerMinimal} from "../../src/curb/PositionLock.sol";
import {FeeHook} from "../../src/curb/FeeHook.sol";
import {FeeEscrow} from "../../src/curb/FeeEscrow.sol";
import {FeePolicy} from "../../src/curb/FeePolicy.sol";
import {SharingCatalog} from "../../src/curb/SharingCatalog.sol";
import {ISharingCatalog} from "../../src/curb/sharing/ICurbSharing.sol";

import {B20ForkTest} from "./B20ForkTest.sol";
import {PoolHarness} from "./B20UniswapV4.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {HolderDistributorFactory} from "../../src/curb/sharing/HolderDistributorFactory.sol";
import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";

/// A DISTRIBUTOR VERSION THAT IS HOSTILE TO EVERYTHING BUT ITS OWN LAUNCH: it
/// refuses ether, and every function it has reaches for somebody else's money.
contract HostileDistributor {
    address public launchToken;
    address public quoteToken;
    address public graduator;

    constructor(address t, address q, address g) {
        launchToken = t;
        quoteToken = q;
        graduator = g;
    }

    receive() external payable {
        revert("hostile: no ether");
    }

    function tryEnable(address victimToken, address factory) external returns (bool ok) {
        (ok,) = graduator.call(abi.encodeCall(Graduator.enableHolderSharing, (victimToken, factory)));
    }

    function tryEscrow(address escrow) external returns (bool ok) {
        (ok,) = escrow.call(abi.encodeWithSignature("claimToken(address)", quoteToken));
    }

    function tryRelease(address lock, address party) external returns (bool ok) {
        (ok,) = lock.call(abi.encodeCall(PositionLock.release, (party)));
    }
}

contract HostileFactory {
    LaunchRegistry public immutable registry;
    address public immutable graduator;
    mapping(address => address) public built;
    address public impersonate;

    constructor(LaunchRegistry r, address g) {
        registry = r;
        graduator = g;
    }

    function setImpersonate(address d) external {
        impersonate = d;
    }

    function deploy(address token) external returns (address d) {
        if (impersonate != address(0)) return impersonate;
        d = built[token];
        if (d == address(0)) {
            d = address(new HostileDistributor(token, registry.launchOf(token).quoteToken, graduator));
            built[token] = d;
        }
    }
}

/// HOLDER SHARING AGAINST THE REAL PoolManager, PositionManager, WETH and the
/// B20 equities, at the pinned fork block (core v2 design, A.10 10-17). The
/// distributor is the real one, HolderFeeDistributor v1 built by its own
/// factory, so every leg the core pays is the leg the distributor's harvest()
/// collects. The minimal TestDistributor stays for the core's unit tests.
abstract contract HolderSharingForkBase is B20ForkTest {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IPositionManagerMinimal internal constant POSM = IPositionManagerMinimal(0x7C5f5A4bBd8fD63184577525326123B519429bDc);
    IPermit2Minimal internal constant PERMIT2 = IPermit2Minimal(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address internal constant POLICY_REG = 0x8453000000000000000000000000000000000002;

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint24 internal constant FEE = 500;
    int24 internal constant TICK_SPACING = 10;
    uint16 internal constant TAX = 300;
    uint16 internal constant MAX_IMPACT_BPS = 500;

    address internal creator = makeAddr("creator");
    address internal coldWallet = makeAddr("the creator's other address");
    address internal trader = makeAddr("trader");
    address internal stranger = makeAddr("stranger");
    address internal refundTo = makeAddr("refund");
    address internal protocolRecipient = makeAddr("protocol");
    address internal publisher = makeAddr("sharing publisher");
    address internal keeperPayee = makeAddr("keeper payee");
    address internal guardian = makeAddr("guardian vetoer");

    struct Asset {
        address quote;
        string sym;
        /// DeployCurb's phantom, its own figure since the 2026-10-03 shape.
        uint256 phantom;
        uint256 threshold;
        address holder;
        uint8 decimals;
    }

    struct Stack {
        Asset a;
        LaunchRegistry registry;
        SharingCatalog catalog;
        Graduator graduator;
        FeeHook hook;
        FeeEscrow escrow;
        CurbLaunchFactory factory;
        HolderDistributorFactory dfac;
        LaunchLens lens;
    }

    struct Launched {
        CurbLaunchToken token;
        PonsV2BondingCurve curve;
        PoolKey key;
    }

    uint256 internal saltNonce;

    function setUp() public virtual {
        _forkGuard();
    }

    // ------------------------------------------------------------ fixtures

    function _weth() internal pure returns (Asset memory) {
        return Asset(WETH, "WETH", 1.65e18, 4.47e18, 0x6c561B446416E1A00E8E93E221854d6eA4171372, 18);
    }

    function _nvdac() internal pure returns (Asset memory) {
        return Asset(NVDAC, "NVDAc", 18.5e8, 50e8, 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9, 8);
    }

    /// The fourteen quote assets the deployment enables (DeployCurb's list of
    /// 2026-10-15), with the holders and thresholds B20MultiAsset measured at
    /// the pinned block. The three added that day keep the indices after the
    /// eleven, so every older test name still names the asset it did.
    function _assets() internal pure returns (Asset[] memory list) {
        list = new Asset[](14);
        list[0] = _weth();
        list[1] = _nvdac();
        list[2] = Asset(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf, "cbBTC", 0.0487e8, 0.132e8,
            0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1, 8);
        list[3] = Asset(0xcb585250f852C6c6bf90434AB21A00f02833a4af, "cbXRP", 3010e6, 8150e6,
            0x40EbC1Ac8d4Fedd2E144b75fe9C0420BE82750c6, 6);
        list[4] = Asset(0xB2000000000000000000008501b13360000cb2EC, "cbZEC", 3.23e8, 8.74e8,
            0x40EbC1Ac8d4Fedd2E144b75fe9C0420BE82750c6, 8);
        list[5] = Asset(0xb2000000000000000000007b9fcbd005511aCBd5, "SPCXc", 27.5e8, 74.5e8,
            0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E, 8);
        list[6] = Asset(0xb2000000000000000000002D0BA3164cc74f58B7, "GOOGLc", 11.5e8, 31.1e8,
            0xB1987CAD1682841b4b641d50E520777eC5Ab5542, 8);
        list[7] = Asset(0xb200000000000000000000d9192b6B456483C2E8, "AMZNc", 15.8e8, 42.9e8,
            0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b, 8);
        list[8] = Asset(0xB200000000000000000000Ab99cFa739E253872B, "MSFTc", 7.42e8, 20.1e8,
            0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54, 8);
        list[9] = Asset(0xb200000000000000000000C2e324d24d7eEcd1fb, "AAPLc", 11.6e8, 31.5e8,
            0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0, 8);
        list[10] = Asset(0xb2000000000000000000008bC8786B856E61707C, "METAc", 5.44e8, 14.7e8,
            0xEAF57753BC382E0324a1D43F72E7027705a2273E, 8);
        list[11] = Asset(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, "USDC", 4000e6, 10800e6,
            0x943C3B3aEe55aB6cC16c559c48B085cd60167203, 6);
        list[12] = Asset(0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b, "VIRTUAL", 5940e18, 16100e18,
            0x582717501Dec047513EC258458da7834011076DE, 18);
        list[13] = Asset(0x940181a94A35A4569E4529A3CDfB74e38FD98631, "AERO", 4290e18, 11600e18,
            0xBaeD383EDE0e5d9d72430661f3285DAa77E9439F, 18);
    }

    function _stack(Asset memory a) internal returns (Stack memory s) {
        s.a = a;
        s.registry = new LaunchRegistry(address(this));
        s.catalog = new SharingCatalog(address(this), address(this));
        s.graduator = new Graduator(POOL_MANAGER, POSM, PERMIT2, s.registry, ISharingCatalog(address(s.catalog)));
        s.hook = _mineHook(address(s.graduator), s.registry);
        s.escrow = new FeeEscrow(a.quote);
        IPonsV2FeePolicy policy = IPonsV2FeePolicy(
            address(new FeePolicy(protocolRecipient, IPonsV2FeeEscrow(address(s.escrow)), MAX_IMPACT_BPS))
        );
        PonsV2BuybackVault vault = new PonsV2BuybackVault(address(this), policy, IPonsV2FeeEscrow(address(s.escrow)));
        s.factory = new CurbLaunchFactory(
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
        s.registry.wire(address(s.factory), address(s.hook));
        address[] memory vetoers = new address[](1);
        vetoers[0] = guardian;
        s.dfac = new HolderDistributorFactory(
            address(s.registry), address(s.graduator), address(this), publisher, keeperPayee, vetoers
        );
        s.catalog.admitInitial(address(s.dfac));
        s.lens = new LaunchLens(s.registry, s.graduator);
    }

    function _mineHook(address poolOpener, LaunchRegistry reg) internal returns (FeeHook) {
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (, bytes32 salt) = HookMiner.find(
            address(this),
            flags,
            type(FeeHook).creationCode,
            abi.encode(POOL_MANAGER, protocolRecipient, reg, poolOpener, address(this))
        );
        return new FeeHook{salt: salt}(POOL_MANAGER, protocolRecipient, reg, poolOpener, address(this));
    }

    function _fund(Asset memory a, address who, uint256 amount) internal {
        vm.prank(a.holder);
        SafeERC20.safeTransfer(IERC20(a.quote), who, amount);
    }

    function _launch(Stack memory s, address shareFactory, uint256 devBuy) internal returns (Launched memory l) {
        return _launchFor(s, shareFactory, devBuy, address(0));
    }

    function _launchFor(Stack memory s, address shareFactory, uint256 devBuy, address wallet)
        internal
        returns (Launched memory l)
    {
        if (devBuy != 0) {
            _fund(s.a, creator, devBuy);
            vm.prank(creator);
            SafeERC20.forceApprove(IERC20(s.a.quote), address(s.factory), devBuy);
        }
        (uint16 bps, address to) = s.factory.currentPlatformPolicy();
        CurbLaunchFactory.LaunchConfig memory cfg = CurbLaunchFactory.LaunchConfig({
            name: "Shared",
            symbol: "SHR",
            tokenUri: "",
            salt: bytes32(++saltNonce),
            quoteRefundTo: refundTo,
            totalTaxBps: TAX,
            devBuy: devBuy,
            creatorWallet: wallet,
            expectedPlatformBps: bps,
            expectedPlatformRecipient: to,
            holderShareFactory: shareFactory
        });
        vm.prank(creator);
        (l.token, l.curve) = s.factory.launch(cfg);
        bool launchIs0 = address(l.token) < s.a.quote;
        l.key = PoolKey({
            currency0: Currency.wrap(launchIs0 ? address(l.token) : s.a.quote),
            currency1: Currency.wrap(launchIs0 ? s.a.quote : address(l.token)),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(s.hook))
        });
    }

    function _buy(Stack memory s, Launched memory l, uint256 amount) internal returns (uint256 gasUsed) {
        _fund(s.a, trader, amount);
        vm.startPrank(trader);
        SafeERC20.forceApprove(IERC20(s.a.quote), address(l.curve), type(uint256).max);
        uint256 g = gasleft();
        l.curve.buy(amount, 0, trader);
        gasUsed = g - gasleft();
        vm.stopPrank();
    }

    function _graduate(Stack memory s, Launched memory l) internal returns (uint256 gasUsed) {
        gasUsed = _buy(s, l, s.a.threshold * 2);
        assertTrue(l.curve.graduated(), string.concat(s.a.sym, ": the crossing buy did not graduate"));
    }

    /// A buy and then a sell in the pool: both fee legs, and LP fees on both
    /// sides of the position.
    function _poolRoundTrip(Stack memory s, Launched memory l, uint256 quoteIn) internal {
        PoolHarness h = new PoolHarness(POOL_MANAGER);
        _fund(s.a, address(h), quoteIn);
        bool quoteIs0 = s.a.quote < address(l.token);
        h.swap(l.key, quoteIs0, -int256(quoteIn));
        uint256 got = l.token.balanceOf(address(h));
        h.swap(l.key, !quoteIs0, -int256(got / 2));
    }

    function _lock(Stack memory s, Launched memory l) internal view returns (PositionLock) {
        return PositionLock(s.graduator.lockOf(address(l.token)));
    }

    /// Everything the creator holds or is owed in the quote asset.
    function _creatorQuote(Stack memory s) internal view returns (uint256) {
        return creator.balance + IERC20(s.a.quote).balanceOf(creator)
            + s.escrow.balanceOfToken(creator, s.a.quote) + s.hook.owed(creator, s.a.quote);
    }

    /// Everything a distributor holds or is owed in the quote asset.
    function _received(Stack memory s, address d) internal view returns (uint256) {
        return d.balance + IERC20(s.a.quote).balanceOf(d) + s.escrow.balanceOfToken(d, s.a.quote)
            + s.hook.owed(d, s.a.quote);
    }

    function _quoteIndex(Stack memory s, Launched memory l) internal pure returns (uint256) {
        return Currency.unwrap(l.key.currency0) == s.a.quote ? 0 : 1;
    }

    function _dist(Stack memory s, Launched memory l) internal view returns (HolderFeeDistributor) {
        return HolderFeeDistributor(payable(s.graduator.holderDistributorOf(address(l.token))));
    }

    /// What the lock reported paying, out of its own FeesClaimed events in
    /// `logs`, as (quote, launch token). Read from the lock's event because
    /// nothing else separates the lock's leg from the others a harvest pulls.
    function _lockPaid(Stack memory s, Launched memory l, Vm.Log[] memory logs)
        internal
        view
        returns (uint256 quoteAmt, uint256 tokenAmt)
    {
        address lock = s.graduator.lockOf(address(l.token));
        uint256 qi = _quoteIndex(s, l);
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != lock || logs[i].topics[0] != PositionLock.FeesClaimed.selector) continue;
            (uint256 a0, uint256 a1) = abi.decode(logs[i].data, (uint256, uint256));
            quoteAmt += qi == 0 ? a0 : a1;
            tokenAmt += qi == 0 ? a1 : a0;
        }
    }

    // ------------------------------------------------------------ B20 issuer policy

    function _scopeNamed(address asset, string memory name) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSignature(name));
        require(ok, string.concat(name, " did not answer"));
        return abi.decode(ret, (bytes32));
    }

    function _setBlocked(address asset, address who, bool blocked) internal {
        bytes32 scope = _scopeNamed(asset, "TRANSFER_RECEIVER_POLICY()");
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSignature("policyId(bytes32)", scope));
        require(ok, "policyId() did not answer");
        uint64 policy = abi.decode(ret, (uint64));
        (ok, ret) = POLICY_REG.staticcall(abi.encodeWithSignature("policyAdmin(uint64)", policy));
        require(ok, "policyAdmin() did not answer");
        address[] memory list = new address[](1);
        list[0] = who;
        vm.prank(abi.decode(ret, (address)));
        (ok,) = POLICY_REG.call(abi.encodeWithSignature("updateBlocklist(uint64,bool,address[])", policy, blocked, list));
        require(ok, "the registry refused the blocklist update");
    }

}

contract HolderSharingForkTest is HolderSharingForkBase {
    // ================================================================
    // 10. WETH, SHARING AT LAUNCH: every leg reaches the distributor
    // ================================================================

    function test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked() public onlyFork {
        Stack memory s = _stack(_weth());
        // A twentieth of the threshold: a tenth bought more than the dev buy
        // cap (a fifth of the supply) allows on WETH.
        uint256 dev = s.a.threshold / 20;
        Launched memory l = _launch(s, address(s.dfac), dev);
        address d = s.graduator.holderDistributorOf(address(l.token));
        assertEq(d, s.dfac.predict(address(l.token)), "not the factory's distributor");
        assertEq(s.graduator.sharingSince(address(l.token)), uint64(block.number), "not switched in the launch block");
        assertEq(s.registry.launchOf(address(l.token)).beneficiary, creator, "the beneficiary moved");
        assertEq(l.curve.deployer(), d, "the curve still pays the creator");
        assertEq(s.lens.launchState(address(l.token)).holderDistributor, d, "LaunchView word 15 is not the distributor");

        // the dev buy: its tokens are the creator's, its tax is the holders'
        assertGt(l.token.balanceOf(creator), 0, "the dev-buy tokens did not reach the creator");
        uint256 devTax = l.curve.creatorTaxBalance();
        assertGt(devTax, 0, "the dev buy paid no creator tax");

        // the distributor's own harvest: it sweeps the curve as the curve's
        // creator, and the escrow then pays it the credit that sweep made
        HolderFeeDistributor dist = HolderFeeDistributor(payable(d));
        dist.harvest();
        assertEq(l.curve.creatorTaxBalance(), 0, "the harvest did not sweep the curve");
        assertEq(s.escrow.balanceOfToken(creator, WETH), 0, "the sweep credited the creator");
        assertEq(s.escrow.balanceOfToken(d, WETH), 0, "the harvest left the distributor's escrow credit");
        assertEq(d.balance + IERC20(WETH).balanceOf(d), devTax, "the escrow did not pay the distributor");
        assertEq(dist.received0(), devTax, "the distributor does not count the dev-buy tax as received");

        // graduation, inside the crossing buy: the pool leg starts at the distributor
        _graduate(s, l);
        FeeHook.LaunchFee memory f = s.hook.feeOf(l.key);
        assertEq(f.creator, d, "the pool's creator leg is not the distributor from the first swap");
        assertTrue(f.holderShared, "the hook's flag is not set");
        PositionLock lock = _lock(s, l);
        assertEq(lock.beneficiary(), creator, "the principal's owner moved");
        assertEq(lock.feeRecipient(), d, "the lock does not pay the distributor");
        // the graduation sweep credited the distributor too
        assertGt(s.escrow.balanceOfToken(d, WETH), 0, "the graduation sweep did not credit the distributor");

        // pool swaps: on WETH both legs accrue as debts, the creator's to the distributor
        uint256 creatorBefore = _creatorQuote(s);
        _poolRoundTrip(s, l, s.a.threshold / 20);
        assertGt(s.hook.owed(d, WETH), 0, "the pool's creator leg did not accrue to the distributor");
        assertEq(s.hook.owed(creator, WETH), 0, "the pool paid the creator");
        uint256 owedD = s.hook.owed(d, WETH);
        uint256 creditD = s.escrow.balanceOfToken(d, WETH);
        uint256 before = d.balance + IERC20(WETH).balanceOf(d);
        uint256 tokBefore = l.token.balanceOf(d);
        vm.recordLogs();
        dist.harvest();
        (uint256 lockQuote, uint256 lockTok) = _lockPaid(s, l, vm.getRecordedLogs());
        assertEq(s.hook.owed(d, WETH), 0, "the harvest left the hook's debt");
        assertEq(s.escrow.balanceOfToken(d, WETH), 0, "the harvest left the escrow credit");
        assertGt(lockQuote + lockTok, 0, "the harvest collected nothing from the lock");
        assertEq(
            d.balance + IERC20(WETH).balanceOf(d) - before,
            owedD + creditD + lockQuote,
            "the harvest did not collect exactly the hook, the escrow and the lock"
        );
        assertEq(l.token.balanceOf(d) - tokBefore, lockTok, "the lock's token side did not reach the distributor");
        assertEq(dist.received1(), l.token.balanceOf(d), "the distributor does not count the token side");

        // the lock pays the distributor, called by anyone
        _poolRoundTrip(s, l, s.a.threshold / 20);
        uint256 dWethBefore = IERC20(WETH).balanceOf(d);
        uint256 dTokBefore = l.token.balanceOf(d);
        lock.claimFees();
        assertTrue(
            IERC20(WETH).balanceOf(d) > dWethBefore || l.token.balanceOf(d) > dTokBefore,
            "the lock's fees did not reach the distributor"
        );
        assertEq(_creatorQuote(s), creatorBefore, "the creator received quote after the switch");

        // ten years on: the fees still go to the holders, and nobody - the
        // creator included - can take the liquidity out
        uint128 lockedBefore = lock.lockedLiquidity();
        _poolRoundTrip(s, l, s.a.threshold / 20);
        vm.warp(vm.getBlockTimestamp() + 10 * 365 days);
        dWethBefore = IERC20(WETH).balanceOf(d);
        dTokBefore = l.token.balanceOf(d);
        uint256 creatorWethBefore = IERC20(WETH).balanceOf(creator);
        uint256 creatorTokBefore = l.token.balanceOf(creator);
        vm.startPrank(creator);
        (bool ok,) = address(lock).call(
            abi.encodeWithSignature("withdrawLiquidity(uint128,uint128,address,uint256)", 0, 0, creator, type(uint256).max)
        );
        assertFalse(ok, "the lock let the creator withdraw the liquidity");
        (ok,) = address(lock).call(abi.encodeWithSignature("withdraw()"));
        assertFalse(ok, "the lock let the creator withdraw the position");
        vm.stopPrank();
        lock.claimFees();
        assertTrue(
            IERC20(WETH).balanceOf(d) > dWethBefore || l.token.balanceOf(d) > dTokBefore,
            "ten years on, the LP fees did not go to the holders"
        );
        assertEq(IERC20(WETH).balanceOf(creator), creatorWethBefore, "the creator received WETH");
        assertEq(l.token.balanceOf(creator), creatorTokBefore, "the creator received tokens");
        assertTrue(lock.holdsPosition(), "the lock let go of the position");
        assertEq(lock.lockedLiquidity(), lockedBefore, "liquidity left the lock");
        assertEq(IERC721(address(POSM)).ownerOf(lock.tokenId()), address(lock), "the NFT left the lock");
    }

    function _cheapestSwap(PoolHarness h, PoolKey memory key, bool zeroForOne, uint256 amount)
        internal
        returns (uint256 least)
    {
        // Each measured buy is sold back unmeasured, so every buy starts from
        // about the same price and the comparison is not one of price drift.
        IERC20 launch = IERC20(Currency.unwrap(zeroForOne ? key.currency1 : key.currency0));
        least = type(uint256).max;
        for (uint256 k = 0; k < 6; k++) {
            uint256 before = launch.balanceOf(address(h));
            uint256 g = gasleft();
            h.swap(key, zeroForOne, -int256(amount));
            uint256 used = g - gasleft();
            if (k != 0 && used < least) least = used;
            h.swap(key, !zeroForOne, -int256(launch.balanceOf(address(h)) - before));
        }
    }

    /// PER-SWAP GAS IS UNCHANGED BY SHARING. The same pool's swap, before and
    /// after its creator leg moves, both measured warm (the hook copies the
    /// switch once, in syncCreator, and reads nothing new per swap).
    ///
    /// THE BENEFICIARY IS A CONTRACT HERE, like the distributor. A B20 direct
    /// take costs more when its receiver is a contract than when it is a plain
    /// account; that is the asset's price for the receiver, not the hook's,
    /// and comparing like with like keeps it out of the measurement.
    function test_aPoolSwapCostsTheSameWithSharingOn() public onlyFork {
        Asset[] memory as_ = new Asset[](2);
        as_[0] = _weth();
        as_[1] = _nvdac();
        for (uint256 i = 0; i < 2; i++) {
            Stack memory s = _stack(as_[i]);
            address wallet = address(new PoolHarness(POOL_MANAGER));
            Launched memory l = _launchFor(s, address(0), 0, wallet);
            _graduate(s, l);
            uint256 amount = s.a.threshold / 50;
            PoolHarness h = new PoolHarness(POOL_MANAGER);
            _fund(s.a, address(h), amount * 12);
            bool quoteIs0 = s.a.quote < address(l.token);

            // THE CHEAPEST OF FIVE WARM BUYS ON EACH SIDE. Single swaps move
            // by several thousand gas from one to the next with no change in
            // the hook at all - the asset's own accounting for a new receiver,
            // and storage going between zero and non-zero in the pool - so a
            // single pair of measurements compares those, not the hook.
            //
            // AND FROM THE SAME POOL STATE ON BOTH SIDES. Run one after the
            // other, the "on" buys start where the five "off" buys left the
            // price. On the 2026-10-03 shape's thinner pool that alone made
            // the WETH "on" buys 849 gas dearer with the hook unchanged - the
            // pool's cost at a different price, which a comparison of the hook
            // must not count.
            uint256 snap = vm.snapshotState();
            uint256 off = _cheapestSwap(h, l.key, quoteIs0, amount);
            vm.revertToState(snap);
            vm.prank(wallet);
            s.graduator.enableHolderSharing(address(l.token), address(s.dfac));
            uint256 on = _cheapestSwap(h, l.key, quoteIs0, amount);

            emit log_named_uint(string.concat(s.a.sym, " pool buy gas, sharing off"), off);
            emit log_named_uint(string.concat(s.a.sym, " pool buy gas, sharing on"), on);
            // EXACT ON WETH, where both legs accrue in the hook and the
            // receiver never enters the swap. On a B20 the creator leg is a
            // direct take, and the asset charges its own receiver-dependent
            // amount (the distributor measured slightly cheaper), so there it
            // must only never cost more.
            if (s.a.quote == WETH) assertEq(on, off, "WETH: a swap costs a different amount with sharing on");
            else assertLe(on, off, string.concat(s.a.sym, ": a swap costs more with sharing on"));
        }
    }

    // ================================================================
    // 11. NVDAc, ENABLED AFTER GRADUATION
    // ================================================================

    function test_nvdac_enabledAfterGraduation_aCleanCut() public onlyFork {
        Stack memory s = _stack(_nvdac());
        Launched memory l = _launch(s, address(0), 0);
        _buy(s, l, s.a.threshold / 10);
        _graduate(s, l);
        _poolRoundTrip(s, l, s.a.threshold / 20);
        PositionLock lock = _lock(s, l);
        assertEq(lock.feeRecipient(), creator, "sharing is off, the lock must pay the creator");

        uint256 creditBefore = s.escrow.balanceOfToken(creator, NVDAC);
        assertGt(creditBefore, 0, "the graduation sweep did not credit the creator");
        uint256 owedBefore = s.hook.owed(creator, NVDAC);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheBeneficiary.selector, stranger));
        s.graduator.enableHolderSharing(address(l.token), address(s.dfac));

        // the clean cut: the LP fees accrued so far are collected for the creator
        uint256 cQ = IERC20(NVDAC).balanceOf(creator);
        uint256 cT = l.token.balanceOf(creator);
        vm.prank(creator);
        address d = s.graduator.enableHolderSharing(address(l.token), address(s.dfac));
        assertTrue(
            IERC20(NVDAC).balanceOf(creator) > cQ || l.token.balanceOf(creator) > cT,
            "the LP fees earned before the switch did not go to the creator"
        );
        assertEq(s.escrow.balanceOfToken(creator, NVDAC), creditBefore, "the creator's escrow credit moved");
        assertEq(s.hook.owed(creator, NVDAC), owedBefore, "the creator's hook debt moved");
        assertEq(IERC20(NVDAC).balanceOf(d), 0, "the holders got money earned before the switch");
        assertEq(s.hook.feeOf(l.key).creator, d, "the pool leg did not move");
        assertEq(lock.feeRecipient(), d, "the lock does not follow the switch");

        // after the switch: direct takes go to the distributor, and only there
        uint256 creatorAfter = _creatorQuote(s);
        uint256 creatorTokAfter = l.token.balanceOf(creator);
        _poolRoundTrip(s, l, s.a.threshold / 20);
        assertGt(IERC20(NVDAC).balanceOf(d), 0, "the pool's creator leg did not go to the distributor");
        lock.claimFees();
        assertEq(_creatorQuote(s), creatorAfter, "the creator received quote after the switch");
        assertEq(l.token.balanceOf(creator), creatorTokAfter, "the creator received LP fees after the switch");

        // and the creator's pre-switch credit is still the creator's to claim
        uint256 bq = IERC20(NVDAC).balanceOf(creator);
        vm.prank(creator);
        s.escrow.claimToken(NVDAC);
        assertEq(IERC20(NVDAC).balanceOf(creator) - bq, creditBefore, "the creator could not claim the pre-switch credit");
    }

    // ================================================================
    // 12. ENABLED BEFORE GRADUATION
    // ================================================================

    function test_nvdac_enabledBeforeGraduation_pendingToTheCreatorLaterToTheHolders() public onlyFork {
        Stack memory s = _stack(_nvdac());
        Launched memory l = _launch(s, address(0), 0);
        _buy(s, l, s.a.threshold / 10);
        uint256 pending = l.curve.creatorTaxBalance();
        assertGt(pending, 0, "nothing pending");
        uint256 cQ = IERC20(NVDAC).balanceOf(creator);

        vm.prank(creator);
        address d = s.graduator.enableHolderSharing(address(l.token), address(s.dfac));
        assertEq(IERC20(NVDAC).balanceOf(creator) - cQ, pending, "the pending tax did not go to the creator");
        assertEq(l.curve.creatorTaxBalance(), 0, "the pending tax stayed");
        assertEq(l.curve.deployer(), d, "the curve was not redirected");

        _buy(s, l, s.a.threshold / 10);
        _graduate(s, l);
        assertGt(s.escrow.balanceOfToken(d, NVDAC), 0, "later tax did not reach the distributor");
        assertEq(s.escrow.balanceOfToken(creator, NVDAC), 0, "later tax reached the creator");
        assertEq(s.hook.feeOf(l.key).creator, d, "graduation did not honour the switch");
        assertTrue(s.hook.feeOf(l.key).holderShared, "graduation did not set the hook's flag");
        assertEq(_lock(s, l).feeRecipient(), d, "the lock does not pay the distributor");
        assertEq(
            IERC20(NVDAC).balanceOf(creator) - cQ, pending, "the creator received something after the switch"
        );
    }

    // ================================================================
    // 13. B20 ISSUER POLICY
    // ================================================================

    /// THE ISSUER BLOCKS THE DISTRIBUTOR: the hook falls back to owed,
    /// claimFees holds, the principal still leaves, and the held fees go out
    /// once the block is lifted.
    function test_issuer_blocksTheDistributor() public onlyFork {
        Stack memory s = _stack(_nvdac());
        Launched memory l = _launch(s, address(s.dfac), 0);
        address d = s.graduator.holderDistributorOf(address(l.token));
        _graduate(s, l);
        _setBlocked(NVDAC, d, true);

        _poolRoundTrip(s, l, s.a.threshold / 20);
        assertGt(s.hook.owed(d, NVDAC), 0, "a refused take did not fall back to owed");
        assertEq(IERC20(NVDAC).balanceOf(d), 0, "a blocked distributor was paid");

        PositionLock lock = _lock(s, l);
        uint256 qi = _quoteIndex(s, l);
        lock.claimFees();
        uint256 held_ = lock.held(d, qi);
        assertGt(held_, 0, "the lock did not hold the refused quote fees");

        _poolRoundTrip(s, l, s.a.threshold / 20);
        vm.warp(vm.getBlockTimestamp() + 10 * 365 days);
        uint256 cQ = IERC20(NVDAC).balanceOf(creator);
        lock.claimFees();
        assertEq(IERC20(NVDAC).balanceOf(creator), cQ, "the creator was paid the blocked distributor's fees");
        assertGt(lock.held(d, qi), held_, "the later fees were not held for the distributor");

        // a harvest while blocked: every step is refused, none stops another,
        // and nothing moves
        HolderFeeDistributor dist = HolderFeeDistributor(payable(d));
        uint256 total = lock.held(d, qi);
        uint256 owed = s.hook.owed(d, NVDAC);
        uint256 credit = s.escrow.balanceOfToken(d, NVDAC);
        assertGt(credit, 0, "the graduation sweep did not credit the distributor");
        dist.harvest();
        assertEq(dist.received0(), 0, "a blocked distributor received quote");
        assertEq(lock.held(d, qi), total, "a refused release moved the held fees");
        assertEq(s.hook.owed(d, NVDAC), owed, "a refused claim moved the hook debt");

        // unblocked: one harvest collects the held fees, the hook debt and the
        // escrow credit, and nothing else
        _setBlocked(NVDAC, d, false);
        dist.harvest();
        assertEq(lock.held(d, qi), 0, "the held fees were not released");
        assertEq(s.hook.owed(d, NVDAC), 0, "the hook debt was not paid");
        assertEq(s.escrow.balanceOfToken(d, NVDAC), 0, "the escrow credit was not paid");
        assertEq(IERC20(NVDAC).balanceOf(d), total + owed + credit, "the harvest did not collect exactly what was waiting");
        assertEq(dist.received0(), total + owed + credit, "the distributor does not count what it collected");
    }

    /// THE ISSUER BLOCKS THE CREATOR DURING THE SWITCH: the rescue is caught,
    /// and the pending tax goes to the holders.
    function test_issuer_blocksTheCreatorDuringEnable() public onlyFork {
        Stack memory s = _stack(_nvdac());
        Launched memory l = _launch(s, address(0), 0);
        _buy(s, l, s.a.threshold / 10);
        uint256 pending = l.curve.creatorTaxBalance();
        _setBlocked(NVDAC, creator, true);
        uint256 cQ = IERC20(NVDAC).balanceOf(creator);

        vm.prank(creator);
        address d = s.graduator.enableHolderSharing(address(l.token), address(s.dfac));
        assertEq(l.curve.deployer(), d, "the switch did not happen");
        assertEq(l.curve.creatorTaxBalance(), pending, "the refused rescue moved the pending tax");
        assertEq(IERC20(NVDAC).balanceOf(creator), cQ, "a blocked creator was paid");

        _graduate(s, l);
        assertGe(s.escrow.balanceOfToken(d, NVDAC), pending, "the pending tax did not go to the holders");
        assertEq(s.escrow.balanceOfToken(creator, NVDAC), 0, "the creator was credited");
    }

    // ================================================================
    // 14. AUTO-GRADUATION INSIDE A BUY, WITH SHARING ON
    // ================================================================

    function test_autoGraduationInsideABuyWithSharingOn_gasHeadroom() public onlyFork {
        Stack memory s = _stack(_weth());
        Launched memory plain = _launch(s, address(0), 0);
        uint256 gPlain = _graduate(s, plain);
        Launched memory shared = _launch(s, address(s.dfac), 0);
        uint256 gShared = _graduate(s, shared);
        emit log_named_uint("crossing buy gas, sharing off", gPlain);
        emit log_named_uint("crossing buy gas, sharing on", gShared);
        assertEq(
            s.hook.feeOf(shared.key).creator,
            s.graduator.holderDistributorOf(address(shared.token)),
            "the auto-graduation did not move the pool leg"
        );
        // syncCreator and the lock's two extra immutables, nothing more
        assertLt(gShared, gPlain + 60_000, "sharing made the auto-graduation much dearer");
        // and well inside what a wallet will send for a buy
        assertLt(gShared, 6_000_000, "the crossing buy is too close to a wallet's gas limit");
    }

    // ================================================================
    // 15. ALL FOURTEEN QUOTE ASSETS x {AT LAUNCH, LATER}
    // ================================================================

    function _sharedLifecycle(Asset memory a, bool atLaunch) internal {
        Stack memory s = _stack(a);
        Launched memory l = _launch(s, atLaunch ? address(s.dfac) : address(0), 0);
        _buy(s, l, a.threshold / 10);
        address d;
        if (atLaunch) {
            d = s.graduator.holderDistributorOf(address(l.token));
        } else {
            vm.prank(creator);
            d = s.graduator.enableHolderSharing(address(l.token), address(s.dfac));
        }
        assertEq(l.curve.deployer(), d, string.concat(a.sym, ": the curve was not redirected"));
        _graduate(s, l);
        assertEq(s.hook.feeOf(l.key).creator, d, string.concat(a.sym, ": the pool leg is not the distributor"));
        PositionLock lock = _lock(s, l);
        assertEq(lock.feeRecipient(), d, string.concat(a.sym, ": the lock does not pay the distributor"));

        uint256 creatorBefore = _creatorQuote(s);
        uint256 dBefore = _received(s, d);
        _poolRoundTrip(s, l, a.threshold / 20);
        lock.claimFees();
        assertGt(_received(s, d), dBefore, string.concat(a.sym, ": the distributor received nothing from the pool"));
        assertEq(_creatorQuote(s), creatorBefore, string.concat(a.sym, ": the creator received quote after the switch"));
    }

    function test_allQuoteAssets_00_WETH_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[0], true);
    }

    function test_allQuoteAssets_00_WETH_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[0], false);
    }

    function test_allQuoteAssets_01_NVDAc_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[1], true);
    }

    function test_allQuoteAssets_01_NVDAc_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[1], false);
    }

    function test_allQuoteAssets_02_cbBTC_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[2], true);
    }

    function test_allQuoteAssets_02_cbBTC_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[2], false);
    }

    function test_allQuoteAssets_03_cbXRP_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[3], true);
    }

    function test_allQuoteAssets_03_cbXRP_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[3], false);
    }

    function test_allQuoteAssets_04_cbZEC_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[4], true);
    }

    function test_allQuoteAssets_04_cbZEC_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[4], false);
    }

    function test_allQuoteAssets_05_SPCXc_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[5], true);
    }

    function test_allQuoteAssets_05_SPCXc_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[5], false);
    }

    function test_allQuoteAssets_06_GOOGLc_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[6], true);
    }

    function test_allQuoteAssets_06_GOOGLc_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[6], false);
    }

    function test_allQuoteAssets_07_AMZNc_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[7], true);
    }

    function test_allQuoteAssets_07_AMZNc_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[7], false);
    }

    function test_allQuoteAssets_08_MSFTc_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[8], true);
    }

    function test_allQuoteAssets_08_MSFTc_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[8], false);
    }

    function test_allQuoteAssets_09_AAPLc_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[9], true);
    }

    function test_allQuoteAssets_09_AAPLc_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[9], false);
    }

    function test_allQuoteAssets_10_METAc_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[10], true);
    }

    function test_allQuoteAssets_10_METAc_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[10], false);
    }

    function test_allQuoteAssets_11_USDC_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[11], true);
    }

    function test_allQuoteAssets_11_USDC_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[11], false);
    }

    function test_allQuoteAssets_12_VIRTUAL_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[12], true);
    }

    function test_allQuoteAssets_12_VIRTUAL_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[12], false);
    }

    function test_allQuoteAssets_13_AERO_sharedAtLaunch() public onlyFork {
        _sharedLifecycle(_assets()[13], true);
    }

    function test_allQuoteAssets_13_AERO_sharedLater() public onlyFork {
        _sharedLifecycle(_assets()[13], false);
    }

    // ================================================================
    // 16. ISOLATION: A HOSTILE VERSION FOR ONE LAUNCH
    // ================================================================

    function test_aHostileVersionReachesOnlyItsOwnLaunch() public onlyFork {
        Stack memory s = _stack(_nvdac());
        Launched memory a = _launch(s, address(s.dfac), 0);
        address dA = s.graduator.holderDistributorOf(address(a.token));
        Launched memory b = _launch(s, address(0), 0);
        _graduate(s, a);
        _graduate(s, b);
        _poolRoundTrip(s, a, s.a.threshold / 20);

        HostileFactory evil = new HostileFactory(s.registry, address(s.graduator));
        s.catalog.propose(address(evil));
        vm.warp(vm.getBlockTimestamp() + s.catalog.ADMISSION_DELAY());

        // it cannot hand B the distributor of A
        evil.setImpersonate(dA);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotADistributorForThisToken.selector, dA));
        s.graduator.enableHolderSharing(address(b.token), address(evil));
        evil.setImpersonate(address(0));

        uint256 creditA = s.escrow.balanceOfToken(dA, NVDAC);
        uint256 owedA = s.hook.owed(dA, NVDAC);
        uint256 balA = IERC20(NVDAC).balanceOf(dA);
        PositionLock lockA = _lock(s, a);

        vm.prank(creator);
        address dB = s.graduator.enableHolderSharing(address(b.token), address(evil));
        HostileDistributor h = HostileDistributor(payable(dB));
        assertFalse(h.tryEnable(address(a.token), address(evil)), "a distributor switched another launch");
        assertFalse(h.tryEscrow(address(s.escrow)), "a distributor claimed credit it never had");
        assertFalse(h.tryRelease(address(lockA), dB), "a distributor released another lock's fees to itself");

        _poolRoundTrip(s, b, s.a.threshold / 20);
        _lock(s, b).claimFees();
        assertGt(IERC20(NVDAC).balanceOf(dB), 0, "the hostile version's own launch paid nothing");

        assertEq(s.graduator.holderDistributorOf(address(a.token)), dA, "launch A's switch moved");
        assertEq(lockA.feeRecipient(), dA, "launch A's lock moved");
        assertEq(s.hook.feeOf(a.key).creator, dA, "launch A's pool leg moved");
        assertEq(s.escrow.balanceOfToken(dA, NVDAC), creditA, "launch A's escrow credit moved");
        assertEq(s.hook.owed(dA, NVDAC), owedA, "launch A's hook debt moved");
        assertEq(IERC20(NVDAC).balanceOf(dA), balA, "launch A's distributor was touched");
    }
}

/// Random sequences of everything that moves a launch's money, on one NVDAc
/// launch, with holder sharing switched on at some point or never.
contract SharingHandler is Test {
    PonsV2BondingCurve public curve;
    CurbLaunchToken public token;
    Graduator public grad;
    FeeHook public hook;
    FeeEscrow public escrow;
    HolderDistributorFactory public dfac;
    address public quote;
    address public holder;
    uint256 public threshold;
    PoolKey public key;
    address public creator;
    address public trader = makeAddr("handler trader");
    address public sink = makeAddr("the creator's principal address");

    address public d0;
    bool public switched;
    bool public switchedOnTheCurve;
    uint128 public liquidityAtGraduation;
    uint256 public creatorQuoteAtSwitch;
    uint256 public creatorTokenAtSwitch;
    PoolHarness internal harness;

    constructor(
        PonsV2BondingCurve curve_,
        CurbLaunchToken token_,
        Graduator grad_,
        FeeHook hook_,
        FeeEscrow escrow_,
        HolderDistributorFactory dfac_,
        address quote_,
        address holder_,
        uint256 threshold_,
        PoolKey memory key_,
        address creator_
    ) {
        curve = curve_;
        token = token_;
        grad = grad_;
        hook = hook_;
        escrow = escrow_;
        dfac = dfac_;
        quote = quote_;
        holder = holder_;
        threshold = threshold_;
        key = key_;
        creator = creator_;
        harness = new PoolHarness(IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b));
    }

    function _fund(address who, uint256 amount) internal {
        vm.prank(holder);
        SafeERC20.safeTransfer(IERC20(quote), who, amount);
    }

    function _lock() internal view returns (PositionLock) {
        return PositionLock(grad.lockOf(address(token)));
    }

    function buy(uint256 seed) external {
        uint256 amount = bound(seed, threshold / 100, threshold / 2);
        if (!curve.graduated()) {
            if (curve.readyToGraduate()) return;
            _fund(trader, amount);
            vm.startPrank(trader);
            SafeERC20.forceApprove(IERC20(quote), address(curve), type(uint256).max);
            try curve.buy(amount, 0, trader) {} catch {}
            vm.stopPrank();
            // A crossing buy graduates inside itself.
            _noteTheLock();
        } else {
            amount = amount / 10;
            _fund(address(harness), amount);
            try harness.swap(key, quote < address(token), -int256(amount)) {} catch {}
        }
    }

    function sell(uint256 seed) external {
        if (!curve.graduated()) {
            uint256 bal = token.balanceOf(trader);
            if (bal == 0 || curve.readyToGraduate()) return;
            uint256 amount = bound(seed, 1, bal / 2 + 1);
            vm.startPrank(trader);
            token.approve(address(curve), type(uint256).max);
            try curve.sell(amount, 0, trader) {} catch {}
            vm.stopPrank();
        } else {
            uint256 bal = token.balanceOf(address(harness));
            if (bal == 0) return;
            uint256 amount = bound(seed, 1, bal);
            try harness.swap(key, address(token) < quote, -int256(amount)) {} catch {}
        }
    }

    function graduate() external {
        if (curve.readyToGraduate()) {
            try grad.graduate(address(token)) {} catch {}
            _noteTheLock();
        }
    }

    /// What graduation locked, written down the first time a lock exists -
    /// in the same call that graduated, so nothing can have moved it yet.
    function _noteTheLock() internal {
        if (liquidityAtGraduation != 0 || address(_lock()) == address(0)) return;
        liquidityAtGraduation = _lock().lockedLiquidity();
    }

    function enable() external {
        if (switched) return;
        vm.prank(creator);
        try grad.enableHolderSharing(address(token), address(dfac)) returns (address d) {
            d0 = d;
            switched = true;
            switchedOnTheCurve = !grad.hasGraduated(address(token));
            creatorQuoteAtSwitch = creatorQuote();
            creatorTokenAtSwitch = creatorToken();
        } catch {}
    }

    function claimLock() external {
        if (address(_lock()) == address(0)) return;
        try _lock().claimFees() {} catch {}
    }

    function harvest() external {
        if (!switched) return;
        try HolderFeeDistributor(payable(d0)).harvest() {} catch {}
    }

    /// The creator collecting what it earned before the switch: moves value
    /// between the places creatorQuote() counts, never into it.
    function creatorClaims() external {
        vm.startPrank(creator);
        try escrow.claimToken(quote) {} catch {}
        try hook.claim(quote) {} catch {}
        vm.stopPrank();
        if (address(_lock()) != address(0)) {
            try _lock().release(creator) {} catch {}
        }
    }

    /// The creator trying every way the liquidity ever had out, up to ten
    /// years later. None exists; the invariant checks that nothing moved.
    function tryToTakeTheLiquidity(uint256 seed) external {
        PositionLock lock = _lock();
        if (address(lock) == address(0)) return;
        vm.warp(vm.getBlockTimestamp() + bound(seed, 0, 10 * 365 days));
        vm.startPrank(creator);
        (bool ok,) = address(lock).call(abi.encodeWithSignature("withdraw()"));
        (ok,) = address(lock).call(
            abi.encodeWithSignature("withdrawLiquidity(uint128,uint128,address,uint256)", 0, 0, sink, type(uint256).max)
        );
        ok;
        vm.stopPrank();
    }

    function warp(uint256 seed) external {
        vm.warp(vm.getBlockTimestamp() + bound(seed, 1, 20 days));
    }

    function _quoteIndex() internal view returns (uint256) {
        return Currency.unwrap(key.currency0) == quote ? 0 : 1;
    }

    function creatorQuote() public view returns (uint256 w) {
        w = IERC20(quote).balanceOf(creator) + escrow.balanceOfToken(creator, quote) + hook.owed(creator, quote);
        if (address(_lock()) != address(0)) w += _lock().held(creator, _quoteIndex());
    }

    function creatorToken() public view returns (uint256 w) {
        w = token.balanceOf(creator);
        if (address(_lock()) != address(0)) w += _lock().held(creator, 1 - _quoteIndex());
    }
}

/// A.10 17: THE SWITCH UNDER RANDOM SEQUENCES.
contract HolderSharingInvariantTest is HolderSharingForkBase {
    SharingHandler internal handler;
    Stack internal st;
    Launched internal ln;

    function setUp() public override {
        // OFF THE FORK THERE IS NOTHING TO FUZZ, and an invariant suite with
        // no target FAILS ("No contracts to fuzz") instead of skipping. So it
        // is skipped here, as every onlyFork test is - and a run that declares
        // itself a fork run (B20_FORK) fails rather than skip.
        if (!_forkGuard()) {
            require(!vm.envOr("B20_FORK", false), "B20_FORK is set but this is not the Base fork");
            vm.skip(true);
            return;
        }
        Stack memory s = _stack(_nvdac());
        Launched memory l = _launch(s, address(0), 0);
        st = s;
        ln = l;
        handler = new SharingHandler(
            l.curve, l.token, s.graduator, s.hook, s.escrow, s.dfac, s.a.quote, s.a.holder, s.a.threshold, l.key, creator
        );
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](10);
        sel[0] = SharingHandler.buy.selector;
        sel[1] = SharingHandler.sell.selector;
        sel[2] = SharingHandler.graduate.selector;
        sel[3] = SharingHandler.enable.selector;
        sel[4] = SharingHandler.claimLock.selector;
        sel[5] = SharingHandler.harvest.selector;
        sel[6] = SharingHandler.creatorClaims.selector;
        sel[7] = SharingHandler.tryToTakeTheLiquidity.selector;
        sel[8] = SharingHandler.warp.selector;
        sel[9] = SharingHandler.buy.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// THE FOUR PROPERTIES, checked after every call: the lock pays only the
    /// beneficiary or the switch's distributor; the switch, once written,
    /// never changes or clears; no leg is ever pointed back at the creator;
    /// and the creator receives nothing after the switch - what it holds or is
    /// owed in the quote and in the token stays exactly what it was.
    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 24
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_sharingIsOneWayAndTheCreatorGetsNothingAfterIt() public view {
        if (block.chainid != BASE_CHAIN_ID) return;
        address t = address(ln.token);
        address d = st.graduator.holderDistributorOf(t);
        address lock = st.graduator.lockOf(t);
        if (lock != address(0)) {
            address r = PositionLock(lock).feeRecipient();
            assertTrue(r == creator || (r == d && d != address(0)), "the lock pays someone else");
        }
        if (!handler.switched()) {
            assertEq(d, address(0), "the switch moved without the handler throwing it");
            return;
        }
        assertEq(d, handler.d0(), "the switch changed");
        assertGt(st.graduator.sharingSince(t), 0, "the switch's block was cleared");
        // the curve's leg moves only for a switch thrown before graduation;
        // after it the curve has nothing left to pay
        if (handler.switchedOnTheCurve()) {
            assertEq(ln.curve.deployer(), d, "the curve's leg went back to the creator");
        } else {
            assertEq(ln.curve.deployer(), creator, "a graduated curve's recipient was moved");
        }
        FeeHook.LaunchFee memory f = st.hook.feeOf(ln.key);
        if (f.configured) {
            assertEq(f.creator, d, "the pool's leg went back to the creator");
            assertTrue(f.holderShared, "the hook's flag was cleared");
        }
        if (lock != address(0)) assertEq(PositionLock(lock).feeRecipient(), d, "the lock went back to the creator");
        assertEq(handler.creatorQuote(), handler.creatorQuoteAtSwitch(), "the creator received quote after the switch");
        assertEq(handler.creatorToken(), handler.creatorTokenAtSwitch(), "the creator received tokens after the switch");
    }

    /// THE LIQUIDITY NEVER LEAVES THE LOCK, whatever the sequence: the lock
    /// owns the position and holds exactly what graduation put in it.
    /// forge-config: default.invariant.runs = 8
    /// forge-config: default.invariant.depth = 24
    /// forge-config: default.invariant.fail-on-revert = false
    function invariant_theLiquidityNeverLeavesTheLock() public view {
        if (block.chainid != BASE_CHAIN_ID) return;
        address lock = st.graduator.lockOf(address(ln.token));
        if (lock == address(0)) return;
        uint256 id = PositionLock(lock).tokenId();
        assertTrue(PositionLock(lock).holdsPosition(), "the lock let go of the position");
        assertEq(IERC721(address(POSM)).ownerOf(id), lock, "the NFT left the lock");
        assertEq(POSM.getPositionLiquidity(id), handler.liquidityAtGraduation(), "liquidity left the lock");
        assertGt(handler.liquidityAtGraduation(), 0, "graduation locked nothing");
    }
}
