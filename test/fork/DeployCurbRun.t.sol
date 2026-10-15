// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {DeployCurb} from "../../script/DeployCurb.s.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {CurbLaunchFactory} from "../../src/curb/CurbLaunchFactory.sol";
import {CurbLaunchToken} from "../../src/curb/CurbLaunchToken.sol";
import {B20ForkTest, ISafe} from "./B20ForkTest.sol";

/// DeployCurb's deploy() - every transaction run() sends and every read-back
/// after them - reached from a plan written here rather than from the
/// environment. Inherited, not copied, so the script's own code is what runs.
contract DeployCurbRunProbe is DeployCurb {
    function deployWith(Plan memory p) external returns (Deployed memory) {
        return deploy(p);
    }

    function assets() external pure returns (Asset[] memory) {
        return quoteAssets();
    }

    function roles(address publisher, address keeperPayee, address[] memory vetoers, address owner_)
        external
        pure
        returns (SharingRoles memory)
    {
        return checkSharingRoles(publisher, keeperPayee, vetoers, owner_, false, address(0));
    }

    function firstFromEnv(address deployer) external view returns (FirstLaunch memory) {
        return firstLaunchFromEnv(deployer);
    }

    function firstCheck(FirstLaunch memory f, address deployer) external view {
        checkFirstLaunch(f, deployer);
    }

    function order(Asset[] memory list) external pure returns (uint256[] memory) {
        return admissionOrder(list);
    }
}

/**
 * @title DeployCurbRunTest
 * @notice THE WHOLE DEPLOYMENT, RUN ON THE FORK: $CURB as the registry's first
 *         launch on the WETH factory, and the registry offered to the policy
 *         Safe before the run ends - and taken by it.
 *
 * WHY deploy() AND NOT run(). run() reads the environment, which is one per
 * process, and forge runs test contracts side by side: B20MultiAsset's run()
 * test sets CURB_POLICY_OWNER and the rest while it runs, so a second test
 * setting them would race it. deploy() is everything run() sends, from the plan
 * run() builds once its checks pass; the checks themselves are driven by
 * B20MultiAsset and DeployCurbChecks, and run() end to end - environment and
 * broadcast both - by script/b20/check-deployment.sh --rehearse, against a
 * scratch fork.
 *
 * THE DEPLOYER IS tx.origin. deploy() broadcasts with vm.startBroadcast(), which
 * in a test sends as tx.origin, and the plan's deployer must be the key that
 * sends: it owns the registry, whose wire() refuses anybody else.
 *
 * THE ENVIRONMENT IS READ BY ONE TEST HERE, and only CURB_FIRST_* and
 * CURB_ALLOW_EOA_CREATOR: nothing else reads those, since run() reads them
 * after the depth check, where B20MultiAsset's run() test always stops.
 */
contract DeployCurbRunTest is B20ForkTest {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    bytes32 internal constant LAUNCH_CREATED =
        keccak256("LaunchCreated(address,address,address,uint256,uint16)");
    bytes32 internal constant LAUNCHER_SET = keccak256("LauncherSet(address)");
    bytes32 internal constant WETH_DEPOSIT = keccak256("Deposit(address,uint256)");
    bytes32 internal constant ERC20_APPROVAL = keccak256("Approval(address,address,uint256)");
    bytes32 internal constant OWNERSHIP_TRANSFERRED = keccak256("OwnershipTransferred(address,address)");

    DeployCurbRunProbe internal probe;
    address internal deployer;
    address internal treasury;
    address internal platform;

    function setUp() public {
        if (!_forkGuard()) return;
        probe = new DeployCurbRunProbe();
        deployer = tx.origin;
        treasury = makeAddr("the $CURB treasury");
        platform = makeAddr("the platform recipient");
        vm.deal(deployer, 10 ether);
    }

    function _plan(address policyOwner, DeployCurb.FirstLaunch memory first)
        internal
        returns (DeployCurb.Plan memory p)
    {
        address[] memory vetoers = new address[](1);
        vetoers[0] = makeAddr("a vetoer");
        p.deployer = deployer;
        p.platform = platform;
        p.policyOwner = policyOwner;
        p.roles = probe.roles(makeAddr("the publisher"), makeAddr("the keeper payee"), vetoers, policyOwner);
        p.demo = false;
        p.assets = probe.assets();
        p.first = first;
    }

    function _curb(uint256 devBuy, bool share) internal view returns (DeployCurb.FirstLaunch memory f) {
        f.on = true;
        f.name = "Curb";
        f.symbol = "CURB";
        f.uri = "ipfs://curb-first-launch";
        f.taxBps = 300;
        f.creator = treasury;
        f.devBuy = devBuy;
        f.share = share;
        // THE TREASURY HERE IS ONE KEY (makeAddr), so it is said, as
        // CURB_ALLOW_EOA_CREATOR=true says it to run().
        f.allowEoaCreator = true;
    }

    /// $CURB IS registry.launchAt(0), ON THE WETH FACTORY, FOR THE TREASURY -
    /// and the registry is offered to the policy Safe, which takes it.
    ///
    /// WHICH FACTORY MADE IT is read from the factory's own LaunchCreated, not
    /// inferred from the pair: the record says WETH, and the event says which
    /// launcher emitted it.
    function test_theFirstLaunchIsCurbOnTheWethFactory_andTheSafeTakesTheRegistry() public onlyFork {
        (ISafe safe, uint256[3] memory keys,) = _deploySafe();
        vm.recordLogs();
        DeployCurb.Deployed memory d =
            probe.deployWith(_plan(address(safe), _curb(0.3 ether, true)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        LaunchRegistry registry = d.s.registry;
        // THE WETH FACTORY BY ITS ASSET, not its place in the list.
        address weth;
        for (uint256 i = 0; i < d.factories.length; i++) {
            if (CurbLaunchFactory(d.factories[i]).quoteToken() == WETH) weth = d.factories[i];
        }
        assertTrue(weth != address(0), "the run built no WETH factory");

        // THE FIRST LAUNCH AND THE ONLY ONE.
        assertEq(registry.launchCount(), 1, "the run left other than one launch");
        assertEq(registry.launchAt(0), d.firstToken, "launchAt(0) is not $CURB");
        LaunchRegistry.Launch memory rec = registry.launchOf(d.firstToken);
        assertEq(rec.quoteToken, WETH, "$CURB is not paired with WETH");
        assertEq(rec.beneficiary, treasury, "$CURB's beneficiary is not the creator named");
        assertEq(rec.refundTo, treasury, "$CURB's refunds do not go to the creator named");
        assertEq(rec.curve, d.firstCurve, "$CURB's record names another curve");
        assertEq(uint256(rec.totalTaxBps), 300, "$CURB's tax is not the one named");
        assertEq(CurbLaunchToken(d.firstToken).symbol(), "CURB", "not the symbol named");
        assertEq(CurbLaunchToken(d.firstToken).name(), "Curb", "not the name named");
        assertEq(CurbLaunchToken(d.firstToken).tokenURI(), "ipfs://curb-first-launch", "not the URI named");

        // MADE BY THE WETH FACTORY, said by that factory.
        uint256 created;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 4 && logs[i].topics[0] == LAUNCH_CREATED) {
                created++;
                assertEq(logs[i].emitter, weth, "LaunchCreated came from a factory other than the WETH one");
                assertEq(address(uint160(uint256(logs[i].topics[1]))), d.firstToken, "LaunchCreated names another token");
                assertEq(address(uint160(uint256(logs[i].topics[3]))), treasury, "LaunchCreated names another creator");
            }
        }
        assertEq(created, 1, "the run did not create exactly one launch");

        // SHARED WITH ITS HOLDERS FROM THE START, and the dev buy went to the
        // creator, inside the fifth, with nothing left on the deployer.
        assertTrue(d.s.graduator.holderDistributorOf(d.firstToken) != address(0), "$CURB does not share with its holders");
        uint256 bought = CurbLaunchToken(d.firstToken).balanceOf(treasury);
        assertGt(bought, 0, "the dev buy delivered nothing to the creator");
        assertLe(bought, (SUPPLY * 2000) / 10_000, "the dev buy took more than a fifth");
        assertEq(CurbLaunchToken(d.firstToken).balanceOf(deployer), 0, "the deployer holds $CURB");
        assertEq(IERC20(WETH).allowance(deployer, weth), 0, "an allowance was left standing");

        // THE REGISTRY IS OFFERED, NOT HANDED OVER: the deployer still owns it.
        assertEq(registry.owner(), deployer, "the deployer lost the registry before the Safe accepted");
        assertEq(registry.pendingOwner(), address(safe), "the registry was not offered to the policy Safe");

        // THE SAFE TAKES IT, through its own threshold - the runbook's step.
        bytes memory accept = abi.encodeWithSignature("acceptOwnership()");
        bytes memory sigs = _signSafeTx(safe, keys, address(registry), accept);
        vm.prank(makeAddr("anybody relaying the Safe's transaction"));
        safe.execTransaction(address(registry), 0, accept, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
        assertEq(registry.owner(), address(safe), "the Safe did not take the registry");
        assertEq(registry.pendingOwner(), address(0), "an offer is still standing after the Safe accepted");

        // AND THE DEPLOYER'S KEY CAN NO LONGER ADMIT A LAUNCHER.
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(LaunchRegistry.NotTheDeployer.selector, deployer));
        registry.addLauncher(d.factories[1]);
    }

    /// NO FACTORY IS ADMITTED BEFORE $CURB'S OWN, AND $CURB IS THE NEXT THING
    /// THE RUN DOES AFTER IT. launch() is open to anyone from the receipt of a
    /// factory's admission, so a factory admitted before $CURB's launch is a
    /// window in which somebody else's launch becomes launch 0. The WETH
    /// factory used to be wired first, ten stacks and the sharing contracts
    /// ahead of $CURB; then it was admitted last, and the factory wired first
    /// was open to anyone for the ~40 transactions that built the rest. Now
    /// every stack is built, the WETH factory is the run's first admission,
    /// $CURB follows it at once, and every other admission comes after $CURB.
    ///
    /// READ FROM THE RUN'S OWN EVENTS, in the order they were emitted: the
    /// registry's LauncherSet per admission, WETH's Deposit and the deployer's
    /// Approval for the dev buy, the WETH factory's LaunchCreated, and each
    /// stack's buyback vault taking its owner (its OwnershipTransferred, from
    /// its constructor). Every vault is built before the first admission;
    /// before $CURB's LaunchCreated there is exactly one admission, the WETH
    /// factory's, with no wrap and no approval by the deployer after it - and
    /// the wrap and the approval come before it.
    function test_noFactoryIsAdmittedBeforeCurbsOwn_andCurbIsTheNextThingTheRunSends() public onlyFork {
        (ISafe safe,,) = _deploySafe();
        vm.recordLogs();
        DeployCurb.Deployed memory d = probe.deployWith(_plan(address(safe), _curb(0.3 ether, true)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        LaunchRegistry registry = d.s.registry;
        address weth;
        for (uint256 i = 0; i < d.factories.length; i++) {
            if (CurbLaunchFactory(d.factories[i]).quoteToken() == WETH) weth = d.factories[i];
        }
        assertTrue(weth != address(0), "the run built no WETH factory");

        // THE REGISTRY'S OWN ORDER: WETH's is the launcher wired, the first,
        // and the order is admissionOrder's.
        uint256 n = registry.launcherCount();
        assertEq(n, d.factories.length, "not one launcher per listed asset");
        assertEq(registry.launcher(), weth, "the WETH factory was not the one wired");
        assertEq(registry.launcherAt(0), weth, "the WETH factory is not the first launcher admitted");
        uint256[] memory order = probe.order(probe.assets());
        for (uint256 k = 0; k < n; k++) {
            assertEq(registry.launcherAt(k), d.factories[order[k]], "the launchers are not in admissionOrder");
        }

        // THE EVENTS, IN ORDER.
        uint256 wethAdmitted = type(uint256).max;
        uint256 launched = type(uint256).max;
        uint256 wrapped = type(uint256).max;
        uint256 approved = type(uint256).max;
        uint256 firstAdmission = type(uint256).max;
        uint256 lastVaultBuilt;
        uint256 vaultsBuilt;
        uint256 admissions;
        for (uint256 i = 0; i < logs.length; i++) {
            bytes32 t0 = logs[i].topics.length > 0 ? logs[i].topics[0] : bytes32(0);
            if (t0 == OWNERSHIP_TRANSFERRED && _isVault(d, logs[i].emitter)) {
                vaultsBuilt++;
                lastVaultBuilt = i;
            }
            if (logs[i].emitter == address(registry) && t0 == LAUNCHER_SET) {
                admissions++;
                if (firstAdmission == type(uint256).max) firstAdmission = i;
                if (address(uint160(uint256(logs[i].topics[1]))) == weth) wethAdmitted = i;
            } else if (logs[i].emitter == weth && t0 == LAUNCH_CREATED) {
                launched = i;
            } else if (logs[i].emitter == WETH && t0 == WETH_DEPOSIT && _topicIs(logs[i], 1, deployer)) {
                wrapped = i;
            } else if (logs[i].emitter == WETH && t0 == ERC20_APPROVAL && _topicIs(logs[i], 1, deployer)) {
                approved = i;
            }
        }
        assertEq(admissions, n, "one LauncherSet per admission");
        assertTrue(wethAdmitted != type(uint256).max && launched != type(uint256).max, "the premise: both events found");
        assertEq(vaultsBuilt, n, "the premise: one vault's construction found per stack");
        assertLt(lastVaultBuilt, firstAdmission, "a stack was still being built after the first admission");
        assertEq(firstAdmission, wethAdmitted, "a factory was admitted before the WETH factory");
        assertLt(wrapped, wethAdmitted, "the dev buy was wrapped after the WETH factory's admission");
        assertLt(approved, wethAdmitted, "the dev buy was approved after the WETH factory's admission");
        assertLt(wethAdmitted, launched, "$CURB launched before the WETH factory was admitted");
        for (uint256 i = 0; i < launched; i++) {
            bytes32 t0 = logs[i].topics.length > 0 ? logs[i].topics[0] : bytes32(0);
            assertFalse(
                i != wethAdmitted && logs[i].emitter == address(registry) && t0 == LAUNCHER_SET,
                "a launcher other than the WETH factory was admitted before $CURB"
            );
            assertFalse(
                i > wethAdmitted && logs[i].emitter == WETH && (t0 == WETH_DEPOSIT || t0 == ERC20_APPROVAL)
                    && _topicIs(logs[i], 1, deployer),
                "the run wrapped or approved between the WETH factory's admission and $CURB"
            );
        }
        assertEq(registry.launchAt(0), d.firstToken, "launchAt(0) is not $CURB");
    }

    function _topicIs(Vm.Log memory l, uint256 k, address who) internal pure returns (bool) {
        return l.topics.length > k && address(uint160(uint256(l.topics[k]))) == who;
    }

    /// Whether `who` is the buyback vault of one of the run's stacks.
    function _isVault(DeployCurb.Deployed memory d, address who) internal view returns (bool) {
        for (uint256 i = 0; i < d.factories.length; i++) {
            if (address(CurbLaunchFactory(d.factories[i]).buybackVault()) == who) return true;
        }
        return false;
    }

    /// WITHOUT CURB_FIRST_LAUNCH NOTHING IS LAUNCHED, and a policy owner that
    /// is the deployer gets no offer: there is nobody else to hand it to.
    function test_withoutTheFirstLaunchNothingIsLaunched_andAOneKeyRunOffersTheRegistryToNobody() public onlyFork {
        DeployCurb.FirstLaunch memory none;
        DeployCurb.Deployed memory d = probe.deployWith(_plan(deployer, none));
        assertEq(d.s.registry.launchCount(), 0, "a run without the first launch launched something");
        assertEq(d.firstToken, address(0), "a run without the first launch reports a token");
        assertEq(d.s.registry.owner(), deployer, "the registry is not the deployer's");
        assertEq(d.s.registry.pendingOwner(), address(0), "a one-key run offered the registry to somebody");
        assertEq(d.s.registry.launcherCount(), probe.assets().length, "not one launcher per listed asset");
    }

    /// WHAT THE THREE LAUNCHERS ADDED ON 2026-10-15 COST EVERY LAUNCH, MEASURED.
    ///
    /// launch() asks every admitted launcher, one by one, whether the creator
    /// is that launcher or its escrow, fee policy or buyback vault
    /// (CurbLaunchFactory._refuseOtherLaunchers): one registry read and three
    /// bounded calls per launcher. So each launcher admitted is gas on every
    /// launch on every factory, for good - none is ever removed - and the list
    /// grew from eleven to fourteen. This runs the deployment both ways, the
    /// eleven kept and all fourteen, and makes the same launch on each one's
    /// WETH factory, with everything the run built made COLD first, as it is
    /// to a real launch transaction: measured warm, right after the run that
    /// wrote it, the loop costs a fraction of what a launch pays on chain.
    ///
    /// MEASURED 2026-10-15 at the pin: 2,839,518 gas with eleven, 2,857,539
    /// with fourteen - 18,021 for the three, about 6,000 a launcher (its slot
    /// in the registry and its account, both cold, and three calls to it).
    /// THE BOUND IS PER LAUNCHER, 25,000 gas: the three calls are capped at
    /// 20,000 each only against a launcher that burns its gas, which no
    /// factory here does; the measured cost is a quarter of the bound.
    function test_threeMoreLaunchersCostEachLaunchLittle_fourteenAgainstEleven() public onlyFork {
        DeployCurb.Asset[] memory all = probe.assets();
        assertEq(all.length, 14, "the premise moved: the list is not fourteen assets");
        DeployCurb.Asset[] memory eleven = new DeployCurb.Asset[](11);
        uint256 k;
        for (uint256 i = 0; i < all.length; i++) {
            bytes32 l = keccak256(bytes(all[i].label));
            if (l == keccak256("USDC") || l == keccak256("VIRTUAL") || l == keccak256("AERO")) continue;
            eleven[k++] = all[i];
        }
        assertEq(k, 11, "the premise moved: USDC, VIRTUAL and AERO are not all on the list");

        uint256 snap = vm.snapshotState();
        uint256 g11 = _oneLaunchGas(eleven);
        vm.revertToState(snap);
        uint256 g14 = _oneLaunchGas(all);
        emit log_named_uint("gas: one launch() on the WETH factory, 11 launchers admitted", g11);
        emit log_named_uint("gas: one launch() on the WETH factory, 14 launchers admitted", g14);
        emit log_named_uint("gas: what the three added launchers cost each launch", g14 - g11);
        // A FLOOR, NOT "MORE THAN": each added launcher is at least one cold
        // account the loop calls (2,600 gas, EIP-2929). This read assertGt
        // first, and a mutant measuring the fourteen twice still passed it -
        // the two runs differ by 28 gas of noise.
        assertGe(g14 - g11, 3 * 2_600, "three more launchers cost a launch next to nothing: the loop over them was not measured cold");
        assertLt(g14 - g11, 3 * 25_000, "an added launcher costs each launch more than 25,000 gas");
    }

    /// The run on `list`, then one launch on its WETH factory from a creator
    /// with no stake in any of it, every contract of the run cold.
    function _oneLaunchGas(DeployCurb.Asset[] memory list) internal returns (uint256 used) {
        DeployCurb.FirstLaunch memory none;
        DeployCurb.Plan memory p = _plan(deployer, none);
        p.assets = list;
        DeployCurb.Deployed memory d = probe.deployWith(p);
        assertEq(d.s.registry.launcherCount(), list.length, "not one launcher per listed asset");
        CurbLaunchFactory weth;
        for (uint256 i = 0; i < d.factories.length; i++) {
            if (CurbLaunchFactory(d.factories[i]).quoteToken() == WETH) weth = CurbLaunchFactory(d.factories[i]);
        }
        assertTrue(address(weth) != address(0), "the run built no WETH factory");
        // THE TERMS ARE READ BEFORE ANYTHING IS COOLED: reading them warms the
        // hook and the registry again.
        (uint16 bps, address to) = weth.currentPlatformPolicy();
        CurbLaunchFactory.LaunchConfig memory cfg = CurbLaunchFactory.LaunchConfig({
            name: "Gas",
            symbol: "GAS",
            tokenUri: "",
            salt: bytes32(uint256(0x6a5)),
            quoteRefundTo: makeAddr("a gas creator"),
            totalTaxBps: 300,
            devBuy: 0,
            creatorWallet: address(0),
            expectedPlatformBps: bps,
            expectedPlatformRecipient: to,
            holderShareFactory: address(0)
        });
        for (uint256 i = 0; i < d.factories.length; i++) {
            CurbLaunchFactory f = CurbLaunchFactory(d.factories[i]);
            address[4] memory parts =
                [address(f), address(f.feeEscrow()), address(f.feePolicy()), address(f.buybackVault())];
            for (uint256 j = 0; j < 4; j++) vm.cool(parts[j]);
        }
        address[6] memory shared = [
            address(d.s.registry),
            address(d.s.catalog),
            address(d.s.graduator),
            address(d.s.hook),
            address(d.s.distributorFactory),
            address(d.s.lens)
        ];
        for (uint256 j = 0; j < 6; j++) vm.cool(shared[j]);

        vm.prank(makeAddr("a gas creator"));
        uint256 g = gasleft();
        weth.launch(cfg);
        used = g - gasleft();
        assertEq(d.s.registry.launchCount(), 1, "the launch was not registered");
    }

    /// A DEV BUY PAST A FIFTH OF THE SUPPLY STOPS THE WHOLE RUN - and so,
    /// under forge script, sends nothing. 0.5 WETH buys more than a fifth of
    /// a curve whose phantom is 1.65: a fifth costs a quarter of the phantom,
    /// 0.4125 WETH net, 0.425 with a 3% tax on top.
    function test_aFirstLaunchTheFactoryRefusesStopsTheRun() public onlyFork {
        DeployCurb.Plan memory p = _plan(deployer, _curb(0.5 ether, false));
        vm.expectPartialRevert(CurbLaunchFactory.DevBuyAboveShare.selector);
        probe.deployWith(p);
    }

    /// THE CREATOR IS NEVER ZERO AND NEVER THE DEPLOYER, refused before
    /// anything is sent.
    function test_theFirstLaunchsCreatorIsNeverZeroNorTheDeployer() public onlyFork {
        DeployCurb.FirstLaunch memory f = _curb(0, false);
        probe.firstCheck(f, deployer); // the control
        f.creator = address(0);
        vm.expectRevert(bytes("CURB_FIRST_CREATOR is the zero address. Zero would make the deployer $CURB's creator for good."));
        probe.firstCheck(f, deployer);
        f.creator = deployer;
        vm.expectRevert(
            bytes(
                "CURB_FIRST_CREATOR is the deployer. A hot key would be $CURB's creator and the owner of its locked position for good."
            )
        );
        probe.firstCheck(f, deployer);
        f.on = false; // off, nothing is asked
        probe.firstCheck(f, deployer);
    }

    /// A CREATOR THAT IS ONE KEY IS REFUSED UNLESS SAID - decision 6 asks for
    /// a treasury Safe, and a code-less address is also what a mistyped one
    /// looks like. A Safe needs no opt-in.
    function test_aOneKeyCreatorIsRefusedUnlessSaid_andASafeNeedsNoOptIn() public onlyFork {
        DeployCurb.FirstLaunch memory f = _curb(0, false);
        f.allowEoaCreator = false;
        assertEq(treasury.code.length, 0, "the premise: the treasury here is one key");
        vm.expectRevert(
            bytes(
                "CURB_FIRST_CREATOR is one key (no code, or only an EIP-7702 delegation). DEPLOY.txt decision 6 asks for a Safe. If that is really intended, set CURB_ALLOW_EOA_CREATOR=true."
            )
        );
        probe.firstCheck(f, deployer);
        f.allowEoaCreator = true;
        probe.firstCheck(f, deployer); // said: passes
        (ISafe safe,,) = _deploySafe();
        f.creator = address(safe);
        f.allowEoaCreator = false;
        probe.firstCheck(f, deployer); // a Safe: no opt-in needed
    }

    /// EACH CURB_FIRST_* VARIABLE IS READ INTO ITS OWN FIELD, AND EXACTLY.
    /// The only test that sets the environment, and only these names.
    function test_theFirstLaunchIsReadFromTheEnvironmentExactly() public onlyFork {
        // UNSET OR 0: OFF, and nothing past it is read.
        if (!vm.envExists("CURB_FIRST_LAUNCH")) assertFalse(probe.firstFromEnv(deployer).on, "unset is not off");
        vm.setEnv("CURB_FIRST_LAUNCH", "0");
        assertFalse(probe.firstFromEnv(deployer).on, "0 is not off");

        // EVERYTHING SET: each value in its own field. The treasury here is one
        // key, so CURB_ALLOW_EOA_CREATOR says so; without it, refused.
        _firstEnv("Curb", "CURB", "", "300", vm.toString(treasury), "250000000000000000", "1");
        vm.setEnv("CURB_FIRST_LAUNCH", "1");
        vm.setEnv("CURB_ALLOW_EOA_CREATOR", "false");
        vm.expectRevert(
            bytes(
                "CURB_FIRST_CREATOR is one key (no code, or only an EIP-7702 delegation). DEPLOY.txt decision 6 asks for a Safe. If that is really intended, set CURB_ALLOW_EOA_CREATOR=true."
            )
        );
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_ALLOW_EOA_CREATOR", "true");
        DeployCurb.FirstLaunch memory f = probe.firstFromEnv(deployer);
        assertTrue(f.allowEoaCreator, "the creator opt-in");
        assertTrue(f.on, "1 is not on");
        assertEq(f.name, "Curb", "the name");
        assertEq(f.symbol, "CURB", "the symbol");
        assertEq(f.uri, "", "an empty URI is allowed");
        assertEq(uint256(f.taxBps), 300, "the tax");
        assertEq(f.creator, treasury, "the creator");
        assertEq(f.devBuy, 0.25 ether, "the dev buy");
        assertTrue(f.share, "the share flag");
        vm.setEnv("CURB_FIRST_SHARE", "0");
        assertFalse(probe.firstFromEnv(deployer).share, "share 0 is not off");

        // A FLAG THAT IS NOT EXACTLY 1 OR 0.
        vm.setEnv("CURB_FIRST_LAUNCH", "true");
        vm.expectRevert(bytes("CURB_FIRST_LAUNCH must be exactly 1 or 0, not 'true'."));
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_FIRST_LAUNCH", "1");
        vm.setEnv("CURB_FIRST_SHARE", "yes");
        vm.expectRevert(bytes("CURB_FIRST_SHARE must be exactly 1 or 0, not 'yes'."));
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_FIRST_SHARE", "1");

        // NUMBERS IN PLAIN DIGITS.
        vm.setEnv("CURB_FIRST_DEV_BUY", "0.25e18");
        vm.expectRevert(bytes("CURB_FIRST_DEV_BUY must be plain decimal digits."));
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_FIRST_DEV_BUY", "0");
        // (forge trims the spaces around a value before the script sees it,
        // so "300 " would read as 300; the preflight refuses such a value.)
        vm.setEnv("CURB_FIRST_TAX_BPS", "3e2");
        vm.expectRevert(bytes("CURB_FIRST_TAX_BPS must be plain decimal digits."));
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_FIRST_TAX_BPS", "70000");
        vm.expectRevert(bytes("CURB_FIRST_TAX_BPS is out of range. The factory takes 100 to 500."));
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_FIRST_TAX_BPS", "300");

        // TEXT WITHOUT CONTROL CHARACTERS, AND A NAME AND SYMBOL NOT EMPTY.
        vm.setEnv("CURB_FIRST_NAME", "Curb\nCoin");
        vm.expectRevert(
            bytes("CURB_FIRST_NAME holds a control character (a newline, a tab). It is written into $CURB for good.")
        );
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_FIRST_NAME", "Curb");
        vm.setEnv("CURB_FIRST_SYMBOL", "");
        vm.expectRevert(bytes("CURB_FIRST_SYMBOL is empty. It is written into $CURB for good."));
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_FIRST_SYMBOL", "CURB");

        // THE CREATOR, read and checked: the deployer is refused.
        vm.setEnv("CURB_FIRST_CREATOR", vm.toString(deployer));
        vm.expectRevert(
            bytes(
                "CURB_FIRST_CREATOR is the deployer. A hot key would be $CURB's creator and the owner of its locked position for good."
            )
        );
        probe.firstFromEnv(deployer);
        // ...and its EIP-55 checksum held, written in mixed case: one letter's
        // case flipped is refused, which vm.envAddress used to take.
        bytes memory typo = bytes(vm.toString(treasury));
        uint256 at = 2;
        while (!((typo[at] >= "a" && typo[at] <= "f") || (typo[at] >= "A" && typo[at] <= "F"))) at++;
        typo[at] = typo[at] >= "a" ? bytes1(uint8(typo[at]) - 32) : bytes1(uint8(typo[at]) + 32);
        assertEq(vm.parseAddress(string(typo)), treasury, "the premise: the typo parses to the same address");
        vm.setEnv("CURB_FIRST_CREATOR", string(typo));
        vm.expectRevert(
            bytes(
                "CURB_FIRST_CREATOR is written in mixed case and that is not its EIP-55 checksum: one mistyped character reads like this. Copy the address again from where it is kept; never correct it by hand."
            )
        );
        probe.firstFromEnv(deployer);
        vm.setEnv("CURB_FIRST_CREATOR", vm.toString(treasury));
        assertTrue(probe.firstFromEnv(deployer).on, "back to a good set (the control)");

        // NOTHING ON IS LEFT ON THE PROCESS for whatever runs after.
        vm.setEnv("CURB_FIRST_LAUNCH", "0");
        vm.setEnv("CURB_ALLOW_EOA_CREATOR", "false");
    }

    function _firstEnv(
        string memory name,
        string memory symbol,
        string memory uri,
        string memory tax,
        string memory creator,
        string memory devBuy,
        string memory share
    ) internal {
        vm.setEnv("CURB_FIRST_NAME", name);
        vm.setEnv("CURB_FIRST_SYMBOL", symbol);
        vm.setEnv("CURB_FIRST_URI", uri);
        vm.setEnv("CURB_FIRST_TAX_BPS", tax);
        vm.setEnv("CURB_FIRST_CREATOR", creator);
        vm.setEnv("CURB_FIRST_DEV_BUY", devBuy);
        vm.setEnv("CURB_FIRST_SHARE", share);
    }
}
