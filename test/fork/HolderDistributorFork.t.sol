// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PositionLock} from "../../src/curb/PositionLock.sol";
import {Graduator} from "../../src/curb/Graduator.sol";
import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";
import {HolderDistributorFactory} from "../../src/curb/sharing/HolderDistributorFactory.sol";

import {HolderSharingForkBase} from "./HolderSharing.t.sol";
import {MerkleBuilder} from "../sharing/MerkleBuilder.sol";

/// THE REAL HOLDER DISTRIBUTOR AGAINST THE REAL CORE, on the pinned fork (core
/// v2 design, D.1.3 "Fork"). Every source harvest() pulls from, on WETH and on
/// NVDAc, before and after graduation: the curve sweep it may run as the
/// curve's creator, rescueCurveFees paying it directly, the escrow credit, the
/// hook's debt, a B20 direct take, the lock's fees and the lock's held fees.
/// Each test makes exactly one source hold money and checks that harvest()
/// brings in exactly that amount - read from the source before, or from the
/// lock's own FeesClaimed event - and nothing else. Then the whole way to the
/// holders: a root published through the factory, a veto, the hour, a push,
/// the keeper's fee, and a holder the issuer blocks taking its share to
/// another address.
contract HolderDistributorForkTest is HolderSharingForkBase {
    using MerkleBuilder for MerkleBuilder.Tree;

    function _held0(Stack memory s, address d) internal view returns (uint256) {
        return IERC20(s.a.quote).balanceOf(d) + (s.a.quote == WETH ? d.balance : 0);
    }

    /// harvest(), and what it changed: received0 and received1 deltas, the
    /// lock's reported (quote, token), and the distributor's held quote delta.
    function _harvest(Stack memory s, Launched memory l)
        internal
        returns (uint256 d0, uint256 d1, uint256 lockQuote, uint256 lockTok)
    {
        HolderFeeDistributor dist = _dist(s, l);
        uint256 r0 = dist.received0();
        uint256 r1 = dist.received1();
        uint256 h0 = _held0(s, address(dist));
        vm.recordLogs();
        dist.harvest();
        (lockQuote, lockTok) = _lockPaid(s, l, vm.getRecordedLogs());
        d0 = dist.received0() - r0;
        d1 = dist.received1() - r1;
        // received0 is what it holds plus what it paid; nothing was paid here
        assertEq(_held0(s, address(dist)) - h0, d0, "received0 moved by something other than what arrived");
    }

    // ================================================================
    // BEFORE GRADUATION
    // ================================================================

    /// The curve's pending tax, swept by harvest() as the curve's creator
    /// (`deployer`), credited to the distributor in the escrow, and claimed
    /// from the escrow in the same harvest.
    function _curveSweep(Asset memory a) internal {
        Stack memory s = _stack(a);
        Launched memory l = _launch(s, address(s.dfac), 0);
        address d = address(_dist(s, l));
        assertEq(l.curve.deployer(), d, "the curve does not pay the distributor");
        _buy(s, l, a.threshold / 10);
        uint256 tax = l.curve.creatorTaxBalance();
        assertGt(tax, 0, "nothing pending on the curve");
        // the platform's base fee is the curve's fee pool, all of it the
        // platform's (PROTOCOL_FEE_SHARE_BPS = 10_000); the sweep moves it too
        assertGt(l.curve.quoteFeeBalance(), 0, "the platform's fee did not accrue");
        uint256 platformBefore = s.escrow.balanceOfToken(protocolRecipient, a.quote);

        (uint256 d0, uint256 d1,,) = _harvest(s, l);
        assertEq(d0, tax, string.concat(a.sym, ": the harvest did not bring in exactly the curve's pending tax"));
        assertEq(d1, 0, string.concat(a.sym, ": launch tokens arrived from the curve"));
        assertEq(l.curve.creatorTaxBalance(), 0, "the curve still holds the tax");
        assertEq(s.escrow.balanceOfToken(d, a.quote), 0, "the escrow credit was left behind");
        assertEq(s.escrow.balanceOfToken(creator, a.quote), 0, "the sweep credited the creator");
        assertGt(
            s.escrow.balanceOfToken(protocolRecipient, a.quote),
            platformBefore,
            "the sweep did not move the platform's share to the platform"
        );

        // a second harvest finds nothing and changes nothing
        (d0, d1,,) = _harvest(s, l);
        assertEq(d0 + d1, 0, "a second harvest brought in something");
    }

    function test_harvest_curveSweepAsDeployer_WETH() public onlyFork {
        _curveSweep(_weth());
    }

    function test_harvest_curveSweepAsDeployer_NVDAc() public onlyFork {
        _curveSweep(_nvdac());
    }

    /// rescueCurveFees pays the distributor directly: the distributor counts
    /// it as received at once, and harvest() adds nothing. Before the curve is
    /// full only its two payees may call it - a stranger is refused, the
    /// record's platform recipient is not.
    function _rescue(Asset memory a) internal {
        Stack memory s = _stack(a);
        Launched memory l = _launch(s, address(s.dfac), 0);
        HolderFeeDistributor dist = _dist(s, l);
        _buy(s, l, a.threshold / 10);
        uint256 tax = l.curve.creatorTaxBalance();
        assertGt(tax, 0, "nothing pending on the curve");
        assertFalse(l.curve.readyToGraduate(), "the curve is full, so the stranger below would be let in");

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Graduator.RescueNotOpenYet.selector, stranger, 0));
        s.graduator.rescueCurveFees(address(l.token));

        vm.prank(protocolRecipient);
        (, uint256 creatorAmount) = s.graduator.rescueCurveFees(address(l.token));
        assertEq(creatorAmount, tax, "the rescue did not pay the whole pending tax");
        assertEq(dist.received0(), tax, string.concat(a.sym, ": the rescue did not pay the distributor directly"));
        assertEq(_held0(s, address(dist)), tax, "the rescue paid somewhere else");
        assertEq(IERC20(a.quote).balanceOf(creator), 0, "the rescue paid the creator");

        (uint256 d0, uint256 d1,,) = _harvest(s, l);
        assertEq(d0 + d1, 0, "a harvest after the rescue brought in something more");
    }

    function test_rescueCurveFeesPaysTheDistributorDirectly_WETH() public onlyFork {
        _rescue(_weth());
    }

    function test_rescueCurveFeesPaysTheDistributorDirectly_NVDAc() public onlyFork {
        _rescue(_nvdac());
    }

    // ================================================================
    // AFTER GRADUATION
    // ================================================================

    /// The graduation sweep credits the distributor in the escrow; the first
    /// harvest claims exactly that credit, plus whatever the crossing buy left
    /// in the hook and the lock, each read from its own source.
    function _escrowAfterGraduation(Asset memory a) internal {
        Stack memory s = _stack(a);
        Launched memory l = _launch(s, address(s.dfac), 0);
        address d = address(_dist(s, l));
        _graduate(s, l);
        uint256 credit = s.escrow.balanceOfToken(d, a.quote);
        assertGt(credit, 0, "the graduation sweep did not credit the distributor");
        uint256 owed = s.hook.owed(d, a.quote);
        uint256 taken = _held0(s, d);

        (uint256 d0, uint256 d1, uint256 lq, uint256 lt) = _harvest(s, l);
        assertEq(d0, credit + owed + lq, string.concat(a.sym, ": the harvest did not claim exactly the escrow credit"));
        assertEq(d1, lt, "launch tokens arrived from somewhere other than the lock");
        assertEq(s.escrow.balanceOfToken(d, a.quote), 0, "the escrow credit was left behind");
        assertEq(_dist(s, l).received0(), taken + credit + owed + lq, "received0 does not add up");

        // and with nothing traded since, a second harvest brings in nothing
        (d0, d1,,) = _harvest(s, l);
        assertEq(d0 + d1, 0, "a second harvest brought in something");
    }

    function test_harvest_escrowCreditAfterGraduation_WETH() public onlyFork {
        _escrowAfterGraduation(_weth());
    }

    function test_harvest_escrowCreditAfterGraduation_NVDAc() public onlyFork {
        _escrowAfterGraduation(_nvdac());
    }

    /// WETH: the pool's creator leg accrues in the hook as a debt to the
    /// distributor; harvest() claims it, and the lock's fees on both sides.
    function test_harvest_hookDebtAndLockFees_WETH() public onlyFork {
        Stack memory s = _stack(_weth());
        Launched memory l = _launch(s, address(s.dfac), 0);
        address d = address(_dist(s, l));
        _graduate(s, l);
        _harvest(s, l); // the graduation's escrow credit, out of the way

        _poolRoundTrip(s, l, s.a.threshold / 20);
        uint256 owed = s.hook.owed(d, WETH);
        assertGt(owed, 0, "the pool's creator leg did not accrue to the distributor");
        assertEq(s.escrow.balanceOfToken(d, WETH), 0, "an escrow credit appeared");

        (uint256 d0, uint256 d1, uint256 lq, uint256 lt) = _harvest(s, l);
        assertGt(lq, 0, "the lock paid no WETH");
        assertGt(lt, 0, "the lock paid no launch tokens");
        assertEq(d0, owed + lq, "the harvest did not bring in exactly the hook's debt and the lock's WETH");
        assertEq(d1, lt, "the harvest did not bring in exactly the lock's launch tokens");
        assertEq(s.hook.owed(d, WETH), 0, "the hook's debt was left behind");
        PositionLock lock = _lock(s, l);
        assertEq(lock.held(d, 0) + lock.held(d, 1), 0, "the lock held a WETH-launch distributor's fees");
    }

    /// NVDAc: the pool's creator leg is a B20 direct take, straight to the
    /// distributor inside the swap - received without any harvest. harvest()
    /// then brings in the lock's fees only.
    function test_directTakeAndLockFees_NVDAc() public onlyFork {
        Stack memory s = _stack(_nvdac());
        Launched memory l = _launch(s, address(s.dfac), 0);
        HolderFeeDistributor dist = _dist(s, l);
        address d = address(dist);
        _graduate(s, l);
        _harvest(s, l);

        uint256 r0 = dist.received0();
        _poolRoundTrip(s, l, s.a.threshold / 20);
        assertEq(s.hook.owed(d, NVDAC), 0, "a take the issuer allows fell back to a debt");
        uint256 direct = dist.received0() - r0;
        assertGt(direct, 0, "the direct take did not reach the distributor");

        (uint256 d0, uint256 d1, uint256 lq, uint256 lt) = _harvest(s, l);
        assertGt(lq, 0, "the lock paid no NVDAc");
        assertGt(lt, 0, "the lock paid no launch tokens");
        assertEq(d0, lq, "the harvest brought in quote other than the lock's");
        assertEq(d1, lt, "the harvest brought in launch tokens other than the lock's");
    }

    /// NVDAc, the issuer blocking the distributor: the take falls back to a
    /// debt in the hook and the lock holds the distributor's quote fees.
    /// Unblocked, one harvest brings in exactly the debt and the held fees.
    function test_harvest_hookDebtAndLockReleaseAfterAnIssuerBlock_NVDAc() public onlyFork {
        Stack memory s = _stack(_nvdac());
        Launched memory l = _launch(s, address(s.dfac), 0);
        HolderFeeDistributor dist = _dist(s, l);
        address d = address(dist);
        _graduate(s, l);
        _harvest(s, l);

        _setBlocked(NVDAC, d, true);
        _poolRoundTrip(s, l, s.a.threshold / 20);
        uint256 owed = s.hook.owed(d, NVDAC);
        assertGt(owed, 0, "a refused take did not fall back to a debt");
        PositionLock lock = _lock(s, l);
        uint256 qi = _quoteIndex(s, l);
        lock.claimFees();
        uint256 held = lock.held(d, qi);
        assertGt(held, 0, "the lock did not hold the refused quote fees");
        assertEq(lock.held(d, 1 - qi), 0, "the lock held launch tokens the distributor can take");

        // blocked: the harvest's every quote step is refused, and none stops it
        (uint256 d0,,,) = _harvest(s, l);
        assertEq(d0, 0, "a blocked distributor received quote");

        _setBlocked(NVDAC, d, false);
        uint256 d1;
        uint256 lq;
        (d0, d1, lq,) = _harvest(s, l);
        assertEq(lq, 0, "the lock found new fees with nothing traded");
        assertEq(d0, owed + held, "the harvest did not bring in exactly the hook's debt and the held fees");
        assertEq(d1, 0, "launch tokens arrived");
        assertEq(lock.held(d, qi), 0, "the held fees were not released");
        assertEq(s.hook.owed(d, NVDAC), 0, "the hook's debt was not paid");
    }

    // ================================================================
    // THE WHOLE WAY TO THE HOLDERS
    // ================================================================

    struct Epoch {
        address[] who;
        uint256[] c0;
        uint256[] c1;
        uint256 keeper;
    }

    function _leaves(HolderFeeDistributor dist, Epoch memory e) internal view returns (bytes32[] memory h) {
        h = new bytes32[](e.who.length);
        for (uint256 i = 0; i < e.who.length; i++) {
            h[i] = dist.leafOf(e.who[i], e.c0[i], e.c1[i]);
        }
    }

    function _root(HolderFeeDistributor dist, Epoch memory e, uint32 epoch, uint64 fromBlock)
        internal
        view
        returns (HolderFeeDistributor.Root memory r)
    {
        uint256 h0;
        uint256 h1;
        for (uint256 i = 0; i < e.who.length; i++) {
            h0 += e.c0[i];
            h1 += e.c1[i];
        }
        r = HolderFeeDistributor.Root({
            merkleRoot: MerkleBuilder.build(_leaves(dist, e)).root(),
            contentHash: keccak256(abi.encode("an epoch file", epoch)),
            cumHolders0: uint128(h0),
            cumHolders1: uint128(h1),
            cumKeeper0: uint128(e.keeper),
            fromBlock: fromBlock,
            toBlock: uint64(block.number - 1),
            epoch: epoch,
            payableAt: 0
        });
    }

    function _push(HolderFeeDistributor dist, Epoch memory e) internal returns (uint256 gasUsed) {
        MerkleBuilder.Tree memory t = MerkleBuilder.build(_leaves(dist, e));
        uint256[] memory idx = new uint256[](e.who.length);
        for (uint256 i = 0; i < idx.length; i++) {
            idx[i] = i;
        }
        (uint256[] memory order, bytes32[] memory proof, bool[] memory flags) = t.multiProof(idx);
        HolderFeeDistributor.Leaf[] memory ls = new HolderFeeDistributor.Leaf[](order.length);
        for (uint256 i = 0; i < order.length; i++) {
            ls[i] = HolderFeeDistributor.Leaf(e.who[order[i]], e.c0[order[i]], e.c1[order[i]]);
        }
        uint256 g = gasleft();
        dist.push(ls, proof, flags);
        gasUsed = g - gasleft();
    }

    /// Everything received split between the creator and the trader, with the
    /// keeper's 2% taken first.
    function _split(HolderFeeDistributor dist) internal view returns (Epoch memory e) {
        uint256 in0 = dist.received0();
        uint256 in1 = dist.received1();
        e.keeper = in0 * 200 / 10_000;
        e.who = new address[](2);
        e.c0 = new uint256[](2);
        e.c1 = new uint256[](2);
        e.who[0] = creator;
        e.who[1] = trader;
        e.c0[0] = (in0 - e.keeper) / 2;
        e.c0[1] = in0 - e.keeper - e.c0[0];
        e.c1[0] = in1 / 3;
        e.c1[1] = in1 - e.c1[0];
    }

    /// Launch with sharing on, trade on the curve and in the pool, harvest,
    /// publish, wait the hour, push, pay the keeper. The amounts each holder
    /// receives are exactly its leaf; the keeper's exactly its fee; nothing is
    /// left in the distributor but what no leaf allocated.
    function _toTheHolders(Asset memory a, bool blockTheTrader) internal {
        Stack memory s = _stack(a);
        Launched memory l = _launch(s, address(s.dfac), a.threshold / 20); // a dev buy is capped at 20% of the supply
        HolderFeeDistributor dist = _dist(s, l);
        _buy(s, l, a.threshold / 10);
        _graduate(s, l);
        _poolRoundTrip(s, l, a.threshold / 20);
        vm.roll(block.number + 5);
        uint256 g = gasleft();
        dist.harvest();
        emit log_named_uint(string.concat(a.sym, " harvest gas (curve gone, escrow, hook, lock)"), g - gasleft());
        assertGt(dist.received0(), 0, "nothing received in the quote");
        assertGt(dist.received1(), 0, "nothing received in the launch token");

        Epoch memory e = _split(dist);
        uint64 since = s.graduator.sharingSince(address(l.token));

        // epoch 1 is published and vetoed by the guardian inside its hour
        HolderFeeDistributor.Root memory r = _root(dist, e, 1, since);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotThePublisher.selector, stranger));
        s.dfac.publish(address(dist), r, "ipfs://epoch-1");
        vm.prank(publisher);
        g = gasleft();
        s.dfac.publish(address(dist), r, "ipfs://epoch-1");
        emit log_named_uint(string.concat(a.sym, " publish gas, first"), g - gasleft());
        vm.prank(guardian);
        s.dfac.veto(address(dist), 1, bytes32("mismatch"));
        vm.warp(vm.getBlockTimestamp() + dist.VETO_WINDOW());
        vm.expectRevert(HolderFeeDistributor.NothingPending.selector);
        dist.activate();

        // epoch 2 covers the same blocks again, and pays after its own hour
        r = _root(dist, e, 2, since);
        vm.prank(publisher);
        s.dfac.publish(address(dist), r, "ipfs://epoch-2");
        (,,,,,,,, uint40 payableAt) = dist.pending();
        vm.expectRevert(abi.encodeWithSelector(HolderFeeDistributor.NotYetPayable.selector, payableAt));
        dist.activate();
        vm.warp(payableAt);

        if (blockTheTrader) _setBlocked(a.quote, trader, true);
        uint256 c0 = a.quote == WETH ? creator.balance : IERC20(a.quote).balanceOf(creator);
        uint256 t0 = a.quote == WETH ? trader.balance : IERC20(a.quote).balanceOf(trader);
        uint256 cT = l.token.balanceOf(creator);
        uint256 tT = l.token.balanceOf(trader);
        if (blockTheTrader) {
            vm.expectEmit(true, false, false, true, address(dist));
            emit HolderFeeDistributor.PushSkipped(trader, 0);
        }
        g = _push(dist, e);
        emit log_named_uint(string.concat(a.sym, " push gas, two leaves, first payout (activates)"), g);

        uint256 c1 = a.quote == WETH ? creator.balance : IERC20(a.quote).balanceOf(creator);
        assertEq(c1 - c0, e.c0[0], string.concat(a.sym, ": the creator was not paid exactly its leaf"));
        assertEq(l.token.balanceOf(creator) - cT, e.c1[0], "the creator's launch tokens are not its leaf");
        assertEq(l.token.balanceOf(trader) - tT, e.c1[1], "the trader's launch tokens are not its leaf");
        assertEq(dist.received0(), e.c0[0] + e.c0[1] + e.keeper, "received0 changed with the payouts");

        if (blockTheTrader) {
            assertEq(IERC20(a.quote).balanceOf(trader), t0, "a holder the issuer blocks was paid");
            assertEq(dist.paid0(trader), 0, "a skipped push was booked");
            // the trader takes its own share to another address of its own
            MerkleBuilder.Tree memory t = MerkleBuilder.build(_leaves(dist, e));
            vm.prank(trader);
            dist.claim(e.c0[1], e.c1[1], t.proof(1), coldWallet);
            assertEq(IERC20(a.quote).balanceOf(coldWallet), e.c0[1], "the claim did not reach the trader's other address");
        } else {
            uint256 t1 = a.quote == WETH ? trader.balance : IERC20(a.quote).balanceOf(trader);
            assertEq(t1 - t0, e.c0[1], string.concat(a.sym, ": the trader was not paid exactly its leaf"));
        }
        assertEq(dist.totalPaid0(), e.c0[0] + e.c0[1], "the holders were not paid the root's total");

        // a second push of the same leaves pays nothing
        uint256 c2 = a.quote == WETH ? creator.balance : IERC20(a.quote).balanceOf(creator);
        g = _push(dist, e);
        emit log_named_uint(string.concat(a.sym, " push gas, two leaves, repeat"), g);
        assertEq((a.quote == WETH ? creator.balance : IERC20(a.quote).balanceOf(creator)), c2, "a leaf was paid twice");

        // the keeper's fee, as the quote token (WETH, never raw ETH)
        dist.payKeeper();
        assertEq(IERC20(a.quote).balanceOf(keeperPayee), e.keeper, "the keeper was not paid exactly its fee");
        assertEq(_held0(s, address(dist)), 0, "quote was left in the distributor with everything allocated");
        assertEq(l.token.balanceOf(address(dist)), 0, "launch tokens were left with everything allocated");
    }

    function test_toTheHolders_WETH() public onlyFork {
        _toTheHolders(_weth(), false);
    }

    function test_toTheHolders_NVDAc_aBlockedHolderClaimsToAnotherAddress() public onlyFork {
        _toTheHolders(_nvdac(), true);
    }

    /// The real factory admitted by the real catalog refuses to serve a launch
    /// that is not registered, and a deploy() made before the launch's switch
    /// changes nothing: the switch still binds the same clone.
    function test_aDeployBeforeTheSwitchIsTheSameDistributor() public onlyFork {
        Stack memory s = _stack(_nvdac());
        vm.expectRevert(abi.encodeWithSelector(HolderDistributorFactory.NotRegistered.selector, stranger));
        s.dfac.deploy(stranger);
        Launched memory l = _launch(s, address(0), 0);
        vm.prank(stranger);
        address early = s.dfac.deploy(address(l.token));
        assertEq(early, s.dfac.predict(address(l.token)), "deploy() is not at the predicted address");
        vm.prank(creator);
        address d = s.graduator.enableHolderSharing(address(l.token), address(s.dfac));
        assertEq(d, early, "the switch bound another clone than the one deployed early");
        assertEq(HolderFeeDistributor(payable(d)).launchToken(), address(l.token), "the clone serves another token");
        assertEq(HolderFeeDistributor(payable(d)).escrow(), address(s.escrow), "the clone reads another escrow");
        assertEq(HolderFeeDistributor(payable(d)).hook(), address(s.hook), "the clone reads another hook");
    }
}
