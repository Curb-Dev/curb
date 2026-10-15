// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

/// Runs SharerProbe's creation code the way an eth_call with no `to` does, and
/// hands back what the constructor returned (the code it would deploy).
contract ProbeRunner {
    function run(bytes memory init) external returns (bytes memory) {
        address a;
        assembly {
            a := create(0, add(init, 32), mload(init))
        }
        require(a != address(0), "the probe creation failed");
        return a.code;
    }
}

/// SharerProbe (src/curb/sharing/SharerProbe.sol), the helper curb-sharer
/// sends as the creation code of every probe eth_call: every call gets exactly
/// CALL_GAS wherever it stands, the helper stops before a call it could not
/// give that much and says how many it answered, the output never passes
/// EIP-170, every call is static, and its code is the one services/sharer
/// pins (PROBE_CODE_HASH). The build is read from its artifact, never
/// imported, like the router's (foundry.toml).
///
/// Every address here is derived from a label nothing else uses and checked to
/// hold no code first, so the suite means the same on a Base fork.
///
/// EACH RUN IS ITS OWN TRANSACTION (isolate), as each probe eth_call is: in
/// one test transaction every target an earlier run touched would stay warm
/// (EIP-2929) and its call 2,500 gas cheaper than on chain, which hides a check
/// that forgets the cold access. (vm.cool does not reset that in this forge.)
/// forge-config: default.isolate = true
contract SharerProbeTest is Test {
    /// The same number as services/sharer/src/chain/probe.ts PROBE_CODE_HASH
    /// and the spec (services/sharer/spec/README.md, 4.10).
    bytes32 constant PROBE_CODE_HASH = 0xb6280b759f2832de05a3812c4335bc2ac47927b4ae5c63533efe8b286d8a6ac0;
    uint256 constant CALL_GAS = 100_000;
    uint256 constant RETURN_CAP = 160;
    uint256 constant MAX_OUT = 24_576;

    ProbeRunner runner;
    bytes init;

    address reporter; // returns gasleft() as it starts
    address burner; // code 0xfe: uses up every bit of gas it is given
    address writer; // SSTOREs: allowed in a CALL, not in a STATICCALL
    address big; // returns 300 bytes: word 0 = 0x11.., word 4 = 0x33.., word 5 = 0x22..
    address odd; // returns 33 bytes of 0xff
    address reverter; // reverts with 64 bytes
    address hog; // spends all but at most 22 of its gas, then returns 192 bytes
    address nobody; // no code at all
    address constant PAIRING = address(0x08); // bn254 pairing: a 4-byte input burns its gas

    function _fresh(string memory label) internal view returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encodePacked("curb.sharerprobe.", label)))));
        require(a.code.length == 0 && a.balance == 0, "a label address holds state here");
    }

    function setUp() public {
        runner = new ProbeRunner();
        init = vm.getCode("SharerProbe.sol:SharerProbe");
        reporter = _fresh("reporter");
        burner = _fresh("burner");
        writer = _fresh("writer");
        big = _fresh("big");
        odd = _fresh("odd");
        reverter = _fresh("reverter");
        nobody = _fresh("nobody");
        hog = _fresh("hog");
        // GAS PUSH0 MSTORE PUSH1 32 PUSH0 RETURN
        vm.etch(reporter, hex"5a5f5260205ff3");
        vm.etch(burner, hex"fe");
        // PUSH1 1 PUSH0 SSTORE PUSH1 32 PUSH0 RETURN
        vm.etch(writer, hex"60015f5560205ff3");
        // PUSH32 0x11.. PUSH0 MSTORE  PUSH32 0x33.. PUSH1 0x80 MSTORE  PUSH32 0x22.. PUSH1 0xa0 MSTORE  PUSH2 300 PUSH0 RETURN
        vm.etch(
            big,
            abi.encodePacked(
                hex"7f",
                bytes32(type(uint256).max / 255 * 0x11),
                hex"5f52",
                hex"7f",
                bytes32(type(uint256).max / 255 * 0x33),
                hex"608052",
                hex"7f",
                bytes32(type(uint256).max / 255 * 0x22),
                hex"60a052",
                hex"61012c5ff3"
            )
        );
        // PUSH0 NOT PUSH0 MSTORE PUSH0 NOT PUSH1 32 MSTORE PUSH1 33 PUSH0 RETURN
        vm.etch(odd, hex"5f195f525f1960205260215ff3");
        // PUSH1 64 PUSH0 REVERT
        vm.etch(reverter, hex"60405ffd");
        // 0: JUMPDEST PUSH1 60 GAS GT PUSH0 JUMPI (loop while gas > 60), then PUSH1 192 PUSH0 RETURN
        vm.etch(hog, hex"5b603c5a115f5760c05ff3");
    }

    // ------------------------------------------------------------ plumbing

    struct Answer {
        bool ok;
        uint256 size;
        bytes data;
    }

    function _input(address[] memory to, bytes[] memory data) internal pure returns (bytes memory packed) {
        for (uint256 i; i < to.length; i++) {
            packed = abi.encodePacked(packed, to[i], uint16(data[i].length), data[i]);
        }
    }

    function _withInput(bytes memory packed) internal view returns (bytes memory) {
        return abi.encodePacked(init, packed, uint256(packed.length));
    }

    /// One request: its own transaction (see the contract's isolate line), so
    /// its targets start cold, as in a fresh eth_call.
    function _run(address[] memory to, bytes[] memory data, uint256 gas) internal returns (bytes memory) {
        return runner.run{gas: gas}(_withInput(_input(to, data)));
    }

    function _decode(bytes memory out) internal pure returns (Answer[] memory a) {
        require(out.length >= 32, "short output");
        uint256 n;
        assembly {
            n := mload(add(out, 32))
        }
        a = new Answer[](n);
        uint256 at = 32;
        for (uint256 i; i < n; i++) {
            uint256 h;
            assembly {
                h := mload(add(add(out, 32), at))
            }
            at += 32;
            a[i].ok = h >> 255 == 1;
            a[i].size = h & ((uint256(1) << 255) - 1);
            if (a[i].ok) {
                uint256 c = a[i].size > RETURN_CAP ? RETURN_CAP : a[i].size;
                a[i].data = new bytes(c);
                for (uint256 j; j < c; j++) {
                    a[i].data[j] = out[at + j];
                }
                uint256 padded = (c + 31) / 32 * 32;
                for (uint256 j = c; j < padded; j++) {
                    require(out[at + j] == 0, "padding is not zero");
                }
                at += padded;
            }
        }
        require(at == out.length, "trailing output");
    }

    function _same(uint256 n, address target) internal pure returns (address[] memory to, bytes[] memory data) {
        to = new address[](n);
        data = new bytes[](n);
        for (uint256 i; i < n; i++) {
            to[i] = target;
            data[i] = hex"0dfe1681"; // token0()
        }
    }

    function _reported(Answer memory a) internal pure returns (uint256) {
        assertTrue(a.ok, "the reporter answered");
        assertEq(a.size, 32);
        return abi.decode(a.data, (uint256));
    }

    // ------------------------------------------------------------ the code

    function test_theBuildIsThePinnedCode() public view {
        // the number services/sharer sends and the spec names
        assertEq(keccak256(init), PROBE_CODE_HASH, "SharerProbe's creation code moved: update probe.ts, the spec and this pin together");
        // CALL_NEED as written in the contract, and why EIP-150 needs no term
        // of its own: at a check, gas >= CALL_NEED + 200 * (32 + 192); what
        // reaches the CALL after a cold access still leaves 63/64 >= CALL_GAS
        uint256 callNeed = CALL_GAS + 2600 + 1000;
        assertEq(callNeed, 103_600);
        assertGe((callNeed + 200 * (32 + 192) - 2600 - 100) * 63 / 64, CALL_GAS);
    }

    // ------------------------------------------------------------ the gas

    function test_everyCallGetsExactlyCallGasWhereverItStands() public {
        address[] memory to = new address[](16);
        bytes[] memory data = new bytes[](16);
        for (uint256 i; i < 16; i++) {
            to[i] = i % 3 == 2 ? reporter : (i % 2 == 0 ? burner : PAIRING);
            data[i] = hex"0dfe1681";
        }
        Answer[] memory a = _decode(_run(to, data, 10_000_000));
        assertEq(a.length, 16, "every call answered");
        uint256 reporters;
        for (uint256 i; i < 16; i++) {
            if (to[i] == reporter) {
                // GAS costs 2: the reporter starts with exactly CALL_GAS
                assertEq(_reported(a[i]), CALL_GAS - 2, "a reporter after burners gets the full CALL_GAS");
                reporters++;
            } else {
                assertFalse(a[i].ok, "a burner fails");
                assertEq(a[i].size, 0);
                assertEq(a[i].data.length, 0);
            }
        }
        assertEq(reporters, 5);
    }

    // ------------------------------------------------------------ the edges
    //
    // WHERE A MISTAKE IN THE GAS CHECK SHOWS: at the edges, the smallest gas at
    // which a request makes its k-th call. Each edge is found by bisection and
    // then walked in steps of 37 gas from 1,500 below it to 300 above, so a
    // check that lets a call through a little early - one that forgets the
    // cold access, the bookkeeping or a part of the code deposit - is caught
    // where it does (the window such a mutant opens is wider than the step).
    // Every request on the way must answer, and every call it makes must pass
    // `ok`. Bisection instead of a sweep of the whole range keeps the number of
    // creations - each a new address a fork has to ask its upstream about -
    // in the hundreds.

    /// Asserts what every answer in a run must be, and returns how many calls
    /// the request answered.
    function _answered(address[] memory to, bytes[] memory data, uint256 g, bool hogs) internal returns (uint256) {
        Answer[] memory a = _decode(_run(to, data, g));
        for (uint256 i; i < a.length; i++) {
            if (hogs) {
                assertTrue(a[i].ok, "the hog answered");
                assertEq(a[i].size, 192);
                assertEq(a[i].data.length, RETURN_CAP);
            } else if (to[i] == reporter) {
                assertEq(_reported(a[i]), CALL_GAS - 2, "never less than CALL_GAS");
            }
        }
        return a.length;
    }

    /// Every edge of a request of n calls, bisected in [lo, hi) and walked.
    function _walkEdges(address[] memory to, bytes[] memory data, bool hogs, uint256 lo, uint256 hi) internal {
        uint256 n = to.length;
        assertEq(_answered(to, data, hi, hogs), n, "the top of the range answers every call");
        uint256 floor = lo;
        for (uint256 k = 1; k <= n; k++) {
            (uint256 a, uint256 b) = (floor, hi);
            while (a < b) {
                uint256 mid = (a + b) / 2;
                if (_answered(to, data, mid, hogs) >= k) b = mid;
                else a = mid + 1;
            }
            assertGt(a, floor, "the edge is inside the range");
            uint256 last;
            for (uint256 g = a - 1500; g < a + 300; g += 37) {
                uint256 got = _answered(to, data, g, hogs);
                assertGe(got, last, "more gas never answers fewer calls");
                last = got;
                if (g < a) assertLt(got, k, "below the edge the k-th call is not made");
                else assertGe(got, k, "from the edge on it is");
            }
            floor = a;
        }
    }

    /// Down to the last gas a request has: a call is either made with the full
    /// CALL_GAS or not made at all, and a request never fails.
    function test_aCallIsMadeWithTheFullCallGasOrNotAtAll() public {
        (address[] memory to, bytes[] memory data) = _same(4, reporter);
        to[0] = burner;
        _walkEdges(to, data, false, 100_000, 2_000_000);
    }

    /// A call that spends all but a few gas of its CALL_GAS and answers in
    /// full (192 bytes, the largest record) leaves just enough for the deposit
    /// of everything returned: at the edge of every budget, the request still
    /// answers instead of failing as a whole.
    function test_aCallThatSpendsItsWholeBudgetStillLeavesTheRequestAnswered() public {
        (address[] memory to, bytes[] memory data) = _same(3, hog);
        _walkEdges(to, data, true, 100_000, 2_000_000);
    }

    /// A request that stops early, and the rest sent after it, give what one
    /// request with gas to spare gives.
    function test_stoppingEarlyAndContinuingAnswersAsOneRequest() public {
        address[] memory to = new address[](24);
        bytes[] memory data = new bytes[](24);
        for (uint256 i; i < 24; i++) {
            to[i] = i % 4 == 3 ? reporter : (i % 4 == 1 ? big : burner);
            data[i] = hex"c45a0155"; // factory()
        }
        Answer[] memory whole = _decode(_run(to, data, 10_000_000));
        assertEq(whole.length, 24);

        uint256 done;
        uint256 requests;
        while (done < 24) {
            uint256 left = 24 - done;
            address[] memory t = new address[](left);
            bytes[] memory d = new bytes[](left);
            for (uint256 i; i < left; i++) {
                (t[i], d[i]) = (to[done + i], data[done + i]);
            }
            Answer[] memory a = _decode(_run(t, d, 700_000));
            assertGt(a.length, 0, "every request answers at least one call");
            for (uint256 i; i < a.length; i++) {
                Answer memory w = whole[done + i];
                assertEq(a[i].ok, w.ok);
                assertEq(a[i].size, w.size);
                assertEq(a[i].data, w.data);
            }
            done += a.length;
            requests++;
        }
        assertGt(requests, 3, "the small requests did stop early");
    }

    // ------------------------------------------------------------ the answers

    function test_anAnswerIsItsFirst160BytesAndItsSize() public {
        address[] memory to = new address[](5);
        bytes[] memory data = new bytes[](5);
        (to[0], to[1], to[2], to[3], to[4]) = (big, odd, reverter, nobody, writer);
        for (uint256 i; i < 5; i++) {
            data[i] = hex"0dfe1681";
        }
        Answer[] memory a = _decode(_run(to, data, 10_000_000));
        assertEq(a.length, 5);
        // 300 bytes: the header keeps the size, the data stops at 160
        assertTrue(a[0].ok);
        assertEq(a[0].size, 300);
        assertEq(a[0].data.length, RETURN_CAP);
        bytes32 w0;
        bytes32 w4;
        bytes memory d0 = a[0].data;
        assembly {
            w0 := mload(add(d0, 32))
            w4 := mload(add(d0, 160))
        }
        assertEq(w0, bytes32(type(uint256).max / 255 * 0x11));
        assertEq(w4, bytes32(type(uint256).max / 255 * 0x33), "the fifth word is in");
        // (the sixth, 0x22.., is not: _decode found nothing after 160 bytes)
        // 33 bytes, zero-padded to two words (_decode checks the padding)
        assertTrue(a[1].ok);
        assertEq(a[1].size, 33);
        assertEq(a[1].data.length, 33);
        assertEq(uint8(a[1].data[32]), 0xff);
        // a revert: its size, never its data
        assertFalse(a[2].ok);
        assertEq(a[2].size, 64);
        assertEq(a[2].data.length, 0);
        // no code: an empty success, as an eth_call to an EOA gives
        assertTrue(a[3].ok);
        assertEq(a[3].size, 0);
        // a write fails: every call is a STATICCALL
        assertFalse(a[4].ok, "a probed contract cannot write");
    }

    function test_theOutputNeverPassesEip170() public {
        (address[] memory to, bytes[] memory data) = _same(200, big);
        bytes memory out = _run(to, data, 15_000_000);
        assertLe(out.length, MAX_OUT);
        Answer[] memory a = _decode(out);
        // a header and 160 bytes each: 127 fit after the count word, 128 do not
        assertEq(a.length, 127);
        assertEq(out.length, 32 + 127 * 192);
    }

    // ------------------------------------------------------------ refused input

    function test_aRecordThatRunsPastTheEndRevertsTheRequest() public {
        // a 36-byte calldata announced, 4 given
        bytes memory bad = abi.encodePacked(reporter, uint16(36), hex"0dfe1681");
        vm.expectRevert(bytes("the probe creation failed"));
        runner.run(_withInput(bad));
        // a record shorter than its own target and length
        bytes memory stub = abi.encodePacked(bytes20(reporter), bytes1(0x00));
        vm.expectRevert(bytes("the probe creation failed"));
        runner.run(_withInput(stub));
        // a length word larger than the code before it, and a whole number of
        // 22-byte records: unchecked, the copy would start before the code,
        // read as zeroes, and answer that many calls to address 0
        uint256 tooLong = (init.length / 22 + 1) * 22;
        assertGt(tooLong, init.length);
        vm.expectRevert(bytes("the probe creation failed"));
        runner.run(abi.encodePacked(init, tooLong));
    }

    function test_noCallsAnswersNothing() public {
        Answer[] memory a = _decode(runner.run(_withInput("")));
        assertEq(a.length, 0);
    }
}
