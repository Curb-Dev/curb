#!/usr/bin/env bash
# THE LAUNCH-POLICY CHECKS, BROKEN ON PURPOSE.
#
#   bash script/b20/start-node.sh          (in another terminal)
#   RPC=http://127.0.0.1:8546 bash script/b20/mutate-launch-policy.sh
#
# Break each new check in turn, FROM THE SAME STARTING STATE, and read the
# failure. A check no test can break is not a check.
# -e, AND IT IS THE POINT. Without it a mutation whose search text had gone
# stale failed its assert inside the heredoc, the script carried on, and the
# test ran against UNMUTATED source and passed - four of thirteen did exactly
# that for as long as nobody re-read them, and the final byte-identical check
# said all was well because nothing had been written. A stale anchor now stops
# the run, and the trap below puts the sources back on the way out.
set -euo pipefail
# READ BEFORE THE cd, so the baseline below can be taken from this very file.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-http://127.0.0.1:8546}"
F=src/curb/CurbLaunchFactory.sol
R=src/curb/LaunchRegistry.sol


# A VERDICT PER RUN, AND AN EXIT CODE THAT MEANS SOMETHING. This used to print
# the forge lines and nothing else: a surviving mutant printed [PASS], a mutant
# that no longer compiled printed nothing at all (the grep hid the error), a
# broken baseline did not stop anything - and the script exited 0 every time.
FAILED=0
judge() { # judge <name> <output> [expect-green]
  local name="$1" out="$2" want="${3:-red}" pass fail
  pass=$(printf '%s\n' "$out" | grep -c '^\[PASS' || true)
  fail=$(printf '%s\n' "$out" | grep -c '^\[FAIL' || true)
  if [ "$name" = baseline ] || [ "$want" = green ]; then
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
LAST_OUT=""
# MUT_ONLY="f1 f2 f30": RUN ONLY THESE MUTATIONS (and the baseline). Each
# mutant recompiles the contracts under via_ir, minutes apiece, so the whole
# list takes hours; split across checkouts, each with its own out/, it runs in
# a fraction. A block outside the list still applies and restores its edit -
# which is how its anchor stays checked - but runs no tests and has no verdict.
MUT_ONLY="${MUT_ONLY:-}"
SKIPPED=0
run() { # run <name> <match-pattern>
  if [ -n "$MUT_ONLY" ] && [ "$1" != baseline ] && [[ " $MUT_ONLY " != *" $1 "* ]]; then
    echo "  skipped $1 (not in MUT_ONLY)"; SKIPPED=$((SKIPPED + 1)); return 0
  fi
  # `|| true`: a mutated run is SUPPOSED to fail, and under -e/pipefail its
  # exit status would otherwise end the script at the first mutation that works.
  local out
  out="$(B20_FORK=true base-forge test --match-path "test/fork/*" \
    --match-test "$2" --fork-url "$RPC" 2>&1 \
    | grep -E "^\[(PASS|FAIL)|Suite result" | sed 's/ (gas.*//' || true)"
  printf '%s\n' "$out"
  LAST_OUT="$out"
  judge "$1" "$out"
}

H=src/curb/FeeHook.sol
G=src/curb/Graduator.sol
# A SNAPSHOT OF ITS OWN, not one fixed path: two runs at once (MUT_ONLY, one per
# checkout) each restored from whichever snapshot the other had written last.
SNAP="$(mktemp -d /tmp/curb-mutation-snapshot.XXXXXX)"
cp "$F" "$SNAP/factory.sol"
cp "$R" "$SNAP/registry.sol"
cp "$H" "$SNAP/hook.sol"
cp "$G" "$SNAP/graduator.sol"
# RESTORE FROM THE SNAPSHOT, NEVER FROM GIT. An earlier version used
# `git checkout -- <file>`, which restores from the INDEX - and with a stale
# index that silently reverted both contracts to HEAD, destroying the work
# under test. The snapshot is taken from the working tree, above, once.
restore() {
  cp "$SNAP/factory.sol" "$F"; cp "$SNAP/registry.sol" "$R"; cp "$SNAP/hook.sol" "$H"; cp "$SNAP/graduator.sol" "$G"
}
trap restore EXIT

# THE BASELINE IS EVERY TARGET BELOW, READ OUT OF THIS FILE. It was a list
# typed by hand, and it drifted: seven of the targets (f7 to f13) were never in
# it, so a target test that already failed on unmutated code would have had its
# mutant reported as "caught". Now a new block is in the baseline by being a
# block, and each target has to show at least one PASS of its own, so a pattern
# that matches nothing, or matches only a failing test, stops the run here.
TARGETS=()
while IFS= read -r t; do TARGETS+=("$t"); done \
  < <(grep -oE "^run f[0-9]+ '[^']+'" "$SELF" | sed -E "s/^run f[0-9]+ '(.*)'$/\1/")
[ "${#TARGETS[@]}" -gt 0 ] || { echo "  no mutation targets found in $SELF"; exit 1; }
BASELINE="$(IFS='|'; echo "${TARGETS[*]}")"

echo "############ 0. UNMUTATED, the tests that must break below (${#TARGETS[@]} targets)"
run baseline "$BASELINE"
for t in "${TARGETS[@]}"; do
  if ! printf '%s\n' "$LAST_OUT" | grep -qE "^\[PASS\] [A-Za-z0-9_]*($t)"; then
    echo "  VERDICT baseline: target '$t' has no passing test"; FAILED=$((FAILED + 1))
  fi
done
[ "$FAILED" = 0 ] || { echo "  THE BASELINE IS NOT GREEN - no verdict below would mean anything"; exit 1; }

echo
echo "############ 1. the factory stops checking the band"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (cfg.totalTaxBps < minTotalTaxBps || cfg.totalTaxBps > maxTotalTaxBps) {
            revert TaxOutOfBand(cfg.totalTaxBps, minTotalTaxBps, maxTotalTaxBps);
        }"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f1 'theTaxBandIsRefused'
restore

echo
echo "############ 2. the registry stops checking the band"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (launch.totalTaxBps < MIN_TOTAL_TAX_BPS || launch.totalTaxBps > MAX_TOTAL_TAX_BPS) {
            revert TaxOutOfRange(launch.totalTaxBps, MIN_TOTAL_TAX_BPS, MAX_TOTAL_TAX_BPS);
        }"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f2 'theRegistryRefusesAnOutOfBand'
restore

echo
echo "############ 3. the platform's fee follows the creator's tax"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            platformBps,
            cfg.totalTaxBps - platformBps,"""
new="""            cfg.totalTaxBps / 6,
            cfg.totalTaxBps - cfg.totalTaxBps / 6,"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f3 'thePlatformsShareDoesNotMove'
restore

echo
echo "############ 4. the caller becomes the protocol fee recipient"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="            protocolFeeRecipient: platformTo,"
new="            protocolFeeRecipient: msg.sender,"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f4 'aStrangerCannotRedirect'
restore

echo
echo "############ 5. the protocol share is no longer all of the base fee"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="            protocolFeeShareBps: PROTOCOL_FEE_SHARE_BPS,"
new="            protocolFeeShareBps: 2_000,"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f5 'aStrangerCannotRedirect|thePlatformsShareDoesNotMove'
restore

echo
echo "############ 6. the creator is not the caller"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="        address creator = cfg.creatorWallet == address(0) ? msg.sender : cfg.creatorWallet;"
new="        address creator = cfg.creatorWallet == address(0) ? protocolFeeRecipient : cfg.creatorWallet;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f6 'aStrangerCanLaunchAndIsTheCreator'
restore

echo
echo "############ 7. the tick-spacing ceiling goes away again"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (terms.tickSpacing < TickMath.MIN_TICK_SPACING || terms.tickSpacing > TickMath.MAX_TICK_SPACING) {"""
new="""        if (terms.tickSpacing < TickMath.MIN_TICK_SPACING) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
EOF
run f7 'IllegalTickSpacingCannotBeDEPLOYED'
restore

echo
echo "############ 8. the buy side stops being charged"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="        uint256 charged = _pay(id, quote, base, cfg);"
new="        uint256 charged = 0; base; quote;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
EOF
run f8 'aBuyIsChargedOn'
restore

echo
echo "############ 9. an unconfigured pool trades free instead of failing"
# BOTH GUARDS, because either one alone catches it. beforeSwap and afterSwap
# each refuse an unbound pool, so removing one is invisible - which is the
# point of having two, and the reason this mutation removes both rather than
# reporting a pass that would mean nothing.
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
n=s.count("        if (!cfg.configured) revert PoolNotConfigured(id);")
assert n==2, n
s=s.replace("        if (!cfg.configured) revert PoolNotConfigured(id);","        cfg;")
io.open(p,"w",encoding="utf-8").write(s)
EOF
run f9 'anUnboundPoolCannotBeTradedAtAll'
restore

echo
echo "############ 10. the platform's leg follows the tax"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="        platformAmount = (base * cfg.platformBps) / BPS;"
new="        platformAmount = (base * (cfg.totalTaxBps / 6)) / BPS;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
EOF
run f10 'hePlatformIsPaidTheSame|hePlatformsShareIsTheSame'
restore

echo
echo "############ 11. anyone may bind a pool to a launch"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (msg.sender != poolOpener) revert NotThePoolOpener(msg.sender);

        LaunchRegistry.Launch memory rec"""
new="""        LaunchRegistry.Launch memory rec"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
EOF
run f11 'onlyTheGraduatorCanBindAPool'
restore

echo
echo "############ 12. any key is accepted for any launch"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (!wellFormed) revert KeyIsNotThisLaunchsPool(launchToken);"
new="        wellFormed; launchToken;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
EOF
run f12 'aKeyThatIsNotTheLaunchsPoolIsRefused'
restore

echo
echo "############ 13. a partial fill is charged instead of refused"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="            if (spent != offered) revert PartialFillNotSupported(offered, spent);"
new="            spent; offered;"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8").write(s.replace(old,new,1))
EOF
run f13 'CannotFillCompletely'
restore

echo
echo "############ 14. the registry takes a platform share above the whole tax"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (launch.platformBps > launch.totalTaxBps) {
            revert PlatformShareAboveTax(launch.platformBps, launch.totalTaxBps);
        }"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f14 'theRegistryRefusesAPlatformShareAboveTheTax'
restore

echo
echo "############ 15. the registry takes a platform recipient of nobody"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (launch.platformRecipient == address(0)) revert IncompleteRecord();"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f15 'theRegistryRefusesAPlatformRecipientOfNobody'
restore

echo
echo "############ 16. the graduator goes back to a raw approve"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""        IERC20(token0).forceApprove(address(permit2), amount0Max);
        IERC20(token1).forceApprove(address(permit2), amount1Max);"""
new="""        IERC20(token0).approve(address(permit2), amount0Max);
        IERC20(token1).approve(address(permit2), amount1Max);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f16 'twoGraduationsOnOneStackAgainstAUsdtShapedQuote'
restore

echo
echo "############ 17. the hook stops refusing exact output before the swap"
# beforeSwap's guard only. afterSwap has the same line, which is not reached:
# without the first, the fee arithmetic overflows on the negated amount - a
# revert of a different kind, which is exactly what the test must tell apart.
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (params.amountSpecified > 0) revert ExactOutputNotSupported();"
assert s.count(old)==2, s.count(old)
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f17 'exactOutputIsRefusedThroughTheRouter'
restore

echo
echo "############ 18. the factory stops comparing the expected recipient"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (cfg.expectedPlatformBps != platformBps || cfg.expectedPlatformRecipient != platformTo) {"
new="        if (cfg.expectedPlatformBps != platformBps) {"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f18 'aLaunchIsRefusedWhenOnlyThePlatformRecipientMoved'
restore

echo
echo "############ 19. a launch may be made for the deployment's own contracts"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (_isOwnContract(creator)) revert CreatorIsInfrastructure(creator);"""
assert s.count(old)==1
s=s.replace(old,"""if (_isOwnContract(creator)) { creator; }""",1)
io.open(p,"w",encoding="utf-8",newline="\n").write(s)
EOF
run f19 'aLaunchForTheDeploymentsOwnContractsIsRefused'
restore

echo
echo "############ 20. the asset's decimals are trusted after construction"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="            if (nowDecimals != declaredQuoteDecimals) {"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"            if (nowDecimals != nowDecimals) {",1))
EOF
run f20 'aLaunchIsRefusedWhenTheAssetsDecimalsChangedAfterTheFactory'
restore

echo
echo "############ 21. the registry takes the curve's escrow as a beneficiary"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="                if (escrow == launch.beneficiary) revert BeneficiaryIsTheEscrow(launch.beneficiary);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f21 'theRegistryRefusesABeneficiaryThatIsTheCurvesEscrow'
restore

echo
echo "############ 22. the graduator approves without the reset, ignoring the answer"
# The shape forceApprove exists to beat when an allowance is left standing: a
# tolerant call that never zeroes first. The raw approve (16) fails on the
# FIRST graduation; this one only on the second, over the stale allowance.
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""        IERC20(token0).forceApprove(address(permit2), amount0Max);
        IERC20(token1).forceApprove(address(permit2), amount1Max);"""
new="""        (bool a0,) = token0.call(abi.encodeCall(IERC20.approve, (address(permit2), amount0Max))); a0;
        (bool a1,) = token1.call(abi.encodeCall(IERC20.approve, (address(permit2), amount1Max))); a1;"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f22 'twoGraduationsOnOneStackAgainstAUsdtShapedQuote'
restore

echo
echo "############ 23. the hook rounds each leg UP"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""        platformAmount = (base * cfg.platformBps) / BPS;
        creatorAmount = (base * (cfg.totalTaxBps - cfg.platformBps)) / BPS;"""
new="""        platformAmount = (base * cfg.platformBps + BPS - 1) / BPS;
        creatorAmount = (base * (cfg.totalTaxBps - cfg.platformBps) + BPS - 1) / BPS;"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f23 'test_bothLegsRoundDownAndNeverOvercharge'
restore

echo
echo "############ 24. the factory takes an infrastructure platform recipient"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (_isOwnContract(platformTo)) revert PlatformRecipientIsInfrastructure(platformTo);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"""if (_isOwnContract(platformTo)) { platformTo; }""",1))
EOF
run f24 'PlatformRecipientIsAnyDeploymentContract'
restore

echo
echo "############ 25. the registry takes the curve's escrow as the platform recipient"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="                if (escrow == launch.platformRecipient) revert PlatformRecipientIsTheEscrow(launch.platformRecipient);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f25 'theRegistryRefusesAPlatformRecipientThatIsTheCurvesEscrow'
restore

echo
echo "############ 26. the opening price overflows at 2^64 again"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (amount1 / amount0 < (1 << 64)) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"""        if (true) {""",1))
EOF
run f26 'theOpeningPriceHelperCoversTheWholeRange'
restore

echo
echo "############ 27. claim() loses its re-entry guard"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="        if (_claiming) revert ClaimReentered();"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f27 'claimCannotBeReenteredOrEmpty'
restore

echo
echo "############ 28. a cancel no longer says what it withdrew"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="        emit PlatformRecipientCancelled(pendingRecipient);"
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"        emit PlatformRecipientCancelled(address(0));",1))
EOF
run f28 'eachCancelNamesTheChangeItWithdrew'
restore

echo
echo "############ 29. claim() stops clearing its guard on the token exit"
# The ether exit clears it on a line of its own and every other claim test
# leaves that way. Only a SECOND claim after the token exit (the WETH fallback,
# or a plain NVDAc debt) can see this one missing.
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""        emit FeeClaimed(msg.sender, token, amount);
        _claiming = false;
    }"""
new="""        emit FeeClaimed(msg.sender, token, amount);
    }"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f29 'aCreatorThatRefusesEtherGetsWeth|aClaimPaidInTheTokenLeavesTheNextClaimOpen'
restore

echo
echo "############ 30. the announcement stops refusing the deployment's contracts"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (next == address(this)) revert RecipientIsTheHook();
        _refuseDeploymentContract(next);"""
new="""        if (next == address(this)) revert RecipientIsTheHook();"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f30 'theHookRefusesEveryDeploymentContractAsThePlatformRecipient'
restore

echo
echo "############ 31. a recipient is not asked again when it lands"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""        _refuseDeploymentContract(pendingRecipient);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f31 'aRecipientThatBecameADeploymentContractWhileAnnouncedCannotLand'
restore

echo
echo "############ 32. the hook forgets the launchers' escrows"
# The finding itself: asset B's escrow announced and stamped into asset A.
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""            if (next == launcher || _names(launcher, ILauncherEscrow.feeEscrow.selector, next)) {"""
new="""            if (next == launcher) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f32 'theHookRefusesEveryDeploymentContractAsThePlatformRecipient'
restore

echo
echo "############ 33. the hook forgets the launchers themselves"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""            if (next == launcher || _names(launcher, ILauncherEscrow.feeEscrow.selector, next)) {"""
new="""            if (_names(launcher, ILauncherEscrow.feeEscrow.selector, next)) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f33 'theHookRefusesEveryDeploymentContractAsThePlatformRecipient'
restore

echo
echo "############ 34. the hook forgets the PoolManager"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""            next == address(poolManager) || next == address(registry) || next == poolOpener"""
new="""            next == address(registry) || next == poolOpener"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f34 'theHookRefusesEveryDeploymentContractAsThePlatformRecipient'
restore

echo
echo "############ 69. the hook forgets the PositionManager"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""                || _names(poolOpener, POSITION_MANAGER_SELECTOR, next)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f69 'r9_F1hook_theHookRefusesThePositionManagerAsThePlatformRecipient'
restore

# 70-71: THE HOOK'S QUESTIONS TO THE LAUNCHERS ARE BOUNDED (the F1 sibling).
# The unbounded high-level read it replaced forwards all but 1/64 of the gas
# and copies the whole reply; a reverting launcher reverted the announcement.
echo
echo "############ 70. the hook asks the launchers' escrows without a gas bound"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""            let ok := staticcall(20000, target, 0, 4, 0, 32)"""
new="""            let ok := staticcall(gas(), target, 0, 4, 0, 32)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f70 'r9_F1hook_aGasBurningOrHugeReplyLauncherDoesNotStopAnnouncements'
restore

echo
echo "############ 71. the hook goes back to the plain high-level escrow read"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old="""            if (next == launcher || _names(launcher, ILauncherEscrow.feeEscrow.selector, next)) {"""
new="""            if (next == launcher || next == ILauncherEscrow(launcher).feeEscrow()) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f71 'r9_F1hook_aGasBurningOrHugeReplyLauncherDoesNotStopAnnouncements'
restore

echo
echo "############ 35. a hook can be built paying its own infrastructure"
python3 - <<'EOF'
import io
p="src/curb/FeeHook.sol"; s=io.open(p,encoding="utf-8").read()
old=""") revert RecipientIsDeploymentContract(platformRecipient_);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,""") { platformRecipient_; }""",1))
EOF
run f35 'theHookCannotBeBuiltPayingItsOwnInfrastructure'
restore

# 36-40, 59, 62-63, 72-75: ONE TERM OF _isOwnContract AT A TIME. The creator
# and the platform recipient share that one list, so each term is judged
# against the tests of both: some addresses (the factory, its escrow) are also
# refused through _refuseOtherLaunchers on the creator side, and only the
# platform-recipient test can tell their term is gone. f19 and f24 remove each
# refusal whole.
echo
echo "############ 36. the factory forgets its escrow (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""        return a == address(feeEscrow) || a == address(graduator) || a == address(hooks)"""
new="""        return a == address(graduator) || a == address(hooks)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f36 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore

echo
echo "############ 37. the factory forgets the graduator (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""        return a == address(feeEscrow) || a == address(graduator) || a == address(hooks)"""
new="""        return a == address(feeEscrow) || a == address(hooks)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f37 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore

echo
echo "############ 38. the factory forgets the hook (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""        return a == address(feeEscrow) || a == address(graduator) || a == address(hooks)"""
new="""        return a == address(feeEscrow) || a == address(graduator)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f38 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore

echo
echo "############ 39. the factory forgets the registry (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == address(registry) || a == address(this) || a == graduatorPoolManager"""
new="""            || a == address(this) || a == graduatorPoolManager"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f39 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore

echo
echo "############ 40. the factory forgets itself (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == address(registry) || a == address(this) || a == graduatorPoolManager"""
new="""            || a == address(registry) || a == graduatorPoolManager"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f40 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore

echo
echo "############ 41. the seedability check forgets its encoding bound entirely"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""            revert SeedTooLargeToEncode(reserved, graduationThreshold);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f41 'aFactoryWhoseSeedCannotBeEncodedCannotBeDEPLOYED'
restore

echo
echo "############ 42. a factory takes another asset's escrow"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            if (escrowAsset != quoteToken_) {
                revert EscrowIsForAnotherAsset(address(feeEscrow_), escrowAsset, quoteToken_);
            }"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f42 'aFactoryOnAnotherAssetsEscrowCannotBeDEPLOYED'
restore

echo
echo "############ 43. a factory takes an escrow that will not say its asset"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            if (!okEsc || rawEsc.length != 32) revert EscrowUnreadable(address(feeEscrow_));
            address escrowAsset = abi.decode(rawEsc, (address));"""
new="""            address escrowAsset = okEsc && rawEsc.length == 32 ? abi.decode(rawEsc, (address)) : quoteToken_;"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f43 'aFactoryOnAnotherAssetsEscrowCannotBeDEPLOYED'
restore

echo
echo "############ 44. a factory takes a policy that names another escrow"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            revert PolicyNamesAnotherEscrow(address(feePolicy_.feeEscrow()), address(feeEscrow_));"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f44 'aFactoryWhosePolicyNamesAnotherEscrowCannotBeDEPLOYED'
restore

echo
echo "############ 45. the quote refund goes back to a raw, bool-decoding transfer"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""        IERC20(token).safeTransfer(to, left);"""
new="""        if (!IERC20(token).transfer(to, left)) revert ZeroReserves();"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f45 'aNonZeroQuoteRefundReachesTheRefundAddress'
restore

echo
echo "############ 46. the quote refund is not sent at all"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""        IERC20(token).safeTransfer(to, left);"""
new="""        to; left;"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f46 'aNonZeroQuoteRefundReachesTheRefundAddress'
restore

echo
echo "############ 47. the graduator accepts other people's NFTs again"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""    // back. Without it such a transfer reverts and the sender keeps the NFT.
}"""
new="""    // back. Without it such a transfer reverts and the sender keeps the NFT.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f47 'theGraduatorRefusesAnNftSentToIt'
restore

echo
echo "############ 48. the square root loses its small-input answer"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (x <= 3) return x == 0 ? 0 : 1;"""
new="""        if (x == 0) return 0;"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f48 'theSquareRootIsTheFloorAtItsSmallestInputs'
restore

# 49-53: THE REGISTRY'S ADMISSION CHECKS. The hook sees only launchers admitted
# before a recipient lands; these cover the other order, and keep the hook's
# feeEscrow() call from ever meeting a launcher that cannot answer it.
echo
echo "############ 49. the registry admits a launcher that is already the platform recipient"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (recipient == launcher_ || recipient == escrow) revert LauncherIsThePlatformRecipient(launcher_, recipient);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f49 'aLauncherThatIsAlreadyThePlatformRecipientCannotBeAdmitted|aStackWhoseHookPaysTheFirstLaunchersEscrowCannotBeWired'
restore

echo
echo "############ 50. the registry forgets the launcher's escrow as the recipient"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (recipient == launcher_ || recipient == escrow) revert"""
new="""        if (recipient == launcher_) revert"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f50 'aStackWhoseHookPaysTheFirstLaunchersEscrowCannotBeWired'
restore

echo
echo "############ 51. the registry forgets the launcher itself as the recipient"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (recipient == launcher_ || recipient == escrow) revert"""
new="""        if (recipient == escrow) revert"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f51 'aLauncherThatIsAlreadyThePlatformRecipientCannotBeAdmitted'
restore

echo
echo "############ 52. the registry admits a launcher that will not name its escrow"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (!okEsc || rawEsc.length != 32) revert LauncherEscrowUnreadable(launcher_);
        address escrow = abi.decode(rawEsc, (address));"""
new="""        address escrow = okEsc && rawEsc.length == 32 ? abi.decode(rawEsc, (address)) : address(1);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f52 'aLauncherThatWillNotNameItsEscrowCannotBeAdmitted'
restore

echo
echo "############ 53. the registry takes a zero as an escrow"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (escrow == address(0)) revert LauncherEscrowUnreadable(launcher_);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f53 'aLauncherThatWillNotNameItsEscrowCannotBeAdmitted'
restore

# 54-56: THE SEED BOUND IS v4's int128, NOT THE MINT'S uint128. Each side is
# broken on its own, so a test that pinned only one side would let the other
# survive.
echo
echo "############ 54. the seedability check goes back to the mint's uint128 bound"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (reserved > MAX_SEED_AMOUNT || graduationThreshold > MAX_SEED_AMOUNT) {"""
new="""if (reserved > type(uint128).max || graduationThreshold > type(uint128).max) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f54 'theSeedBoundIsV4sInt128OnBothSides'
restore

echo
echo "############ 55. the token side alone goes back to uint128"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (reserved > MAX_SEED_AMOUNT || graduationThreshold > MAX_SEED_AMOUNT) {"""
new="""if (reserved > type(uint128).max || graduationThreshold > MAX_SEED_AMOUNT) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f55 'theSeedBoundIsV4sInt128OnBothSides'
restore

echo
echo "############ 56. the quote side alone goes back to uint128"
python3 - <<'EOF'
import io
p="src/curb/Graduator.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (reserved > MAX_SEED_AMOUNT || graduationThreshold > MAX_SEED_AMOUNT) {"""
new="""if (reserved > MAX_SEED_AMOUNT || graduationThreshold > type(uint128).max) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f56 'theSeedBoundIsV4sInt128OnBothSides'
restore

# 57-58: THE CURVE'S RANGE FOR THE BUYBACK IMPACT CAP, checked in the factory's
# constructor. Both ends, because the curve refuses both.
echo
echo "############ 57. the factory takes a zero buyback impact cap"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (terms.maxInternalPriceImpactBps == 0 || terms.maxInternalPriceImpactBps >= 10_000) {"""
new="""if (terms.maxInternalPriceImpactBps >= 10_000) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f57 'aFactoryWithABuybackImpactCapItsCurvesRefuseCannotBeDEPLOYED'
restore

echo
echo "############ 58. the factory takes a buyback impact cap of the whole price"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (terms.maxInternalPriceImpactBps == 0 || terms.maxInternalPriceImpactBps >= 10_000) {"""
new="""if (terms.maxInternalPriceImpactBps == 0) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f58 'aFactoryWithABuybackImpactCapItsCurvesRefuseCannotBeDEPLOYED'
restore

echo
echo "############ 59. the factory forgets the PoolManager (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == address(registry) || a == address(this) || a == graduatorPoolManager"""
new="""            || a == address(registry) || a == address(this)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f59 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore

# 60-61: A HELD LAUNCH FEE CAN GO WHERE THE RECIPIENT NAMES. The recipient in
# the target test still refuses ether, so paying it instead of the named
# address fails the same way the plain withdrawal does.
echo
echo "############ 60. withdrawLaunchFeesTo pays the caller instead of the named address"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""        return _withdrawLaunchFees(to);"""
new="""        return _withdrawLaunchFees(msg.sender);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f60 'aRecipientThatStillRefusesEtherWithdrawsToAnotherAddress'
restore

echo
echo "############ 61. withdrawLaunchFeesTo sends a held fee to address zero"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (to == address(0)) revert ZeroDestination();"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f61 'aRecipientThatStillRefusesEtherWithdrawsToAnotherAddress'
restore

# 62-65: EVERY OTHER CONTRACT OF THE DEPLOYMENT THE FACTORY CAN REACH, as the
# creator. Each term is broken on its own, since the target tests list them
# one by one and a single missing term must be enough to fail one of them.
echo
echo "############ 62. the factory forgets the PositionManager (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == graduatorPositionManager || a == address(feePolicy) || a == address(buybackVault)"""
new="""            || a == address(feePolicy) || a == address(buybackVault)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f62 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore

echo
echo "############ 63. the factory forgets its fee policy (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == graduatorPositionManager || a == address(feePolicy) || a == address(buybackVault)"""
new="""            || a == graduatorPositionManager || a == address(buybackVault)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f63 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore

echo
echo "############ 64. the factory never asks the registry's other launchers"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""        _refuseOtherLaunchers(creator);
"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,"",1))
EOF
run f64 'aLaunchForAnyOtherContractOfTheDeploymentIsRefused'
restore

echo
echo "############ 65. the factory asks the other launchers but not their escrows"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""_answers(other, ILauncherFeeEscrow.feeEscrow.selector, want)"""
new="""false"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f65 'aLaunchForAnyOtherContractOfTheDeploymentIsRefused'
restore

# 66-67: THE LAUNCH'S OWN CURVE AND TOKEN, as the creator - each half alone.
echo
echo "############ 66. the factory takes the launch's own curve as its creator"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (creator == address(curve) || creator == address(token)) {"""
new="""if (creator == address(token)) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f66 'aLaunchForItsOwnCurveOrTokenIsRefused'
restore

echo
echo "############ 67. the factory takes the launch's own token as its creator"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (creator == address(curve) || creator == address(token)) {"""
new="""if (creator == address(curve)) {"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f67 'aLaunchForItsOwnCurveOrTokenIsRefused'
restore

# 68: THE DEV BUY CAP'S PRICE IN NVDAc IS MEASURED. A cap one point higher (21%
# of the supply) costs 0.266 of the phantom instead of a quarter, outside the
# band the arithmetic sets.
echo
echo "############ 68. the dev-buy cap moves and the quoted cost goes stale"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""uint16 public constant MAX_DEV_BUY_BPS = 2000;"""
new="""uint16 public constant MAX_DEV_BUY_BPS = 2100;"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f68 'devBuy_theCapCostsAQuarterOfThePhantomAndLeavesMostOfTheCurve'
restore

# 72-83: THE r7 LOWS (core v2 design, section C), each guard broken on its own.
echo
echo "############ 72. the factory forgets its buyback vault (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == graduatorPositionManager || a == address(feePolicy) || a == address(buybackVault)"""
new="""            || a == graduatorPositionManager || a == address(feePolicy)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f72 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore
echo
echo "############ 73. the factory forgets the quote asset (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == quoteToken || a == BASE_PERMIT2 || registry.isRegistered(a);"""
new="""            || a == BASE_PERMIT2 || registry.isRegistered(a);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f73 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore
echo
echo "############ 74. the factory forgets Permit2 (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == quoteToken || a == BASE_PERMIT2 || registry.isRegistered(a);"""
new="""            || a == quoteToken || registry.isRegistered(a);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f74 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore
echo
echo "############ 75. the factory forgets registered launch tokens (creator and platform recipient)"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""            || a == quoteToken || a == BASE_PERMIT2 || registry.isRegistered(a);"""
new="""            || a == quoteToken || a == BASE_PERMIT2;"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f75 'PlatformRecipientIsAnyDeploymentContract|aLaunchForTheDeploymentsOwnContractsIsRefused|aLaunchForThePoolManagerIsRefused|aLaunchForAnyOtherContractOfTheDeploymentIsRefused|r9_C1_platformRecipientRefusesEveryOwnContract|r9_F2_creatorRefuses'
restore
echo
echo "############ 76. the factory does not ask the other launchers for their fee policy"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""_answers(other, ILauncherFeeEscrow.feePolicy.selector, want)"""
new="""false"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f76 'r9_F2_creatorRefusesQuotePermit2LaunchTokensAndOtherAssetsPolicyAndVault'
restore
echo
echo "############ 77. the factory does not ask the other launchers for their buyback vault"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""_answers(other, ILauncherFeeEscrow.buybackVault.selector, want)"""
new="""false"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f77 'r9_F2_creatorRefusesQuotePermit2LaunchTokensAndOtherAssetsPolicyAndVault'
restore
echo
echo "############ 78. the factory asks the other launchers without a gas bound"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""let ok := staticcall(20000, target, 0, 4, 0, 32)"""
new="""let ok := staticcall(gas(), target, 0, 4, 0, 32)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f78 'r9_F1_aGasBurningOrHugeReplyLauncherDoesNotStopLaunches'
restore
echo
echo "############ 79. an unreadable launcher is refused instead of skipped"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""hit := and(and(ok, eq(returndatasize(), 32)), eq(mload(0), want))"""
new="""hit := or(iszero(ok), and(eq(returndatasize(), 32), eq(mload(0), want)))"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f79 'r9_F7_anUnreadableLauncherIsSkippedNotRefused'
restore
echo
echo "############ 80. a dirty word over the creator is read as the creator"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""hit := and(and(ok, eq(returndatasize(), 32)), eq(mload(0), want))"""
new="""hit := and(and(ok, eq(returndatasize(), 32)), eq(and(mload(0), 0xffffffffffffffffffffffffffffffffffffffff), want))"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f80 'r9_F7_anUnreadableLauncherIsSkippedNotRefused'
restore
echo
echo "############ 81. withdrawLaunchFeesTo sends ether to the factory itself"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (to == address(this) || to == quoteToken || to == BASE_WETH) revert DestinationKeepsNoEther(to);"""
new="""if (to == quoteToken || to == BASE_WETH) revert DestinationKeepsNoEther(to);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f81 'r9_F3_withdrawLaunchFeesToRefusesWethQuoteAndSelf'
restore
echo
echo "############ 82. withdrawLaunchFeesTo sends ether to the quote asset"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (to == address(this) || to == quoteToken || to == BASE_WETH) revert DestinationKeepsNoEther(to);"""
new="""if (to == address(this) || to == BASE_WETH) revert DestinationKeepsNoEther(to);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f82 'r9_F3_withdrawLaunchFeesToRefusesWethQuoteAndSelf'
restore
echo
echo "############ 83. withdrawLaunchFeesTo sends ether to WETH"
python3 - <<'EOF'
import io
p="src/curb/CurbLaunchFactory.sol"; s=io.open(p,encoding="utf-8").read()
old="""if (to == address(this) || to == quoteToken || to == BASE_WETH) revert DestinationKeepsNoEther(to);"""
new="""if (to == address(this) || to == quoteToken) revert DestinationKeepsNoEther(to);"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f83 'r9_F3_withdrawLaunchFeesToRefusesWethQuoteAndSelf'
restore

# 84-91: A RECORD NAMES ITS OWN CURVE (the curve-reuse theft of the
# 2026-10-08 audit). Each question register() asks of the curve, the one-curve-
# one-record rule and the read's bounds, broken on its own; then all of it.
echo
echo "############ 84. the registry does not ask the curve for its token"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        _requireCurveSays(curve, IRegisteredCurve.token.selector, launchToken);
"""
new=""""""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f84 'test_pathB_aLauncherCannotGraduateALiveCurveUnderItsOwnToken|test_pathA_aLauncherCannotRedirectALiveCurvesCreatorIncome|test_register_eachQuestionIsAskedOfTheCurve'
restore
echo
echo "############ 85. the registry does not ask the curve for its asset"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        _requireCurveSays(curve, IRegisteredCurve.pairToken.selector, launch.quoteToken);
"""
new=""""""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f85 'test_register_eachQuestionIsAskedOfTheCurve'
restore
echo
echo "############ 86. the registry does not ask the curve for its factory"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        _requireCurveSays(curve, IRegisteredCurve.factory.selector, ILauncherWiring(msg.sender).graduator());
"""
new=""""""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f86 'test_register_eachQuestionIsAskedOfTheCurve'
restore
echo
echo "############ 87. the registry lets two records name one curve"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        if (launchOfCurve[curve] != address(0)) revert CurveAlreadyRegistered(curve, launchOfCurve[curve]);
"""
new=""""""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f87 'test_register_aCurveIsNamedByOneRecordOnly'
restore
echo
echo "############ 88. the registry does not write the curve down"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        launchOfCurve[curve] = launchToken;
"""
new=""""""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f88 'test_register_aCurveIsNamedByOneRecordOnly|test_register_theFactorysOwnLaunchWritesItsCurveDown'
restore
echo
echo "############ 89. the registry asks the curve without a gas bound"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""            let ok := staticcall(20000, curve, 0, 4, 0, 32)"""
new="""            let ok := staticcall(gas(), curve, 0, 4, 0, 32)"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f89 'test_register_aCurveThatWillNotAnswerIsRefused'
restore
echo
echo "############ 90. a dirty word over the right address is read as the address"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""            hit := and(and(ok, eq(returndatasize(), 32)), eq(mload(0), word))"""
new="""            hit := and(and(ok, eq(returndatasize(), 32)), eq(and(mload(0), 0xffffffffffffffffffffffffffffffffffffffff), word))"""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f90 'test_register_aCurveThatWillNotAnswerIsRefused'
restore
echo
echo "############ 91. no binding at all: the audit's theft, unfixed"
python3 - <<'EOF'
import io
p="src/curb/LaunchRegistry.sol"; s=io.open(p,encoding="utf-8").read()
old="""        _requireCurveSays(curve, IRegisteredCurve.token.selector, launchToken);
        _requireCurveSays(curve, IRegisteredCurve.pairToken.selector, launch.quoteToken);
        _requireCurveSays(curve, IRegisteredCurve.factory.selector, ILauncherWiring(msg.sender).graduator());
        if (launchOfCurve[curve] != address(0)) revert CurveAlreadyRegistered(curve, launchOfCurve[curve]);
"""
new=""""""
assert s.count(old)==1
io.open(p,"w",encoding="utf-8",newline="\n").write(s.replace(old,new,1))
EOF
run f91 'test_pathB_aLauncherCannotGraduateALiveCurveUnderItsOwnToken|test_pathA_aLauncherCannotRedirectALiveCurvesCreatorIncome'
restore

echo
echo "############ restored:"
trap - EXIT
diff -q "$SNAP/factory.sol" "$F" && diff -q "$SNAP/registry.sol" "$R" && diff -q "$SNAP/hook.sol" "$H" \
  && diff -q "$SNAP/graduator.sol" "$G" && echo "  all four contracts are byte-identical to the snapshot"
[ "$FAILED" = 0 ] || { echo "  $FAILED VERDICT(S) FAILED - read them above"; exit 1; }
if [ "$SKIPPED" -gt 0 ]; then
  echo "  every mutant run was caught and the baseline was green; $SKIPPED were skipped (MUT_ONLY) and have no verdict here"
else
  echo "  every mutant was caught and the baseline was green"
fi
