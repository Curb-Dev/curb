#!/usr/bin/env bash
# DO THE COST TESTS ACTUALLY HOLD THE SCREEN UP?
#
#   bash script/b20/mutate-cost-display.sh
#
# The cost line is the one number a person reads before signing, so the tests
# for it have to go red when it is wrong. Ways it could be wrong are put into
# web/app.js in turn, and the NAMED cost test must be the thing that fails.
#
#   FIXED PERCENTAGE   the arithmetic stays right and the screen prints 0.00%.
#                      An earlier version of those tests compared the FUNCTION's
#                      result and then asked only whether the page contained
#                      some percentage - this mutation passed it.
#   INVERTED MID       the pool's price is read with the two currencies the
#                      wrong way round, so the reference is its own reciprocal.
#                      The arithmetic is untouched. An earlier version took its
#                      reference off the app's own quote object, so it would
#                      have made the same mistake and agreed.
#
#   CONVERSION BPS     the swap between ETH and a pair's asset is checked
#                      against Chainlink (app.js withConversion), and its
#                      shortfall is written ten times too small: 33% reads as
#                      3%, nothing is warned and nothing past half is refused.
#                      Case 4, against router.spec's check of the ETH buy.
#   SALE'S SIDES       the same check with a sale's two sides the buy's way
#                      round: what the sale pays in ETH is taken as what goes
#                      in, so a sale losing most of its value reads as a gain.
#                      Case 5, against router.spec's check of the router sale.
#
# AND THE REPORTER IS TESTED TOO, which is case 3. Playwright's line reporter
# prints the name of every test it RUNS, passing ones included, so grepping the
# log for the target's name says nothing about whether the target failed - a
# broken unrelated test would have read as a catch. The verdict comes from the
# JSON report and from that one spec's own status.
#
# THIS SCRIPT EDITS SOURCE FILES IN PLACE, so every path through it is written
# around one question: can it lose the original? Never `git checkout` to undo a
# mutation - an earlier harness in this repo did, and a stale index restored two
# uncommitted contracts from HEAD instead of from the working tree.
#
# THE WHOLE SUITE RUNS EACH TIME, which is slow and unavoidable: these tests are
# serial and need the launches the ones before them create, so a -g filter fails
# for want of a page rather than for the reason being tested. Cases 4 and 5 are
# the exception: router.spec's conversion tests make the launch they trade, so
# each runs alone with -g - and the control, which runs everything, must have
# passed both of them for their verdicts to mean anything.
set -uo pipefail
cd "$(dirname "$0")/../.."

# ALL FOUR OVERRIDABLE, so the failure paths below can be tested with wrong
# values and against throwaway copies - the same reason script/b20/env.sh makes
# its fork block overridable. Nothing but a test should set them.
#
# The workdir is a relative path on purpose: mktemp -d hands back a Git Bash
# path like /tmp/tmp.XXXX, and this harness drives playwright and python on the
# WINDOWS side, where that is not a path at all.
APP=${MUTCOST_APP:-web/app.js}
SPEC=${MUTCOST_SPEC:-web/e2e/app.spec.js}
SNAP=${MUTCOST_WORKDIR:-web/e2e/.mut}
LOCK=${MUTCOST_LOCK:-web/e2e/.mut.lock}
MUT="$SNAP/mutate.py"

# WHERE A FAILED CASE'S RECORDS SURVIVE.
#
# $SNAP is deleted on the way out, reports and all. That is right for a clean
# run and wrong for a failed one: when the control case went red, the only
# thing left was the count of tests, and which test had failed - and why - was
# gone with the log. A later green run does not answer that question either.
#
# So a case that fails gets its log and its JSON report copied OUT of $SNAP,
# into a folder named after the run, before anything is cleaned up. This adds
# a copy and nothing else: restoring the sources and releasing the claim are
# untouched, and a failure to keep the records never becomes a failure to put
# the originals back.
KEEP_ROOT=${MUTCOST_KEEPDIR:-web/e2e/.mut-failed}
KEPT=""

# THE INTERPRETER IS RESOLVED BEFORE THE CLAIM IS TAKEN.
#
# This harness drives playwright, so it runs on the Windows side where the
# interpreter is `python`; the fork harnesses run under WSL where it is
# `python3`. Hardcoding python3 once made both mutations fail to apply - and the
# suite then passed, which the checks below read correctly as "the mutation
# changed nothing" rather than as a pass.
#
# IT IS CHECKED FIRST so a machine with no python never takes the claim at all.
# `${VAR-default}` rather than `${VAR:-default}`: an explicitly empty override
# has to stay empty, or this path could not be tested.
PY=${MUTCOST_PYTHON-$(command -v python3 || command -v python)}
if [ -z "${PY:-}" ]; then
  echo "FAIL: no python on PATH; the mutations cannot be applied." >&2
  echo "      Nothing was claimed and nothing was touched." >&2
  exit 1
fi

# THE CLAIM COMES FIRST, BEFORE ANY DELETE AND BEFORE ANY COPY.
#
# Two runs at once is not a slow build, it is lost work: the second run's
# `rm -rf "$SNAP"` deletes the first run's only copy of the originals, and then
# both mutate the same two files. Whichever finishes last restores whatever it
# happened to snapshot - which by then is a mutated file.
#
# A RUN-SPECIFIC FOLDER DOES NOT FIX THAT. The folder is not the shared thing;
# the sources are. So the claim is on the WORK, taken atomically with mkdir -
# which either creates the directory or fails, with no window between looking
# and taking - and a refused run exits having touched nothing at all.
#
# Same discipline, and the same reasons, as the node claim in start-node.sh.
RUN="mutcost-$$-$(date +%s)"
HELD=0
BACKUP_OK=0
# AND WHETHER THE WORKDIR IS OURS TO DELETE. It is not the same question as
# whether we hold the claim: a run that died left its originals in there, and
# this run takes a fresh claim over them. Removing $SNAP on the way out would
# then destroy the only copies of somebody else's sources - which is what the
# self-test caught the first version of this doing.
SNAP_MINE=0

# RESTORING IS A WRITE, so it is gated on the same two things every other write
# here is: we still own the claim, and there is a backup we VERIFIED.
#
#   `-f` IS NOT ENOUGH. A copy interrupted halfway leaves a file that exists and
#   is truncated. Restoring from it would overwrite a good source with a partial
#   one - the exact loss this harness is supposed to make impossible - so the
#   gate is a flag set only after both copies were made AND compared, never the
#   presence of the files.
we_still_own() {
  [ "$(cat "$LOCK/owner" 2>/dev/null || true)" = "$RUN" ]
}

restore_from_backup() {
  # OWNERSHIP IS CHECKED HERE, not only in cleanup. Putting the originals back
  # is a write like any other, and this function has two callers: cleanup, on
  # the way out, and restore, between cases. Only the first one used to ask who
  # owns the claim - so a run that had lost it would still copy its backups over
  # the CURRENT owner's working files on its way into the next case.
  we_still_own || {
    echo "  refusing to restore: the claim is not ours any more" >&2
    return 1
  }
  [ "$BACKUP_OK" = 1 ] || {
    echo "  refusing to restore: no verified backup was ever taken" >&2
    return 1
  }
  cp "$SNAP/app.original" "$APP" || return 1
  cp "$SNAP/spec.original" "$SPEC" || return 1
  # And the restore is checked too. A cp that reports success and leaves a short
  # file is the same loss arriving from the other side.
  cmp -s "$SNAP/app.original" "$APP" || return 1
  cmp -s "$SNAP/spec.original" "$SPEC" || return 1
  return 0
}

cleanup() {
  [ "$HELD" = 1 ] || return 0
  owner=$(cat "$LOCK/owner" 2>/dev/null || true)
  if [ "$owner" != "$RUN" ]; then
    echo "NOT restoring and NOT releasing: ${LOCK} says ${owner:-<unreadable>}," >&2
    echo "we are ${RUN}. Somebody else owns these files now." >&2
    return 0
  fi
  if [ "$BACKUP_OK" != 1 ]; then
    # No verified backup means no mutation was ever applied, so there is
    # nothing to put back. Release the claim, and remove the workdir ONLY if
    # this run is the one that made it.
    [ "$SNAP_MINE" = 1 ] && rm -rf "$SNAP"
    rm -rf "$LOCK"
    return 0
  fi
  if restore_from_backup; then
    rm -rf "$SNAP" "$LOCK"
  else
    # THE BACKUPS STAY, AND SO DOES THE CLAIM. The sources are in an unknown
    # state; deleting the only good copies of them, or letting the next run
    # mutate them, would turn a failed restore into a permanent one.
    echo "FAIL: could not put the originals back." >&2
    echo "      The backups in ${SNAP} are KEPT, and so is ${LOCK} - the next" >&2
    echo "      run must not mutate files in an unknown state. By hand:" >&2
    echo "        cp ${SNAP}/app.original ${APP}" >&2
    echo "        cp ${SNAP}/spec.original ${SPEC}" >&2
    echo "        rm -rf ${SNAP} ${LOCK}" >&2
    exit 1
  fi
}

if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/owner" 2>/dev/null || true)
  echo "FAIL: this harness is already claimed by ${holder:-<a run still taking it>}." >&2
  echo "      Not touching ${APP} or ${SPEC}, and not removing anything." >&2
  echo "      If no run is going, remove ${LOCK} by hand." >&2
  exit 1
fi
echo "$RUN" > "$LOCK/owner"
HELD=1
# THE TRAP GOES ON AS SOON AS THERE IS SOMETHING TO CLEAN UP. It used to be
# installed after the backups were taken, so a failure in between - the
# interpreter check, a copy that would not write - left the claim behind for
# the next run to trip over.
trap cleanup EXIT
# ANNOUNCED so a caller can tell this run's claim from somebody else's. The
# self-test needs that to know whether a lock it finds afterwards is a leak it
# caused or a run that started in the meantime.
echo "claimed ${LOCK} as ${RUN}"

# A LEFTOVER BACKUP IS NOT RUBBISH TO SWEEP UP.
#
# The claim is fresh, so anything already in $SNAP came from a run that died
# without putting the sources back. `rm -rf` on it would throw away the only
# copies of those originals. Refuse instead, and say what to do.
if [ -e "$SNAP/app.original" ] || [ -e "$SNAP/spec.original" ]; then
  echo "FAIL: ${SNAP} already holds backups from a run that did not finish." >&2
  echo "      They may be the only copies of the originals, so they are being" >&2
  echo "      left alone. Check them, put them back if they are needed, and" >&2
  echo "      remove ${SNAP} before running this again." >&2
  exit 1
fi

# THE WORKING COPY IS MADE AND THEN VERIFIED. A mutation with no good original
# beside it is not a mutation, it is a loss: there would be nothing to put back.
rm -rf "$SNAP"
if ! mkdir -p "$SNAP" 2>/dev/null; then
  echo "FAIL: could not make the working directory ${SNAP}." >&2
  echo "      No mutation was applied." >&2
  exit 1
fi
SNAP_MINE=1
if ! cp "$APP" "$SNAP/app.original" || ! cp "$SPEC" "$SNAP/spec.original"; then
  echo "FAIL: could not copy the originals into ${SNAP}." >&2
  echo "      No mutation was applied." >&2
  exit 1
fi
if ! cmp -s "$APP" "$SNAP/app.original" || ! cmp -s "$SPEC" "$SNAP/spec.original"; then
  echo "FAIL: the backup does not match the file it was taken from." >&2
  echo "      No mutation was applied." >&2
  exit 1
fi
# ONLY NOW may anything be mutated, and only now may anything be restored.
BACKUP_OK=1

# Between cases, and it is FATAL. A restore that did not happen leaves a mutated
# file on disk; carrying on from there would run the next case against the last
# case's mutation and report the result as if it meant something.
restore() {
  restore_from_backup && return 0
  echo "FAIL: could not put the originals back between cases." >&2
  exit 1
}

PASS=0
FAILED=0
TARGET="the pool's cost line on screen matches the trade that happens, both directions"
# THE CONVERSION CHECK'S TWO TARGETS, in web/e2e/router.spec.js.
CONV_BUY_TARGET="the swap between ETH and the pair's asset is checked against Chainlink: past 15% it is warned strongly, past 50% nothing is sent"
CONV_SALE_TARGET="an NVDAc router sale is checked against Chainlink as a buy is: warned past 5% and 15%, refused past 50%, with the sale's own figure"

run_suite() {   # run_suite <tag> -> suite exit code on stdout
  local tag="$1"
  # The name is relative to web/e2e, which is where playwright runs.
  (cd web/e2e && PLAYWRIGHT_JSON_OUTPUT_NAME=".mut/$tag.json" \
     npx playwright test --reporter=line,json) >"$SNAP/$tag.log" 2>&1
  echo $?
}

# ONE TEST OF ONE SPEC, by its whole title - for the cases whose target makes
# its own launch. The title goes to -g as a regex, so its specials are escaped.
run_one() {   # run_one <tag> <spec> <title> -> exit code on stdout
  local tag="$1" spec="$2" re
  re=$(printf '%s' "$3" | sed 's/[][\.*^$?+(){}|/]/\\&/g')
  (cd web/e2e && PLAYWRIGHT_JSON_OUTPUT_NAME=".mut/$tag.json" \
     npx playwright test "$spec" -g "$re" --reporter=line,json) >"$SNAP/$tag.log" 2>&1
  echo $?
}

target_status() {   # target_status <tag> [title] - the cost test unless another is named
  "$PY" script/b20/e2e_report_status.py "${2:-$TARGET}" "$SNAP/$1.json" 2>/dev/null || echo unreadable
}

keep_evidence() {   # keep_evidence <tag>
  local tag="$1" dest="$KEEP_ROOT/$RUN" kept=0
  if ! mkdir -p "$dest" 2>/dev/null; then
    echo "          could not make ${dest}; the records are lost when this run ends" >&2
    return 1
  fi
  for f in "$SNAP/$tag.log" "$SNAP/$tag.json"; do
    if [ ! -f "$f" ]; then
      echo "          no $(basename "$f") was written - nothing to keep"
    elif cp "$f" "$dest/" 2>/dev/null; then
      kept=$((kept + 1))
    else
      echo "          could not copy $(basename "$f") into ${dest}" >&2
    fi
  done
  [ "$kept" = 0 ] && return 1
  KEPT="$dest"
  echo "          kept for reading: ${dest}"
  return 0
}

verdict() {   # verdict <name> <tag> <rc> <expected suite: green|red> <expected target status> [target title]
  local name="$1" tag="$2" rc="$3" wantSuite="$4" wantTarget="$5" title="${6:-$TARGET}"
  local sawSuite="green" sawTarget
  [ "$rc" = 0 ] || sawSuite="red"
  sawTarget=$(target_status "$tag" "$title")
  if [ "$sawSuite" = "$wantSuite" ] && [ "$sawTarget" = "$wantTarget" ]; then
    echo "  PASS  $name: suite $sawSuite, target $sawTarget"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name: suite $sawSuite (wanted $wantSuite), target $sawTarget (wanted $wantTarget)"
    grep -E "[0-9]+ (passed|failed)" "$SNAP/$tag.log" | tail -3 | sed 's/^/          /'
    keep_evidence "$tag" || true
    FAILED=$((FAILED + 1))
  fi
}

echo "=== 0. the control: no mutation. Green, and the target passed ==="
restore
rc=$(run_suite control)
verdict "control" control "$rc" green passed
# AND THE CONVERSION TARGETS PASSED IN IT, or cases 4 and 5 prove nothing.
verdict "control, the conversion check of a buy" control "$rc" green passed "$CONV_BUY_TARGET"
verdict "control, the conversion check of a sale" control "$rc" green passed "$CONV_SALE_TARGET"

echo
echo "=== 1. THE SCREEN LIES WHILE THE ARITHMETIC IS FINE: every cost row"
echo "       prints 0.00%, and nothing else changes ==="
restore
cat > "$MUT" <<'MUTPY'
import io
p = "web/app.js"
s = io.open(p, encoding="utf-8").read()
pairs = [
    ('"<strong>" + (costBps / 100).toFixed(2) + "%</strong> against mid"',
     '"<strong>0.00%</strong> against mid"'),
    ('"<strong>" + (costBps / 100).toFixed(2) + "%</strong> against the curve\'s mid"',
     '"<strong>0.00%</strong> against the curve\'s mid"'),
]
for a, b in pairs:
    assert s.count(a) == 1, "mutation target moved: " + a[:60]
    s = s.replace(a, b, 1)
io.open(p, "w", encoding="utf-8").write(s)
print("  applied: every cost row prints 0.00%")
MUTPY
"$PY" "$MUT" || { echo "  FAIL  mutation 1 could not be applied - not running the suite"; exit 1; }
rc=$(run_suite fixed)
verdict "fixed 0.00%" fixed "$rc" red failed

echo
echo "=== 2. THE WRONG MID IS CARRIED: the pool's price is read with the two"
echo "       currencies the wrong way round, which is its own reciprocal ==="
restore
cat > "$MUT" <<'MUTPY'
import io
p = "web/app.js"
s = io.open(p, encoding="utf-8").read()
old = "    expected = poolAtMid(P, v.tokenIsC0, v.side, v.amount);"
new = ("    // MUTATION: the currencies the wrong way round, so the reference is\n"
       "    // the reciprocal of the real mid. A test that took its reference\n"
       "    // from the app's own quote object would make the same mistake.\n"
       "    expected = poolAtMid(P, !v.tokenIsC0, v.side, v.amount);")
assert s.count(old) == 1, "mutation target moved"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
print("  applied: the direct route prices against an inverted mid")
MUTPY
"$PY" "$MUT" || { echo "  FAIL  mutation 2 could not be applied - not running the suite"; exit 1; }
rc=$(run_suite mid)
verdict "inverted mid" mid "$rc" red failed

echo
echo "=== 3. THE REPORTER'S OWN TEST. app.js is left alone and a deliberately"
echo "       failing test is appended to the spec. The suite goes red while the"
echo "       cost test PASSES - and that must NOT read as a mutation caught ==="
restore
cat > "$MUT" <<'MUTPY'
import io
p = "web/e2e/app.spec.js"
s = io.open(p, encoding="utf-8").read()
s += '\n\ntest("an unrelated test that fails on purpose", async () => {\n'
s += '  expect(1, "planted by mutate-cost-display.sh case 3").toBe(2);\n});\n'
io.open(p, "w", encoding="utf-8").write(s)
print("  applied: one unrelated failing test appended, app.js untouched")
MUTPY
"$PY" "$MUT" || { echo "  FAIL  case 3 could not be applied - not running the suite"; exit 1; }
rc=$(run_suite unrelated)
verdict "unrelated failure is not a catch" unrelated "$rc" red passed

echo
echo "=== 4. THE CONVERSION'S SHORTFALL TEN TIMES TOO SMALL: the swap between"
echo "       ETH and the pair's asset, checked against Chainlink, reads 33% as 3% ==="
restore
cat > "$MUT" <<'MUTPY'
import io
p = "web/app.js"
s = io.open(p, encoding="utf-8").read()
old = "const bps = got >= given ? 0 : Math.round((1 - got / given) * 10000);"
new = "const bps = got >= given ? 0 : Math.round((1 - got / given) * 1000);"
assert s.count(old) == 1, "mutation target moved"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
print("  applied: the conversion's basis points are a tenth of what they are")
MUTPY
"$PY" "$MUT" || { echo "  FAIL  mutation 4 could not be applied - not running the test"; exit 1; }
rc=$(run_one convbps router.spec.js "$CONV_BUY_TARGET")
verdict "conversion bps a tenth" convbps "$rc" red failed "$CONV_BUY_TARGET"

echo
echo "=== 5. A SALE'S SIDES THE BUY'S WAY ROUND: what the sale pays in ETH is"
echo "       taken as what goes into the swap ==="
restore
cat > "$MUT" <<'MUTPY'
import io
p = "web/app.js"
s = io.open(p, encoding="utf-8").read()
old = "  const given = buy ? ethUsd : qUsd;\n  const got = buy ? qUsd : ethUsd;\n"
new = "  const given = ethUsd;\n  const got = qUsd;\n"
assert s.count(old) == 1, "mutation target moved"
io.open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
print("  applied: a sale's conversion compares its two sides the buy's way round")
MUTPY
"$PY" "$MUT" || { echo "  FAIL  mutation 5 could not be applied - not running the test"; exit 1; }
rc=$(run_one convsides router.spec.js "$CONV_SALE_TARGET")
verdict "a sale's sides swapped" convsides "$rc" red failed "$CONV_SALE_TARGET"

restore
echo
echo "${PASS} passed, ${FAILED} failed."
if [ -n "$KEPT" ]; then
  echo "the failed cases' logs and JSON reports are in ${KEPT}"
  echo "  they are NOT removed by this harness - read them, then delete them yourself"
fi
[ "$FAILED" = 0 ] || exit 1
