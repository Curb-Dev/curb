// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeployCurb} from "../../script/DeployCurb.s.sol";
import {DeployAssetStack} from "../../script/DeployAssetStack.s.sol";
import {LaunchRegistry} from "../../src/curb/LaunchRegistry.sol";
import {CurbLaunchFactory} from "../../src/curb/CurbLaunchFactory.sol";
import {B20ForkTest, ISafe} from "./B20ForkTest.sol";
import {DeployCurbRunProbe} from "./DeployCurbRun.t.sol";

/// DeployAssetStack's admit() from plain arguments, for the refusals; run()
/// itself is driven from the environment by one test below.
contract DeployAssetStackProbe is DeployAssetStack {
    function admitWith(LaunchRegistry registry, string memory label) external returns (address, bytes memory) {
        return admit(registry, label, msg.sender);
    }
}

/**
 * @title DeployAssetStackTest
 * @notice A QUOTE ASSET ADDED AFTER LAUNCH: the stack is built against the live
 *         registry, Graduator and hook with the list's own terms, nothing is
 *         admitted by the script, and the policy Safe's printed call is what
 *         admits it.
 *
 * THE LIVE DEPLOYMENT IS DeployCurb's deploy() WITH TWO OF THE LISTED ASSETS,
 * WETH and NVDAc, so a third from the same list can be added. Its policy owner
 * is a real 2-of-3 Safe from Base's own factory, which accepts the registry
 * first - the state DEPLOY.txt leaves the registry in.
 */
contract DeployAssetStackTest is B20ForkTest {
    address internal constant SPCXC = 0xb2000000000000000000007b9fcbd005511aCBd5;

    DeployCurbRunProbe internal probe;
    address internal deployer;

    function setUp() public {
        if (!_forkGuard()) return;
        probe = new DeployCurbRunProbe();
        deployer = tx.origin;
    }

    function _two() internal view returns (DeployCurb.Asset[] memory two) {
        DeployCurb.Asset[] memory all = probe.assets();
        two = new DeployCurb.Asset[](2);
        for (uint256 i = 0; i < all.length; i++) {
            if (keccak256(bytes(all[i].label)) == keccak256("WETH")) two[0] = all[i];
            if (keccak256(bytes(all[i].label)) == keccak256("NVDAc")) two[1] = all[i];
        }
        require(two[0].quote != address(0) && two[1].quote != address(0), "the list lost WETH or NVDAc");
    }

    function _live(address policyOwner) internal returns (DeployCurb.Deployed memory) {
        address[] memory vetoers = new address[](1);
        vetoers[0] = makeAddr("a vetoer");
        DeployCurb.Plan memory p;
        p.deployer = deployer;
        p.platform = makeAddr("the platform recipient");
        p.policyOwner = policyOwner;
        p.roles = probe.roles(makeAddr("the publisher"), makeAddr("the keeper payee"), vetoers, policyOwner);
        p.assets = _two();
        return probe.deployWith(p);
    }

    function _safeSends(ISafe safe, uint256[3] memory keys, address to, bytes memory data) internal {
        bytes memory sigs = _signSafeTx(safe, keys, to, data);
        vm.prank(makeAddr("anybody relaying the Safe's transaction"));
        safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function _listed(string memory label) internal view returns (DeployCurb.Asset memory a) {
        DeployCurb.Asset[] memory all = probe.assets();
        for (uint256 i = 0; i < all.length; i++) {
            if (keccak256(bytes(all[i].label)) == keccak256(bytes(label))) return all[i];
        }
        revert(string.concat("the list does not hold ", label));
    }

    /// SPCXc, ADDED: run() reads the registry and the label from the
    /// environment, builds the stack with the list's terms against the live
    /// contracts, admits nothing, and prints the call that the Safe then sends.
    /// A launch on the new factory goes through once it has.
    function test_aNewAssetIsBuiltAgainstTheLiveDeployment_andOnlyTheSafesCallAdmitsIt() public onlyFork {
        (ISafe safe, uint256[3] memory keys,) = _deploySafe();
        DeployCurb.Deployed memory d = _live(address(safe));
        LaunchRegistry registry = d.s.registry;
        _safeSends(safe, keys, address(registry), abi.encodeWithSignature("acceptOwnership()"));
        assertEq(registry.owner(), address(safe), "the Safe did not take the registry (the premise)");

        DeployAssetStack script = new DeployAssetStack();
        vm.setEnv("CURB_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("CURB_ASSET_LABEL", "SPCXc");
        script.run();
        CurbLaunchFactory f = CurbLaunchFactory(script.builtFactory());

        // THE LIST'S TERMS, AGAINST THE LIVE CONTRACTS.
        DeployCurb.Asset memory spcx = _listed("SPCXc");
        assertEq(f.quoteToken(), SPCXC, "the stack is for another asset");
        assertEq(f.phantomQuote(), spcx.phantomQuote, "not the list's phantom");
        assertEq(f.graduationThreshold(), spcx.threshold, "not the list's threshold");
        assertEq(address(f.graduator()), address(d.s.graduator), "built against another Graduator");
        assertEq(address(f.hooks()), address(d.s.hook), "built against another hook");
        assertEq(address(f.registry()), address(registry), "built against another registry");

        // NOTHING ADMITTED BY THE SCRIPT; THE CALL IT PRINTED IS THE SAFE'S.
        assertFalse(registry.isLauncher(address(f)), "the script admitted the factory itself");
        assertEq(registry.launcherCount(), 2, "the launcher list moved without the Safe");
        assertEq(
            script.safeCalldata(), abi.encodeCall(LaunchRegistry.addLauncher, (address(f))), "not the Safe's addLauncher call"
        );
        _safeSends(safe, keys, address(registry), script.safeCalldata());
        assertTrue(registry.isLauncher(address(f)), "the Safe's call did not admit the factory");
        assertEq(registry.launcherAt(2), address(f), "the factory is not the third launcher");

        // AND IT LAUNCHES.
        (uint16 bps, address to) = f.currentPlatformPolicy();
        CurbLaunchFactory.LaunchConfig memory cfg;
        cfg.name = "Third Asset";
        cfg.symbol = "THIRD";
        cfg.quoteRefundTo = makeAddr("refunds");
        cfg.totalTaxBps = 300;
        cfg.expectedPlatformBps = bps;
        cfg.expectedPlatformRecipient = to;
        vm.prank(makeAddr("a creator"));
        f.launch(cfg);
        assertEq(registry.launchCount(), 1, "no launch on the new factory");

        vm.setEnv("CURB_ASSET_LABEL", "");
    }

    /// WHAT IT REFUSES, before anything is sent: a label the list does not
    /// hold, an asset the registry already has a factory for, and a registry
    /// whose handover to the Safe is still pending.
    function test_aLabelOutsideTheList_anAssetAlreadyAdmitted_andAPendingHandoverAreRefused() public onlyFork {
        (ISafe safe,,) = _deploySafe();
        DeployCurb.Deployed memory d = _live(address(safe));
        DeployAssetStackProbe stack = new DeployAssetStackProbe();

        // PENDING: offered to the Safe, not yet accepted.
        assertEq(d.s.registry.pendingOwner(), address(safe), "the premise: the handover is pending");
        vm.expectRevert(
            bytes(
                "the registry's handover is still pending: the policy Safe accepts it (acceptOwnership) before an asset is added"
            )
        );
        stack.admitWith(d.s.registry, "SPCXc");

        // ACCEPTED, then the other two refusals.
        vm.prank(address(safe));
        d.s.registry.acceptOwnership();
        vm.expectRevert(
            bytes(
                "CURB_ASSET_LABEL 'DOGE' names no asset in DeployCurb.quoteAssets(). Add it there first, in a commit of its own."
            )
        );
        stack.admitWith(d.s.registry, "DOGE");
        vm.expectRevert(bytes("the registry already admits a factory for this asset"));
        stack.admitWith(d.s.registry, "NVDAc");

        // THE CONTROL: the same registry takes a listed, unadmitted asset.
        (address f,) = stack.admitWith(d.s.registry, "SPCXc");
        assertEq(CurbLaunchFactory(f).quoteToken(), SPCXC, "the control did not build SPCXc's stack");
    }
}
