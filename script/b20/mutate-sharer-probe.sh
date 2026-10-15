#!/usr/bin/env bash
# SHARERPROBE, BROKEN ON PURPOSE.
#
#   bash script/b20/mutate-sharer-probe.sh
#   MUT_ONLY="p1 p7" ...   run only these mutants (and the baseline)
#
# SharerProbe (src/curb/sharing/SharerProbe.sol) is the creation code
# curb-sharer runs as every probe eth_call. Its guards: every call gets
# exactly CALL_GAS or is not made, the request keeps enough gas for the code
# deposit of everything it returns, the output never passes EIP-170, every
# call is static, an answer is cut at RETURN_CAP and padded with zeroes, and
# malformed input reverts the request. Each is removed or weakened on its own,
# from the same starting state, and the named tests of
# test/sharing/SharerProbe.t.sol must fail - printed with their reasons, so a
# mutant caught for the wrong one can be told apart. The pin test
# (test_theBuildIsThePinnedCode) is left out: every mutant moves the code hash,
# so it would catch all of them for a reason that says nothing.
#
# Same shape as mutate-distributor-roles.sh: -e so a stale anchor stops the
# run, a snapshot restored on exit, a baseline that must be green, a verdict
# per mutant and an exit code that means something. No chain.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
MUT_ONLY="${MUT_ONLY:-}"

P=src/curb/sharing/SharerProbe.sol
FILES=("$P")
SNAP="$(mktemp -d /tmp/curb-probe-snapshot.XXXXXX)"
for f in "${FILES[@]}"; do mkdir -p "$SNAP/$(dirname "$f")"; cp "$f" "$SNAP/$f"; done
restore() { for f in "${FILES[@]}"; do cp "$SNAP/$f" "$f"; done; }
trap restore EXIT

FAILED=0
SKIPPED=0
judge() { # judge <name> <output>
  local name="$1" out="$2" pass fail
  pass=$(printf '%s\n' "$out" | grep -c '^\[PASS' || true)
  fail=$(printf '%s\n' "$out" | grep -c '^\[FAIL' || true)
  if [[ "$name" == baseline* ]]; then
    if [ "$pass" -gt 0 ] && [ "$fail" = 0 ]; then
      echo "  VERDICT $name: green, as it must be ($pass passed)"
    else
      echo "  VERDICT $name: NOT GREEN ($pass passed, $fail failed)"; FAILED=$((FAILED + 1))
    fi
  elif [ "$fail" -gt 0 ]; then
    echo "  VERDICT $name: caught"
  else
    echo "  VERDICT $name: SURVIVED ($pass passed, 0 failed)$([ "$pass" = 0 ] && echo ' - nothing ran; did the mutant compile?')"
    FAILED=$((FAILED + 1))
  fi
}
run() { # run <name> <match-test regex>
  if [ -n "$MUT_ONLY" ] && [[ "$1" != baseline* ]] && [[ " $MUT_ONLY " != *" $1 "* ]]; then
    echo "  skipped $1 (not in MUT_ONLY)"; SKIPPED=$((SKIPPED + 1)); return 0
  fi
  local out
  out="$(base-forge test --match-path 'test/sharing/SharerProbe.t.sol' --match-test "$2" 2>&1 \
    | grep -E "^\[(PASS|FAIL)|Suite result" | sed 's/ (gas.*//' | cut -c1-300 || true)"
  printf '%s\n' "$out"
  judge "$1" "$out"
}
mutate() { # mutate <file> ; reads OLD and NEW from the environment
  python3 - "$1" <<'EOF'
import io, os, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = os.environ["OLD"]; new = os.environ["NEW"]
assert s.count(old) == 1, "stale anchor in %s: %r" % (p, old[:80])
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new, 1))
EOF
}

ALL='test_everyCall|test_aCallIsMade|test_aCallThatSpends|test_stoppingEarly|test_anAnswerIs|test_theOutputNever|test_aRecordThatRuns|test_noCalls'
echo "############ 0. UNMUTATED, every target below"
run baseline0 "$ALL"

echo; echo "############ p1. no gas check: a call is made with whatever is left"
OLD='                if lt(gas(), add(CALL_NEED, mul(DEPOSIT_GAS, add(sub(w, out), RECORD_MAX)))) { break }
' NEW='' mutate "$P"
run p1 'test_aCallIsMadeWithTheFullCallGasOrNotAtAll|test_aCallThatSpendsItsWholeBudget'
restore

echo; echo "############ p2. the code deposit is not reserved"
OLD='if lt(gas(), add(CALL_NEED, mul(DEPOSIT_GAS, add(sub(w, out), RECORD_MAX)))) { break }' \
NEW='if lt(gas(), CALL_NEED) { break }' mutate "$P"
run p2 'test_aCallIsMadeWithTheFullCallGasOrNotAtAll|test_aCallThatSpendsItsWholeBudget'
restore

echo; echo "############ p3. the deposit of this call's own answer is not reserved"
OLD='mul(DEPOSIT_GAS, add(sub(w, out), RECORD_MAX))' NEW='mul(DEPOSIT_GAS, sub(w, out))' mutate "$P"
run p3 'test_aCallIsMadeWithTheFullCallGasOrNotAtAll|test_aCallThatSpendsItsWholeBudget'
restore

echo; echo "############ p4. CALL_NEED without the cold access (2,600)"
OLD='uint256 internal constant CALL_NEED = 103_600;' NEW='uint256 internal constant CALL_NEED = 101_000;' mutate "$P"
run p4 'test_aCallThatSpendsItsWholeBudget'
restore

echo; echo "############ p5. CALL_NEED without the bookkeeping (1,000)"
OLD='uint256 internal constant CALL_NEED = 103_600;' NEW='uint256 internal constant CALL_NEED = 102_600;' mutate "$P"
run p5 'test_aCallThatSpendsItsWholeBudget'
restore

echo; echo "############ p6. the output may pass EIP-170"
OLD='                if gt(add(w, RECORD_MAX), limit) { break }
' NEW='' mutate "$P"
run p6 'test_theOutputNeverPassesEip170'
restore

echo; echo "############ p7. a call that may write (CALL instead of STATICCALL)"
OLD='let ok := staticcall(CALL_GAS, shr(96, mload(p)), add(p, 22), dlen, 0, 0)' \
NEW='let ok := call(CALL_GAS, shr(96, mload(p)), 0, add(p, 22), dlen, 0, 0)' mutate "$P"
run p7 'test_anAnswerIsItsFirst160BytesAndItsSize'
restore

echo; echo "############ p8. a call given all the gas there is, not CALL_GAS"
OLD='let ok := staticcall(CALL_GAS, shr(96, mload(p)), add(p, 22), dlen, 0, 0)' \
NEW='let ok := staticcall(gas(), shr(96, mload(p)), add(p, 22), dlen, 0, 0)' mutate "$P"
run p8 'test_everyCallGetsExactlyCallGasWhereverItStands'
restore

echo; echo "############ p9. an answer is not cut at RETURN_CAP"
OLD='                    if gt(c, RETURN_CAP) { c := RETURN_CAP }
' NEW='' mutate "$P"
run p9 'test_anAnswerIsItsFirst160BytesAndItsSize|test_theOutputNeverPassesEip170'
restore

echo; echo "############ p10. an answer is not padded to a whole word"
OLD='                    w := add(w, and(add(c, 31), not(31)))' NEW='                    w := add(w, c)' mutate "$P"
run p10 'test_anAnswerIsItsFirst160BytesAndItsSize'
restore

echo; echo "############ p11. a record that runs past the end is read anyway"
OLD='                if gt(next, end) { revert(0, 0) }
' NEW='' mutate "$P"
run p11 'test_aRecordThatRunsPastTheEndRevertsTheRequest'
restore

echo; echo "############ p12. a length word larger than the code is read anyway"
OLD='            if gt(len, sub(size, 32)) { revert(0, 0) }
' NEW='' mutate "$P"
run p12 'test_aRecordThatRunsPastTheEndRevertsTheRequest'
restore

echo; echo "############ p13. the success bit is not written"
OLD='mstore(w, or(shl(255, ok), rsize))' NEW='mstore(w, rsize)' mutate "$P"
run p13 'test_everyCallGetsExactlyCallGasWhereverItStands|test_anAnswerIsItsFirst160BytesAndItsSize'
restore

echo; echo "############ p14. the count of answered calls is not written"
OLD='            mstore(out, n)
' NEW='' mutate "$P"
run p14 'test_everyCallGetsExactlyCallGasWhereverItStands|test_stoppingEarlyAndContinuingAnswersAsOneRequest'
restore

echo
echo "################################################################"
echo "  $( [ "$FAILED" = 0 ] && echo 'every mutant caught, baseline green' || echo "$FAILED PROBLEM(S) - read the verdicts above" )$( [ "$SKIPPED" -gt 0 ] && echo " ($SKIPPED skipped by MUT_ONLY)" )"
exit "$FAILED"
