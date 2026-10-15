#!/usr/bin/env bash
# THE DISTRIBUTOR ROLES' DELAYS AND THE FREEZE, BROKEN ON PURPOSE.
#
#   bash script/b20/mutate-distributor-roles.sh
#   MUT_ONLY="r1 r7" ...   run only these mutants (and the baseline)
#
# The guards that keep an independent vetoer's veto worth something against
# the factory's owner, and that make a freeze hold every queued root: removing
# a vetoer and unfreezing are announced and wait 48 hours, a removal waits out
# the veto hour of every root already relayed, a rotation is held while
# frozen, a frozen factory's pending roots never become payable and stay
# vetoable, a freeze cancels an unfreeze already announced, and vetoMany. Each guard is removed, inverted or weakened on its
# own, from the same starting state, and the named tests must fail. No chain:
# these are the unit suites under test/sharing.
#
# Same shape as mutate-sharing.sh: -e so a stale anchor stops the run, a
# snapshot restored on exit, a baseline that must be green, a verdict per
# mutant and an exit code that means something.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
MUT_ONLY="${MUT_ONLY:-}"

F=src/curb/sharing/HolderDistributorFactory.sol
D=src/curb/sharing/HolderFeeDistributor.sol
FILES=("$F" "$D")
SNAP="$(mktemp -d /tmp/curb-roles-snapshot.XXXXXX)"
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
  # the reason a test failed is printed with it, so a mutant caught by the
  # wrong failure can be told apart
  out="$(base-forge test --match-path 'test/sharing/*' --match-test "$2" 2>&1 \
    | grep -E "^\[(PASS|FAIL)|Suite result" | sed 's/ (gas.*//' || true)"
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

ALL='test_aVetoerIsNotRemovedWhileARootIsInsideItsHour|test_A1_|test_A1b_|test_A2_|test_A3_|test_B_|test_removingAVetoerTakes48Hours|test_addingAVetoerAgainCancelsItsAnnouncedRemoval|test_anUnfreezeCannotBeArmedAheadOfAFreeze|test_freezeByTheOwnerOrAVetoer_unfreezeOnlyAfterAnAnnouncement|test_aRotationIsNotExecutedWhileFrozen|test_anUnfreezeExpiresAfterItsWindow|test_vetoManyVetoesEveryRootOfABatch|test_aFreezeHoldsAPendingRoot|test_aHeldRootBecomesPayableAfterTheUnfreeze|test_vetoInsideTheHourOnly|test_theActiveRootKeepsPayingWhileFrozen|test_theOwnerMayFreezeWithoutBeingAVetoer|test_addVetoerIsOwnerOnlyAndAtOnce|test_A4_'
echo "############ 0. UNMUTATED, every target below"
run baseline0 "$ALL"

echo; echo "############ r1. a publish does not move the veto hour on"
OLD=$'        vetoableUntil = block.timestamp + SHARING_VETO_WINDOW;\n' NEW='' mutate "$F"
run r1 'test_aVetoerIsNotRemovedWhileARootIsInsideItsHour|test_A1b_'
restore

echo; echo "############ r2. a removal takes effect without its 48 hours"
OLD=$'        _requireRipe(vetoerRemovalAt[account]);\n' NEW='' mutate "$F"
run r2 'test_removingAVetoerTakes48Hours|test_A1_'
restore

echo; echo "############ r3. a removal does not wait out the roots' veto hour"
OLD=$'        if (block.timestamp < vetoableUntil) revert RootsStillVetoable(vetoableUntil);\n' NEW='' mutate "$F"
run r3 'test_aVetoerIsNotRemovedWhileARootIsInsideItsHour|test_A1b_'
restore

echo; echo "############ r4. a removal lands one second before the hour ends"
OLD='if (block.timestamp < vetoableUntil) revert' NEW='if (block.timestamp + 1 < vetoableUntil) revert' mutate "$F"
run r4 'test_aVetoerIsNotRemovedWhileARootIsInsideItsHour'
restore

echo; echo "############ r5. anybody announces a vetoer's removal"
OLD='    function announceVetoerRemoval(address account) external onlyOwner {' NEW='    function announceVetoerRemoval(address account) external {' mutate "$F"
run r5 'test_removingAVetoerTakes48Hours'
restore

echo; echo "############ r6. adding a vetoer again leaves its removal announced"
OLD=$'        _setVetoer(account, true);\n        vetoerRemovalAt[account] = 0;\n' NEW=$'        _setVetoer(account, true);\n' mutate "$F"
run r6 'test_addingAVetoerAgainCancelsItsAnnouncedRemoval'
restore

echo; echo "############ r7. an executed removal is not spent"
OLD=$'        vetoerRemovalAt[account] = 0;\n        _setVetoer(account, false);\n' NEW=$'        _setVetoer(account, false);\n' mutate "$F"
run r7 'test_removingAVetoerTakes48Hours'
restore

echo; echo "############ r8. an unfreeze can be announced while nothing is frozen"
OLD=$'        if (!frozen) revert NotFrozen();\n' NEW='' mutate "$F"
run r8 'test_anUnfreezeCannotBeArmedAheadOfAFreeze'
restore

echo; echo "############ r9. anybody announces an unfreeze"
OLD='    function announceUnfreeze() external onlyOwner {' NEW='    function announceUnfreeze() external {' mutate "$F"
run r9 'test_freezeByTheOwnerOrAVetoer_unfreezeOnlyAfterAnAnnouncement'
restore

echo; echo "############ r10. an unfreeze takes effect without its 48 hours"
OLD=$'        _requireRipe(uint64(pendingUnfreezeAt));\n' NEW='' mutate "$F"
run r10 'test_freezeByTheOwnerOrAVetoer_unfreezeOnlyAfterAnAnnouncement|test_A2_|test_anUnfreezeCannotBeArmedAheadOfAFreeze'
restore

echo; echo "############ r11. an executed unfreeze is not spent"
OLD=$'        _requireRipe(uint64(pendingUnfreezeAt));\n        pendingUnfreezeAt = 0;\n' NEW=$'        _requireRipe(uint64(pendingUnfreezeAt));\n' mutate "$F"
run r11 'test_freezeByTheOwnerOrAVetoer_unfreezeOnlyAfterAnAnnouncement'
restore

echo; echo "############ r12. a rotation is executed while frozen"
OLD=$'        _requireRipe(pendingPublisherAt);\n        if (frozen) revert PublishingFrozen();\n' NEW=$'        _requireRipe(pendingPublisherAt);\n' mutate "$F"
run r12 'test_aRotationIsNotExecutedWhileFrozen|test_A2_'
restore

echo; echo "############ r13. cancelPending leaves the unfreeze announced"
OLD=$'        pendingKeeperPayeeAt = 0;\n        pendingUnfreezeAt = 0;\n        emit PendingCancelled();\n' NEW=$'        pendingKeeperPayeeAt = 0;\n        emit PendingCancelled();\n' mutate "$F"
run r13 'test_anUnfreezeExpiresAfterItsWindow'
restore

echo; echo "############ r14. anybody vetoes many"
OLD=$'        _checkVetoer();\n        uint256 n = distributors.length;\n' NEW=$'        uint256 n = distributors.length;\n' mutate "$F"
run r14 'test_vetoManyVetoesEveryRootOfABatch'
restore

echo; echo "############ r15. vetoMany takes mismatched lists"
OLD=$'        if (epochs.length != n) revert LengthMismatch();\n' NEW='' mutate "$F"
run r15 'test_vetoManyVetoesEveryRootOfABatch'
restore

echo; echo "############ r16. vetoMany vetoes only the first"
OLD=$'            _veto(distributors[i], epochs[i], reason);\n' NEW=$'            _veto(distributors[0], epochs[0], reason);\n' mutate "$F"
run r16 'test_vetoManyVetoesEveryRootOfABatch|test_B_'
restore

echo; echo "############ r17. a frozen factory's ripe root is promoted on the way in"
OLD='if (at == 0 || block.timestamp < at || _frozen()) return;' NEW='if (at == 0 || block.timestamp < at) return;' mutate "$D"
run r17 'test_aFreezeHoldsAPendingRoot|test_aHeldRootBecomesPayableAfterTheUnfreeze'
restore

echo; echo "############ r18. activate goes through while frozen"
OLD=$'        if (_frozen()) revert Frozen();\n' NEW='' mutate "$D"
run r18 'test_aFreezeHoldsAPendingRoot|test_B_'
restore

echo; echo "############ r19. a frozen factory's held root cannot be vetoed after its hour"
OLD='if (block.timestamp >= at && !_frozen()) revert VetoWindowOver(at);' NEW='if (block.timestamp >= at) revert VetoWindowOver(at);' mutate "$D"
run r19 'test_aFreezeHoldsAPendingRoot|test_B_'
restore

echo; echo "############ r20. a root can be vetoed after its hour while nothing is frozen"
OLD='if (block.timestamp >= at && !_frozen()) revert VetoWindowOver(at);' NEW='if (block.timestamp >= at && _frozen()) revert VetoWindowOver(at);' mutate "$D"
run r20 'test_vetoInsideTheHourOnly|test_aHeldRootBecomesPayableAfterTheUnfreeze'
restore

echo; echo "############ r21. the distributor never sees the freeze"
OLD='        return IDistributorFactoryRoles(factory).frozen();' NEW='        return false;' mutate "$D"
run r21 'test_aFreezeHoldsAPendingRoot|test_aHeldRootBecomesPayableAfterTheUnfreeze|test_B_'
restore

echo; echo "############ r22. a freeze leaves an announced unfreeze in place"
OLD=$'        if (pendingUnfreezeAt != 0) {\n            pendingUnfreezeAt = 0;\n            emit UnfreezeCancelled(msg.sender);\n        }\n' NEW='' mutate "$F"
run r22 'test_A4_'
restore

echo; echo "############ r23. a freeze cancels the unfreeze and says nothing"
OLD=$'            pendingUnfreezeAt = 0;\n            emit UnfreezeCancelled(msg.sender);\n' NEW=$'            pendingUnfreezeAt = 0;\n' mutate "$F"
run r23 'test_A4_'
restore

echo; echo "############ r24. every freeze reports a cancelled unfreeze"
OLD=$'        if (pendingUnfreezeAt != 0) {\n            pendingUnfreezeAt = 0;\n            emit UnfreezeCancelled(msg.sender);\n        }\n' NEW=$'        pendingUnfreezeAt = 0;\n        emit UnfreezeCancelled(msg.sender);\n' mutate "$F"
run r24 'test_A4_'
restore

echo
echo "############ restored:"
trap - EXIT
for f in "${FILES[@]}"; do diff -q "$SNAP/$f" "$f"; done && echo "  every contract is byte-identical to the snapshot"
[ "$FAILED" = 0 ] || { echo "  $FAILED VERDICT(S) FAILED - read them above"; exit 1; }
if [ "$SKIPPED" -gt 0 ]; then
  echo "  every mutant run was caught and the baseline was green; $SKIPPED were skipped (MUT_ONLY)"
else
  echo "  every mutant was caught and the baseline was green"
fi
