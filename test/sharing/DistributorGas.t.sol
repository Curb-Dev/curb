// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HolderFeeDistributor} from "../../src/curb/sharing/HolderFeeDistributor.sol";
import {SharingFixture} from "./SharingFixture.sol";
import {MerkleBuilder} from "./MerkleBuilder.sol";
import {Tok} from "./SharingMocks.sol";

/// Gas of the distributor's operations on the mocked core (design D.1.2 gas
/// table). Logged, with loose ceilings so a regression shows. Run with
/// --isolate for figures with cold storage, as a real transaction sees them.
contract DistributorGasTest is SharingFixture {
    function _holders(uint256 n, uint256 base, uint256 each) internal pure returns (Alloc[] memory al) {
        al = new Alloc[](n);
        for (uint256 i; i < n; ++i) {
            al[i] = Alloc(address(uint160(base + i)), each, 0);
        }
    }

    function test_gas_deployAndInitialize() public {
        L memory l = _newLaunch(address(new Tok("Q", 18)));
        uint256 g = gasleft();
        fac.deploy(l.token);
        uint256 used = g - gasleft();
        emit log_named_uint("deploy + initialize", used);
        assertLt(used, 370_000);
    }

    function _run(bool weth, uint256 n) internal {
        address q = weth ? WETH : address(new Tok("Q", 18));
        L memory l = _sharingLaunch(q);
        _fund0(l, n * 1e18);
        Alloc[] memory al = _holders(n, 0x100000, 1e18);
        if (!weth) {
            for (uint256 i; i < n; ++i) {
                Tok(q).mint(al[i].a, 1); // holders usually hold the quote already
            }
        }
        for (uint256 i; i < n; ++i) {
            vm.deal(al[i].a, 1); // an account that exists
        }
        MerkleBuilder.Tree memory t = _tree(l.d, al);
        HolderFeeDistributor.Root memory r = _next(l.d, MerkleBuilder.root(t), n * 1e18, 0, 0);
        vm.prank(publisher);
        uint256 g = gasleft();
        fac.publish(address(l.d), r, "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
        emit log_named_uint("publish, first", g - gasleft());
        _ripen();
        g = gasleft();
        l.d.activate();
        emit log_named_uint("activate, first", g - gasleft());
        (HolderFeeDistributor.Leaf[] memory ls, bytes32[] memory p, bool[] memory f) = _batch(al, t, _idx(n));
        g = gasleft();
        l.d.push(ls, p, f);
        uint256 used = g - gasleft();
        emit log_named_uint(weth ? "push ETH, first payout, per leaf" : "push token, first payout, per leaf", used / n);

        // epoch 2: everyone earns another 0.5
        _fund0(l, n * 0.5e18);
        vm.roll(vm.getBlockNumber() + 10);
        for (uint256 i; i < n; ++i) {
            al[i].c0 = 1.5e18;
        }
        t = _tree(l.d, al);
        r = _next(l.d, MerkleBuilder.root(t), n * 1.5e18, 0, 0);
        vm.prank(publisher);
        g = gasleft();
        fac.publish(address(l.d), r, "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
        uint256 steady = g - gasleft();
        emit log_named_uint("publish, steady state", steady);
        assertLt(steady, 130_000);
        _ripen();
        g = gasleft();
        l.d.activate();
        uint256 act = g - gasleft();
        emit log_named_uint("activate, steady state", act);
        assertLt(act, 80_000);
        (ls, p, f) = _batch(al, t, _idx(n));
        g = gasleft();
        l.d.push(ls, p, f);
        used = g - gasleft();
        emit log_named_uint(weth ? "push ETH, repeat payout, per leaf" : "push token, repeat payout, per leaf", used / n);

        // epoch 3, claimed by one holder
        _fund0(l, n * 0.5e18);
        vm.roll(vm.getBlockNumber() + 10);
        for (uint256 i; i < n; ++i) {
            al[i].c0 = 2e18;
        }
        t = _publishAlloc(l.d, al, 0);
        l.d.activate();
        bytes32[] memory pr = MerkleBuilder.proof(t, 0);
        vm.prank(al[0].a);
        g = gasleft();
        l.d.claim(al[0].c0, 0, pr, address(0));
        emit log_named_uint("claim", g - gasleft());
        g = gasleft();
        l.d.harvest();
        emit log_named_uint("harvest, nothing owed", g - gasleft());
    }

    function test_gas_weth128() public {
        _run(true, 128);
    }

    function test_gas_token128() public {
        _run(false, 128);
    }

    function test_gas_harvestEverySource() public {
        Tok q = new Tok("Q", 18);
        L memory l = _sharingLaunch(address(q));
        q.mint(address(l.curve), 100);
        l.curve.accrue(100);
        q.mint(address(l.hook), 50);
        l.hook.accrueOwed(address(l.d), address(q), 50);
        uint256 g = gasleft();
        l.d.harvest();
        emit log_named_uint("harvest, curve + escrow + hook", g - gasleft());
        assertEq(l.d.received0(), 150);
    }

    function _idx(uint256 n) internal pure returns (uint256[] memory idx) {
        idx = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            idx[i] = i;
        }
    }
}
