// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {PonsV2BondingCurve} from "../../src/vendor/PonsV2BondingCurve.sol";
import {Graduator} from "../../src/curb/Graduator.sol";
import {LaunchRegistry, IRegisteredCurve} from "../../src/curb/LaunchRegistry.sol";
import {PositionLock} from "../../src/curb/PositionLock.sol";

import {MockQuoteToken} from "../mocks/Mocks.sol";
import {HolderSharingForkBase} from "./HolderSharing.t.sol";

/// A LAUNCHER THE REGISTRY'S OWNER ADMITS BY MISTAKE, OR UNDER A STOLEN KEY.
/// It passes every admission check because it names the real graduator and an
/// escrow, and then registers whatever record it is handed.
contract HostileLauncher {
    address public immutable graduator;
    address public immutable feeEscrow;

    constructor(address graduator_, address feeEscrow_) {
        graduator = graduator_;
        feeEscrow = feeEscrow_;
    }

    function registerOver(LaunchRegistry r, address launchToken, LaunchRegistry.Launch calldata rec) external {
        r.register(launchToken, rec);
    }
}

/// A CURVE THAT ANSWERS THE REGISTRY'S THREE QUESTIONS WITH WHATEVER WORDS IT
/// IS GIVEN: right, wrong, dirty, or a spin until its gas is gone.
contract AnsweringCurve {
    bytes32 public tokenWord;
    bytes32 public pairWord;
    bytes32 public factoryWord;
    bool public spin;

    function set(address token_, address pair_, address factory_) external {
        tokenWord = bytes32(uint256(uint160(token_)));
        pairWord = bytes32(uint256(uint160(pair_)));
        factoryWord = bytes32(uint256(uint160(factory_)));
    }

    function setTokenWord(bytes32 w) external {
        tokenWord = w;
    }

    function setSpin(bool s) external {
        spin = s;
    }

    function token() external view returns (bytes32) {
        if (spin) {
            uint256 i;
            while (i != type(uint256).max) i++;
        }
        return tokenWord;
    }

    function pairToken() external view returns (bytes32) {
        return pairWord;
    }

    function factory() external view returns (bytes32) {
        return factoryWord;
    }
}

/// THE CURVE-REUSE THEFT OF THE 2026-10-08 AUDIT, AS IT WAS RUN, AND REFUSED.
///
/// The registry tied nothing in a record to its curve, and the Graduator holds
/// every curve's factory role. So an admitted launcher could register a token
/// of its own over a LIVE launch's curve. The audit ran it on this fork, on the
/// real PoolManager and PositionManager, and it worked both ways:
///   PATH B, the reserve: the attacker bought the curve out with its automatic
///     graduation starved of gas, graduated it under its own token - the curve
///     handed its whole reserve and its tokens to the Graduator - and drained
///     the pool it opened with freely minted tokens: 3.9006 of the curve's 3.94
///     WETH, the live launch's 270M tokens stranded and its holders frozen.
///   PATH A, the income: as its own record's beneficiary the attacker switched
///     holder sharing on, and the live curve's creator income went to the
///     attacker's distributor.
/// register() now asks the curve whether a record is its own, and refuses a
/// curve another record already names; the Graduator asks again at every door.
/// Each test below makes the attack's first move and reads the refusal, then
/// shows the live launch untouched by everything that came after.
contract CurveReuseForkTest is HolderSharingForkBase {
    address internal attacker = makeAddr("curve-reuse attacker");
    address internal victim = makeAddr("a buyer of the live launch");

    function _hostile(Stack memory s) internal returns (HostileLauncher h) {
        h = new HostileLauncher(address(s.graduator), address(0xdead));
        s.registry.addLauncher(address(h));
    }

    /// The audit's record: every party the attacker, its own token, and the
    /// LIVE launch's curve.
    function _recordOver(Stack memory s, address curve) internal view returns (LaunchRegistry.Launch memory) {
        return LaunchRegistry.Launch({
            curve: curve,
            quoteToken: s.a.quote,
            beneficiary: attacker,
            refundTo: attacker,
            reservedZero: 0,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(s.hook)),
            totalTaxBps: 100,
            platformBps: 0,
            platformRecipient: attacker,
            launchedAt: 0
        });
    }

    function _buyAs(Stack memory s, PonsV2BondingCurve curve, address who, uint256 amount) internal {
        _fund(s.a, who, amount);
        vm.startPrank(who);
        SafeERC20.forceApprove(IERC20(s.a.quote), address(curve), type(uint256).max);
        curve.buy(amount, 0, who);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ the theft, both paths

    /// PATH B: THE RESERVE. Refused at the record; and the curve the attacker
    /// bought out still graduates into its own launch's pool and lock.
    function test_pathB_aLauncherCannotGraduateALiveCurveUnderItsOwnToken() public onlyFork {
        Stack memory s = _stack(_weth());
        Launched memory l = _launch(s, address(0), 0);
        _buyAs(s, l.curve, victim, 3.5e18);
        assertFalse(l.curve.readyToGraduate(), "the victim alone filled the curve; the premise moved");

        HostileLauncher h = _hostile(s);
        MockQuoteToken x = new MockQuoteToken("X", "X", 18);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRegistry.CurveDoesNotMatch.selector, address(l.curve), IRegisteredCurve.token.selector
            )
        );
        h.registerOver(s.registry, address(x), _recordOver(s, address(l.curve)));
        assertFalse(s.registry.isRegistered(address(x)), "the hostile record was written");
        assertEq(s.registry.launchOfCurve(address(l.curve)), address(l.token), "the live curve changed hands");

        // AND THE REST OF THE ATTACK FINDS NOTHING TO STAND ON. The curve is
        // bought out with its automatic graduation starved, as the audit did.
        _fund(s.a, attacker, 5e18);
        vm.prank(attacker);
        SafeERC20.forceApprove(IERC20(s.a.quote), address(l.curve), type(uint256).max);
        uint256 snap = vm.snapshotState();
        bool readyNotGraduated;
        for (uint256 g = 250_000; g < 2_000_000; g += 10_000) {
            vm.prank(attacker);
            try l.curve.buy{gas: g}(5e18, 0, attacker) {
                if (l.curve.readyToGraduate() && !l.curve.graduated()) {
                    readyNotGraduated = true;
                    break;
                }
            } catch {}
            vm.revertToState(snap);
        }
        assertTrue(readyNotGraduated, "could not leave the curve full but ungraduated");

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.NotRegistered.selector, address(x)));
        s.graduator.graduate(address(x));

        uint256 attackerQuote = IERC20(s.a.quote).balanceOf(attacker);
        (PositionLock lock,,) = s.graduator.graduate(address(l.token));
        assertTrue(l.curve.graduated(), "the live curve did not graduate");
        assertEq(lock.beneficiary(), creator, "the live launch's position is locked for someone else");
        assertEq(s.graduator.lockOf(address(l.token)), address(lock), "the live launch has no lock");
        assertEq(l.token.balanceOf(address(s.graduator)), 0, "launch tokens were stranded in the graduator");
        assertEq(IERC20(s.a.quote).balanceOf(attacker), attackerQuote, "the attacker took quote");
    }

    /// PATH A: THE INCOME. Refused at the record; the attacker's switch has no
    /// record to stand on, and the live curve still pays its creator.
    function test_pathA_aLauncherCannotRedirectALiveCurvesCreatorIncome() public onlyFork {
        Stack memory s = _stack(_weth());
        Launched memory l = _launch(s, address(0), 0);
        assertEq(l.curve.deployer(), creator, "the curve does not pay its creator to begin with");

        HostileLauncher h = _hostile(s);
        address x = address(new MockQuoteToken("X", "X", 18));
        vm.expectRevert(
            abi.encodeWithSelector(
                LaunchRegistry.CurveDoesNotMatch.selector, address(l.curve), IRegisteredCurve.token.selector
            )
        );
        h.registerOver(s.registry, x, _recordOver(s, address(l.curve)));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.NotRegistered.selector, x));
        s.graduator.enableHolderSharing(x, address(s.dfac));

        assertEq(l.curve.deployer(), creator, "the live curve's creator income moved");
        assertEq(s.graduator.holderDistributorOf(address(l.token)), address(0), "the live launch was switched");

        // a trade on the live launch, swept by its creator: the creator is paid
        _buyAs(s, l.curve, victim, 1e18);
        uint256 tax = l.curve.creatorTaxBalance();
        assertGt(tax, 0, "the trade left no creator tax");
        vm.prank(creator);
        l.curve.sweepFees(0);
        assertEq(s.escrow.balanceOfToken(creator, s.a.quote), tax, "the creator's tax went elsewhere");
    }

    /// AND NOT UNDER THE LIVE TOKEN EITHER: that record exists and is never
    /// rewritten, by any launcher.
    function test_aLauncherCannotReRegisterTheLiveTokenOverItsOwnCurve() public onlyFork {
        Stack memory s = _stack(_weth());
        Launched memory l = _launch(s, address(0), 0);
        HostileLauncher h = _hostile(s);
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.AlreadyRegistered.selector, address(l.token)));
        h.registerOver(s.registry, address(l.token), _recordOver(s, address(l.curve)));
    }

    // ------------------------------------------------------------ what register() asks of the curve

    function _plainRecord(Stack memory s, address curve) internal view returns (LaunchRegistry.Launch memory) {
        return LaunchRegistry.Launch({
            curve: curve,
            quoteToken: s.a.quote,
            beneficiary: creator,
            refundTo: refundTo,
            reservedZero: 0,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(s.hook)),
            totalTaxBps: TAX,
            platformBps: s.hook.platformFeeBps(),
            platformRecipient: s.hook.platformRecipient(),
            launchedAt: 0
        });
    }

    /// The record is built first: it reads the hook, and an external call
    /// between the prank and register() would take the prank.
    function _refusedFor(Stack memory s, address tok, address curve, bytes4 question) internal {
        LaunchRegistry.Launch memory rec = _plainRecord(s, curve);
        vm.prank(address(s.factory));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.CurveDoesNotMatch.selector, curve, question));
        s.registry.register(tok, rec);
    }

    function _registerAsFactory(Stack memory s, address tok, address curve) internal {
        LaunchRegistry.Launch memory rec = _plainRecord(s, curve);
        vm.prank(address(s.factory));
        s.registry.register(tok, rec);
    }

    /// EACH OF THE THREE QUESTIONS IS ASKED, AND EACH ALONE REFUSES: the
    /// curve's token is the record's token, its asset is the record's, and the
    /// factory it answers to is the registering launcher's graduator.
    function test_register_eachQuestionIsAskedOfTheCurve() public onlyFork {
        Stack memory s = _stack(_weth());
        address tok = makeAddr("a token registered by hand");
        AnsweringCurve c = new AnsweringCurve();

        c.set(makeAddr("another token"), s.a.quote, address(s.graduator));
        _refusedFor(s, tok, address(c), IRegisteredCurve.token.selector);
        c.set(tok, NVDAC, address(s.graduator));
        _refusedFor(s, tok, address(c), IRegisteredCurve.pairToken.selector);
        c.set(tok, s.a.quote, makeAddr("another graduator"));
        _refusedFor(s, tok, address(c), IRegisteredCurve.factory.selector);

        // the control: all three right, and the record is written and the curve
        // is now this token's
        c.set(tok, s.a.quote, address(s.graduator));
        _registerAsFactory(s, tok, address(c));
        assertEq(s.registry.launchOf(tok).curve, address(c), "the record was not written");
        assertEq(s.registry.launchOfCurve(address(c)), tok, "the curve was not written down as this token's");
    }

    /// ONE CURVE, ONE RECORD. A curve whose token() answer can change - no
    /// real curve's can, which is why this is the second line and not the
    /// first - is refused for a second token.
    function test_register_aCurveIsNamedByOneRecordOnly() public onlyFork {
        Stack memory s = _stack(_weth());
        address first = makeAddr("the first token");
        address second = makeAddr("the second token");
        AnsweringCurve c = new AnsweringCurve();
        c.set(first, s.a.quote, address(s.graduator));
        _registerAsFactory(s, first, address(c));

        c.set(second, s.a.quote, address(s.graduator));
        LaunchRegistry.Launch memory rec = _plainRecord(s, address(c));
        vm.prank(address(s.factory));
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.CurveAlreadyRegistered.selector, address(c), first));
        s.registry.register(second, rec);
        assertFalse(s.registry.isRegistered(second), "a second record names the curve");
    }

    /// A CURVE THAT DOES NOT ANSWER IS REFUSED, AND CHEAPLY: no code at all, a
    /// dirty word over the right address, and one that spins until its gas is
    /// gone - which costs the 20,000 the question is given, not the caller's
    /// whole allowance.
    function test_register_aCurveThatWillNotAnswerIsRefused() public onlyFork {
        Stack memory s = _stack(_weth());
        address tok = makeAddr("a token whose curve says nothing");

        address noCode = address(uint160(uint256(keccak256("curb.CurveReuse.no code here"))));
        assertEq(noCode.code.length, 0, "the no-code address holds code here");
        _refusedFor(s, tok, noCode, IRegisteredCurve.token.selector);

        AnsweringCurve c = new AnsweringCurve();
        c.set(tok, s.a.quote, address(s.graduator));
        c.setTokenWord(bytes32(uint256(uint160(tok)) | (uint256(1) << 200)));
        _refusedFor(s, tok, address(c), IRegisteredCurve.token.selector);

        c.set(tok, s.a.quote, address(s.graduator));
        c.setSpin(true);
        LaunchRegistry.Launch memory rec = _plainRecord(s, address(c));
        vm.prank(address(s.factory));
        vm.expectRevert(
            abi.encodeWithSelector(LaunchRegistry.CurveDoesNotMatch.selector, address(c), IRegisteredCurve.token.selector)
        );
        uint256 g0 = gasleft();
        s.registry.register{gas: 5_000_000}(tok, rec);
        uint256 used = g0 - gasleft();
        assertLt(used, 400_000, "a curve that spins cost more than its bounded question");
    }

    /// THE FACTORY'S OWN FLOW IS UNCHANGED: it initializes the curve before it
    /// registers, so the curve already vouches for the record it writes.
    function test_register_theFactorysOwnLaunchWritesItsCurveDown() public onlyFork {
        Stack memory s = _stack(_nvdac());
        Launched memory l = _launch(s, address(s.dfac), 0);
        assertEq(s.registry.launchOfCurve(address(l.curve)), address(l.token), "the curve was not written down");
        assertEq(l.curve.token(), address(l.token), "the curve dispenses another token");
        assertEq(l.curve.factory(), address(s.graduator), "the curve answers to another factory");
    }
}
