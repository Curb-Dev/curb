// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";

import {LaunchRegistry} from "../src/curb/LaunchRegistry.sol";
import {Graduator, IPermit2Minimal} from "../src/curb/Graduator.sol";
import {PositionLock, IPositionManagerMinimal} from "../src/curb/PositionLock.sol";
import {SharingCatalog} from "../src/curb/SharingCatalog.sol";
import {FeeHook} from "../src/curb/FeeHook.sol";
import {ISharingCatalog} from "../src/curb/sharing/ICurbSharing.sol";
import {TestDistributor, TestDistributorFactory} from "./harness/TestDistributor.sol";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

contract Tok is ERC20 {
    constructor() ERC20("T", "T") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// A token whose transfers to one address can be refused, the way a B20
/// issuer's receiver policy refuses them - and which can also be told to
/// return false, or to report success while moving nothing.
contract PolicyTok is ERC20 {
    mapping(address => bool) public blocked;
    address public returnFalseTo;
    address public lieTo;
    address public moveButFalseTo;
    uint256 public burnGas;

    constructor() ERC20("P", "P") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setBlocked(address a, bool b) external {
        blocked[a] = b;
    }

    function setReturnFalse(address to) external {
        returnFalseTo = to;
    }

    function setLie(address to) external {
        lieTo = to;
    }

    function setMoveButFalse(address to) external {
        moveButFalseTo = to;
    }

    function setBurnGas(uint256 g) external {
        burnGas = g;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        if (burnGas != 0) {
            uint256 start = gasleft();
            while (start - gasleft() < burnGas) {}
        }
        require(!blocked[to], "PolicyTok: receiver blocked");
        if (to == returnFalseTo) return false;
        if (to == moveButFalseTo) {
            super.transfer(to, a);
            return false;
        }
        if (to == lieTo) return true;
        return super.transfer(to, a);
    }
}

contract MockReg {
    mapping(address => LaunchRegistry.Launch) internal recs;
    mapping(address => bool) public isLauncher;
    uint16 public constant PLATFORM_FEE_BPS = 50;

    function set(address t, LaunchRegistry.Launch memory r) external {
        recs[t] = r;
    }

    function setLauncher(address l) external {
        isLauncher[l] = true;
    }

    function launchOf(address t) external view returns (LaunchRegistry.Launch memory r) {
        r = recs[t];
        require(r.curve != address(0), "NotRegistered");
    }

    function isRegistered(address t) external view returns (bool) {
        return recs[t].curve != address(0);
    }

    function launcherCount() external pure returns (uint256) {
        return 0;
    }
}

/// The parts of PonsV2BondingCurve the switch touches, with the same gates.
contract MockCurve {
    address public factory;
    address public feeEscrow;
    address public deployer;
    address public token;
    uint256 public pending;
    Tok public quote;
    bool public rescueReverts;
    /// Whether the curve is full. Off by default: a curve still selling.
    bool public readyToGraduate;

    constructor(address factory_, address escrow_, address deployer_, Tok quote_) {
        factory = factory_;
        feeEscrow = escrow_;
        deployer = deployer_;
        quote = quote_;
    }

    function initialize(address t) external {
        require(msg.sender == factory, "onlyFactory");
        require(token == address(0), "AlreadyInitialized");
        token = t;
    }

    function setCreatorFeeRecipient(address r) external {
        require(msg.sender == factory, "onlyFactory");
        require(r != address(0), "ZeroAddress");
        deployer = r;
    }

    function accrue(uint256 a) external {
        quote.mint(address(this), a);
        pending += a;
    }

    function setRescueReverts(bool b) external {
        rescueReverts = b;
    }

    function setReady(bool b) external {
        readyToGraduate = b;
    }

    function rescueFees() external returns (uint256, uint256) {
        require(msg.sender == factory, "onlyFactory");
        require(!rescueReverts, "blocked");
        require(pending != 0, "ZeroAmount");
        uint256 a = pending;
        pending = 0;
        quote.transfer(deployer, a);
        return (0, a);
    }
}

/// Records what the Graduator asks of the hook.
contract MockHook {
    address[] public synced;

    function syncCreator(address t) external {
        synced.push(t);
    }

    function syncedCount() external view returns (uint256) {
        return synced.length;
    }
}

/// Records the switch as the lock would read it when its fees are claimed.
contract MockLock {
    Graduator public grad;
    address public token;
    bool public reverts;
    uint256 public claims;
    address public distributorSeenAtClaim;

    constructor(Graduator g, address t) {
        grad = g;
        token = t;
    }

    function setReverts(bool b) external {
        reverts = b;
    }

    function claimFees() external {
        require(!reverts, "lock: refused");
        claims++;
        distributorSeenAtClaim = grad.holderDistributorOf(token);
    }
}

/// A distributor whose identity answers can be set freely.
contract FakeDistributor {
    address public launchToken;
    address public quoteToken;
    address public graduator;

    function set(address t, address q, address g) external {
        launchToken = t;
        quoteToken = q;
        graduator = g;
    }
}

/// A factory that hands back whatever address it is told to.
contract EvilFactory {
    address public target;

    function setTarget(address t) external {
        target = t;
    }

    function deploy(address) external view returns (address) {
        return target;
    }
}

/// A factory that calls back into the Graduator from deploy().
contract ReenteringFactory {
    Graduator public grad;
    uint256 public mode;

    constructor(Graduator g) {
        grad = g;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function deploy(address token) external returns (address) {
        if (mode == 0) grad.enableHolderSharing(token, address(this));
        else if (mode == 1) grad.enableHolderSharingAtLaunch(token, address(this));
        else if (mode == 2) grad.graduate(token);
        else grad.rescueCurveFees(token);
        return address(0);
    }
}

/// The buyer whose buy fills a curve, in one call: the fill (here the mock's
/// flag; the fork test buys it out with its graduation starved), the note,
/// and the rescue.
contract SameTxRescuer {
    function fillNoteAndRescue(Graduator grad, MockCurve curve, address token) external {
        curve.setReady(true);
        grad.noteReady(token);
        grad.rescueCurveFees(token);
    }
}

// ---------------------------------------------------------------------------
// The switch, the catalog, the identity checks, the guard
// ---------------------------------------------------------------------------

contract HolderSharingTest is Test {
    event HolderSharingEnabled(
        address indexed launchToken,
        address indexed distributor,
        address indexed factory,
        address by,
        bool graduated,
        uint64 sinceBlock
    );

    MockReg reg;
    SharingCatalog cat;
    Graduator grad;
    TestDistributorFactory dfac;
    Tok quote;
    Tok token;
    MockCurve curve;
    MockHook hook;

    address creator = makeAddr("creator");
    address refund = makeAddr("refund address");
    address platform = makeAddr("platform recipient");
    address escrow = makeAddr("fee escrow");
    address alice = makeAddr("alice");
    address launcher = makeAddr("launcher");
    address constant PM = address(0x1111);
    address constant POSM = address(0x2222);

    function setUp() public {
        reg = new MockReg();
        cat = new SharingCatalog(address(this), address(this));
        grad = new Graduator(
            IPoolManager(PM),
            IPositionManagerMinimal(POSM),
            IPermit2Minimal(address(0x3333)),
            LaunchRegistry(address(reg)),
            ISharingCatalog(address(cat))
        );
        dfac = new TestDistributorFactory(LaunchRegistry(address(reg)), address(grad));
        cat.admitInitial(address(dfac));
        quote = new Tok();
        hook = new MockHook();
        reg.setLauncher(launcher);
        (token, curve) = _newLaunch();
    }

    /// A launch whose curve is initialized for its token, as every registered
    /// launch's is: the registry refuses a record whose curve dispenses another
    /// token, and the Graduator asks again at every door.
    function _newLaunch() internal returns (Tok t, MockCurve c) {
        (t, c) = _newUninitializedLaunch();
        vm.prank(address(grad));
        c.initialize(address(t));
    }

    /// The same before its launcher has initialized the curve - for the
    /// at-launch door, whose mark only initializeCurve leaves.
    function _newUninitializedLaunch() internal returns (Tok t, MockCurve c) {
        t = new Tok();
        c = new MockCurve(address(grad), escrow, creator, quote);
        reg.set(
            address(t),
            LaunchRegistry.Launch({
                curve: address(c),
                quoteToken: address(quote),
                beneficiary: creator,
                refundTo: refund,
                reservedZero: 0,
                fee: 3000,
                tickSpacing: 60,
                hooks: IHooks(address(hook)),
                totalTaxBps: 300,
                platformBps: 50,
                platformRecipient: platform,
                launchedAt: 0
            })
        );
    }

    function _approveLater(address f) internal {
        cat.propose(f);
        vm.warp(vm.getBlockTimestamp() + cat.ADMISSION_DELAY());
    }

    // ------------------------------------------------------------ 1. who

    function test_onlyTheBeneficiaryCanEnable() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheBeneficiary.selector, alice));
        grad.enableHolderSharing(address(token), address(dfac));
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheBeneficiary.selector, launcher));
        grad.enableHolderSharing(address(token), address(dfac));

        vm.prank(creator);
        address d = grad.enableHolderSharing(address(token), address(dfac));
        assertEq(d, dfac.predict(address(token)), "not the factory's distributor for this token");
    }

    // ------------------------------------------------------------ 2. which factory

    function test_aFactoryTheCatalogDoesNotApproveIsRefused() public {
        TestDistributorFactory later = new TestDistributorFactory(LaunchRegistry(address(reg)), address(grad));
        // never proposed
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.FactoryNotApproved.selector, address(later)));
        grad.enableHolderSharing(address(token), address(later));

        // proposed, one second short of its delay
        cat.propose(address(later));
        vm.warp(vm.getBlockTimestamp() + cat.ADMISSION_DELAY() - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.FactoryNotApproved.selector, address(later)));
        grad.enableHolderSharing(address(token), address(later));

        // retired, even though it was approved
        cat.retire(address(dfac));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.FactoryNotApproved.selector, address(dfac)));
        grad.enableHolderSharing(address(token), address(dfac));

        // and once the delay has run, the proposed one works
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(creator);
        address d = grad.enableHolderSharing(address(token), address(later));
        assertEq(d, later.predict(address(token)), "the admitted factory was not used");
    }

    // ------------------------------------------------------------ 3. the catalog

    /// An address that holds no code here, on a fresh chain and on the Base
    /// fork alike. makeAddr's labels are private keys anybody can derive -
    /// makeAddr("eoa") and makeAddr("alice") carry EIP-7702 code on Base - so
    /// this one is a bare hash, which no key signs for.
    function _noCode(string memory label) internal view returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encodePacked("curb.HolderSharing.", label)))));
        require(a.code.length == 0, "the no-code address holds code here");
    }

    function test_catalog_admitInitialOnceOnlyForTheBootstrapperOnlyBeforeTheDeadline() public {
        SharingCatalog c = new SharingCatalog(address(this), alice);
        assertEq(c.bootstrapUntil(), uint64(vm.getBlockTimestamp()) + 1 days, "the window is not one day");

        vm.expectRevert(SharingCatalog.NotTheBootstrapper.selector);
        c.admitInitial(address(dfac));

        address noCode = _noCode("eoa");
        vm.prank(alice);
        vm.expectRevert(SharingCatalog.NotAContract.selector);
        c.admitInitial(noCode);

        vm.prank(alice);
        c.admitInitial(address(dfac));
        assertTrue(c.isApproved(address(dfac)), "not approved at once");
        assertEq(c.recommended(), address(dfac), "not recommended");
        assertTrue(c.bootstrapped(), "not marked used");

        vm.prank(alice);
        vm.expectRevert(SharingCatalog.AlreadyBootstrapped.selector);
        c.admitInitial(address(hook));

        // a fresh catalog whose window has closed, at its exact boundary
        SharingCatalog late = new SharingCatalog(address(this), alice);
        vm.warp(late.bootstrapUntil());
        vm.prank(alice);
        vm.expectRevert(SharingCatalog.BootstrapExpired.selector);
        late.admitInitial(address(dfac));
        // and one second earlier it would have worked
        SharingCatalog edge = new SharingCatalog(address(this), alice);
        vm.warp(edge.bootstrapUntil() - 1);
        vm.prank(alice);
        edge.admitInitial(address(dfac));
        assertTrue(edge.isApproved(address(dfac)), "refused inside the window");
    }

    function test_catalog_proposeCancelRetireAndRecommend() public {
        address f = address(new TestDistributorFactory(LaunchRegistry(address(reg)), address(grad)));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        cat.propose(f);
        address noCode = _noCode("not a factory");
        vm.expectRevert(SharingCatalog.NotAContract.selector);
        cat.propose(noCode);

        cat.propose(f);
        assertEq(cat.admittedAt(f), uint64(vm.getBlockTimestamp()) + 7 days, "the delay is not seven days");
        vm.expectRevert(abi.encodeWithSelector(SharingCatalog.AlreadyProposed.selector, f));
        cat.propose(f);
        vm.expectRevert(abi.encodeWithSelector(SharingCatalog.FactoryNotApproved.selector, f));
        cat.setRecommended(f);
        assertFalse(cat.isApproved(f), "approved inside its delay");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        cat.setRecommended(address(dfac));

        // cancel: only while pending
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        cat.cancel(f);
        cat.cancel(f);
        assertEq(cat.admittedAt(f), 0, "a cancelled proposal stayed");
        vm.expectRevert(abi.encodeWithSelector(SharingCatalog.NotPending.selector, f));
        cat.cancel(f);
        vm.expectRevert(abi.encodeWithSelector(SharingCatalog.NotPending.selector, address(dfac)));
        cat.cancel(address(dfac));

        // propose again, let it ripen at its exact second
        cat.propose(f);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertTrue(cat.isApproved(f), "not approved when its delay ran out");
        cat.setRecommended(f);
        assertEq(cat.recommended(), f, "not recommended");

        // retire: immediate, permanent, clears the recommendation
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        cat.retire(f);
        cat.retire(f);
        assertFalse(cat.isApproved(f), "a retired factory is approved");
        assertEq(cat.recommended(), address(0), "a retired factory is still recommended");
        vm.expectRevert(abi.encodeWithSelector(SharingCatalog.UnknownOrRetired.selector, f));
        cat.retire(f);
        vm.expectRevert(abi.encodeWithSelector(SharingCatalog.AlreadyProposed.selector, f));
        cat.propose(f);
        vm.expectRevert(abi.encodeWithSelector(SharingCatalog.UnknownOrRetired.selector, alice));
        cat.retire(alice);

        // retiring one that is not recommended leaves the recommendation alone
        assertEq(cat.recommended(), address(0));
        cat.setRecommended(address(dfac));
        address g = address(new TestDistributorFactory(LaunchRegistry(address(reg)), address(grad)));
        cat.propose(g);
        cat.retire(g);
        assertEq(cat.recommended(), address(dfac), "retiring another version moved the recommendation");
    }

    function test_catalog_refusesAZeroBootstrapper() public {
        vm.expectRevert(SharingCatalog.ZeroAddress.selector);
        new SharingCatalog(address(this), address(0));
    }

    // ------------------------------------------------------------ 4. the switch on the curve

    function test_enableRedirectsTheCurveIsOneWayAndMakesACleanCut() public {
        curve.accrue(100);
        uint64 at = uint64(vm.getBlockNumber());
        address predicted = dfac.predict(address(token));
        vm.expectEmit(true, true, true, true, address(grad));
        emit HolderSharingEnabled(address(token), predicted, address(dfac), creator, false, at);
        vm.prank(creator);
        address d = grad.enableHolderSharing(address(token), address(dfac));

        assertEq(grad.holderDistributorOf(address(token)), d, "the switch was not written");
        assertEq(grad.sharingSince(address(token)), at, "the block was not written");
        assertEq(grad.launchOfDistributor(d), address(token), "the reverse map was not written");
        assertEq(curve.deployer(), d, "the curve still pays the creator");
        // clean cut: what was pending before the switch went to the creator
        assertEq(quote.balanceOf(creator), 100, "the creator lost fees earned before the switch");
        assertEq(quote.balanceOf(d), 0, "the holders got fees earned before the switch");
        assertEq(hook.syncedCount(), 0, "a curve-stage switch touched the hook");

        // one way: no second switch, by anyone
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.AlreadySharing.selector, address(token)));
        grad.enableHolderSharing(address(token), address(dfac));

        // and later fees follow the switch
        curve.accrue(40);
        vm.prank(platform);
        grad.rescueCurveFees(address(token));
        assertEq(quote.balanceOf(d), 40, "fees after the switch did not reach the distributor");
        assertEq(quote.balanceOf(creator), 100, "the creator was paid after the switch");
    }

    /// A RESCUE THAT FAILS (an issuer blocking the creator, say) DOES NOT STOP
    /// THE SWITCH: the pending fee stays in the curve and goes to the holders.
    function test_aRefusedCleanCutStillSwitches() public {
        curve.accrue(100);
        curve.setRescueReverts(true);
        vm.prank(creator);
        address d = grad.enableHolderSharing(address(token), address(dfac));
        assertEq(curve.deployer(), d, "the switch did not happen");
        assertEq(curve.pending(), 100, "the pending fee moved");
        curve.setRescueReverts(false);
        vm.prank(platform);
        grad.rescueCurveFees(address(token));
        assertEq(quote.balanceOf(d), 100, "the pending fee did not go to the holders");
    }

    /// AFTER GRADUATION THE POOL'S LEG MOVES, NOT THE CURVE'S, AND THE LOCK'S
    /// FEES ARE CLAIMED BEFORE THE SWITCH IS WRITTEN - so they are the
    /// creator's.
    function test_enableAfterGraduationSyncsTheHookAndClaimsTheLockFirst() public {
        MockLock lock = new MockLock(grad, address(token));
        _markGraduated(address(token), address(lock));

        vm.prank(creator);
        address d = grad.enableHolderSharing(address(token), address(dfac));
        assertEq(lock.claims(), 1, "the lock's fees were not claimed");
        assertEq(lock.distributorSeenAtClaim(), address(0), "the lock was claimed after the switch was written");
        assertEq(hook.syncedCount(), 1, "the hook was not told");
        assertEq(hook.synced(0), address(token), "the hook was told about another token");
        assertEq(curve.deployer(), creator, "a graduated launch's curve recipient was moved");
        assertEq(grad.holderDistributorOf(address(token)), d, "the switch was not written");
    }

    function test_aLockThatRefusesTheCleanCutDoesNotStopTheSwitch() public {
        MockLock lock = new MockLock(grad, address(token));
        lock.setReverts(true);
        _markGraduated(address(token), address(lock));
        vm.prank(creator);
        address d = grad.enableHolderSharing(address(token), address(dfac));
        assertEq(grad.holderDistributorOf(address(token)), d, "the switch was not written");
        assertEq(hook.syncedCount(), 1, "the hook was not told");
    }

    /// hasGraduated and lockOf are public mappings declared one after the
    /// other; their slots are found by probing rather than assumed.
    function _markGraduated(address t, address lock) internal {
        bool doneG;
        bool doneL;
        for (uint256 slot = 0; slot < 16 && !(doneG && doneL); slot++) {
            bytes32 k = keccak256(abi.encode(t, slot));
            if (!doneG) {
                vm.store(address(grad), k, bytes32(uint256(1)));
                if (grad.hasGraduated(t)) {
                    doneG = true;
                    continue;
                }
                vm.store(address(grad), k, bytes32(0));
            }
            if (!doneL) {
                vm.store(address(grad), k, bytes32(uint256(uint160(lock))));
                if (grad.lockOf(t) == lock) {
                    doneL = true;
                    continue;
                }
                vm.store(address(grad), k, bytes32(0));
            }
        }
        require(doneG && doneL, "slots not found");
    }

    // ------------------------------------------------------------ 5. at launch

    function test_atLaunch_onlyTheCreatingLauncherInTheSameTransaction() public {
        (token, curve) = _newUninitializedLaunch();
        // nobody initialized this token's curve in this transaction
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheCreatingLauncher.selector, launcher));
        grad.enableHolderSharingAtLaunch(address(token), address(dfac));

        vm.prank(launcher);
        grad.initializeCurve(address(curve), address(token));

        // another admitted launcher cannot use the mark
        address other = makeAddr("another launcher");
        reg.setLauncher(other);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheCreatingLauncher.selector, other));
        grad.enableHolderSharingAtLaunch(address(token), address(dfac));
        // nor the creator through this door
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheCreatingLauncher.selector, creator));
        grad.enableHolderSharingAtLaunch(address(token), address(dfac));

        vm.prank(launcher);
        address d = grad.enableHolderSharingAtLaunch(address(token), address(dfac));
        assertEq(curve.deployer(), d, "the at-launch switch did not redirect the curve");

        // the mark is spent: the next call finds nothing, rather than the switch
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheCreatingLauncher.selector, launcher));
        grad.enableHolderSharingAtLaunch(address(token), address(dfac));
    }

    /// TRANSIENT MEANS ONE TRANSACTION. Under isolation every call below is a
    /// transaction of its own.
    /// forge-config: default.isolate = true
    function test_atLaunch_aLaterTransactionFindsNoMark() public {
        (token, curve) = _newUninitializedLaunch();
        vm.prank(launcher);
        grad.initializeCurve(address(curve), address(token));
        vm.prank(launcher);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheCreatingLauncher.selector, launcher));
        grad.enableHolderSharingAtLaunch(address(token), address(dfac));
    }

    /// THE MARK IS KEYED BY THE CURVE. A launcher that initializes a curve of
    /// its own for somebody else's token writes a slot nobody reads.
    function test_atLaunch_aLauncherWithItsOwnCurveCannotSwitchSomeoneElsesLaunch() public {
        address evil = makeAddr("evil launcher");
        reg.setLauncher(evil);
        MockCurve fake = new MockCurve(address(grad), escrow, evil, quote);
        vm.startPrank(evil);
        grad.initializeCurve(address(fake), address(token));
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheCreatingLauncher.selector, evil));
        grad.enableHolderSharingAtLaunch(address(token), address(dfac));
        vm.stopPrank();
        assertEq(grad.holderDistributorOf(address(token)), address(0), "a stranger's curve switched the launch");
    }

    function test_atLaunch_anUnadmittedLauncherCannotLeaveAMark() public {
        address stranger = makeAddr("not a launcher");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheLauncher.selector, stranger));
        grad.initializeCurve(address(curve), address(token));
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotTheCreatingLauncher.selector, stranger));
        grad.enableHolderSharingAtLaunch(address(token), address(dfac));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ 6. identity

    function _evil() internal returns (EvilFactory e) {
        e = new EvilFactory();
        _approveLater(address(e));
    }

    function _refused(EvilFactory e, address d) internal {
        e.setTarget(d);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotADistributorForThisToken.selector, d));
        grad.enableHolderSharing(address(token), address(e));
    }

    function test_identity_refusesWhatIsNotThisLaunchsDistributor() public {
        EvilFactory e = _evil();
        // no code
        _refused(e, makeAddr("an address with no code"));
        // wrong token, wrong quote, wrong graduator - each alone
        FakeDistributor f = new FakeDistributor();
        f.set(address(quote), address(quote), address(grad));
        _refused(e, address(f));
        f.set(address(token), address(token), address(grad));
        _refused(e, address(f));
        f.set(address(token), address(quote), address(this));
        _refused(e, address(f));
        // and the control: the right answers pass
        f.set(address(token), address(quote), address(grad));
        e.setTarget(address(f));
        vm.prank(creator);
        assertEq(grad.enableHolderSharing(address(token), address(e)), address(f), "a well-formed distributor was refused");
    }

    /// ONE DISTRIBUTOR, ONE LAUNCH. It answers for the second token
    /// correctly; only the reverse map refuses it.
    function test_identity_refusesADistributorAlreadyServingAnotherLaunch() public {
        EvilFactory e = _evil();
        FakeDistributor f = new FakeDistributor();
        f.set(address(token), address(quote), address(grad));
        e.setTarget(address(f));
        vm.prank(creator);
        grad.enableHolderSharing(address(token), address(e));

        (Tok token2,) = _newLaunch();
        f.set(address(token2), address(quote), address(grad));
        e.setTarget(address(f));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.NotADistributorForThisToken.selector, address(f)));
        grad.enableHolderSharing(address(token2), address(e));
    }

    /// EVERY ROLE THIS LAUNCH OR THE DEPLOYMENT ALREADY HAS IS REFUSED, even
    /// when the address answers the identity perfectly.
    function test_identity_refusesEveryInfrastructureAddress() public {
        EvilFactory e = _evil();
        address[12] memory infra = [
            address(curve),
            address(token),
            address(quote),
            address(hook),
            creator,
            refund,
            platform,
            address(grad),
            address(reg),
            PM,
            POSM,
            escrow
        ];
        for (uint256 i = 0; i < infra.length; i++) {
            address x = infra[i];
            if (x.code.length == 0) vm.etch(x, hex"00");
            vm.mockCall(x, abi.encodeWithSignature("launchToken()"), abi.encode(address(token)));
            vm.mockCall(x, abi.encodeWithSignature("quoteToken()"), abi.encode(address(quote)));
            vm.mockCall(x, abi.encodeWithSignature("graduator()"), abi.encode(address(grad)));
            _refused(e, x);
        }
    }

    // ------------------------------------------------------------ 7. the guard

    function test_aFactoryThatReentersIsRefused() public {
        ReenteringFactory r = new ReenteringFactory(grad);
        _approveLater(address(r));
        for (uint256 mode = 0; mode < 4; mode++) {
            r.setMode(mode);
            vm.prank(creator);
            vm.expectRevert(Graduator.Reentered.selector);
            grad.enableHolderSharing(address(token), address(r));
        }
        // and through the at-launch door too
        r.setMode(2);
        (token, curve) = _newUninitializedLaunch();
        vm.prank(launcher);
        grad.initializeCurve(address(curve), address(token));
        vm.prank(launcher);
        vm.expectRevert(Graduator.Reentered.selector);
        grad.enableHolderSharingAtLaunch(address(token), address(r));
    }

    function test_theGraduatorRefusesAZeroCatalog() public {
        vm.expectRevert(Graduator.ZeroAddress.selector);
        new Graduator(
            IPoolManager(PM),
            IPositionManagerMinimal(POSM),
            IPermit2Minimal(address(0x3333)),
            LaunchRegistry(address(reg)),
            ISharingCatalog(address(0))
        );
    }

    // ------------------------------------------------------------ 8. the record's curve is its own

    /// EVERY DOOR THAT MAKES A CURVE MOVE VALUE REFUSES A RECORD WHOSE CURVE IS
    /// ANOTHER LAUNCH'S, behind the registry, which refuses to write one. The
    /// record is written straight into the mock registry, the way a registry
    /// that let one through would hold it: launch X, naming the live launch's
    /// curve, with an attacker as every party. This was the audit's theft -
    /// graduate(X) took the live curve's reserve, the switch took its income.
    function test_ownCurve_everyDoorRefusesARecordNamingAnotherLaunchsCurve() public {
        Tok x = new Tok();
        LaunchRegistry.Launch memory rec = reg.launchOf(address(token));
        rec.beneficiary = alice;
        rec.refundTo = alice;
        rec.platformRecipient = alice;
        reg.set(address(x), rec);
        curve.accrue(100);
        // full, and alice is the foreign record's platform recipient, so the
        // fee hatch's caller gate lets her through and only the curve check
        // stands in the way
        curve.setReady(true);
        bytes memory refusal =
            abi.encodeWithSelector(Graduator.CurveIsAnotherLaunchs.selector, address(curve), address(token));

        vm.prank(alice);
        vm.expectRevert(refusal);
        grad.graduate(address(x));

        vm.prank(alice);
        vm.expectRevert(refusal);
        grad.rescueCurveFees(address(x));

        vm.prank(alice);
        vm.expectRevert(refusal);
        grad.enableHolderSharing(address(x), address(dfac));

        // and the note that opens the hatch to strangers
        vm.prank(alice);
        vm.expectRevert(refusal);
        grad.noteReady(address(x));
        assertEq(grad.readySince(address(x)), 0, "the foreign record was noted ready");

        assertFalse(grad.hasGraduated(address(x)), "the foreign record graduated");
        assertEq(curve.pending(), 100, "the live curve's fees moved");
        assertEq(curve.deployer(), creator, "the live curve's creator income moved");
        assertEq(grad.holderDistributorOf(address(x)), address(0), "the foreign record switched");

        // the control: the live launch's own record still opens every door
        vm.prank(creator);
        grad.rescueCurveFees(address(token));
        assertEq(quote.balanceOf(creator), 100, "the live launch's own rescue was refused");
    }

    // ------------------------------------------------------------ 9. the fee hatch's callers

    /// BEFORE THE CURVE IS FULL ONLY ITS TWO PAYEES MAY OPEN THE HATCH: the
    /// curve's creator-fee recipient and the record's platform recipient. A
    /// stranger forcing the creator's tax out as raw quote - to a creator
    /// contract built around the escrow's ETH, which cannot move a token - is
    /// the grief this stops.
    function test_rescue_beforeTheCurveIsFullOnlyItsTwoPayees() public {
        curve.accrue(100);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, alice, 0));
        grad.rescueCurveFees(address(token));
        // the refund address is not a payee of the curve
        vm.prank(refund);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, refund, 0));
        grad.rescueCurveFees(address(token));
        // and a curve still selling cannot be noted ready to start the clock
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Graduator.CurveNotReady.selector, address(curve)));
        grad.noteReady(address(token));
        assertEq(curve.pending(), 100, "a refused rescue moved the fees");

        vm.prank(creator);
        grad.rescueCurveFees(address(token));
        assertEq(quote.balanceOf(creator), 100, "the creator's own rescue did not pay it");

        curve.accrue(30);
        vm.prank(platform);
        grad.rescueCurveFees(address(token));
        assertEq(quote.balanceOf(creator), 130, "the platform recipient's rescue did not go through");
    }

    /// THE CREATOR-FEE RECIPIENT IS READ OFF THE CURVE, LIVE: after the switch
    /// it is the distributor, and the creator is no longer one of the two.
    function test_rescue_theCreatorFeeRecipientIsTheCurvesNow() public {
        vm.prank(creator);
        address d = grad.enableHolderSharing(address(token), address(dfac));
        curve.accrue(50);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, creator, 0));
        grad.rescueCurveFees(address(token));
        vm.prank(d);
        grad.rescueCurveFees(address(token));
        assertEq(quote.balanceOf(d), 50, "the distributor's rescue did not pay it");
    }

    /// ANYONE, ONCE THE CURVE HAS SAT FULL AND UNGRADUATED FOR RESCUE_DELAY:
    /// its pending fees are what can block its graduation, and that recovery
    /// must not wait for an operator. Not before - full is not stuck - and the
    /// hour runs from the first note, which a second note does not move.
    function test_rescue_aFullCurveOpensToAnyoneRescueDelayAfterItWasNoted() public {
        curve.accrue(100);
        curve.setReady(true);
        // full, and nobody has noted it: closed to a stranger
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, alice, 0));
        grad.rescueCurveFees(address(token));

        uint256 at = vm.getBlockTimestamp();
        uint256 opensAt = at + grad.RESCUE_DELAY();
        vm.expectEmit(true, true, true, true, address(grad));
        emit Graduator.ReadyNoted(address(token), at);
        vm.prank(alice);
        assertEq(grad.noteReady(address(token)), at, "the note did not return its time");
        assertEq(grad.readySince(address(token)), at, "the note was not written");

        // noted: still closed, and the refusal says until when
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, alice, opensAt));
        grad.rescueCurveFees(address(token));

        // a second note later does not move the clock
        vm.warp(opensAt - 1);
        vm.prank(refund);
        assertEq(grad.noteReady(address(token)), at, "a second note moved the clock");
        assertEq(grad.readySince(address(token)), at, "a second note rewrote the time");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, alice, opensAt));
        grad.rescueCurveFees(address(token));

        // the second it opens
        vm.warp(opensAt);
        vm.prank(alice);
        grad.rescueCurveFees(address(token));
        assertEq(quote.balanceOf(creator), 100, "a stuck curve's rescue did not pay the creator");
    }

    /// THE SAME-TRANSACTION ATTACK, AT THIS LEVEL: the buyer who fills a curve
    /// and starves its graduation notes it ready and rescues in the same call.
    /// The note is written, and opens nothing for an hour.
    function test_rescue_fillNoteAndRescueInOneTransactionIsRefused() public {
        curve.accrue(100);
        SameTxRescuer attacker = new SameTxRescuer();
        uint256 opensAt = vm.getBlockTimestamp() + grad.RESCUE_DELAY();
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, address(attacker), opensAt));
        attacker.fillNoteAndRescue(grad, curve, address(token));
        assertEq(curve.pending(), 100, "the same-transaction rescue moved the creator's fees");
        assertEq(quote.balanceOf(creator), 0, "the creator was paid raw quote");
    }

    /// GRADUATION CLOSES THE HATCH TO STRANGERS AGAIN: a curve that has moved
    /// says it is not ready, whatever the note said. And a graduated launch
    /// cannot be noted at all.
    function test_rescue_aCurveThatIsNoLongerReadyIsClosedToStrangers() public {
        curve.accrue(100);
        curve.setReady(true);
        vm.prank(alice);
        grad.noteReady(address(token));
        uint256 opensAt = grad.readySince(address(token)) + grad.RESCUE_DELAY();
        vm.warp(opensAt + 1 days);
        curve.setReady(false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, alice, opensAt));
        grad.rescueCurveFees(address(token));
        // the two payees are not gated by any of it
        vm.prank(platform);
        grad.rescueCurveFees(address(token));
        assertEq(quote.balanceOf(creator), 100, "the platform recipient's rescue was refused");

        // a graduated launch is refused a note (the flag is the Graduator's own)
        (Tok t2, MockCurve c2) = _newLaunch();
        c2.setReady(true);
        vm.store(address(grad), keccak256(abi.encode(address(t2), uint256(0))), bytes32(uint256(1)));
        assertTrue(grad.hasGraduated(address(t2)), "the hasGraduated slot moved; this case stores into the wrong one");
        vm.expectRevert(abi.encodeWithSelector(Graduator.AlreadyGraduated.selector, address(t2)));
        grad.noteReady(address(t2));
    }

    /// THE CLEAN CUT INSIDE THE SWITCH IS NOT GATED. The at-launch switch is
    /// thrown by the launcher, which is neither payee, on a curve that is not
    /// full - and the creator's pending fees still reach the creator first.
    function test_rescue_theCleanCutInsideTheSwitchIsNotGated() public {
        (token, curve) = _newUninitializedLaunch();
        vm.prank(launcher);
        grad.initializeCurve(address(curve), address(token));
        curve.accrue(70);
        vm.prank(launcher);
        address d = grad.enableHolderSharingAtLaunch(address(token), address(dfac));
        assertEq(quote.balanceOf(creator), 70, "the clean cut did not pay the creator");
        assertEq(quote.balanceOf(d), 0, "the holders got fees earned before the switch");
        assertEq(curve.pending(), 0, "the clean cut left the fees in the curve");
    }
}

// ---------------------------------------------------------------------------
// The hook's half: syncCreator and the configureLaunch re-call rule
// ---------------------------------------------------------------------------

contract MockOpener {
    mapping(address => address) public holderDistributorOf;
    address public positionManager = address(0x2222);

    function set(address t, address d) external {
        holderDistributorOf[t] = d;
    }

    function configure(FeeHook h, address t, PoolKey calldata key) external {
        h.configureLaunch(t, key);
    }

    function sync(FeeHook h, address t) external {
        h.syncCreator(t);
    }
}

contract FeeHookSharingTest is Test {
    using PoolIdLibrary for PoolKey;

    event CreatorRedirected(PoolId indexed poolId, address indexed launchToken, address previous, address distributor);

    MockReg reg;
    MockOpener opener;
    FeeHook hook;
    address constant PM = address(0x1111);
    address creator = makeAddr("creator");
    address platform = makeAddr("platform");
    address token = address(0xA000);
    address quote = address(0xB000);
    address d = makeAddr("distributor");
    PoolKey key;

    function setUp() public {
        reg = new MockReg();
        opener = new MockOpener();
        hook = new FeeHook(IPoolManager(PM), platform, LaunchRegistry(address(reg)), address(opener), address(this));
        reg.set(
            token,
            LaunchRegistry.Launch({
                curve: address(0xC000),
                quoteToken: quote,
                beneficiary: creator,
                refundTo: creator,
                reservedZero: 0,
                fee: 3000,
                tickSpacing: 60,
                hooks: IHooks(address(hook)),
                totalTaxBps: 300,
                platformBps: 50,
                platformRecipient: platform,
                launchedAt: 0
            })
        );
        key = PoolKey({
            currency0: Currency.wrap(token),
            currency1: Currency.wrap(quote),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function test_syncCreator_refusesAnyoneButThePoolOpener() public {
        opener.configure(hook, token, key);
        opener.set(token, d);
        vm.expectRevert(abi.encodeWithSelector(FeeHook.NotThePoolOpener.selector, address(this)));
        hook.syncCreator(token);
    }

    function test_syncCreator_refusesAnUnconfiguredPool() public {
        opener.set(token, d);
        vm.expectRevert(abi.encodeWithSelector(FeeHook.PoolNotConfigured.selector, key.toId()));
        opener.sync(hook, token);
    }

    function test_syncCreator_refusesALaunchThatIsNotSharing() public {
        opener.configure(hook, token, key);
        vm.expectRevert(abi.encodeWithSelector(FeeHook.NotSharing.selector, token));
        opener.sync(hook, token);
    }

    function test_syncCreator_movesTheLegOnceAndForGood() public {
        opener.configure(hook, token, key);
        opener.set(token, d);
        vm.expectEmit(true, true, false, true, address(hook));
        emit CreatorRedirected(key.toId(), token, creator, d);
        opener.sync(hook, token);
        FeeHook.LaunchFee memory f = hook.feeOf(key);
        assertEq(f.creator, d, "the creator leg did not move");
        assertTrue(f.holderShared, "the flag was not set");
        (,, address c,,,) = hook.taxOfId(key.toId());
        assertEq(c, d, "taxOfId does not show the distributor");

        vm.expectRevert(abi.encodeWithSelector(FeeHook.AlreadyShared.selector, key.toId()));
        opener.sync(hook, token);
        // even if the source were to answer differently, nothing moves again
        opener.set(token, makeAddr("another distributor"));
        vm.expectRevert(abi.encodeWithSelector(FeeHook.AlreadyShared.selector, key.toId()));
        opener.sync(hook, token);
    }

    function test_syncCreator_refusesTheHookAndThePoolManager() public {
        opener.configure(hook, token, key);
        opener.set(token, address(hook));
        vm.expectRevert(FeeHook.RecipientIsTheHook.selector);
        opener.sync(hook, token);
        opener.set(token, PM);
        vm.expectRevert(abi.encodeWithSelector(FeeHook.RecipientIsDeploymentContract.selector, PM));
        opener.sync(hook, token);
    }

    /// A SECOND configureLaunch FOR THE SAME LAUNCH STAYS A NO-OP AFTER THE
    /// LEG MOVED - and still refuses a creator that is neither the record's
    /// beneficiary nor the switch's distributor.
    function test_configureLaunch_isStillANoOpAfterTheLegMoved() public {
        opener.configure(hook, token, key);
        opener.configure(hook, token, key); // before: creator == beneficiary
        opener.set(token, d);
        opener.sync(hook, token);
        opener.configure(hook, token, key); // after: creator == distributor
        assertEq(hook.feeOf(key).creator, d, "the re-call rewrote the leg");

        opener.set(token, makeAddr("a different distributor"));
        vm.expectRevert(abi.encodeWithSelector(FeeHook.AlreadyConfiguredDifferently.selector, key.toId()));
        opener.configure(hook, token, key);
    }
}

// ---------------------------------------------------------------------------
// The lock: live recipient, collect-or-hold, release, and no way out
// ---------------------------------------------------------------------------

/// The PositionManager calls a lock could make, with v4's shapes: fees on a
/// zero-liquidity decrease, principal on a full one, minimums and deadline
/// enforced, TAKE_PAIR to the named recipient. It still removes principal on a
/// full decrease, so a lock that asked for it would be seen doing so.
contract MockPosm {
    using PositionInfoLibrary for PositionInfo;

    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint128) public liq;
    mapping(uint256 => PositionInfo) internal info;
    address public t0;
    address public t1;
    uint256 public fee0;
    uint256 public fee1;
    uint256 public prin0;
    uint256 public prin1;

    function mintPosition(address to, uint256 id, PoolKey memory key, uint128 l, uint256 p0, uint256 p1) external {
        ownerOf[id] = to;
        liq[id] = l;
        info[id] = PositionInfoLibrary.initialize(key, -60, 60);
        t0 = Currency.unwrap(key.currency0);
        t1 = Currency.unwrap(key.currency1);
        prin0 = p0;
        prin1 = p1;
    }

    function accrue(uint256 a0, uint256 a1) external {
        fee0 += a0;
        fee1 += a1;
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        ownerOf[id] = to;
        PositionLock(to).onERC721Received(msg.sender, from, id, "");
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && msg.sender == from, "not owner");
        ownerOf[id] = to;
    }

    function positionInfo(uint256 id) external view returns (PositionInfo) {
        return info[id];
    }

    function getPositionLiquidity(uint256 id) external view returns (uint128) {
        return liq[id];
    }

    function modifyLiquidities(bytes calldata data, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "DeadlinePassed");
        (bytes memory actions, bytes[] memory params) = abi.decode(data, (bytes, bytes[]));
        require(actions.length == 2 && uint8(actions[0]) == 0x01 && uint8(actions[1]) == 0x11, "actions");
        (uint256 id, uint256 l, uint128 min0, uint128 min1,) =
            abi.decode(params[0], (uint256, uint256, uint128, uint128, bytes));
        (,, address to) = abi.decode(params[1], (Currency, Currency, address));
        require(ownerOf[id] == msg.sender, "not the owner");
        uint256 a0 = fee0;
        uint256 a1 = fee1;
        fee0 = 0;
        fee1 = 0;
        if (l != 0) {
            require(l == liq[id], "partial");
            a0 += prin0;
            a1 += prin1;
            prin0 = 0;
            prin1 = 0;
            liq[id] = 0;
            require(a0 >= min0 && a1 >= min1, "slippage");
        }
        if (a0 != 0) require(ERC20(t0).transfer(to, a0), "t0");
        if (a1 != 0) require(ERC20(t1).transfer(to, a1), "t1");
    }
}

contract MockSource {
    mapping(address => address) public holderDistributorOf;

    function set(address t, address d) external {
        holderDistributorOf[t] = d;
    }
}

contract PositionLockSharingTest is Test {
    MockPosm posm;
    MockSource source;
    PolicyTok t0;
    PolicyTok t1;
    PoolKey key;
    PositionLock lock;
    address token = makeAddr("launch token");
    address creator = makeAddr("creator");
    address d = makeAddr("distributor");
    address to = makeAddr("the creator's other address");
    uint256 constant ID = 7;
    address stranger = makeAddr("stranger");

    event FeesHeld(address indexed party, uint256 indexed currencyIndex, uint256 amount);

    function setUp() public {
        posm = new MockPosm();
        source = new MockSource();
        PolicyTok a = new PolicyTok();
        PolicyTok b = new PolicyTok();
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
        key = PoolKey({
            currency0: Currency.wrap(address(t0)),
            currency1: Currency.wrap(address(t1)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        lock = new PositionLock(IPositionManagerMinimal(address(posm)), creator, key, ID, address(source), token);
        posm.mintPosition(address(this), ID, key, 1e18, 1000e18, 2000e18);
        t0.mint(address(posm), 1_000_000e18);
        t1.mint(address(posm), 1_000_000e18);
        posm.safeTransferFrom(address(this), address(lock), ID);
        assertTrue(lock.holdsPosition(), "the lock did not take the position");
    }

    function _share() internal {
        source.set(token, d);
    }

    function test_feeRecipientFollowsTheSwitch() public {
        assertEq(lock.feeRecipient(), creator, "not the beneficiary while sharing is off");
        posm.accrue(10, 20);
        lock.claimFees();
        assertEq(t0.balanceOf(creator), 10, "the beneficiary was not paid before the switch");
        assertEq(t1.balanceOf(creator), 20, "the beneficiary was not paid before the switch");

        _share();
        assertEq(lock.feeRecipient(), d, "not the distributor once sharing is on");
        posm.accrue(5, 7);
        lock.claimFees();
        assertEq(t0.balanceOf(d), 5, "the distributor was not paid after the switch");
        assertEq(t1.balanceOf(d), 7, "the distributor was not paid after the switch");
        assertEq(t0.balanceOf(creator), 10, "the beneficiary was paid after the switch");
    }

    function test_aLockBuiltOutsideGraduationAlwaysPaysTheBeneficiary() public {
        PositionLock plain = new PositionLock(
            IPositionManagerMinimal(address(posm)), creator, key, ID + 1, address(0), address(0)
        );
        source.set(address(0), d);
        assertEq(plain.feeRecipient(), creator, "a lock with no source followed something");
        // AN EMPTY LOCK HAS NOTHING TO CLAIM, and says so itself rather than
        // leaving it to the PositionManager.
        vm.expectRevert(PositionLock.NoPositionHeld.selector);
        plain.claimFees();
    }

    function test_aRefusedPushIsHeldForTheRightPartyAndReleased() public {
        _share();
        t1.setBlocked(d, true);
        posm.accrue(5, 7);
        vm.expectEmit(true, true, false, true, address(lock));
        emit FeesHeld(d, 1, 7);
        lock.claimFees();
        assertEq(t0.balanceOf(d), 5, "the deliverable currency was not delivered");
        assertEq(lock.held(d, 1), 7, "the refused amount was not held for the distributor");
        assertEq(lock.held(creator, 1), 0, "the refused amount was held for the beneficiary");
        assertEq(t1.balanceOf(address(lock)), 7, "the lock does not hold what it booked");

        vm.expectRevert(); // still blocked: release reverts and keeps the booking
        lock.release(d);
        assertEq(lock.held(d, 1), 7, "a failed release dropped the booking");

        t1.setBlocked(d, false);
        lock.release(d);
        assertEq(t1.balanceOf(d), 7, "release did not pay the distributor");
        assertEq(lock.held(d, 1), 0, "release left the booking");
        vm.expectRevert(abi.encodeWithSelector(PositionLock.NothingHeld.selector, d));
        lock.release(d);
    }

    function test_aFalseReturnOrATransferThatMovesNothingIsHeld() public {
        _share();
        t0.setReturnFalse(d);
        t1.setLie(d);
        posm.accrue(3, 4);
        lock.claimFees();
        assertEq(lock.held(d, 0), 3, "a false return was counted as delivered");
        assertEq(lock.held(d, 1), 4, "a transfer that moved nothing was counted as delivered");
        assertEq(t0.balanceOf(d), 0);
        assertEq(t1.balanceOf(d), 0);
    }

    /// THE BALANCE DECIDES. A token that moves the amount and then returns
    /// false has delivered it; holding it as well would promise the party
    /// tokens the lock no longer has.
    function test_aTransferThatMovesTheAmountButReturnsFalseIsDelivered() public {
        _share();
        t0.setMoveButFalse(d);
        posm.accrue(6, 0);
        lock.claimFees();
        assertEq(t0.balanceOf(d), 6, "the amount did not move");
        assertEq(lock.held(d, 0), 0, "a delivered amount was also held");
        assertEq(t0.balanceOf(address(lock)), 0, "the lock kept something");
    }

    function test_aBeneficiaryHeldBeforeTheSwitchIsReleasedToTheBeneficiary() public {
        t0.setBlocked(creator, true);
        posm.accrue(9, 0);
        lock.claimFees();
        assertEq(lock.held(creator, 0), 9, "not held for the beneficiary");
        _share();
        // a claim after the switch counts only what it collected, never what
        // is already held here for somebody else
        posm.accrue(0, 5);
        lock.claimFees();
        assertEq(t1.balanceOf(d), 5, "the post-switch fees did not reach the distributor");
        assertEq(t0.balanceOf(d), 0, "a claim paid the holders what was held for the beneficiary");
        t0.setBlocked(creator, false);
        lock.release(creator);
        assertEq(t0.balanceOf(creator), 9, "the pre-switch hold did not go to the beneficiary");
        assertEq(t0.balanceOf(d), 0, "the pre-switch hold went to the holders");
    }

    /// STARVING THE TRANSFER NEVER PAYS THE WRONG PARTY: at every gas limit
    /// the call either reverts or settles the whole amount for the
    /// distributor, delivered or held.
    function test_aGasStarvedClaimBooksOrRevertsAndNeverPaysTheWrongParty() public {
        _share();
        t0.setBurnGas(60_000);
        uint256 settledRuns;
        uint256 heldRuns;
        uint256 revertedRuns;
        for (uint256 g = 80_000; g < 400_000; g += 4_000) {
            uint256 snap = vm.snapshotState();
            posm.accrue(11, 0);
            (bool ok,) = address(lock).call{gas: g}(abi.encodeCall(PositionLock.claimFees, ()));
            assertEq(t0.balanceOf(creator), 0, "the beneficiary was paid after the switch");
            if (ok) {
                uint256 delivered = t0.balanceOf(d);
                uint256 held_ = lock.held(d, 0);
                assertEq(delivered + held_, 11, "a successful claim lost part of the fees");
                assertEq(lock.held(creator, 0), 0, "held for the wrong party");
                settledRuns++;
                if (held_ != 0) heldRuns++;
            } else {
                assertEq(posm.fee0(), 11, "a reverted claim moved the fees");
                revertedRuns++;
            }
            vm.revertToState(snap);
        }
        assertGt(settledRuns, 0, "no gas limit was enough to settle");
        assertGt(revertedRuns, 0, "no gas limit was short enough to matter");
        heldRuns;
    }

    // ---- NOTHING TAKES THE LIQUIDITY OUT, EVER.
    //
    // The mock PositionManager above still pays out principal on a full
    // decrease and still lets the owner transfer the NFT, so a lock that asked
    // for either would be seen doing it. Every check below is the same three
    // facts: the NFT is the lock's, the liquidity is whole, and the principal
    // the mock would pay out is still in it.

    function _intact(string memory when) internal view {
        assertEq(posm.ownerOf(ID), address(lock), string.concat("the NFT left the lock ", when));
        assertEq(posm.liq(ID), 1e18, string.concat("liquidity left the lock ", when));
        assertEq(posm.prin0(), 1000e18, string.concat("principal0 was paid out ", when));
        assertEq(posm.prin1(), 2000e18, string.concat("principal1 was paid out ", when));
        assertTrue(lock.holdsPosition(), string.concat("the lock let go of the position ", when));
        assertEq(lock.lockedLiquidity(), 1e18, string.concat("the lock reports less liquidity ", when));
    }

    /// Every caller, every call this lock has or ever had, sharing off and on,
    /// now and after ten years.
    function _tryEverything() internal {
        address[7] memory callers = [creator, d, to, stranger, address(this), address(posm), address(source)];
        for (uint256 c = 0; c < callers.length; c++) {
            bytes[8] memory calls = [
                abi.encodeWithSignature("withdraw()"),
                abi.encodeWithSignature(
                    "withdrawLiquidity(uint128,uint128,address,uint256)", 0, 0, callers[c], type(uint256).max
                ),
                abi.encodeWithSignature("withdrawLiquidity(uint128,uint128,address,uint256)", 0, 0, to, type(uint256).max),
                abi.encodeWithSignature("claimFees()"),
                abi.encodeWithSignature("release(address)", callers[c]),
                abi.encodeWithSignature("release(address)", creator),
                abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", callers[c], callers[c], ID, ""),
                abi.encodeWithSignature("unlockTime()")
            ];
            for (uint256 k = 0; k < calls.length; k++) {
                vm.prank(callers[c]);
                (bool ok,) = address(lock).call(calls[k]);
                ok;
            }
        }
    }

    function test_noCallerAtAnyTimeTakesTheLiquidityOut() public {
        posm.accrue(3, 4);
        _tryEverything();
        _intact("at launch");

        vm.warp(vm.getBlockTimestamp() + 180 days);
        _tryEverything();
        _intact("after 180 days");

        vm.warp(vm.getBlockTimestamp() + 10 * 365 days);
        _tryEverything();
        _intact("after ten years, sharing off");

        _share();
        _tryEverything();
        _intact("after ten years, sharing on");

        vm.warp(vm.getBlockTimestamp() + 90 * 365 days);
        _tryEverything();
        _intact("after a hundred years, sharing on");
    }

    /// The same, with calldata nobody chose: any caller, any selector, any
    /// arguments, any time up to ten years out, either side of the switch.
    function testFuzz_noCalldataTakesTheLiquidityOut(address caller, bytes calldata data, uint32 dt, bool sharing)
        public
    {
        if (sharing) _share();
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 10 * 365 days));
        posm.accrue(1, 1);
        vm.prank(caller);
        (bool ok,) = address(lock).call(data);
        ok;
        _intact("after an arbitrary call");
    }

    /// THE LOCK HAS NO UNLOCK TIME AND NO WITHDRAWAL TO CALL. Asked by
    /// selector, so a reintroduced one fails here by name.
    function test_theLockHasNoUnlockTimeAndNoWithdrawal() public {
        vm.warp(vm.getBlockTimestamp() + 10 * 365 days);
        string[3] memory gone = ["withdraw()", "withdrawLiquidity(uint128,uint128,address,uint256)", "unlockTime()"];
        for (uint256 i = 0; i < gone.length; i++) {
            vm.prank(creator);
            (bool ok, bytes memory ret) = address(lock).call(
                abi.encodePacked(bytes4(keccak256(bytes(gone[i]))), abi.encode(uint256(0), uint256(0), to, type(uint256).max))
            );
            assertFalse(ok, string.concat("the lock answered ", gone[i]));
            assertEq(ret.length, 0, string.concat("the lock has a function behind ", gone[i]));
        }
        _intact("after asking for a withdrawal");
    }

    /// FEES KEEP FLOWING, to the right party, before and after the switch and
    /// across ten years - and none of it is principal.
    function test_feesFlowToTheRightPartyForYearsAndThePrincipalStays() public {
        posm.accrue(10, 20);
        lock.claimFees();
        assertEq(t0.balanceOf(creator), 10, "the beneficiary was not paid at first");
        assertEq(t1.balanceOf(creator), 20, "the beneficiary was not paid at first");

        vm.warp(vm.getBlockTimestamp() + 10 * 365 days);
        posm.accrue(1, 2);
        vm.prank(stranger);
        lock.claimFees();
        assertEq(t0.balanceOf(creator), 11, "the beneficiary was not paid ten years on");
        assertEq(t1.balanceOf(creator), 22, "the beneficiary was not paid ten years on");

        _share();
        posm.accrue(5, 7);
        vm.prank(stranger);
        lock.claimFees();
        assertEq(t0.balanceOf(d), 5, "the distributor was not paid after the switch");
        assertEq(t1.balanceOf(d), 7, "the distributor was not paid after the switch");

        vm.warp(vm.getBlockTimestamp() + 10 * 365 days);
        posm.accrue(8, 9);
        vm.prank(creator);
        lock.claimFees();
        assertEq(t0.balanceOf(d), 13, "the distributor was not paid ten more years on");
        assertEq(t1.balanceOf(d), 16, "the distributor was not paid ten more years on");
        assertEq(t0.balanceOf(creator), 11, "the beneficiary was paid after the switch");
        assertEq(t0.balanceOf(to) + t1.balanceOf(to) + t0.balanceOf(stranger) + t1.balanceOf(stranger), 0,
            "someone other than the fee recipient was paid");
        _intact("after twenty years of fees");
    }

    function test_theLockRefusesANativeCurrencyPool() public {
        PoolKey memory native = key;
        native.currency0 = Currency.wrap(address(0));
        vm.expectRevert(PositionLock.NativeCurrencyNotSupported.selector);
        new PositionLock(IPositionManagerMinimal(address(posm)), creator, native, ID, address(0), address(0));
        native = key;
        native.currency1 = Currency.wrap(address(0));
        vm.expectRevert(PositionLock.NativeCurrencyNotSupported.selector);
        new PositionLock(IPositionManagerMinimal(address(posm)), creator, native, ID, address(0), address(0));
    }
}
