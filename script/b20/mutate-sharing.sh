#!/usr/bin/env bash
# HOLDER SHARING'S GUARDS, BROKEN ON PURPOSE (core v2 design, sections A and B).
#
#   bash script/b20/start-node.sh          (in another terminal)
#   RPC=http://127.0.0.1:8546 bash script/b20/mutate-sharing.sh
#   MUT_ONLY="s1 s7 s30" ...   run only these mutants (and the baseline)
#
# Every guard the sharing work added is removed, inverted or weakened on its
# own, FROM THE SAME STARTING STATE, and the named test must fail. A test that
# stays green against a broken guard is not testing it. Unit-level guards are
# judged by test/HolderSharing.t.sol, which compiles in a fraction of the time
# of the fork suites; the rest by the fork suites against a read-only fork.
#
# Same shape as mutate-launch-policy.sh: -e so a stale anchor stops the run,
# a snapshot restored on exit, a baseline that must be green target by target,
# and a verdict per mutant with an exit code that means something.
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8546}"
MUT_ONLY="${MUT_ONLY:-}"

FILES=(src/curb/Graduator.sol src/curb/SharingCatalog.sol src/curb/FeeHook.sol src/curb/PositionLock.sol
  src/curb/CurbLaunchFactory.sol src/curb/LaunchRegistry.sol src/curb/LaunchLens.sol)
SNAP="$(mktemp -d /tmp/curb-sharing-snapshot.XXXXXX)"
for f in "${FILES[@]}"; do mkdir -p "$SNAP/$(dirname "$f")"; cp "$f" "$SNAP/$f"; done
restore() { for f in "${FILES[@]}"; do cp "$SNAP/$f" "$f"; done; }
trap restore EXIT

FAILED=0
SKIPPED=0
LAST_OUT=""
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
run() { # run <name> <match-path> <match-test>
  if [ -n "$MUT_ONLY" ] && [[ "$1" != baseline* ]] && [[ " $MUT_ONLY " != *" $1 "* ]]; then
    echo "  skipped $1 (not in MUT_ONLY)"; SKIPPED=$((SKIPPED + 1)); return 0
  fi
  local out
  if [[ "$2" == test/fork/* ]]; then
    out="$(B20_FORK=true base-forge test --match-path "$2" --match-test "$3" --fork-url "$RPC" 2>&1 \
      | grep -E "^\[(PASS|FAIL)|Suite result" | sed 's/ (gas.*//' || true)"
  else
    out="$(base-forge test --match-path "$2" --match-test "$3" 2>&1 \
      | grep -E "^\[(PASS|FAIL)|Suite result" | sed 's/ (gas.*//' || true)"
  fi
  printf '%s\n' "$out"
  LAST_OUT="$out"
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
echo "############ 0. UNMUTATED, every target below"
run baseline0 'test/HolderSharing.t.sol' 'test_onlyTheBeneficiaryCanEnable|test_atLaunch_|test_atLaunch_onlyTheCreatingLauncherInTheSameTransaction|test_atLaunch_aLauncherWithItsOwnCurveCannotSwitchSomeoneElsesLaunch|test_enableRedirectsTheCurveIsOneWayAndMakesACleanCut|test_aFactoryTheCatalogDoesNotApproveIsRefused|test_identity_|test_identity_refusesEveryInfrastructureAddress|test_enableAfterGraduationSyncsTheHookAndClaimsTheLockFirst|test_aRefusedCleanCutStillSwitches|test_aLockThatRefusesTheCleanCutDoesNotStopTheSwitch|test_identity_refusesADistributorAlreadyServingAnotherLaunch|test_aFactoryThatReentersIsRefused|test_theGraduatorRefusesAZeroCatalog|test_catalog_|test_syncCreator_|test_configureLaunch_|test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays|test_theLockRefusesANativeCurrencyPool|test_atLaunch_aLaterTransactionFindsNoMark|test_ownCurve_|test_rescue_'
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_onlyTheBeneficiaryCanEnable)' || { echo "  VERDICT baseline: target 'test_onlyTheBeneficiaryCanEnable' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_atLaunch_)' || { echo "  VERDICT baseline: target 'test_atLaunch_' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_atLaunch_onlyTheCreatingLauncherInTheSameTransaction)' || { echo "  VERDICT baseline: target 'test_atLaunch_onlyTheCreatingLauncherInTheSameTransaction' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_atLaunch_aLauncherWithItsOwnCurveCannotSwitchSomeoneElsesLaunch)' || { echo "  VERDICT baseline: target 'test_atLaunch_aLauncherWithItsOwnCurveCannotSwitchSomeoneElsesLaunch' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_enableRedirectsTheCurveIsOneWayAndMakesACleanCut)' || { echo "  VERDICT baseline: target 'test_enableRedirectsTheCurveIsOneWayAndMakesACleanCut' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_aFactoryTheCatalogDoesNotApproveIsRefused)' || { echo "  VERDICT baseline: target 'test_aFactoryTheCatalogDoesNotApproveIsRefused' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_identity_)' || { echo "  VERDICT baseline: target 'test_identity_' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_identity_refusesEveryInfrastructureAddress)' || { echo "  VERDICT baseline: target 'test_identity_refusesEveryInfrastructureAddress' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_enableAfterGraduationSyncsTheHookAndClaimsTheLockFirst)' || { echo "  VERDICT baseline: target 'test_enableAfterGraduationSyncsTheHookAndClaimsTheLockFirst' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_aRefusedCleanCutStillSwitches)' || { echo "  VERDICT baseline: target 'test_aRefusedCleanCutStillSwitches' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_aLockThatRefusesTheCleanCutDoesNotStopTheSwitch)' || { echo "  VERDICT baseline: target 'test_aLockThatRefusesTheCleanCutDoesNotStopTheSwitch' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_identity_refusesADistributorAlreadyServingAnotherLaunch)' || { echo "  VERDICT baseline: target 'test_identity_refusesADistributorAlreadyServingAnotherLaunch' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_aFactoryThatReentersIsRefused)' || { echo "  VERDICT baseline: target 'test_aFactoryThatReentersIsRefused' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_theGraduatorRefusesAZeroCatalog)' || { echo "  VERDICT baseline: target 'test_theGraduatorRefusesAZeroCatalog' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_catalog_)' || { echo "  VERDICT baseline: target 'test_catalog_' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_syncCreator_)' || { echo "  VERDICT baseline: target 'test_syncCreator_|test_configureLaunch_' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_feeRecipientFollowsTheSwitch)' || { echo "  VERDICT baseline: target 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_noCallerAtAnyTimeTakesTheLiquidityOut)' || { echo "  VERDICT baseline: target 'test_noCallerAtAnyTimeTakesTheLiquidityOut' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_feesFlowToTheRightPartyForYearsAndThePrincipalStays)' || { echo "  VERDICT baseline: target 'test_feesFlowToTheRightPartyForYearsAndThePrincipalStays' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_theLockRefusesANativeCurrencyPool)' || { echo "  VERDICT baseline: target 'test_theLockRefusesANativeCurrencyPool' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_atLaunch_aLaterTransactionFindsNoMark)' || { echo "  VERDICT baseline: target 'test_atLaunch_aLaterTransactionFindsNoMark' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_ownCurve_everyDoorRefusesARecordNamingAnotherLaunchsCurve)' || { echo "  VERDICT baseline: target 'test_ownCurve_everyDoorRefusesARecordNamingAnotherLaunchsCurve' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_rescue_beforeTheCurveIsFullOnlyItsTwoPayees)' || { echo "  VERDICT baseline: target 'test_rescue_beforeTheCurveIsFullOnlyItsTwoPayees' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_rescue_theCreatorFeeRecipientIsTheCurvesNow)' || { echo "  VERDICT baseline: target 'test_rescue_theCreatorFeeRecipientIsTheCurvesNow' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_rescue_aFullCurveOpensToAnyoneRescueDelayAfterItWasNoted)' || { echo "  VERDICT baseline: target 'test_rescue_aFullCurveOpensToAnyoneRescueDelayAfterItWasNoted' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_rescue_fillNoteAndRescueInOneTransactionIsRefused)' || { echo "  VERDICT baseline: target 'test_rescue_fillNoteAndRescueInOneTransactionIsRefused' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_rescue_aCurveThatIsNoLongerReadyIsClosedToStrangers)' || { echo "  VERDICT baseline: target 'test_rescue_aCurveThatIsNoLongerReadyIsClosedToStrangers' has no passing test"; FAILED=$((FAILED + 1)); }
run baseline1 'test/fork/HolderSharing.t.sol' 'test_nvdac_enabledBeforeGraduation_pendingToTheCreatorLaterToTheHolders|test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked'
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_nvdac_enabledBeforeGraduation_pendingToTheCreatorLaterToTheHolders)' || { echo "  VERDICT baseline: target 'test_nvdac_enabledBeforeGraduation_pendingToTheCreatorLaterToTheHolders' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked)' || { echo "  VERDICT baseline: target 'test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked' has no passing test"; FAILED=$((FAILED + 1)); }
run baseline2 'test/fork/B20Graduation.t.sol' 'test_launchedAt_isTheRegistrysClockEvenWhenTheLauncherPassesAnother|test_lens_wordsFourteenAndFifteenAreLaunchedAtAndTheDistributor'
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_launchedAt_isTheRegistrysClockEvenWhenTheLauncherPassesAnother)' || { echo "  VERDICT baseline: target 'test_launchedAt_isTheRegistrysClockEvenWhenTheLauncherPassesAnother' has no passing test"; FAILED=$((FAILED + 1)); }
printf '%s\n' "$LAST_OUT" | grep -qE '^\[PASS\] [A-Za-z0-9_]*(test_lens_wordsFourteenAndFifteenAreLaunchedAtAndTheDistributor)' || { echo "  VERDICT baseline: target 'test_lens_wordsFourteenAndFifteenAreLaunchedAtAndTheDistributor' has no passing test"; FAILED=$((FAILED + 1)); }
[ "$FAILED" = 0 ] || { echo "  THE BASELINE IS NOT GREEN - no verdict below would mean anything"; exit 1; }

echo
echo "############ s1. anyone may switch a launch on"
OLD=$'        if (msg.sender != rec.beneficiary) revert NotTheBeneficiary(msg.sender);\n' NEW=$'' mutate src/curb/Graduator.sol
run s1 'test/HolderSharing.t.sol' 'test_onlyTheBeneficiaryCanEnable'
restore
echo
echo "############ s2. the at-launch door ignores the mark"
OLD=$'        if (createdBy != msg.sender) revert NotTheCreatingLauncher(msg.sender);\n' NEW=$'' mutate src/curb/Graduator.sol
run s2 'test/HolderSharing.t.sol' 'test_atLaunch_'
restore
echo
echo "############ s3. the at-launch mark is not spent"
OLD=$'            tstore(slot, 0)\n        }\n        return _enable(launchToken, rec, factory);' NEW=$'        }\n        return _enable(launchToken, rec, factory);' mutate src/curb/Graduator.sol
run s3 'test/HolderSharing.t.sol' 'test_atLaunch_onlyTheCreatingLauncherInTheSameTransaction'
restore
echo
echo "############ s4. the at-launch mark is keyed by the token alone"
OLD=$'        return keccak256(abi.encode(CREATED_BY_TAG, launchToken, curve));' NEW=$'        curve;\n        return keccak256(abi.encode(CREATED_BY_TAG, launchToken));' mutate src/curb/Graduator.sol
run s4 'test/HolderSharing.t.sol' 'test_atLaunch_aLauncherWithItsOwnCurveCannotSwitchSomeoneElsesLaunch'
restore
echo
echo "############ s5. initializeCurve leaves no mark"
OLD=$'            tstore(slot, caller())\n' NEW=$'            pop(slot)\n' mutate src/curb/Graduator.sol
run s5 'test/HolderSharing.t.sol' 'test_atLaunch_onlyTheCreatingLauncherInTheSameTransaction'
restore
echo
echo "############ s6. the at-launch mark is written to persistent storage"
OLD=$'            tstore(slot, caller())\n' NEW=$'            sstore(slot, caller())\n' mutate src/curb/Graduator.sol
run s6 'test/HolderSharing.t.sol' 'test_atLaunch_onlyTheCreatingLauncherInTheSameTransaction'
restore
echo
echo "############ s7. the at-launch mark is read from persistent storage"
OLD=$'            createdBy := tload(slot)\n' NEW=$'            createdBy := sload(slot)\n' mutate src/curb/Graduator.sol
run s7 'test/HolderSharing.t.sol' 'test_atLaunch_onlyTheCreatingLauncherInTheSameTransaction'
restore
echo
echo "############ s8. a launch can be switched twice"
OLD=$'        if (_sharing[launchToken].distributor != address(0)) revert AlreadySharing(launchToken);\n' NEW=$'' mutate src/curb/Graduator.sol
run s8 'test/HolderSharing.t.sol' 'test_enableRedirectsTheCurveIsOneWayAndMakesACleanCut'
restore
echo
echo "############ s9. the catalog is not asked"
OLD=$'        if (!sharingCatalog.isApproved(factory)) revert FactoryNotApproved(factory);\n' NEW=$'' mutate src/curb/Graduator.sol
run s9 'test/HolderSharing.t.sol' 'test_aFactoryTheCatalogDoesNotApproveIsRefused'
restore
echo
echo "############ s10. identity: a distributor with no code"
OLD=$'            d.code.length == 0 || launchOfDistributor[d] != address(0)\n' NEW=$'            launchOfDistributor[d] != address(0)\n' mutate src/curb/Graduator.sol
run s10 'test/HolderSharing.t.sol' 'test_identity_'
restore
echo
echo "############ s11. identity: a distributor already serving another launch"
OLD=$'            d.code.length == 0 || launchOfDistributor[d] != address(0)\n' NEW=$'            d.code.length == 0\n' mutate src/curb/Graduator.sol
run s11 'test/HolderSharing.t.sol' 'test_identity_'
restore
echo
echo "############ s12. identity: a distributor for another token"
OLD=$'                || IHolderDistributorIdentity(d).launchToken() != launchToken\n' NEW=$'' mutate src/curb/Graduator.sol
run s12 'test/HolderSharing.t.sol' 'test_identity_'
restore
echo
echo "############ s13. identity: a distributor for another quote asset"
OLD=$'                || IHolderDistributorIdentity(d).quoteToken() != rec.quoteToken\n' NEW=$'' mutate src/curb/Graduator.sol
run s13 'test/HolderSharing.t.sol' 'test_identity_'
restore
echo
echo "############ s14. identity: a distributor naming another graduator"
OLD=$'|| IHolderDistributorIdentity(d).graduator() != address(this) || d == rec.curve' NEW=$'|| d == rec.curve' mutate src/curb/Graduator.sol
run s14 'test/HolderSharing.t.sol' 'test_identity_'
restore
echo
echo "############ s15. identity: the distributor may be rec.curve"
OLD=$'d == rec.curve' NEW=$'false' mutate src/curb/Graduator.sol
run s15 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s16. identity: the distributor may be launchToken"
OLD=$'d == launchToken' NEW=$'false' mutate src/curb/Graduator.sol
run s16 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s17. identity: the distributor may be rec.quoteToken"
OLD=$'d == rec.quoteToken' NEW=$'false' mutate src/curb/Graduator.sol
run s17 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s18. identity: the distributor may be address(rec.hooks)"
OLD=$'d == address(rec.hooks)' NEW=$'false' mutate src/curb/Graduator.sol
run s18 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s19. identity: the distributor may be rec.beneficiary"
OLD=$'d == rec.beneficiary' NEW=$'false' mutate src/curb/Graduator.sol
run s19 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s20. identity: the distributor may be rec.refundTo"
OLD=$'d == rec.refundTo' NEW=$'false' mutate src/curb/Graduator.sol
run s20 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s21. identity: the distributor may be rec.platformRecipient"
OLD=$'d == rec.platformRecipient' NEW=$'false' mutate src/curb/Graduator.sol
run s21 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s22. identity: the distributor may be address(this)"
OLD=$'d == address(this)' NEW=$'false' mutate src/curb/Graduator.sol
run s22 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s23. identity: the distributor may be address(registry)"
OLD=$'d == address(registry)' NEW=$'false' mutate src/curb/Graduator.sol
run s23 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s24. identity: the distributor may be address(poolManager)"
OLD=$'d == address(poolManager)' NEW=$'false' mutate src/curb/Graduator.sol
run s24 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s25. identity: the distributor may be address(positionManager)"
OLD=$'d == address(positionManager)' NEW=$'false' mutate src/curb/Graduator.sol
run s25 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s26. identity: the distributor may be ICreatorFeeCurve(rec.curve).feeEscrow()"
OLD=$'d == ICreatorFeeCurve(rec.curve).feeEscrow()' NEW=$'false' mutate src/curb/Graduator.sol
run s26 'test/HolderSharing.t.sol' 'test_identity_refusesEveryInfrastructureAddress'
restore
echo
echo "############ s27. no clean cut on the curve"
OLD=$'            try IRescuableCurve(rec.curve).rescueFees() {} catch {}\n' NEW=$'' mutate src/curb/Graduator.sol
run s27 'test/HolderSharing.t.sol' 'test_enableRedirectsTheCurveIsOneWayAndMakesACleanCut'
restore
echo
echo "############ s28. no clean cut on the lock"
OLD=$'            try PositionLock(lockOf[launchToken]).claimFees() {} catch {}\n' NEW=$'' mutate src/curb/Graduator.sol
run s28 'test/HolderSharing.t.sol' 'test_enableAfterGraduationSyncsTheHookAndClaimsTheLockFirst'
restore
echo
echo "############ s29. the switch is written before the clean cut"
OLD=$'        bool graduated = hasGraduated[launchToken];\n' NEW=$'        bool graduated = hasGraduated[launchToken];\n        _sharing[launchToken] = Sharing(d, uint64(block.number));\n' mutate src/curb/Graduator.sol
run s29 'test/HolderSharing.t.sol' 'test_enableAfterGraduationSyncsTheHookAndClaimsTheLockFirst'
restore
echo
echo "############ s30. a refused curve rescue stops the switch"
OLD=$'            try IRescuableCurve(rec.curve).rescueFees() {} catch {}\n' NEW=$'            IRescuableCurve(rec.curve).rescueFees();\n' mutate src/curb/Graduator.sol
run s30 'test/HolderSharing.t.sol' 'test_aRefusedCleanCutStillSwitches'
restore
echo
echo "############ s31. a refused lock claim stops the switch"
OLD=$'            try PositionLock(lockOf[launchToken]).claimFees() {} catch {}\n' NEW=$'            PositionLock(lockOf[launchToken]).claimFees();\n' mutate src/curb/Graduator.sol
run s31 'test/HolderSharing.t.sol' 'test_aLockThatRefusesTheCleanCutDoesNotStopTheSwitch'
restore
echo
echo "############ s32. the curve is not redirected"
OLD=$'            ICreatorFeeCurve(rec.curve).setCreatorFeeRecipient(d);\n' NEW=$'' mutate src/curb/Graduator.sol
run s32 'test/HolderSharing.t.sol' 'test_enableRedirectsTheCurveIsOneWayAndMakesACleanCut'
restore
echo
echo "############ s33. a graduated launch's hook is not told"
OLD=$'        } else {\n            IFeeHookSharing(address(rec.hooks)).syncCreator(launchToken);\n        }\n' NEW=$'        }\n' mutate src/curb/Graduator.sol
run s33 'test/HolderSharing.t.sol' 'test_enableAfterGraduationSyncsTheHookAndClaimsTheLockFirst'
restore
echo
echo "############ s34. the switch's block is not recorded"
OLD=$'        _sharing[launchToken] = Sharing(d, sinceBlock);' NEW=$'        _sharing[launchToken] = Sharing(d, 0);' mutate src/curb/Graduator.sol
run s34 'test/HolderSharing.t.sol' 'test_enableRedirectsTheCurveIsOneWayAndMakesACleanCut'
restore
echo
echo "############ s35. the reverse map is not written"
OLD=$'        launchOfDistributor[d] = launchToken;\n' NEW=$'' mutate src/curb/Graduator.sol
run s35 'test/HolderSharing.t.sol' 'test_identity_refusesADistributorAlreadyServingAnotherLaunch'
restore
echo
echo "############ s36. enableHolderSharing is not guarded"
OLD=$'function enableHolderSharing(address launchToken, address factory) external locked returns' NEW=$'function enableHolderSharing(address launchToken, address factory) external returns' mutate src/curb/Graduator.sol
run s36 'test/HolderSharing.t.sol' 'test_aFactoryThatReentersIsRefused'
restore
echo
echo "############ s37. enableHolderSharingAtLaunch is not guarded"
OLD=$'function enableHolderSharingAtLaunch(address launchToken, address factory) external locked returns' NEW=$'function enableHolderSharingAtLaunch(address launchToken, address factory) external returns' mutate src/curb/Graduator.sol
run s37 'test/HolderSharing.t.sol' 'test_aFactoryThatReentersIsRefused'
restore
echo
echo "############ s38. graduate is not guarded"
OLD=$'        external\n        locked\n        returns (PositionLock lock, uint256 tokenId, PoolKey memory key)' NEW=$'        external\n        returns (PositionLock lock, uint256 tokenId, PoolKey memory key)' mutate src/curb/Graduator.sol
run s38 'test/HolderSharing.t.sol' 'test_aFactoryThatReentersIsRefused'
restore
echo
echo "############ s39. rescueCurveFees is not guarded"
OLD=$'        external\n        locked\n        returns (uint256 protocolAmount, uint256 creatorAmount)' NEW=$'        external\n        returns (uint256 protocolAmount, uint256 creatorAmount)' mutate src/curb/Graduator.sol
run s39 'test/HolderSharing.t.sol' 'test_aFactoryThatReentersIsRefused'
restore
echo
echo "############ s40. the guard never closes"
OLD=$'        if (busy) revert Reentered();\n' NEW=$'        busy;\n' mutate src/curb/Graduator.sol
run s40 'test/HolderSharing.t.sol' 'test_aFactoryThatReentersIsRefused'
restore
echo
echo "############ s41. a zero catalog is accepted"
OLD=$'                || address(sharingCatalog_) == address(0)\n' NEW=$'' mutate src/curb/Graduator.sol
run s41 'test/HolderSharing.t.sol' 'test_theGraduatorRefusesAZeroCatalog'
restore
echo
echo "############ s42. graduation ignores a switch thrown on the curve"
OLD=$'        if (_sharing[launchToken].distributor != address(0)) {\n            IFeeHookSharing(address(rec.hooks)).syncCreator(launchToken);\n        }\n' NEW=$'' mutate src/curb/Graduator.sol
run s42 'test/fork/HolderSharing.t.sol' 'test_nvdac_enabledBeforeGraduation_pendingToTheCreatorLaterToTheHolders'
restore
echo
echo "############ s43. the lock is built without the switch"
OLD=$'rec.beneficiary, key, tokenId, address(this), launchToken);' NEW=$'rec.beneficiary, key, tokenId, address(0), address(0));' mutate src/curb/Graduator.sol
run s43 'test/fork/HolderSharing.t.sol' 'test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked'
restore
echo
echo "############ s44. anyone may bootstrap"
OLD=$'        if (msg.sender != bootstrapper) revert NotTheBootstrapper();\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s44 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s45. the bootstrap can be used twice"
OLD=$'        if (bootstrapped) revert AlreadyBootstrapped();\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s45 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s46. the bootstrap is not marked used"
OLD=$'        bootstrapped = true;\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s46 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s47. the bootstrap never expires"
OLD=$'        if (block.timestamp >= bootstrapUntil) revert BootstrapExpired();\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s47 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s48. the bootstrap expires a second late"
OLD=$'        if (block.timestamp >= bootstrapUntil) revert BootstrapExpired();\n' NEW=$'        if (block.timestamp > bootstrapUntil) revert BootstrapExpired();\n' mutate src/curb/SharingCatalog.sol
run s48 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s49. the bootstrap admits an address with no code"
OLD=$'        if (factory.code.length == 0) revert NotAContract();\n        bootstrapped = true;\n' NEW=$'        bootstrapped = true;\n' mutate src/curb/SharingCatalog.sol
run s49 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s50. the bootstrap does not recommend"
OLD=$'        recommended = factory;\n        emit FactoryAdmitted' NEW=$'        emit FactoryAdmitted' mutate src/curb/SharingCatalog.sol
run s50 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s51. propose is open to anyone"
OLD=$'    function propose(address factory) external onlyOwner {' NEW=$'    function propose(address factory) external {' mutate src/curb/SharingCatalog.sol
run s51 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s52. propose takes an address with no code"
OLD=$'        if (factory.code.length == 0) revert NotAContract();\n        if (admittedAt[factory] != 0' NEW=$'        if (admittedAt[factory] != 0' mutate src/curb/SharingCatalog.sol
run s52 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s53. propose restarts a pending or admitted version"
OLD=$'        if (admittedAt[factory] != 0 || retired[factory]) revert AlreadyProposed(factory);' NEW=$'        if (retired[factory]) revert AlreadyProposed(factory);' mutate src/curb/SharingCatalog.sol
run s53 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s54. propose revives a retired version"
OLD=$'        if (admittedAt[factory] != 0 || retired[factory]) revert AlreadyProposed(factory);' NEW=$'        if (admittedAt[factory] != 0 && !retired[factory]) revert AlreadyProposed(factory);' mutate src/curb/SharingCatalog.sol
run s54 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s55. the admission delay is skipped"
OLD=$'        uint64 at = uint64(block.timestamp) + ADMISSION_DELAY;' NEW=$'        uint64 at = uint64(block.timestamp);' mutate src/curb/SharingCatalog.sol
run s55 'test/HolderSharing.t.sol' 'test_aFactoryTheCatalogDoesNotApproveIsRefused'
restore
echo
echo "############ s56. cancel is open to anyone"
OLD=$'    function cancel(address factory) external onlyOwner {' NEW=$'    function cancel(address factory) external {' mutate src/curb/SharingCatalog.sol
run s56 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s57. cancel withdraws an admitted version"
OLD=$'        if (admittedAt[factory] <= block.timestamp) revert NotPending(factory);\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s57 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s58. cancel leaves the proposal"
OLD=$'        admittedAt[factory] = 0;\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s58 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s59. retire is open to anyone"
OLD=$'    function retire(address factory) external onlyOwner {' NEW=$'    function retire(address factory) external {' mutate src/curb/SharingCatalog.sol
run s59 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s60. retire takes an unknown address"
OLD=$'        if (admittedAt[factory] == 0 || retired[factory]) revert UnknownOrRetired(factory);' NEW=$'        if (retired[factory]) revert UnknownOrRetired(factory);' mutate src/curb/SharingCatalog.sol
run s60 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s61. retire twice"
OLD=$'        if (admittedAt[factory] == 0 || retired[factory]) revert UnknownOrRetired(factory);' NEW=$'        if (admittedAt[factory] == 0) revert UnknownOrRetired(factory);' mutate src/curb/SharingCatalog.sol
run s61 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s62. retire leaves the recommendation"
OLD=$'            recommended = address(0);\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s62 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s63. retire clears any recommendation"
OLD=$'        if (recommended == factory) {' NEW=$'        if (true) {' mutate src/curb/SharingCatalog.sol
run s63 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s64. setRecommended is open to anyone"
OLD=$'    function setRecommended(address factory) external onlyOwner {' NEW=$'    function setRecommended(address factory) external {' mutate src/curb/SharingCatalog.sol
run s64 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s65. setRecommended takes an unapproved version"
OLD=$'        if (!isApproved(factory)) revert FactoryNotApproved(factory);\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s65 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s66. isApproved: never proposed counts"
OLD=$'        return at != 0 && at <= block.timestamp && !retired[factory];' NEW=$'        return at <= block.timestamp && !retired[factory];' mutate src/curb/SharingCatalog.sol
run s66 'test/HolderSharing.t.sol' 'test_aFactoryTheCatalogDoesNotApproveIsRefused'
restore
echo
echo "############ s67. isApproved: the delay is ignored"
OLD=$'        return at != 0 && at <= block.timestamp && !retired[factory];' NEW=$'        return at != 0 && !retired[factory];' mutate src/curb/SharingCatalog.sol
run s67 'test/HolderSharing.t.sol' 'test_aFactoryTheCatalogDoesNotApproveIsRefused'
restore
echo
echo "############ s68. isApproved: the delay ends a second late"
OLD=$'        return at != 0 && at <= block.timestamp && !retired[factory];' NEW=$'        return at != 0 && at < block.timestamp && !retired[factory];' mutate src/curb/SharingCatalog.sol
run s68 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s69. isApproved: retirement is ignored"
OLD=$'        return at != 0 && at <= block.timestamp && !retired[factory];' NEW=$'        return at != 0 && at <= block.timestamp;' mutate src/curb/SharingCatalog.sol
run s69 'test/HolderSharing.t.sol' 'test_aFactoryTheCatalogDoesNotApproveIsRefused'
restore
echo
echo "############ s70. a zero bootstrapper is accepted"
OLD=$'        if (bootstrapper_ == address(0)) revert ZeroAddress();\n' NEW=$'' mutate src/curb/SharingCatalog.sol
run s70 'test/HolderSharing.t.sol' 'test_catalog_'
restore
echo
echo "############ s71. syncCreator is open to anyone"
OLD=$'    function syncCreator(address launchToken) external {\n        if (msg.sender != poolOpener) revert NotThePoolOpener(msg.sender);\n' NEW=$'    function syncCreator(address launchToken) external {\n' mutate src/curb/FeeHook.sol
run s71 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s72. syncCreator moves an unconfigured pool"
OLD=$'        if (!f.configured) revert PoolNotConfigured(id);\n        address d =' NEW=$'        address d =' mutate src/curb/FeeHook.sol
run s72 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s73. syncCreator moves a launch that is not sharing"
OLD=$'        if (d == address(0)) revert NotSharing(launchToken);\n' NEW=$'' mutate src/curb/FeeHook.sol
run s73 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s74. syncCreator moves a leg twice"
OLD=$'        if (f.holderShared) revert AlreadyShared(id);\n' NEW=$'' mutate src/curb/FeeHook.sol
run s74 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s75. syncCreator pays the hook itself"
OLD=$'        if (d == address(this)) revert RecipientIsTheHook();\n' NEW=$'' mutate src/curb/FeeHook.sol
run s75 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s76. syncCreator pays the PoolManager"
OLD=$'        if (d == address(poolManager)) revert RecipientIsDeploymentContract(d);\n' NEW=$'' mutate src/curb/FeeHook.sol
run s76 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s77. syncCreator does not set the flag"
OLD=$'        f.holderShared = true;\n' NEW=$'' mutate src/curb/FeeHook.sol
run s77 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s78. syncCreator does not move the leg"
OLD=$'        f.creator = d;\n' NEW=$'' mutate src/curb/FeeHook.sol
run s78 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s79. configureLaunch refuses its own launch once shared"
OLD=$'                || existing.creator == IHolderSharingSwitch(poolOpener).holderDistributorOf(launchToken);' NEW=$';' mutate src/curb/FeeHook.sol
run s79 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s80. configureLaunch accepts any creator once shared"
OLD=$'                || existing.creator == IHolderSharingSwitch(poolOpener).holderDistributorOf(launchToken);' NEW=$'                || existing.holderShared;' mutate src/curb/FeeHook.sol
run s80 'test/HolderSharing.t.sol' 'test_syncCreator_|test_configureLaunch_'
restore
echo
echo "############ s81. the lock ignores the switch"
OLD=$'        return d == address(0) ? beneficiary : d;' NEW=$'        d;\n        return beneficiary;' mutate src/curb/PositionLock.sol
run s81 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s82. a lock with no source follows something"
OLD=$'        if (address(sharingSource) == address(0)) return address(0);\n' NEW=$'' mutate src/curb/PositionLock.sol
run s82 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s83. a transfer that moved nothing counts as delivered"
OLD=$'        ok = ok && token.balanceOf(address(this)) + amount == before;\n' NEW=$'        before;\n' mutate src/curb/PositionLock.sol
run s83 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s84. a refused amount is held for the beneficiary"
OLD=$'            held[to][i] += amount;\n            emit FeesHeld(to, i, amount);' NEW=$'            held[beneficiary][i] += amount;\n            emit FeesHeld(to, i, amount);' mutate src/curb/PositionLock.sol
run s84 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s85. a refused amount is not held at all"
OLD=$'            held[to][i] += amount;\n' NEW=$'' mutate src/curb/PositionLock.sol
run s85 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s86. collection counts what is already held"
OLD=$'            uint256 amount = _token(i).balanceOf(address(this)) - got[i];' NEW=$'            uint256 amount = _token(i).balanceOf(address(this));' mutate src/curb/PositionLock.sol
run s86 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s87. release keeps the booking"
OLD=$'            held[party][i] = 0;\n' NEW=$'' mutate src/curb/PositionLock.sol
run s87 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s88. release with nothing held succeeds"
OLD=$'        if (h[0] == 0 && h[1] == 0) revert NothingHeld(party);\n' NEW=$'' mutate src/curb/PositionLock.sol
run s88 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s89. a refused release drops the booking"
OLD=$'            if (!_transfer(i, party, h[i])) revert ReleaseRefused(party, i);' NEW=$'            _transfer(i, party, h[i]);' mutate src/curb/PositionLock.sol
run s89 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s90. claimFees with no position"
OLD=$'    function claimFees() external {\n        if (!holdsPosition) revert NoPositionHeld();\n' NEW=$'    function claimFees() external {\n' mutate src/curb/PositionLock.sol
run s90 'test/HolderSharing.t.sol' 'test_feeRecipientFollowsTheSwitch|test_aLockBuiltOutsideGraduation|test_aRefusedPushIsHeld|test_aFalseReturn|test_aBeneficiaryHeldBefore|test_aTransferThatMoves|test_aGasStarvedClaim|test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s91. LOCK FOREVER: the fee collection removes the principal"
OLD=$'        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));' NEW=$'        params[0] = abi.encode(tokenId, uint256(positionManager.getPositionLiquidity(tokenId)), uint128(0), uint128(0), bytes(""));' mutate src/curb/PositionLock.sol
run s91 'test/HolderSharing.t.sol' 'test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s92. LOCK FOREVER: a withdraw() for the beneficiary comes back"
OLD=$'    function _token(uint256 i) private view returns (IERC20) {' NEW=$'    function withdraw() external {\n        if (msg.sender != beneficiary) revert NoPositionHeld();\n        holdsPosition = false;\n        positionNft.transferFrom(address(this), beneficiary, tokenId);\n    }\n\n    function _token(uint256 i) private view returns (IERC20) {' mutate src/curb/PositionLock.sol
run s92 'test/HolderSharing.t.sol' 'test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s93. LOCK FOREVER: a time-gated withdrawLiquidity comes back, ten years out"
OLD=$'    function _token(uint256 i) private view returns (IERC20) {' NEW=$'    function withdrawLiquidity(uint128, uint128, address to, uint256) external {\n        if (msg.sender != beneficiary || block.timestamp < 3650 days) revert NoPositionHeld();\n        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));\n        bytes[] memory params = new bytes[](2);\n        params[0] = abi.encode(tokenId, uint256(positionManager.getPositionLiquidity(tokenId)), uint128(0), uint128(0), bytes(""));\n        params[1] = abi.encode(poolKey.currency0, poolKey.currency1, to);\n        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);\n    }\n\n    function _token(uint256 i) private view returns (IERC20) {' mutate src/curb/PositionLock.sol
run s93 'test/HolderSharing.t.sol' 'test_noCallerAtAnyTimeTakesTheLiquidityOut|testFuzz_noCalldataTakesTheLiquidityOut|test_theLockHasNoUnlockTimeAndNoWithdrawal|test_feesFlowToTheRightPartyForYearsAndThePrincipalStays'
restore
echo
echo "############ s94. LOCK FOREVER: the fee collection is taken to the recipient, not the lock"
OLD=$'        params[1] = abi.encode(poolKey.currency0, poolKey.currency1, address(this));' NEW=$'        params[1] = abi.encode(poolKey.currency0, poolKey.currency1, to);' mutate src/curb/PositionLock.sol
run s94 'test/HolderSharing.t.sol' 'test_aRefusedPushIsHeldForTheRightPartyAndReleased|test_aFalseReturnOrATransferThatMovesNothingIsHeld|test_aGasStarvedClaimBooksOrRevertsAndNeverPaysTheWrongParty'
restore
echo
echo "############ s95. LOCK FOREVER: the registry writes a record with a lock duration"
OLD=$'        if (launch.reservedZero != 0) revert ReservedWordNotZero(launch.reservedZero);\n' NEW=$'' mutate src/curb/LaunchRegistry.sol
run s95 'test/fork/B20Graduation.t.sol' 'test_aRecordWithALockDurationIsRefused'
restore
echo
echo "############ s96. LOCK FOREVER: the lock takes a second position"
OLD=$'        if (holdsPosition) revert OnlyOnePosition();\n' NEW=$'' mutate src/curb/PositionLock.sol
run s96 'test/fork/B20PositionLock.t.sol' 'test_lockRefusesASecondPosition'
restore
echo
echo "############ s97. LOCK FOREVER: the lock approves the beneficiary for the NFT on deposit"
OLD=$'        holdsPosition = true;\n        emit PositionLocked(tokenId_);' NEW=$'        holdsPosition = true;\n        IERC721(address(positionNft)).approve(beneficiary, tokenId_);\n        emit PositionLocked(tokenId_);' mutate src/curb/PositionLock.sol
run s97 'test/fork/B20PositionLock.t.sol' 'test_nobodyCanEverTakeTheLiquidityOut|testFuzz_noCallTakesTheLiquidityOut|test_feesAreClaimableWhilePrincipalIsNot'
restore
echo
echo "############ s98. LOCK FOREVER: a withdraw() comes back, judged on the real PositionManager and by the fork invariant"
OLD=$'    function _token(uint256 i) private view returns (IERC20) {' NEW=$'    function withdraw() external {\n        if (msg.sender != beneficiary) revert NoPositionHeld();\n        positionNft.transferFrom(address(this), beneficiary, tokenId);\n    }\n\n    function _token(uint256 i) private view returns (IERC20) {' mutate src/curb/PositionLock.sol
run s98 'test/fork/B20PositionLock.t.sol' 'test_nobodyCanEverTakeTheLiquidityOut'
restore
echo
echo "############ s103. the lock takes a native currency0"
OLD=$'        if (Currency.unwrap(poolKey_.currency0) == address(0) || Currency.unwrap(poolKey_.currency1) == address(0)) {' NEW=$'        if (Currency.unwrap(poolKey_.currency1) == address(0)) {' mutate src/curb/PositionLock.sol
run s103 'test/HolderSharing.t.sol' 'test_theLockRefusesANativeCurrencyPool'
restore
echo
echo "############ s104. the lock takes a native currency1"
OLD=$'        if (Currency.unwrap(poolKey_.currency0) == address(0) || Currency.unwrap(poolKey_.currency1) == address(0)) {' NEW=$'        if (Currency.unwrap(poolKey_.currency0) == address(0)) {' mutate src/curb/PositionLock.sol
run s104 'test/HolderSharing.t.sol' 'test_theLockRefusesANativeCurrencyPool'
restore
echo
echo "############ s105. the factory never throws the at-launch switch"
OLD=$'            graduator.enableHolderSharingAtLaunch(address(token), cfg.holderShareFactory);\n' NEW=$'' mutate src/curb/CurbLaunchFactory.sol
run s105 'test/fork/HolderSharing.t.sol' 'test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked'
restore
echo
echo "############ s106. the factory throws the switch after the dev buy"
OLD=$'        if (cfg.holderShareFactory != address(0)) {\n            graduator.enableHolderSharingAtLaunch(address(token), cfg.holderShareFactory);\n        }\n        if (cfg.devBuy != 0) {\n            _devBuy(curve, IERC20(quoteToken), cfg.devBuy, creator);\n        }\n' NEW=$'        if (cfg.devBuy != 0) {\n            _devBuy(curve, IERC20(quoteToken), cfg.devBuy, creator);\n        }\n        if (cfg.holderShareFactory != address(0)) {\n            graduator.enableHolderSharingAtLaunch(address(token), cfg.holderShareFactory);\n        }\n' mutate src/curb/CurbLaunchFactory.sol
run s106 'test/fork/HolderSharing.t.sol' 'test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked'
restore
echo
echo "############ s107. the registry keeps the launcher's launchedAt"
OLD=$'        _launches[launchToken].launchedAt = uint64(block.timestamp);\n' NEW=$'' mutate src/curb/LaunchRegistry.sol
run s107 'test/fork/B20Graduation.t.sol' 'test_launchedAt_isTheRegistrysClockEvenWhenTheLauncherPassesAnother'
restore
echo
echo "############ s108. the lens leaves launchedAt out"
OLD=$'        view_.launchedAt = rec.launchedAt;\n' NEW=$'' mutate src/curb/LaunchLens.sol
run s108 'test/fork/B20Graduation.t.sol' 'test_lens_wordsFourteenAndFifteenAreLaunchedAtAndTheDistributor'
restore
echo
echo "############ s109. the lens leaves the distributor out"
OLD=$'        view_.holderDistributor = IHolderSharingSource(address(graduator)).holderDistributorOf(launchToken);\n' NEW=$'' mutate src/curb/LaunchLens.sol
run s109 'test/fork/HolderSharing.t.sol' 'test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked'
restore
echo
echo "############ s110. the at-launch mark lives in persistent storage, written and read"
OLD=$'            tstore(slot, caller())\n' NEW=$'            sstore(slot, caller())\n' mutate src/curb/Graduator.sol
OLD=$'            createdBy := tload(slot)\n' NEW=$'            createdBy := sload(slot)\n' mutate src/curb/Graduator.sol
run s110 'test/HolderSharing.t.sol' 'test_atLaunch_aLaterTransactionFindsNoMark'
restore
echo
echo "############ s111. graduation does not ask whether the record's curve is its own"
OLD=$'        _requireOwnCurve(launchToken, rec.curve);\n        IGraduatingCurve curve = IGraduatingCurve(rec.curve);\n\n' NEW=$'        IGraduatingCurve curve = IGraduatingCurve(rec.curve);\n\n' mutate src/curb/Graduator.sol
run s111 'test/HolderSharing.t.sol' 'test_ownCurve_everyDoorRefusesARecordNamingAnotherLaunchsCurve'
restore
echo
echo "############ s112. the fee hatch does not ask whether the record's curve is its own"
OLD=$'        _requireOwnCurve(launchToken, rec.curve);\n        IGraduatingCurve curve = IGraduatingCurve(rec.curve);\n        if (' NEW=$'        IGraduatingCurve curve = IGraduatingCurve(rec.curve);\n        if (' mutate src/curb/Graduator.sol
run s112 'test/HolderSharing.t.sol' 'test_ownCurve_everyDoorRefusesARecordNamingAnotherLaunchsCurve'
restore
echo
echo "############ s113. the sharing switch does not ask whether the record's curve is its own"
OLD=$'        _requireOwnCurve(launchToken, rec.curve);\n        // ---- 1. once\n' NEW=$'        // ---- 1. once\n' mutate src/curb/Graduator.sol
run s113 'test/HolderSharing.t.sol' 'test_ownCurve_everyDoorRefusesARecordNamingAnotherLaunchsCurve'
restore
echo
echo "############ s114. the own-curve check never fires"
OLD=$'        if (itsToken != launchToken) revert CurveIsAnotherLaunchs(curve, itsToken);\n' NEW=$'        itsToken;\n' mutate src/curb/Graduator.sol
run s114 'test/HolderSharing.t.sol' 'test_ownCurve_everyDoorRefusesARecordNamingAnotherLaunchsCurve'
restore
echo
echo "############ s115. the fee hatch is open to anyone at any time"
OLD=$'            if (since == 0 || block.timestamp < opensAt || !curve.readyToGraduate()) {\n                revert RescueNotOpenYet(msg.sender, opensAt);\n            }\n' NEW=$'' mutate src/curb/Graduator.sol
run s115 'test/HolderSharing.t.sol' 'test_rescue_beforeTheCurveIsFullOnlyItsTwoPayees'
restore
echo
echo "############ s116. the fee hatch never opens to anyone, even an hour after the note"
OLD=$'if (since == 0 || block.timestamp < opensAt || !curve.readyToGraduate()) {' NEW=$'if (true) {' mutate src/curb/Graduator.sol
run s116 'test/HolderSharing.t.sol' 'test_rescue_aFullCurveOpensToAnyoneRescueDelayAfterItWasNoted'
restore
echo
echo "############ s117. the curve's creator-fee recipient may not open the hatch"
OLD=$'if (msg.sender != curve.deployer() && msg.sender != rec.platformRecipient) {' NEW=$'if (msg.sender != rec.platformRecipient) {' mutate src/curb/Graduator.sol
run s117 'test/HolderSharing.t.sol' 'test_rescue_beforeTheCurveIsFullOnlyItsTwoPayees|test_rescue_theCreatorFeeRecipientIsTheCurvesNow'
restore
echo
echo "############ s118. the platform recipient may not open the hatch"
OLD=$'if (msg.sender != curve.deployer() && msg.sender != rec.platformRecipient) {' NEW=$'if (msg.sender != curve.deployer()) {' mutate src/curb/Graduator.sol
run s118 'test/HolderSharing.t.sol' 'test_rescue_beforeTheCurveIsFullOnlyItsTwoPayees'
restore
echo
echo "############ s119. the hatch asks the record's beneficiary instead of the curve's live recipient"
OLD=$'if (msg.sender != curve.deployer() && msg.sender != rec.platformRecipient) {' NEW=$'if (msg.sender != rec.beneficiary && msg.sender != rec.platformRecipient) {' mutate src/curb/Graduator.sol
run s119 'test/HolderSharing.t.sol' 'test_rescue_theCreatorFeeRecipientIsTheCurvesNow'
restore
echo
echo "############ s120. the hatch opens the moment the launch is noted, not an hour later"
OLD=$'if (since == 0 || block.timestamp < opensAt || !curve.readyToGraduate()) {' NEW=$'if (since == 0 || !curve.readyToGraduate()) {' mutate src/curb/Graduator.sol
run s120 'test/HolderSharing.t.sol' 'test_rescue_fillNoteAndRescueInOneTransactionIsRefused|test_rescue_aFullCurveOpensToAnyoneRescueDelayAfterItWasNoted'
restore
echo
echo "############ s121. a full curve nobody noted is open to anyone at once"
OLD=$'if (since == 0 || block.timestamp < opensAt || !curve.readyToGraduate()) {' NEW=$'if (block.timestamp < opensAt || !curve.readyToGraduate()) {' mutate src/curb/Graduator.sol
run s121 'test/HolderSharing.t.sol' 'test_rescue_aFullCurveOpensToAnyoneRescueDelayAfterItWasNoted'
restore
echo
echo "############ s122. a noted curve stays open to anyone after it has moved on"
OLD=$'if (since == 0 || block.timestamp < opensAt || !curve.readyToGraduate()) {' NEW=$'if (since == 0 || block.timestamp < opensAt) {' mutate src/curb/Graduator.sol
run s122 'test/HolderSharing.t.sol' 'test_rescue_aCurveThatIsNoLongerReadyIsClosedToStrangers'
restore
echo
echo "############ s123. a second note moves the clock"
OLD=$'        since = readySince[launchToken];\n        if (since != 0) return since;\n' NEW=$'' mutate src/curb/Graduator.sol
run s123 'test/HolderSharing.t.sol' 'test_rescue_aFullCurveOpensToAnyoneRescueDelayAfterItWasNoted'
restore
echo
echo "############ s124. a curve still selling can be noted ready"
OLD=$'        if (!IGraduatingCurve(rec.curve).readyToGraduate()) revert CurveNotReady(rec.curve);\n        since = block.timestamp;\n' NEW=$'        since = block.timestamp;\n' mutate src/curb/Graduator.sol
run s124 'test/HolderSharing.t.sol' 'test_rescue_beforeTheCurveIsFullOnlyItsTwoPayees'
restore
echo
echo "############ s125. the note does not ask whether the record's curve is its own"
OLD=$'        _requireOwnCurve(launchToken, rec.curve);\n        if (!IGraduatingCurve(rec.curve).readyToGraduate()) revert CurveNotReady(rec.curve);\n' NEW=$'        if (!IGraduatingCurve(rec.curve).readyToGraduate()) revert CurveNotReady(rec.curve);\n' mutate src/curb/Graduator.sol
run s125 'test/HolderSharing.t.sol' 'test_ownCurve_everyDoorRefusesARecordNamingAnotherLaunchsCurve'
restore
echo
echo "############ s126. a graduated launch can be noted ready"
OLD=$'        if (since != 0) return since;\n        if (hasGraduated[launchToken]) revert AlreadyGraduated(launchToken);\n' NEW=$'        if (since != 0) return since;\n' mutate src/curb/Graduator.sol
run s126 'test/HolderSharing.t.sol' 'test_rescue_aCurveThatIsNoLongerReadyIsClosedToStrangers'
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
