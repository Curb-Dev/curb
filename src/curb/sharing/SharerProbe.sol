// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title SharerProbe
 * @notice NEVER DEPLOYED. The curb-sharer service (services/sharer) runs this
 *         contract's CREATION CODE as an eth_call with no `to`, the calls it
 *         wants answered appended after it. The constructor makes every call
 *         and returns the answers as the code it would deploy; an eth_call
 *         writes nothing, so nothing is ever deployed. One request answers
 *         hundreds of calls, on any node, with no contract on chain.
 *
 * WHY IT EXISTS (CURB-SHARE v1, spec 1.3 and 4.10). The sharer asks token0(),
 * token1() and factory() of every address a launch token's Transfer logs
 * name, and anybody can put any address there with a zero-value transfer.
 * Some addresses burn all the gas a call gives them (precompile 0x08, code
 * 0xfe). Through Multicall3 each call gets 63/64 of what is left, so a few
 * burners starve every call after them, and asking the starved ones again on
 * their own gives them other gas than the batch did - an answer that depends
 * on gasleft() then depends on which path asked. Here EVERY CALL GETS EXACTLY
 * CALL_GAS, wherever it stands in the request: before each call the
 * constructor checks that it can give the full CALL_GAS and still pay for
 * everything after it, and when it cannot, it stops and says how many calls
 * it answered. The caller sends the rest in its next request. Nothing is ever
 * asked twice, and no call is ever answered with less gas.
 *
 * EACH CALL IS A STATICCALL: a probed contract cannot change what a later call
 * in the same request sees.
 *
 * INPUT: the creation code, then the calls packed one after another as
 * `target (20 bytes) | length (2 bytes) | calldata (length bytes)`, then one
 * 32-byte word holding the packed calls' byte length. A record that runs past
 * the end reverts the whole request.
 *
 * OUTPUT (the returned "code"): one word n, the number of calls answered (the
 * first n of the input, in order), then per call one header word
 * `success << 255 | returndatasize`, followed - for a call that succeeded - by
 * its first min(returndatasize, RETURN_CAP) bytes, zero-padded to a whole
 * word. A failed call carries no data. The output never exceeds EIP-170's
 * 24,576 bytes (a creation that returned more would fail), and its first byte
 * is never 0xEF (EIP-3541): n is far below 2^248.
 *
 * This file is compiled without the metadata hash (foundry.toml), so its
 * creation code depends on the code alone; services/sharer pins its keccak256
 * (PROBE_CODE_HASH), and test/sharing/SharerProbe.t.sol checks the build
 * against the same number.
 */
contract SharerProbe {
    /// Gas each call is given, exactly.
    uint256 internal constant CALL_GAS = 100_000;
    /// Bytes of a successful call's answer that are returned.
    uint256 internal constant RETURN_CAP = 160;
    /// A header word and the largest answer: the most one call adds.
    uint256 internal constant RECORD_MAX = 192;
    /// EIP-170: the most a creation may return.
    uint256 internal constant MAX_OUT = 24_576;
    /// Code deposit gas per returned byte.
    uint256 internal constant DEPOSIT_GAS = 200;
    /// What a call needs before it is made, besides the code deposit of the
    /// output (checked on top): CALL_GAS for the callee, a cold account
    /// access (EIP-2929, 2,600) and 1,000 for the bookkeeping up to the next
    /// check and the final RETURN (about 300 is used). EIP-150's 63/64 needs
    /// no term of its own: the deposit reserve is at least 200 * (32 + 192) =
    /// 44,800 gas, far above the CALL_GAS / 64 a call keeps back.
    uint256 internal constant CALL_NEED = 103_600;

    constructor() {
        assembly {
            let size := codesize()
            codecopy(0, sub(size, 32), 32)
            let len := mload(0)
            if gt(len, sub(size, 32)) { revert(0, 0) }
            let p := mload(0x40)
            codecopy(p, sub(sub(size, 32), len), len)
            let end := add(p, len)
            let out := and(add(end, 31), not(31))
            let limit := add(out, MAX_OUT)
            let w := add(out, 32)
            let n := 0
            for {} lt(p, end) {} {
                let dlen := shr(240, mload(add(p, 20)))
                let next := add(add(p, 22), dlen)
                if gt(next, end) { revert(0, 0) }
                if gt(add(w, RECORD_MAX), limit) { break }
                if lt(gas(), add(CALL_NEED, mul(DEPOSIT_GAS, add(sub(w, out), RECORD_MAX)))) { break }
                let ok := staticcall(CALL_GAS, shr(96, mload(p)), add(p, 22), dlen, 0, 0)
                let rsize := returndatasize()
                mstore(w, or(shl(255, ok), rsize))
                w := add(w, 32)
                if ok {
                    let c := rsize
                    if gt(c, RETURN_CAP) { c := RETURN_CAP }
                    returndatacopy(w, 0, c)
                    w := add(w, and(add(c, 31), not(31)))
                }
                p := next
                n := add(n, 1)
            }
            mstore(out, n)
            return(out, sub(w, out))
        }
    }
}
