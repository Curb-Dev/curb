// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {HolderDistributorFactory} from "../../src/curb/sharing/HolderDistributorFactory.sol";
import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";
import {SharingFixture} from "./SharingFixture.sol";
import {MerkleBuilder} from "./MerkleBuilder.sol";
import {
    BlockingTok,
    ClaimingWallet,
    EthGasBurner,
    EthRefuser,
    FalseTok,
    GasBurningTok,
    GreedyTok,
    MockLock,
    Reenterer,
    Tok
} from "./SharingMocks.sol";

/// Unit tests of HolderFeeDistributor against a mocked core (design D.1.3).
contract HolderFeeDistributorTest is SharingFixture {
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);

    Tok quote;

    function setUp() public override {
        super.setUp();
        quote = new Tok("QUOTE", 18);
    }

    // =============================================================== building

    function test_initializeReadsEverythingFromTheRecord() public {
        L memory l = _sharingLaunch(address(quote));
        HolderFeeDistributor d = l.d;
        assertEq(d.launchToken(), l.token);
        assertEq(d.quoteToken(), address(quote));
        assertEq(d.curve(), address(l.curve));
        assertEq(d.hook(), address(l.hook));
        assertEq(d.escrow(), address(l.escrow));
        assertEq(d.graduator(), address(grad));
        assertEq(d.factory(), address(fac));
        assertEq(d.poolManager(), pm);
        assertEq(d.positionManager(), posm);
        assertEq(d.registry(), address(reg));
        assertTrue(d.initialized());
    }

    function test_deployIsIdempotentAndFrontRunSafe() public {
        L memory l = _newLaunch(address(quote));
        address predicted = fac.predict(l.token);
        // a stranger builds it first
        vm.prank(address(0xBAD));
        address first = fac.deploy(l.token);
        assertEq(first, predicted);
        assertTrue(fac.isDistributor(first));
        assertEq(fac.distributorOf(l.token), first);
        // again: the same address, nothing new
        assertEq(fac.deploy(l.token), first);
        // the creator's enable lands on the very same, correctly initialized clone
        address d = grad.enable(l.token, address(fac));
        assertEq(d, first);
        assertEq(HolderFeeDistributor(payable(d)).quoteToken(), address(quote));
        assertEq(l.curve.deployer(), d);
    }

    function test_deployRefusesAnUnregisteredToken() public {
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotRegistered.selector, address(0x1234)));
        fac.deploy(address(0x1234));
    }

    function test_theImplementationCannotBeInitialized() public {
        HolderFeeDistributor impl = HolderFeeDistributor(payable(fac.implementation()));
        assertTrue(impl.initialized());
        L memory l = _newLaunch(address(quote));
        vm.prank(address(fac));
        vm.expectRevert(HolderFeeDistributor.AlreadyInitialized.selector);
        impl.initialize(l.token);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NotTheFactory.selector, address(this)));
        impl.initialize(l.token);
    }

    function test_aCloneCannotBeInitializedTwice() public {
        L memory l = _sharingLaunch(address(quote));
        L memory other = _newLaunch(address(quote));
        vm.prank(address(fac));
        vm.expectRevert(HolderFeeDistributor.AlreadyInitialized.selector);
        l.d.initialize(other.token);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NotTheFactory.selector, address(this)));
        l.d.initialize(other.token);
    }

    // =============================================================== roots

    function test_onlyThePublisherPublishes_andOnlyThroughTheFactory() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 1000, 0, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotThePublisher.selector, alice));
        fac.publish(address(l.d), r, "");
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NotTheFactory.selector, publisher));
        l.d.publish(r, "");
        // an address the factory did not build
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.UnknownDistributor.selector, alice));
        fac.publish(alice, r, "");
        _publish(l.d, r);
        assertEq(_pendingRoot(l.d).epoch, 1);
    }

    function test_publishOnlyWhileTheSwitchPointsHere() public {
        L memory l = _newLaunch(address(quote));
        HolderFeeDistributor d = HolderFeeDistributor(payable(fac.deploy(l.token)));
        quote.mint(address(d), 10);
        vm.roll(vm.getBlockNumber() + 5);
        HolderFeeDistributor.Root memory r;
        r.merkleRoot = bytes32(uint256(1));
        r.cumHolders0 = 10;
        r.fromBlock = 0;
        r.toBlock = uint64(vm.getBlockNumber() - 1);
        r.epoch = 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NotSharingHere.selector, l.token));
        fac.publish(address(d), r, "");
        // pointed somewhere else
        grad.forceSwitch(l.token, address(0xD2));
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NotSharingHere.selector, l.token));
        fac.publish(address(d), r, "");
    }

    function test_aPendingRootCannotBeReplaced() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 500, 0, 0));
        HolderFeeDistributor.Root memory honest = _pendingRoot(l.d);
        vm.roll(vm.getBlockNumber() + 3);
        // neither the next number nor the same one
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(2)), 600, 0, 0);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.PendingRoot.selector, 1));
        fac.publish(address(l.d), r, "");
        r.epoch = 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.PendingRoot.selector, 1));
        fac.publish(address(l.d), r, "");
        // the honest root's hour was not restarted
        HolderFeeDistributor.Root memory still = _pendingRoot(l.d);
        assertEq(still.merkleRoot, honest.merkleRoot);
        assertEq(still.payableAt, honest.payableAt);
        // once it is ripe, the next publish promotes it and goes through
        _ripen();
        _publish(l.d, _next(l.d, bytes32(uint256(2)), 600, 0, 0));
        assertEq(_activeRoot(l.d).epoch, 1);
        assertEq(_pendingRoot(l.d).epoch, 2);
    }

    function test_keeperFeeExactlyTwoPercentIsAccepted_oneWeiMoreIsRefused() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 20_000);
        // gross 10_000: fee 201 refused, 200 accepted
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 9_799, 0, 201);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.KeeperFeeAboveCap.selector, 201, 10_000));
        fac.publish(address(l.d), r, "");
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 9_800, 0, 200));
        _ripen();
        // the cap applies to each epoch's delta, not the running total
        vm.roll(vm.getBlockNumber() + 2);
        r = _next(l.d, bytes32(uint256(2)), 9_800 + 4_900, 0, 200 + 101);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.KeeperFeeAboveCap.selector, 101, 5_001));
        fac.publish(address(l.d), r, "");
        _publish(l.d, _next(l.d, bytes32(uint256(2)), 9_800 + 4_900, 0, 200 + 100));
        // a fee with nothing for holders is refused outright
        _ripen();
        vm.roll(vm.getBlockNumber() + 2);
        r = _next(l.d, bytes32(uint256(3)), 9_800 + 4_900, 0, 301);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.KeeperFeeAboveCap.selector, 1, 1));
        fac.publish(address(l.d), r, "");
    }

    function test_overAllocationIsRefused() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        _fund1(l, 50);
        // asset 0: holders + keeper together
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 981, 0, 20);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.AllocatesMoreThanReceived.selector, 0, 1001, 1000));
        fac.publish(address(l.d), r, "");
        // asset 1
        r = _next(l.d, bytes32(uint256(1)), 980, 51, 20);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.AllocatesMoreThanReceived.selector, 1, 51, 50));
        fac.publish(address(l.d), r, "");
        // exactly everything
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 980, 50, 20));
    }

    function test_whatWasPaidOutStillCountsAsReceived() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        _pushAll(l.d, al, t);
        assertEq(quote.balanceOf(address(l.d)), 0);
        assertEq(l.d.received0(), 100);
        // 10 more arrives; a root may now allocate 110 cumulative, not 111
        _fund0(l, 10);
        vm.roll(vm.getBlockNumber() + 2);
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(9)), 111, 0, 0);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.AllocatesMoreThanReceived.selector, 0, 111, 110));
        fac.publish(address(l.d), r, "");
        _publish(l.d, _next(l.d, bytes32(uint256(9)), 110, 0, 0));
    }

    function test_paidOutLaunchTokensAndKeeperFeesStillCountAsReceived() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        _fund1(l, 100);
        Alloc[] memory al = _two(alice, 490, 60, bob, 490, 40);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 20);
        _pushAll(l.d, al, t);
        l.d.payKeeper();
        assertEq(_bal0(l, address(l.d)), 0);
        assertEq(_bal1(l, address(l.d)), 0);
        assertEq(l.d.received0(), 1000, "holders' and keeper's payouts both count");
        assertEq(l.d.received1(), 100);
        vm.roll(vm.getBlockNumber() + 2);
        // nothing new arrived: the same totals may be restated, not raised
        _publish(l.d, _next(l.d, bytes32(uint256(5)), 980, 100, 20));
        vm.prank(guardian);
        fac.veto(address(l.d), 2, "x");
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(5)), 980, 101, 20);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.AllocatesMoreThanReceived.selector, 1, 101, 100));
        fac.publish(address(l.d), r, "");
    }

    function test_epochsGoUpByExactlyOne() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 100, 0, 0);
        r.epoch = 2;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.WrongEpoch.selector, 1, 2));
        fac.publish(address(l.d), r, "");
        r.epoch = 0;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.WrongEpoch.selector, 1, 0));
        fac.publish(address(l.d), r, "");
        r.epoch = 1;
        _publish(l.d, r);
        // a vetoed number is burned
        vm.prank(guardian);
        fac.veto(address(l.d), 1, "bad");
        r.epoch = 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.WrongEpoch.selector, 2, 1));
        fac.publish(address(l.d), r, "");
        r.epoch = 2;
        _publish(l.d, r);
        assertEq(l.d.lastProposedEpoch(), 2);
    }

    function test_blockRangesAreContiguousAndInThePast() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        uint64 since = grad.sharingSince(l.token);
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 100, 0, 0);
        assertEq(r.fromBlock, since);
        // the first range starts at the switch's block, not before or after it
        r.fromBlock = since - 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.BadRange.selector, since, since - 1, r.toBlock));
        fac.publish(address(l.d), r, "");
        r.fromBlock = since + 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.BadRange.selector, since, since + 1, r.toBlock));
        fac.publish(address(l.d), r, "");
        r.fromBlock = since;
        // toBlock must be a past block
        r.toBlock = uint64(vm.getBlockNumber());
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.BadRange.selector, since, since, r.toBlock));
        fac.publish(address(l.d), r, "");
        // and not before fromBlock
        r.toBlock = since - 1;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.BadRange.selector, since, since, since - 1));
        fac.publish(address(l.d), r, "");
        // a single-block range is fine
        r.toBlock = since;
        _publish(l.d, r);
        _ripen();
        vm.roll(vm.getBlockNumber() + 3);
        // the next one starts right after it
        r = _next(l.d, bytes32(uint256(2)), 200, 0, 0);
        assertEq(r.fromBlock, since + 1);
        r.fromBlock = since + 2;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.BadRange.selector, since + 1, since + 2, r.toBlock));
        fac.publish(address(l.d), r, "");
        r.fromBlock = since;
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.BadRange.selector, since + 1, since, r.toBlock));
        fac.publish(address(l.d), r, "");
    }

    function test_cumulativeTotalsNeverShrink() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 10_000);
        _fund1(l, 10_000);
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 1000, 1000, 10));
        _ripen();
        vm.roll(vm.getBlockNumber() + 2);
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(2)), 999, 1000, 10);
        vm.prank(publisher);
        vm.expectRevert(HolderFeeDistributor.RootShrinks.selector);
        fac.publish(address(l.d), r, "");
        r = _next(l.d, bytes32(uint256(2)), 1000, 999, 10);
        vm.prank(publisher);
        vm.expectRevert(HolderFeeDistributor.RootShrinks.selector);
        fac.publish(address(l.d), r, "");
        r = _next(l.d, bytes32(uint256(2)), 1000, 1000, 9);
        vm.prank(publisher);
        vm.expectRevert(HolderFeeDistributor.RootShrinks.selector);
        fac.publish(address(l.d), r, "");
        // unchanged totals are allowed (an epoch with launch-token income only, say)
        _publish(l.d, _next(l.d, bytes32(uint256(2)), 1000, 1000, 10));
    }

    function test_publishEmitsTheDeltasAndTheKeeperFee() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 10_000);
        _fund1(l, 500);
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 4_900, 100, 100));
        _ripen();
        vm.roll(vm.getBlockNumber() + 2);
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(2)), 4_900 + 2_450, 300, 100 + 50);
        uint40 at = uint40(vm.getBlockTimestamp() + 1 hours);
        vm.expectEmit(true, false, false, true, address(l.d));
        emit HolderFeeDistributor.RootPublished(
            2, r.merkleRoot, r.fromBlock, r.toBlock, 2_450, 200, 50, r.contentHash, "ipfs://epoch", at
        );
        _publish(l.d, r);
        // the caller's payableAt is ignored
        r = _pendingRoot(l.d);
        assertEq(r.payableAt, at);
    }

    function test_callerChosenPayableAtIsIgnored() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(1)), 100, 0, 0);
        r.payableAt = 1;
        _publish(l.d, r);
        assertEq(_pendingRoot(l.d).payableAt, uint40(vm.getBlockTimestamp() + 1 hours));
        vm.expectRevert(
            abi.encodeWithSelector(HolderFeeDistributor.NotYetPayable.selector, uint40(vm.getBlockTimestamp() + 1 hours))
        );
        l.d.activate();
    }

    // =============================================================== veto

    function test_vetoInsideTheHourOnly_byAVetoerOnly_andItReopensTheRange() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        uint64 since = grad.sharingSince(l.token);
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 1000, 0, 0));
        // a stranger, and the publisher, cannot veto
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotAVetoer.selector, alice));
        fac.veto(address(l.d), 1, "x");
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotAVetoer.selector, publisher));
        fac.veto(address(l.d), 1, "x");
        // nor straight at the distributor
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NotTheFactory.selector, guardian));
        l.d.veto(1, "x");
        // the wrong epoch
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NoSuchPending.selector, 2));
        fac.veto(address(l.d), 2, "x");
        // an unknown distributor
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.UnknownDistributor.selector, alice));
        fac.veto(alice, 1, "x");
        // one second before the hour ends: still in time
        vm.warp(vm.getBlockTimestamp() + 1 hours - 1);
        vm.expectEmit(true, false, false, true, address(l.d));
        emit HolderFeeDistributor.RootVetoed(1, "mismatch");
        vm.prank(guardian);
        fac.veto(address(l.d), 1, "mismatch");
        assertEq(_pendingRoot(l.d).payableAt, 0);
        // vetoing twice finds nothing
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NoSuchPending.selector, 1));
        fac.veto(address(l.d), 1, "again");
        // the range is offered again from the switch's block, as epoch 2
        vm.roll(vm.getBlockNumber() + 3);
        HolderFeeDistributor.Root memory r = _next(l.d, bytes32(uint256(2)), 1000, 0, 0);
        assertEq(r.epoch, 2);
        assertEq(r.fromBlock, since);
        _publish(l.d, r);
        // at the end of the hour it is too late
        uint40 at = _pendingRoot(l.d).payableAt;
        vm.warp(at);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.VetoWindowOver.selector, at));
        fac.veto(address(l.d), 2, "late");
    }

    function test_aVetoedRootNeverPays() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        MerkleBuilder.Tree memory t = _tree(l.d, al);
        _publish(l.d, _next(l.d, MerkleBuilder.root(t), 100, 0, 0));
        vm.prank(guardian);
        fac.veto(address(l.d), 1, "bad");
        _ripen();
        _ripen();
        vm.expectRevert(HolderFeeDistributor.NothingPending.selector);
        l.d.activate();
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        vm.expectRevert(HolderFeeDistributor.NoActiveRoot.selector);
        l.d.push(ls, p, f);
        bytes32[] memory proof = MerkleBuilder.proof(t, 0);
        vm.prank(alice);
        vm.expectRevert(HolderFeeDistributor.NoActiveRoot.selector);
        l.d.claim(60, 0, proof, alice);
        assertEq(quote.balanceOf(alice), 0);
    }

    function test_aVetoedRootNeverPays_evenAfterAnEarlierActiveOne() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 200);
        Alloc[] memory al = _two(alice, 50, 0, bob, 50, 0);
        MerkleBuilder.Tree memory t1 = _publishAlloc(l.d, al, 0);
        l.d.activate();
        vm.roll(vm.getBlockNumber() + 2);
        Alloc[] memory al2 = _two(alice, 150, 0, bob, 50, 0);
        MerkleBuilder.Tree memory t2 = _tree(l.d, al2);
        _publish(l.d, _next(l.d, MerkleBuilder.root(t2), 200, 0, 0));
        vm.prank(guardian);
        fac.veto(address(l.d), 2, "bad");
        _ripen();
        // the vetoed leaf does not verify; the old one still pays
        bytes32[] memory p2 = MerkleBuilder.proof(t2, 0);
        vm.prank(alice);
        vm.expectRevert(HolderFeeDistributor.BadProof.selector);
        l.d.claim(150, 0, p2, alice);
        _claim(l.d, al, t1, 0, alice);
        assertEq(quote.balanceOf(alice), 50);
    }

    function test_noRootPaysBeforeItsHour() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        MerkleBuilder.Tree memory t = _tree(l.d, al);
        _publish(l.d, _next(l.d, MerkleBuilder.root(t), 100, 0, 0));
        uint40 at = _pendingRoot(l.d).payableAt;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NotYetPayable.selector, at));
        l.d.activate();
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        vm.expectRevert(HolderFeeDistributor.NoActiveRoot.selector);
        l.d.push(ls, p, f);
        bytes32[] memory proof = MerkleBuilder.proof(t, 0);
        vm.prank(alice);
        vm.expectRevert(HolderFeeDistributor.NoActiveRoot.selector);
        l.d.claim(60, 0, proof, alice);
        // at payableAt, push itself promotes the root
        vm.warp(at);
        vm.expectEmit(true, false, false, true, address(l.d));
        emit HolderFeeDistributor.RootActivated(1, MerkleBuilder.root(t));
        l.d.push(ls, p, f);
        assertEq(quote.balanceOf(alice), 60);
        assertEq(_activeRoot(l.d).epoch, 1);
    }

    function test_activateIsPermissionless() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        vm.expectRevert(HolderFeeDistributor.NothingPending.selector);
        l.d.activate();
        _publish(l.d, _next(l.d, bytes32(uint256(7)), 100, 0, 0));
        _ripen();
        vm.prank(address(0xD00D));
        l.d.activate();
        HolderFeeDistributor.Root memory a = _activeRoot(l.d);
        assertEq(a.epoch, 1);
        assertEq(a.merkleRoot, bytes32(uint256(7)));
        assertEq(a.cumHolders0, 100);
        assertEq(_pendingRoot(l.d).payableAt, 0);
        vm.expectRevert(HolderFeeDistributor.NothingPending.selector);
        l.d.activate();
    }

    function test_payKeeperPromotesARipeRoot() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        _publish(l.d, _next(l.d, bytes32(uint256(7)), 980, 0, 20));
        _ripen();
        l.d.payKeeper();
        assertEq(_activeRoot(l.d).epoch, 1);
        assertEq(quote.balanceOf(keeperPayee), 20);
    }

    // =============================================================== payouts

    function test_pushPaysEachLeafOnce_tokenQuote() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        _fund1(l, 100);
        Alloc[] memory al = new Alloc[](3);
        al[0] = Alloc(alice, 500, 50);
        al[1] = Alloc(bob, 300, 30);
        al[2] = Alloc(carol, 180, 20);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 20);
        vm.expectEmit(true, true, false, true, address(l.d));
        emit HolderFeeDistributor.Paid(alice, alice, 500, 50, true);
        _pushAll(l.d, al, t);
        assertEq(quote.balanceOf(alice), 500);
        assertEq(quote.balanceOf(bob), 300);
        assertEq(quote.balanceOf(carol), 180);
        assertEq(_bal1(l, alice), 50);
        assertEq(_bal1(l, carol), 20);
        assertEq(l.d.paid0(alice), 500);
        assertEq(l.d.paid1(bob), 30);
        assertEq(l.d.totalPaid0(), 980);
        assertEq(l.d.totalPaid1(), 100);
        // again: nothing more
        _pushAll(l.d, al, t);
        assertEq(quote.balanceOf(alice), 500);
        assertEq(l.d.totalPaid0(), 980);
        // and a claim of a fully paid leaf has nothing to take
        bytes32[] memory p = MerkleBuilder.proof(t, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NothingToClaim.selector, alice));
        l.d.claim(500, 50, p, alice);
    }

    function test_pushPaysEthOnAWethLaunch_fromEthAndWeth() public {
        L memory l = _sharingLaunch(WETH);
        _fund0(l, 1 ether); // ETH, as the escrow and the hook pay
        vm.deal(address(this), 2 ether);
        IWETHLike(WETH).deposit{value: 2 ether}();
        IERC20(WETH).transfer(address(l.d), 2 ether); // WETH, as the lock pays
        assertEq(l.d.received0(), 3 ether);
        Alloc[] memory al = _two(alice, 2.5 ether, 0, bob, 0.44 ether, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0.06 ether);
        _pushAll(l.d, al, t);
        assertEq(alice.balance, 2.5 ether, "paid in ETH");
        assertEq(bob.balance, 0.44 ether);
        assertEq(IERC20(WETH).balanceOf(alice), 0);
        assertEq(l.d.received0(), 3 ether, "received is unchanged by paying");
        // the keeper is paid WETH, never raw ETH
        l.d.payKeeper();
        assertEq(IERC20(WETH).balanceOf(keeperPayee), 0.06 ether);
        assertEq(keeperPayee.balance, 0);
        assertEq(_bal0(l, address(l.d)), 0);
    }

    function test_leavesAboveTheHeaderCannotBePaid() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        _fund1(l, 1000);
        // leaves 600 + 600 under a header of 1000 (asset 0)
        Alloc[] memory al = _two(alice, 600, 0, bob, 600, 0);
        MerkleBuilder.Tree memory t = _tree(l.d, al);
        _publish(l.d, _next(l.d, MerkleBuilder.root(t), 1000, 0, 0));
        _ripen();
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.LeavesExceedRoot.selector, 0));
        l.d.push(ls, p, f);
        // one by one: the first claim fits, the second does not
        _claim(l.d, al, t, 0, alice);
        bytes32[] memory pb = MerkleBuilder.proof(t, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.LeavesExceedRoot.selector, 0));
        l.d.claim(600, 0, pb, bob);
        assertEq(l.d.totalPaid0(), 600);
    }

    function test_oneWeiAboveTheHeaderIsRefused() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1001); // enough to pay it, so only the header can stop it
        Alloc[] memory al = _two(alice, 600, 0, bob, 401, 0);
        MerkleBuilder.Tree memory t = _tree(l.d, al);
        _publish(l.d, _next(l.d, MerkleBuilder.root(t), 1000, 0, 0));
        _ripen();
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.LeavesExceedRoot.selector, 0));
        l.d.push(ls, p, f);
    }

    function test_launchTokenLeavesAboveTheHeaderCannotBePaid() public {
        L memory l = _sharingLaunch(address(quote));
        _fund1(l, 1000);
        Alloc[] memory al = _two(alice, 0, 600, bob, 0, 600);
        MerkleBuilder.Tree memory t = _tree(l.d, al);
        _publish(l.d, _next(l.d, MerkleBuilder.root(t), 0, 1000, 0));
        _ripen();
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.LeavesExceedRoot.selector, 1));
        l.d.push(ls, p, f);
    }

    function test_leavesAreBoundToTheirDistributor() public {
        L memory l1 = _sharingLaunch(address(quote));
        L memory l2 = _sharingLaunch(address(quote));
        _fund0(l1, 100);
        _fund0(l2, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        // a tree built for d1 ...
        MerkleBuilder.Tree memory t1 = _tree(l1.d, al);
        _publish(l1.d, _next(l1.d, MerkleBuilder.root(t1), 100, 0, 0));
        // ... and the same root, replayed on d2
        _publish(l2.d, _next(l2.d, MerkleBuilder.root(t1), 100, 0, 0));
        _ripen();
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t1, _all(2));
        vm.expectRevert(HolderFeeDistributor.BadProof.selector);
        l2.d.push(ls, p, f);
        bytes32[] memory proof = MerkleBuilder.proof(t1, 0);
        vm.prank(alice);
        vm.expectRevert(HolderFeeDistributor.BadProof.selector);
        l2.d.claim(60, 0, proof, alice);
        // on d1 it pays
        l1.d.push(ls, p, f);
        assertEq(quote.balanceOf(alice), 60);
        // the leaf hash names the distributor
        assertTrue(l1.d.leafOf(alice, 60, 0) != l2.d.leafOf(alice, 60, 0));
        assertEq(l1.d.leafOf(alice, 60, 0), keccak256(bytes.concat(keccak256(abi.encode(address(l1.d), alice, 60, 0)))));
    }

    function test_aBadProofPaysNothing() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        // inflate a leaf
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        ls[0].cum0 += 1;
        vm.expectRevert(HolderFeeDistributor.BadProof.selector);
        l.d.push(ls, p, f);
        // someone else's leaf, claimed by bob
        bytes32[] memory pa = MerkleBuilder.proof(t, 0);
        vm.prank(bob);
        vm.expectRevert(HolderFeeDistributor.BadProof.selector);
        l.d.claim(60, 0, pa, bob);
    }

    function test_excludedLeavesAreSkipped_andCannotClaim() public {
        L memory l = _sharingLaunch(address(quote));
        MockLock lock = _graduate(l);
        L memory other = _sharingLaunch(address(quote));
        address[] memory infra = new address[](15);
        infra[0] = address(0);
        infra[1] = address(0xdEaD);
        infra[2] = address(l.d);
        infra[3] = l.token;
        infra[4] = address(quote);
        infra[5] = address(l.curve);
        infra[6] = address(l.hook);
        infra[7] = address(l.escrow);
        infra[8] = address(grad);
        infra[9] = pm;
        infra[10] = posm;
        infra[11] = address(reg);
        infra[12] = address(fac);
        infra[13] = address(lock);
        infra[14] = address(other.d);
        Alloc[] memory al = new Alloc[](infra.length + 1);
        for (uint256 i; i < infra.length; ++i) {
            assertTrue(l.d.isExcluded(infra[i]), "excluded");
            al[i] = Alloc(infra[i], 10, 1);
        }
        al[infra.length] = Alloc(alice, 10, 1);
        assertFalse(l.d.isExcluded(alice));
        assertFalse(l.d.isExcluded(creator), "the creator is an ordinary holder");
        _fund0(l, 160);
        _fund1(l, 16);
        uint256[] memory before0 = new uint256[](infra.length);
        for (uint256 i; i < infra.length; ++i) {
            before0[i] = quote.balanceOf(infra[i]);
        }
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        vm.expectEmit(true, false, false, false, address(l.d));
        emit HolderFeeDistributor.ExcludedLeaf(infra[0]);
        _pushAll(l.d, al, t);
        for (uint256 i; i < infra.length; ++i) {
            assertEq(l.d.paid0(infra[i]), 0);
            assertEq(l.d.paid1(infra[i]), 0);
            if (infra[i] != address(l.d)) assertEq(quote.balanceOf(infra[i]), before0[i], "infrastructure never paid");
        }
        assertEq(quote.balanceOf(alice), 10);
        assertEq(l.d.totalPaid0(), 10);
        // an excluded account cannot claim for itself either
        bytes32[] memory p = MerkleBuilder.proof(t, 5);
        vm.prank(address(l.curve));
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.Excluded.selector, address(l.curve)));
        l.d.claim(10, 1, p, alice);
    }

    function test_claimToAnExcludedAddressIsRefused() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        bytes32[] memory p = MerkleBuilder.proof(t, 0);
        address[3] memory bad = [address(l.curve), pm, address(l.d)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.Excluded.selector, bad[i]));
            l.d.claim(60, 0, p, bad[i]);
        }
    }

    function test_aRefusingEthReceiverIsPaidWeth() public {
        L memory l = _sharingLaunch(WETH);
        _fund0(l, 2 ether);
        EthRefuser r = new EthRefuser();
        Alloc[] memory al = _two(address(r), 1 ether, 0, alice, 1 ether, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        _pushAll(l.d, al, t);
        assertEq(IERC20(WETH).balanceOf(address(r)), 1 ether, "paid as WETH");
        assertEq(l.d.paid0(address(r)), 1 ether, "and booked as paid");
        assertEq(alice.balance, 1 ether);
    }

    function test_aGasBurningEthReceiverCostsTheBatchAtMost50k() public {
        L memory l = _sharingLaunch(WETH);
        _fund0(l, 3 ether);
        address refuser = address(new EthRefuser());
        address burner = address(new EthGasBurner());
        Alloc[] memory al = new Alloc[](3);
        al[0] = Alloc(alice, 1 ether, 0);
        al[1] = Alloc(refuser, 1 ether, 0);
        al[2] = Alloc(burner, 1 ether, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        uint256[] memory one = new uint256[](1);
        _pushIdx(l.d, al, t, one); // warms everything up
        one[0] = 1;
        uint256 withRefuser = _gasOfPush(l.d, al, t, one);
        one[0] = 2;
        uint256 withBurner = _gasOfPush(l.d, al, t, one);
        emit log_named_uint("push, refusing receiver", withRefuser);
        emit log_named_uint("push, gas-burning receiver", withBurner);
        assertEq(IERC20(WETH).balanceOf(refuser), 1 ether);
        assertEq(IERC20(WETH).balanceOf(burner), 1 ether);
        // 50k handed to the call, plus the 2300 stipend the EVM adds to any call with value
        assertLe(withBurner, withRefuser + 50_000 + 2_300, "a gas burner costs at most the 50k it is handed");
        assertGt(withBurner, withRefuser + 45_000, "and it really was handed about 50k");
    }

    function _gasOfPush(HolderFeeDistributor d, Alloc[] memory al, MerkleBuilder.Tree memory t, uint256[] memory idx)
        internal
        returns (uint256 used)
    {
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, idx);
        uint256 g = gasleft();
        d.push(ls, p, f);
        used = g - gasleft();
    }

    function test_aBlockedHolderIsSkippedByPush_thenClaimsToAnotherAddress() public {
        BlockingTok q = new BlockingTok();
        L memory l = _sharingLaunch(address(q));
        q.mint(address(l.d), 4e8);
        _fund1(l, 2e18);
        q.setBlocked(alice, true);
        Alloc[] memory al = _two(alice, 2e8, 1e18, bob, 2e8, 1e18);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        vm.expectEmit(true, false, false, true, address(l.d));
        emit HolderFeeDistributor.PushSkipped(alice, 0);
        _pushAll(l.d, al, t);
        assertEq(q.balanceOf(bob), 2e8);
        assertEq(q.balanceOf(alice), 0);
        assertEq(l.d.paid0(alice), 0, "the skipped share is still owed");
        assertEq(l.d.totalPaid0(), 2e8);
        assertEq(_bal1(l, alice), 1e18, "the launch-token leg still went");
        // to itself: refused by the issuer, so the claim reverts
        bytes32[] memory p = MerkleBuilder.proof(t, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.TransferRefused.selector, address(q), alice));
        l.d.claim(2e8, 1e18, p, address(0));
        // to another address of its own
        vm.expectEmit(true, true, false, true, address(l.d));
        emit HolderFeeDistributor.Paid(alice, carol, 2e8, 0, false);
        vm.prank(alice);
        l.d.claim(2e8, 1e18, p, carol);
        assertEq(q.balanceOf(carol), 2e8);
        assertEq(l.d.paid0(alice), 2e8);
    }

    function test_aTokenPushIsGasCapped() public {
        GasBurningTok q = new GasBurningTok();
        L memory l = _sharingLaunch(address(q));
        q.mint(address(l.d), 200);
        q.setVictim(alice);
        Alloc[] memory al = _two(alice, 100, 0, bob, 100, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        l.d.activate();
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        uint256 g = gasleft();
        l.d.push{gas: 2_000_000}(ls, p, f);
        uint256 used = g - gasleft();
        assertLt(used, 400_000, "the burner got at most TOKEN_PUSH_GAS");
        assertEq(q.balanceOf(bob), 100);
        assertEq(l.d.paid0(alice), 0);
    }

    function test_aTokenReturningFalseIsSkippedOnPush_andRefusedOnClaim() public {
        FalseTok q = new FalseTok();
        L memory l = _sharingLaunch(address(q));
        q.mint(address(l.d), 200);
        Alloc[] memory al = _two(alice, 100, 0, bob, 100, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        q.setRefuse(true);
        _pushAll(l.d, al, t);
        assertEq(l.d.paid0(alice), 0);
        assertEq(l.d.paid0(bob), 0);
        assertEq(l.d.totalPaid0(), 0);
        bytes32[] memory p = MerkleBuilder.proof(t, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.TransferRefused.selector, address(q), alice));
        l.d.claim(100, 0, p, alice);
        q.setRefuse(false);
        _pushAll(l.d, al, t);
        assertEq(q.balanceOf(alice), 100);
    }

    function test_aRefusedLaunchTokenPushIsSkippedAndStaysOwed() public {
        FalseTok t = new FalseTok();
        L memory l = _newLaunchWithToken(address(quote), address(t));
        _enable(l);
        vm.roll(vm.getBlockNumber() + 5);
        _fund0(l, 200);
        t.mint(address(l.d), 20);
        Alloc[] memory al = _two(alice, 100, 10, bob, 100, 10);
        MerkleBuilder.Tree memory tr = _publishAlloc(l.d, al, 0);
        t.setRefuse(true);
        vm.expectEmit(true, false, false, true, address(l.d));
        emit HolderFeeDistributor.PushSkipped(alice, 1);
        _pushAll(l.d, al, tr);
        assertEq(quote.balanceOf(alice), 100, "the quote leg went");
        assertEq(l.d.paid1(alice), 0, "the launch-token leg is still owed");
        assertEq(l.d.totalPaid1(), 0);
        t.setRefuse(false);
        _pushAll(l.d, al, tr);
        assertEq(t.balanceOf(alice), 10);
        assertEq(l.d.totalPaid1(), 20);
    }

    function test_aTransferThatTakesMoreThanItPaysReverts() public {
        GreedyTok q = new GreedyTok();
        L memory l = _sharingLaunch(address(q));
        q.mint(address(l.d), 300);
        Alloc[] memory al = _two(alice, 100, 0, bob, 100, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.InexactTransfer.selector, address(q), 100, 101));
        l.d.push(ls, p, f);
        bytes32[] memory pa = MerkleBuilder.proof(t, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.InexactTransfer.selector, address(q), 100, 101));
        l.d.claim(100, 0, pa, alice);
    }

    function test_claimPaysOnlyTheCallersOwnLeaf_toItselfByDefault() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        _fund1(l, 10);
        Alloc[] memory al = _two(alice, 60, 6, bob, 40, 4);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        // bob holding alice's proof and figures gets nothing
        bytes32[] memory pa = MerkleBuilder.proof(t, 0);
        vm.prank(bob);
        vm.expectRevert(HolderFeeDistributor.BadProof.selector);
        l.d.claim(60, 6, pa, bob);
        // alice, `to` zero: herself
        vm.expectEmit(true, true, false, true, address(l.d));
        emit HolderFeeDistributor.Paid(alice, alice, 60, 6, false);
        vm.prank(alice);
        l.d.claim(60, 6, pa, address(0));
        assertEq(quote.balanceOf(alice), 60);
        assertEq(_bal1(l, alice), 6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NothingToClaim.selector, alice));
        l.d.claim(60, 6, pa, address(0));
    }

    function test_aContractWalletClaimsWethWhenItRefusesEth() public {
        L memory l = _sharingLaunch(WETH);
        _fund0(l, 1 ether);
        ClaimingWallet w = new ClaimingWallet();
        Alloc[] memory al = _two(address(w), 0.7 ether, 0, alice, 0.3 ether, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        w.claim(address(l.d), 0.7 ether, 0, MerkleBuilder.proof(t, 0), address(0));
        assertEq(IERC20(WETH).balanceOf(address(w)), 0.7 ether);
        // an EOA claimant takes ETH
        _claim(l.d, al, t, 1, address(0));
        assertEq(alice.balance, 0.3 ether);
    }

    function test_sharesAccumulateAcrossEpochs_andArePaidOnce() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        // epoch 1: alice 3 (too small to push), bob 97
        Alloc[] memory al = _two(alice, 3, 0, bob, 97, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        uint256[] memory onlyBob = new uint256[](1);
        onlyBob[0] = 1;
        _pushIdx(l.d, al, t, onlyBob);
        assertEq(quote.balanceOf(bob), 97);
        // epoch 2: 100 more; alice 53 cumulative, bob 147
        _fund0(l, 100);
        vm.roll(vm.getBlockNumber() + 5);
        al = _two(alice, 53, 0, bob, 147, 0);
        t = _publishAlloc(l.d, al, 0);
        _pushAll(l.d, al, t);
        assertEq(quote.balanceOf(alice), 53, "the small share waited and was paid in full");
        assertEq(quote.balanceOf(bob), 147, "bob got only the difference");
        assertEq(l.d.paid0(bob), 147, "paid records the cumulative value");
        assertEq(l.d.totalPaid0(), 200);
        // a third push of the same leaves pays nothing
        _pushAll(l.d, al, t);
        assertEq(quote.balanceOf(bob), 147);
        assertEq(quote.balanceOf(alice), 53);
    }

    function test_aMissedEpochLosesNothing() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 300);
        Alloc[] memory al = _two(alice, 50, 0, bob, 50, 0);
        _publishAlloc(l.d, al, 0);
        vm.roll(vm.getBlockNumber() + 5);
        al = _two(alice, 100, 0, bob, 100, 0);
        _publishAlloc(l.d, al, 0);
        vm.roll(vm.getBlockNumber() + 5);
        al = _two(alice, 150, 0, bob, 150, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        _claim(l.d, al, t, 0, address(0));
        assertEq(quote.balanceOf(alice), 150);
    }

    function test_payKeeperPaysOnlyTheGrantedFee_toTheCurrentPayee() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 1000);
        l.d.payKeeper(); // nothing active: nothing to do
        assertEq(quote.balanceOf(keeperPayee), 0);
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 490, 0, 10));
        l.d.payKeeper(); // still pending: nothing
        assertEq(quote.balanceOf(keeperPayee), 0);
        _ripen();
        vm.expectEmit(true, false, false, true, address(l.d));
        emit HolderFeeDistributor.KeeperPaid(keeperPayee, 10);
        l.d.payKeeper();
        assertEq(quote.balanceOf(keeperPayee), 10);
        l.d.payKeeper();
        assertEq(quote.balanceOf(keeperPayee), 10, "never twice");
        assertEq(l.d.keeperPaid0(), 10);
        // a new payee, after its 48 hours, takes the next fee only
        vm.prank(owner);
        fac.announceKeeperPayee(carol);
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.executeKeeperPayee();
        vm.roll(vm.getBlockNumber() + 2);
        _publish(l.d, _next(l.d, bytes32(uint256(2)), 980, 0, 20));
        _ripen();
        l.d.payKeeper();
        assertEq(quote.balanceOf(carol), 10);
        assertEq(quote.balanceOf(keeperPayee), 10);
    }

    function test_payKeeperOnAWethLaunchWrapsEthAsNeeded() public {
        L memory l = _sharingLaunch(WETH);
        _fund0(l, 1 ether); // all ETH
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 0.98 ether, 0, 0.02 ether));
        _ripen();
        l.d.payKeeper();
        assertEq(IERC20(WETH).balanceOf(keeperPayee), 0.02 ether);
        assertEq(_bal0(l, address(l.d)), 0.98 ether);
    }

    function test_reentryFromAPaymentIsRefused() public {
        L memory l = _sharingLaunch(WETH);
        _fund0(l, 2 ether);
        Reenterer r = new Reenterer();
        Alloc[] memory al = _two(address(r), 1 ether, 0, alice, 1 ether, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        l.d.activate();
        // from inside its ETH payment it tries to harvest; the guard refuses
        r.arm(address(l.d), abi.encodeCall(HolderFeeDistributor.harvest, ()));
        _claim(l.d, al, t, 0, address(0));
        assertTrue(r.reverted(), "the inner call failed");
        assertEq(bytes4(r.revertData()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(address(r).balance, 1 ether, "and the payment itself went through");
    }

    function test_theActiveRootKeepsPayingWhileFrozen() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        l.d.activate();
        vm.prank(guardian);
        fac.freeze();
        _pushIdx(l.d, al, t, _one(0));
        assertEq(quote.balanceOf(alice), 60, "pushed while frozen");
        _claim(l.d, al, t, 1, address(0));
        assertEq(quote.balanceOf(bob), 40, "claimed while frozen");
    }

    /// A freeze holds every pending root, ripe or not: it does not become
    /// payable by activate, push, claim or payKeeper, the active root keeps
    /// paying, and a vetoer can veto the held root long after its hour.
    function test_aFreezeHoldsAPendingRoot_whichStaysVetoable() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 50, 0, bob, 50, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        l.d.activate();
        // epoch 2 gives everything new to carol, with a keeper fee
        _fund0(l, 100);
        vm.roll(vm.getBlockNumber() + 2);
        Alloc[] memory al2 = new Alloc[](3);
        al2[0] = Alloc(alice, 50, 0);
        al2[1] = Alloc(bob, 50, 0);
        al2[2] = Alloc(carol, 98, 0);
        MerkleBuilder.Tree memory t2 = _tree(l.d, al2);
        _publish(l.d, _next(l.d, MerkleBuilder.root(t2), 198, 0, 2));
        uint40 at = _pendingRoot(l.d).payableAt;

        vm.prank(guardian);
        fac.freeze();
        vm.warp(at + 3 days);
        vm.expectRevert(HolderFeeDistributor.Frozen.selector);
        l.d.activate();
        // the active root still pays, and does not promote the held one
        _pushIdx(l.d, al, t, _one(0));
        assertEq(quote.balanceOf(alice), 50);
        l.d.payKeeper();
        assertEq(quote.balanceOf(keeperPayee), 0, "the held root's keeper fee is not paid");
        _claim(l.d, al, t, 1, address(0));
        assertEq(quote.balanceOf(bob), 50);
        assertEq(_activeRoot(l.d).epoch, 1, "still epoch 1");
        bytes32[] memory pc = MerkleBuilder.proof(t2, 2);
        vm.prank(carol);
        vm.expectRevert(HolderFeeDistributor.BadProof.selector);
        l.d.claim(98, 0, pc, carol);

        // three days past its hour, a vetoer still vetoes it
        vm.expectEmit(true, false, false, true, address(l.d));
        emit HolderFeeDistributor.RootVetoed(2, "held");
        vm.prank(guardian);
        fac.veto(address(l.d), 2, "held");
        assertEq(_pendingRoot(l.d).payableAt, 0);

        // unfrozen after its announcement: nothing is left to activate
        vm.prank(owner);
        fac.announceUnfreeze();
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.unfreeze();
        vm.expectRevert(HolderFeeDistributor.NothingPending.selector);
        l.d.activate();
        assertEq(quote.balanceOf(carol), 0);
    }

    /// A held root that nobody vetoed becomes payable once the freeze ends.
    function test_aHeldRootBecomesPayableAfterTheUnfreeze() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        MerkleBuilder.Tree memory t = _tree(l.d, al);
        _publish(l.d, _next(l.d, MerkleBuilder.root(t), 100, 0, 0));
        vm.prank(guardian);
        fac.freeze();
        _ripen();
        // push promotes nothing while frozen, so there is no active root
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _all(2));
        vm.expectRevert(HolderFeeDistributor.NoActiveRoot.selector);
        l.d.push(ls, p, f);
        vm.prank(owner);
        fac.announceUnfreeze();
        vm.warp(vm.getBlockTimestamp() + 48 hours);
        fac.unfreeze();
        // too late to veto now: its hour is long over and nothing is frozen
        uint40 at = _pendingRoot(l.d).payableAt;
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.VetoWindowOver.selector, at));
        fac.veto(address(l.d), 1, "late");
        l.d.push(ls, p, f);
        assertEq(quote.balanceOf(alice), 60);
        assertEq(quote.balanceOf(bob), 40);
    }

    // =============================================================== harvest

    function test_harvestBeforeGraduation_sweepsTheCurveAndClaimsTheEscrow() public {
        L memory l = _sharingLaunch(address(quote));
        quote.mint(address(l.curve), 500);
        l.curve.accrue(500);
        l.d.harvest();
        assertEq(quote.balanceOf(address(l.d)), 500, "swept to the escrow and claimed in one go");
        assertEq(l.curve.pendingTax(), 0);
        assertEq(l.escrow.balanceOfToken(address(l.d), address(quote)), 0);
        assertEq(l.d.received0(), 500);
    }

    function test_harvestOnAWethLaunch_takesTheEscrowsEth() public {
        L memory l = _sharingLaunch(WETH);
        vm.deal(address(this), 1 ether);
        IWETHLike(WETH).deposit{value: 1 ether}();
        IERC20(WETH).transfer(address(l.curve), 1 ether);
        l.curve.accrue(1 ether);
        vm.expectEmit(false, false, false, true, address(l.d));
        emit HolderFeeDistributor.Harvested(1 ether, 0);
        l.d.harvest();
        assertEq(address(l.d).balance, 1 ether, "the escrow pays ETH");
        assertEq(l.d.received0(), 1 ether);
    }

    function test_harvestTakesTheHooksOwed_andDirectTakesCount() public {
        L memory l = _sharingLaunch(WETH);
        vm.deal(address(this), 3 ether);
        IWETHLike(WETH).deposit{value: 3 ether}();
        IERC20(WETH).transfer(address(l.hook), 3 ether);
        l.hook.accrueOwed(address(l.d), WETH, 2 ether);
        l.hook.directTake(address(l.d), WETH, 1 ether);
        l.d.harvest();
        assertEq(l.hook.owed(address(l.d), WETH), 0);
        assertEq(address(l.d).balance, 2 ether);
        assertEq(IERC20(WETH).balanceOf(address(l.d)), 1 ether);
        assertEq(l.d.received0(), 3 ether);
    }

    function test_harvestAfterGraduation_collectsTheLockAndSkipsTheCurve() public {
        L memory l = _sharingLaunch(address(quote));
        MockLock lock = _graduate(l);
        quote.mint(address(lock), 70);
        Tok(l.token).mint(address(lock), 30);
        lock.accrue(70, 30);
        l.d.harvest();
        assertEq(quote.balanceOf(address(l.d)), 70);
        assertEq(_bal1(l, address(l.d)), 30, "the launch-token side is shared in kind");
        assertEq(l.d.received1(), 30);
        assertEq(l.curve.lateSweeps(), 0, "a graduated curve is not swept");
    }

    function test_harvestReleasesWhatTheLockHeldForUs() public {
        BlockingTok q = new BlockingTok();
        L memory l = _sharingLaunch(address(q));
        MockLock lock = _graduate(l);
        q.mint(address(lock), 70);
        lock.accrue(70, 0);
        q.setBlocked(address(l.d), true);
        // blocked: the lock collects and holds it for us; the release fails too
        l.d.harvest();
        assertEq(lock.held(address(l.d), 0), 70);
        assertEq(q.balanceOf(address(l.d)), 0);
        q.setBlocked(address(l.d), false);
        l.d.harvest();
        assertEq(lock.held(address(l.d), 0), 0);
        assertEq(q.balanceOf(address(l.d)), 70);
    }

    function test_oneRefusedHarvestStepDoesNotStopTheOthers() public {
        L memory l = _sharingLaunch(address(quote));
        quote.mint(address(l.curve), 500);
        l.curve.accrue(500);
        l.curve.setRefuseSweep(true); // e.g. a buyback needs the operator
        quote.mint(address(l.hook), 40);
        l.hook.accrueOwed(address(l.d), address(quote), 40);
        l.d.harvest();
        assertEq(quote.balanceOf(address(l.d)), 40, "the hook leg still came in");
        assertEq(l.curve.pendingTax(), 500);
    }

    function test_aRescuePaysTheDistributorDirectly() public {
        L memory l = _sharingLaunch(address(quote));
        quote.mint(address(l.curve), 25);
        l.curve.accrue(25);
        grad.rescue(address(l.curve));
        assertEq(l.d.received0(), 25);
    }

    function test_donationsAreIncome() public {
        L memory l = _sharingLaunch(address(quote));
        quote.mint(address(l.d), 11);
        Tok(l.token).mint(address(l.d), 5);
        assertEq(l.d.received0(), 11);
        assertEq(l.d.received1(), 5);
        _publish(l.d, _next(l.d, bytes32(uint256(1)), 11, 5, 0));
    }

    function test_ethSentToANonWethLaunchIsNotCountedAsQuote() public {
        L memory l = _sharingLaunch(address(quote));
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(l.d).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(l.d.received0(), 0);
    }

    // =============================================================== pinned

    function test_capsWindowAndLeafFormatAreConstants() public {
        L memory l = _sharingLaunch(address(quote));
        assertEq(l.d.VETO_WINDOW(), 1 hours);
        assertEq(l.d.MAX_KEEPER_FEE_BPS(), 200);
        assertEq(l.d.ETH_PUSH_GAS(), 50_000);
        assertEq(l.d.TOKEN_PUSH_GAS(), 200_000);
        assertEq(l.d.WETH(), WETH);
        assertEq(fac.VERSION(), 1);
        assertEq(fac.ROLE_DELAY(), 48 hours);
        assertEq(fac.ROLE_WINDOW(), 7 days);
        // the clone delegates to the implementation, which has no admin entry point
        assertEq(address(l.d).code.length, 45, "an EIP-1167 minimal proxy");
    }

    function test_claimable() public {
        L memory l = _sharingLaunch(address(quote));
        _fund0(l, 100);
        Alloc[] memory al = _two(alice, 60, 0, bob, 40, 0);
        MerkleBuilder.Tree memory t = _publishAlloc(l.d, al, 0);
        (uint256 c0, uint256 c1) = l.d.claimable(alice, 60, 0);
        assertEq(c0, 60);
        assertEq(c1, 0);
        _claim(l.d, al, t, 0, address(0));
        (c0,) = l.d.claimable(alice, 60, 0);
        assertEq(c0, 0);
        (c0,) = l.d.claimable(alice, 50, 0);
        assertEq(c0, 0);
        (c0,) = l.d.claimable(alice, 75, 0);
        assertEq(c0, 15);
    }

    function _all(uint256 n) internal pure returns (uint256[] memory idx) {
        idx = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            idx[i] = i;
        }
    }

    function _one(uint256 i) internal pure returns (uint256[] memory idx) {
        idx = new uint256[](1);
        idx[0] = i;
    }
}

interface IWETHLike {
    function deposit() external payable;
}
