#!/usr/bin/env bash
# THE INTEGRATION'S GUARDS, BROKEN ON PURPOSE (core v2 design, WP8).
#
#   bash script/b20/start-node.sh          (in another terminal)
#   RPC=http://127.0.0.1:8546 bash script/b20/mutate-integration.sh
#   MUT_ONLY="d1 h3" ...   run only these mutants (and the baseline)
#
# Two groups, each judged by the tests written for it:
#   d*  DeployCurb's sharing roles, its pins of the code core v2 leaves
#       unchanged and its read-back of the deploy order - test/DeployCurbChecks.t.sol,
#       and the one test that runs run() itself (B20MultiAsset's environment test);
#   h*  the real HolderFeeDistributor's harvest against the real core on the
#       pinned fork - test/fork/HolderDistributorFork.t.sol and the HolderSharing
#       fork tests that collect through it.
# Every mutant starts from the same snapshot, and its named tests must fail.
# A test that stays green against a broken guard is not testing it.
#
# Same shape as mutate-sharing.sh: -e so a stale anchor stops the run, a
# snapshot restored on exit, a baseline that must be green target by target,
# and a verdict per mutant with an exit code that means something. Each
# failing line is printed with forge's reason, so WHY a mutant was caught can
# be read, not only that it was.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8546}"
MUT_ONLY="${MUT_ONLY:-}"

FILES=(script/DeployCurb.s.sol src/curb/sharing/HolderFeeDistributor.sol)
SNAP="$(mktemp -d /tmp/curb-integration-snapshot.XXXXXX)"
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
run() { # run <name> <match-path> <match-test>
  if [ -n "$MUT_ONLY" ] && [[ "$1" != baseline* ]] && [[ " $MUT_ONLY " != *" $1 "* ]]; then
    echo "  skipped $1 (not in MUT_ONLY)"; SKIPPED=$((SKIPPED + 1)); return 0
  fi
  local out
  if [[ "$2" == test/fork/* ]]; then
    out="$(B20_FORK=true base-forge test --match-path "$2" --match-test "$3" --fork-url "$RPC" 2>&1 \
      | grep -E "^\[(PASS|FAIL)|Suite result|^Error" | sed 's/ (gas.*//' || true)"
  else
    out="$(base-forge test --match-path "$2" --match-test "$3" 2>&1 \
      | grep -E "^\[(PASS|FAIL)|Suite result|^Error" | sed 's/ (gas.*//' || true)"
  fi
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
# one mutant: m <name> <file> <match-path> <match-test>, OLD and NEW exported
m() {
  echo
  echo "############ $1"
  if [ -n "$MUT_ONLY" ] && [[ " $MUT_ONLY " != *" $1 "* ]]; then
    echo "  skipped $1 (not in MUT_ONLY)"; SKIPPED=$((SKIPPED + 1)); return 0
  fi
  mutate "$2"
  run "$1" "$3" "$4"
  restore
}

D=script/DeployCurb.s.sol
H=src/curb/sharing/HolderFeeDistributor.sol
UNIT=test/DeployCurbChecks.t.sol
ENVT=test/fork/B20MultiAsset.t.sol
ENVM=test_theDeploymentsRunAsks
DF=test/fork/HolderDistributorFork.t.sol
HS=test/fork/HolderSharing.t.sol

echo "############ 0. UNMUTATED, every target below"
run baseline0 "$UNIT" '.*'
run baseline1 "$ENVT" "$ENVM"
run baseline2 "$DF" '.*'
run baseline3 "$HS" 'test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked|test_issuer_blocksTheDistributor'
[ "$FAILED" = 0 ] || { echo "  THE BASELINE IS NOT GREEN - no verdict below would mean anything"; exit 1; }

# ------------------------------------------------------------ the sharing roles
OLD=$'            publisher != address(0),' NEW=$'            true,' \
  m d1 "$D" "$UNIT" 'test_sharingRoles_aRealRunRefusesAnUnsetPublisherOrKeeperPayee'
OLD=$'            keeperPayee != address(0),' NEW=$'            true,' \
  m d2 "$D" "$UNIT" 'test_sharingRoles_aRealRunRefusesAnUnsetPublisherOrKeeperPayee'
OLD=$'            demo || vetoers.length > 0,' NEW=$'            true,' \
  m d3 "$D" "$UNIT" 'test_sharingRoles_onlyADemoMayNameNoSeparateVetoer'
OLD=$'            demo || vetoers.length > 0,' NEW=$'            vetoers.length > 0,' \
  m d4 "$D" "$UNIT" 'test_sharingRoles_onlyADemoMayNameNoSeparateVetoer'
OLD=$'            require(v != address(0), "a CURB_SHARING_VETOERS entry is the zero address");\n' NEW='' \
  m d5 "$D" "$UNIT" 'test_sharingRoles_aZeroOrRepeatedVetoerIsRefused'
OLD=$'                v != publisher,' NEW=$'                true,' \
  m d6 "$D" "$UNIT" 'test_sharingRoles_aVetoerMayNotBeThePublisher'
OLD=$'                v != policyOwner,' NEW=$'                true,' \
  m d7 "$D" "$UNIT" 'test_sharingRoles_thePolicyOwnerIsRefusedInTheList'
OLD=$'                require(vetoers[j] != v, "CURB_SHARING_VETOERS names one address twice");\n' NEW='' \
  m d8 "$D" "$UNIT" 'test_sharingRoles_aZeroOrRepeatedVetoerIsRefused'
OLD=$'        r.vetoers[vetoers.length] = policyOwner;\n' NEW='' \
  m d9 "$D" "$UNIT" 'test_sharingRoles_aRealRunNamesAllThreeAndThePolicyOwnerIsAddedLast'
OLD=$'        if (demo && publisher == address(0)) publisher = deployer;\n' NEW='' \
  m d10 "$D" "$UNIT" 'test_sharingRoles_aDemoFillsWhatIsUnsetWithTheDeployer'
OLD=$'        if (demo && publisher == address(0)) publisher = deployer;' NEW=$'        if (publisher == address(0)) publisher = deployer;' \
  m d11 "$D" "$UNIT" 'test_sharingRoles_aRealRunRefusesAnUnsetPublisherOrKeeperPayee'
OLD=$'        if (demo && keeperPayee == address(0)) keeperPayee = deployer;\n' NEW='' \
  m d12 "$D" "$UNIT" 'test_sharingRoles_aDemoFillsWhatIsUnsetWithTheDeployer'
OLD=$'        if (demo && keeperPayee == address(0)) keeperPayee = deployer;' NEW=$'        if (keeperPayee == address(0)) keeperPayee = deployer;' \
  m d13 "$D" "$UNIT" 'test_sharingRoles_aRealRunRefusesAnUnsetPublisherOrKeeperPayee'
# run() itself: each variable into its own slot, a real run read as one
OLD=$'            envAddressOr("CURB_SHARING_PUBLISHER", address(0)),\n            envAddressOr("CURB_SHARING_KEEPER_PAYEE", address(0)),' \
NEW=$'            envAddressOr("CURB_SHARING_KEEPER_PAYEE", address(0)),\n            envAddressOr("CURB_SHARING_PUBLISHER", address(0)),' \
  m d14 "$D" "$ENVT" "$ENVM"
OLD=$'        SharingRoles memory roles = sharingRoles(demoRun, deployer, policyOwner);' \
NEW=$'        SharingRoles memory roles = sharingRoles(true, deployer, policyOwner);' \
  m d15 "$D" "$ENVT" "$ENVM"
OLD=$'            envAddressesOr("CURB_SHARING_VETOERS"),' \
NEW=$'            new address[](0),' \
  m d16 "$D" "$ENVT" "$ENVM"

# ------------------------------------------------------------ the pinned code
OLD=$'        require(trailer + 2 <= n, "the metadata length runs past the code");\n' NEW='' \
  m d17 "$D" "$UNIT" 'test_codeIdentity_refusesALengthPastTheCodeAndAMissingTrailer'
OLD=$'        require(n >= 2, "no runtime code to identify");\n' NEW='' \
  m d18 "$D" "$UNIT" 'test_codeIdentity_refusesALengthPastTheCodeAndAMissingTrailer'
OLD=$'        uint256 len = n - trailer - 2;' NEW=$'        uint256 len = n - trailer - 1;' \
  m d19 "$D" "$UNIT" 'test_codeIdentity_cutsTheMetadataTrailerByItsOwnLength'
OLD=$'        if (got != want) {' NEW=$'        if (false) {' \
  m d20 "$D" "$UNIT" 'test_aChangedContractIsRefusedBeforeAnythingIsSent|test_eachOfTheFivePinsIsAsked'
OLD=$'        for (uint256 i = 0; i < 5; i++) {\n            requireIdentity' NEW=$'        for (uint256 i = 0; i < 4; i++) {\n            requireIdentity' \
  m d21 "$D" "$UNIT" 'test_eachOfTheFivePinsIsAsked'
OLD=$'        artifacts[1] = "FeeEscrow.sol:FeeEscrow";' NEW=$'        artifacts[1] = "FeePolicy.sol:FeePolicy";' \
  m d22 "$D" "$UNIT" 'test_pinnedCode_namesTheFiveUnchangedContracts|test_theFiveUnchangedContractsBuildToTheirPinnedIdentities'
OLD=$'        0xbdea563259fb8a3bacd90780441f1ae18942886c0eee5ea904cee45ce16b3240;' \
NEW=$'        0xbdea563259fb8a3bacd90780441f1ae18942886c0eee5ea904cee45ce16b3241;' \
  m d23 "$D" "$UNIT" 'test_theFiveUnchangedContractsBuildToTheirPinnedIdentities'
OLD=$'        requireUnchangedCode();\n\n        // THE DEPTH CHECKS' NEW=$'\n        // THE DEPTH CHECKS' \
  m d24 "$D" "$ENVT" "$ENVM"

# ------------------------------------------------------------ the read-back
W1='test_wiring_eachLinkIsReadBackOnItsOwn'
W2='test_wiring_theCatalogMustHaveAdmittedAndRecommendTheFactory'
# Read into an array first: forge must not be able to eat the list on stdin.
READBACK=(
  "address(graduator.registry()) == address(registry)|$W1"
  "address(graduator.sharingCatalog()) == address(catalog)|$W1"
  "catalog.owner() == policyOwner|$W1"
  "catalog.bootstrapper() == deployer|$W1"
  "catalog.bootstrapped()|$W2"
  "catalog.isApproved(address(distributorFactory))|$W2"
  "distributorFactory.registry() == address(registry)|$W1"
  "distributorFactory.graduator() == address(graduator)|$W1"
  "distributorFactory.owner() == policyOwner|$W1"
  "distributorFactory.publisher() == roles.publisher|$W1"
  "distributorFactory.isVetoer(roles.vetoers[i])|$W1"
  "!distributorFactory.frozen()|$W1"
  "address(implementation).code.length != 0|$W1"
  "implementation.factory() == address(distributorFactory)|$W1"
  "implementation.graduator() == address(graduator)|$W1"
  "address(lens.registry()) == address(registry)|$W1"
  "address(lens.graduator()) == address(graduator)|$W1"
)
for k in "${!READBACK[@]}"; do
  cond="${READBACK[k]%|*}" target="${READBACK[k]##*|}"
  OLD="require($cond," NEW="require(true," m "w$((k + 1))" "$D" "$UNIT" "$target" </dev/null
done
# the two whose condition spans a line
OLD=$'            catalog.recommended() == address(distributorFactory),' NEW=$'            true,' \
  m w18 "$D" "$UNIT" "$W2"
OLD=$'            distributorFactory.keeperPayee() == roles.keeperPayee,' NEW=$'            true,' \
  m w19 "$D" "$UNIT" "$W1"

# ------------------------------------------------------------ the harvest, on the fork
OLD=$'        if (!g.hasGraduated(t)) _poke(curve, abi.encodeCall(ISharingCurve.sweepFees, (0)));\n' NEW='' \
  m h1 "$H" "$DF" 'test_harvest_curveSweepAsDeployer_'
OLD=$'        if (!g.hasGraduated(t)) _poke(curve,' NEW=$'        if (g.hasGraduated(t)) _poke(curve,' \
  m h2 "$H" "$DF" 'test_harvest_curveSweepAsDeployer_'
OLD=$'        _poke(escrow, abi.encodeCall(ISharingEscrow.claimToken, (q)));\n' NEW='' \
  m h3 "$H" "$DF" 'test_harvest_escrowCreditAfterGraduation_'
OLD=$'        _poke(hook, abi.encodeCall(ISharingHook.claim, (q)));\n' NEW='' \
  m h4 "$H" "$DF" 'test_harvest_hookDebtAndLockFees_WETH|test_harvest_hookDebtAndLockReleaseAfterAnIssuerBlock_NVDAc'
OLD=$'            _poke(lock, abi.encodeCall(IPositionLockSharing.claimFees, ()));\n' NEW='' \
  m h5 "$H" "$DF" 'test_harvest_hookDebtAndLockFees_WETH|test_directTakeAndLockFees_NVDAc'
OLD=$'            _poke(lock, abi.encodeCall(IPositionLockSharing.release, (address(this))));\n' NEW='' \
  m h6 "$H" "$DF" 'test_harvest_hookDebtAndLockReleaseAfterAnIssuerBlock_NVDAc'
OLD=$'        if (lock != address(0)) {' NEW=$'        if (lock == address(0)) {' \
  m h7 "$H" "$DF" 'test_harvest_hookDebtAndLockFees_WETH|test_directTakeAndLockFees_NVDAc'
OLD=$'            pop(call(gas(), target, 0, add(data, 0x20), mload(data), 0, 0))' \
NEW=$'            if iszero(call(gas(), target, 0, add(data, 0x20), mload(data), 0, 0)) { revert(0, 0) }' \
  m h8 "$H" "$DF" 'test_harvest_hookDebtAndLockReleaseAfterAnIssuerBlock_NVDAc'
# the same steps, judged by the HolderSharing fork tests that collect through the real harvest
OLD=$'        _poke(hook, abi.encodeCall(ISharingHook.claim, (q)));\n' NEW='' \
  m h9 "$H" "$HS" 'test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked|test_issuer_blocksTheDistributor'
OLD=$'            _poke(lock, abi.encodeCall(IPositionLockSharing.release, (address(this))));\n' NEW='' \
  m h10 "$H" "$HS" 'test_issuer_blocksTheDistributor'
OLD=$'        if (!g.hasGraduated(t)) _poke(curve, abi.encodeCall(ISharingCurve.sweepFees, (0)));\n' NEW='' \
  m h11 "$H" "$HS" 'test_weth_sharedAtLaunch_everyLegReachesTheDistributorAndThePrincipalStaysLocked'

echo
if [ "$FAILED" = 0 ]; then
  echo "every mutant was caught ($SKIPPED skipped)"
  exit 0
fi
echo "$FAILED verdict(s) went the wrong way ($SKIPPED skipped)"
exit 1
