#!/usr/bin/env bash
# DOES THE MUTATION HARNESS ITSELF BEHAVE?
#
#   bash script/b20/selftest-mutate-harness.sh
#
# Two things the harness has to get right before anything it reports means
# anything, and neither needs a browser - this runs in seconds.
#
#   THE REPORT PARSER. It has to tell passed from skipped, from timedOut, from
#   interrupted, from missing. An earlier version collapsed everything that was
#   not "failed" into "passed" as long as a result existed - and in serial mode
#   every spec after a failure is SKIPPED, so a mutation that broke an earlier
#   test would have had its target reported as passed.
#
#   THE LOCK. The harness edits web/app.js and web/e2e/app.spec.js in place and
#   keeps the originals beside them. Two runs at once would have the second
#   delete the first's backups and then mutate the same files - losing the
#   originals for good. A second run must be refused BEFORE it touches
#   anything, which is what the atomic claim is for.
set -uo pipefail
cd "$(dirname "$0")/../.."

PY=$(command -v python3 || command -v python) || true
if [ -z "${PY:-}" ]; then echo "FAIL: no python on PATH." >&2; exit 1; fi

PARSER=script/b20/e2e_report_status.py
# OVERRIDABLE so these checks can be pointed at a deliberately broken copy and
# shown to go red - the same reason script/b20/env.sh makes its fork block
# overridable. Nothing but a test should ever set it.
HARNESS=${MUTCOST_HARNESS:-script/b20/mutate-cost-display.sh}
LOCK=web/e2e/.mut.lock
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAILED=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAILED=$((FAILED + 1)); }

# ---------------------------------------------------------------------------
echo "=== 1. the report parser says what it saw, and does not round up ==="

report() {   # report <file> <json body of one spec's tests>
  cat > "$1" <<JSON
{"suites":[{"title":"app.spec.js","suites":[{"title":"inner","specs":[
  {"title":"the target","tests":[{"results":[$2]}]},
  {"title":"something else","tests":[{"results":[{"status":"passed"}]}]}
]}]}]}
JSON
}

expect_status() {   # expect_status <name> <file> <wanted>
  local got
  got=$("$PY" "$PARSER" "the target" "$2" 2>/dev/null)
  if [ "$got" = "$3" ]; then ok "$1 -> $got"; else bad "$1 -> got '$got', wanted '$3'"; fi
}

report "$WORK/passed.json" '{"status":"passed"}'
expect_status "a passing spec" "$WORK/passed.json" passed

report "$WORK/failed.json" '{"status":"failed"}'
expect_status "a failing spec" "$WORK/failed.json" failed

# THE ONE THAT USED TO READ AS A PASS.
report "$WORK/skipped.json" '{"status":"skipped"}'
expect_status "a SKIPPED spec is not a pass" "$WORK/skipped.json" skipped

report "$WORK/timeout.json" '{"status":"timedOut"}'
expect_status "a TIMED OUT spec is not a pass" "$WORK/timeout.json" timedOut

report "$WORK/interrupted.json" '{"status":"interrupted"}'
expect_status "an INTERRUPTED spec is not a pass" "$WORK/interrupted.json" interrupted

report "$WORK/noresult.json" ''
expect_status "a spec with no result at all" "$WORK/noresult.json" no-result

report "$WORK/mixed.json" '{"status":"failed"},{"status":"passed"}'
expect_status "a spec that disagreed with itself" "$WORK/mixed.json" mixed:failed+passed

cat > "$WORK/missing.json" <<'JSON'
{"suites":[{"title":"app.spec.js","specs":[{"title":"someone else","tests":[{"results":[{"status":"passed"}]}]}]}]}
JSON
expect_status "a target that is not in the report" "$WORK/missing.json" missing

cat > "$WORK/dupe.json" <<'JSON'
{"suites":[
 {"title":"a","specs":[{"title":"the target","tests":[{"results":[{"status":"passed"}]}]}]},
 {"title":"b","specs":[{"title":"the target","tests":[{"results":[{"status":"failed"}]}]}]}
]}
JSON
expect_status "two specs with the same title" "$WORK/dupe.json" ambiguous

echo "not json at all" > "$WORK/broken.json"
expect_status "a report that will not parse" "$WORK/broken.json" unreadable

# AND THE HARNESS ONLY EVER ACCEPTS TWO OF THESE. If it ever compared against
# anything but passed/failed, a skip could satisfy a case.
wanted=$(grep -oE 'verdict "[^"]+" [a-z]+ "\$rc" (green|red) [a-zA-Z-]+' "$HARNESS" | awk '{print $NF}' | sort -u | tr '\n' ' ')
if [ "$wanted" = "failed passed " ]; then
  ok "the harness only ever expects passed or failed (saw: $wanted)"
else
  bad "the harness expects something other than passed/failed (saw: $wanted)"
fi

# ---------------------------------------------------------------------------
echo
echo "=== 2. a second run is refused before it touches anything ==="

sums() { "$PY" -c "
import hashlib
for f in ('web/app.js', 'web/e2e/app.spec.js'):
    print(hashlib.sha256(open(f,'rb').read()).hexdigest())
"; }

SUMS_BEFORE=$(sums)

# THE CLAIM IS TAKEN ATOMICALLY HERE TOO, and this file used to get it wrong:
# it asked `[ -d "$LOCK" ]` and then did `mkdir -p`. A real run starting in
# between would have had its owner file overwritten, its backups replaced with
# this file's fakes, and its claim deleted at the end - by the very test written
# to prove that cannot happen. mkdir without -p either creates the directory or
# fails, and a failure means somebody else is working.
STOLE=0
if mkdir "$LOCK" 2>/dev/null; then
  STOLE=1
  echo "selftest-$$" > "$LOCK/owner"
else
  echo "  SKIP  a run already holds $LOCK - not touching it, and not testing this"
fi

if [ "$STOLE" = 1 ]; then
  # Stand in for a run already under way: its backups, made only now that this
  # file holds the claim.
  mkdir -p web/e2e/.mut
  echo "FIRST RUN'S BACKUP OF app.js" > web/e2e/.mut/app.original
  echo "FIRST RUN'S BACKUP OF the spec" > web/e2e/.mut/spec.original

  out=$(bash "$HARNESS" 2>&1); rc=$?

  if [ "$rc" = 0 ]; then
    bad "the second run did not refuse"
  elif echo "$out" | grep -qi "claimed\|already"; then
    ok "the second run refused, and said why"
  else
    bad "the second run failed, but not with a claim message: $(echo "$out" | head -2)"
  fi

  if [ "$(cat "$LOCK/owner" 2>/dev/null)" = "selftest-$$" ]; then
    ok "the first run's claim survived"
  else
    bad "the second run took or destroyed the first run's claim"
  fi

  if grep -q "FIRST RUN'S BACKUP OF app.js" web/e2e/.mut/app.original 2>/dev/null &&
     grep -q "FIRST RUN'S BACKUP OF the spec" web/e2e/.mut/spec.original 2>/dev/null; then
    ok "the first run's backups survived"
  else
    bad "the second run deleted the first run's backups"
  fi

  # RELEASE ONLY WHAT THIS FILE OWNS.
  if [ "$(cat "$LOCK/owner" 2>/dev/null)" = "selftest-$$" ]; then
    rm -rf "$LOCK" web/e2e/.mut
  else
    bad "not releasing $LOCK: it is not ours any more"
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "=== 3. the early failure paths leave nothing behind ==="

# A LOCK THIS FILE FINDS IS NOT NECESSARILY A LOCK THIS FILE CAUSED.
#
# These cases used to remove any lock they saw on the way out. A real run
# starting after the check at the top of the section would have had its claim
# deleted out from under it - by the test written to prove that cannot happen.
# The harness announces its claim now ("claimed <lock> as <run>"), so a leak can
# be told from a stranger, and anything else is left exactly where it is.
claim_of() {   # claim_of <harness output> -> the RUN it announced, or nothing
  echo "$1" | sed -n 's/^claimed .* as \(.*\)$/\1/p' | tail -1
}

check_no_leak() {   # check_no_leak <name> <harness output>
  local name="$1" mine owner
  mine=$(claim_of "$2")
  if [ ! -d "$LOCK" ]; then ok "$name: no claim was left behind"; return; fi
  owner=$(cat "$LOCK/owner" 2>/dev/null || true)
  if [ -n "$mine" ] && [ "$owner" = "$mine" ]; then
    bad "$name: a claim was left behind"
    rm -rf "$LOCK"            # ours, by name. Safe to take back.
  else
    echo "  SKIP  $name: a lock appeared that is not ours (${owner:-<unreadable>}) - leaving it"
  fi
}

if [ -d "$LOCK" ]; then
  echo "  SKIP  a run holds $LOCK - not testing the failure paths"
else
  # NO INTERPRETER. The check happens before the claim is taken, so there is
  # nothing to release - and that is the point: it must not be left behind.
  out=$(MUTCOST_PYTHON= bash "$HARNESS" 2>&1); rc=$?
  if [ "$rc" != 0 ] && echo "$out" | grep -qi "no python"; then
    ok "no interpreter: refused, and said so"
  else
    bad "no interpreter: rc=$rc, said: $(echo "$out" | head -1)"
  fi
  check_no_leak "no interpreter" "$out"

  # THE WORKING COPY CANNOT BE MADE. The claim IS taken here, so this is the
  # case that proves the trap goes on before the backups rather than after: the
  # claim has to come back off on the way out.
  BLOCKER=$(mktemp -d)/blocker
  echo "not a directory" > "$BLOCKER"
  out=$(MUTCOST_WORKDIR="$BLOCKER/under-a-file" bash "$HARNESS" 2>&1); rc=$?
  if [ "$rc" != 0 ] && echo "$out" | grep -qi "working directory\|copy the originals\|does not match"; then
    ok "no working copy: refused before any mutation"
  else
    bad "no working copy: rc=$rc, said: $(echo "$out" | head -1)"
  fi
  check_no_leak "no working copy" "$out"
fi

# ---------------------------------------------------------------------------
echo
echo "=== 4-7. the ways a backup, or a source, can be lost ==="
#
# BOTH WORK ON THROWAWAY COPIES. The harness takes the files it mutates from
# MUTCOST_APP and MUTCOST_SPEC, so these cases can be as broken as they need to
# be without the real app.js ever being in reach.
SANDBOX=$(mktemp -d)
S_APP="$SANDBOX/app.js"
S_SPEC="$SANDBOX/spec.js"
S_WORK="$SANDBOX/work"
S_LOCK="$SANDBOX/lock"
printf 'THE REAL APP\n' > "$S_APP"
printf 'THE REAL SPEC\n' > "$S_SPEC"

sandboxed() {
  env MUTCOST_APP="$S_APP" MUTCOST_SPEC="$S_SPEC" \
      MUTCOST_WORKDIR="$S_WORK" MUTCOST_LOCK="$S_LOCK" bash "$HARNESS" 2>&1
}

# ---- 4. a backup from a run that died is not swept up ----------------------
mkdir -p "$S_WORK"
printf "THE DEAD RUN'S ONLY COPY\n" > "$S_WORK/app.original"
out=$(sandboxed); rc=$?
if [ "$rc" != 0 ] && echo "$out" | grep -qi "did not finish"; then
  ok "leftover backup: refused rather than deleting it"
else
  bad "leftover backup: rc=$rc, said: $(echo "$out" | head -1)"
fi
if grep -q "THE DEAD RUN'S ONLY COPY" "$S_WORK/app.original" 2>/dev/null; then
  ok "leftover backup: the dead run's copy is still there"
else
  bad "leftover backup: it was swept up"
fi
if [ ! -d "$S_LOCK" ]; then ok "leftover backup: the claim was released"
else bad "leftover backup: the claim was left behind"; rm -rf "$S_LOCK"; fi
rm -rf "$S_WORK" "$S_LOCK"

# ---- 5. a restore that cannot be written keeps the backups ----------------
#
# The backup is READABLE and the target is NOT WRITABLE, so the harness gets a
# verified backup and then cannot put it back. That is the case where the
# sources are in an unknown state and the backups are the only good copies
# there are: they must survive, the claim must survive with them, and the run
# must fail. It happens at the FIRST restore, before any browser runs.
chmod -w "$S_APP"
if cp "$S_SPEC" "$S_APP" 2>/dev/null; then
  echo "  SKIP  read-only files are not enforced here, so this case cannot run"
  chmod +w "$S_APP"
else
  out=$(sandboxed); rc=$?
  if [ "$rc" != 0 ] && echo "$out" | grep -qi "could not put the originals back"; then
    ok "failed restore: refused and said the backups are kept"
  else
    bad "failed restore: rc=$rc, said: $(echo "$out" | tail -1)"
  fi
  if grep -q "THE REAL APP" "$S_WORK/app.original" 2>/dev/null; then
    ok "failed restore: the backup survived"
  else
    bad "failed restore: the backup was deleted"
  fi
  if [ -d "$S_LOCK" ]; then
    ok "failed restore: the claim was kept, so the next run cannot mutate"
  else
    bad "failed restore: the claim was released over files in an unknown state"
  fi
  chmod +w "$S_APP"
fi
# ---------------------------------------------------------------------------
# THE NEXT TWO CASES INJECT THE FAULT INSTEAD OF WAITING FOR IT.
#
# Both need something to go wrong at an exact moment inside the harness: a copy
# that stops half way, and a claim that changes hands between two statements.
# Neither can be arranged from outside by timing - and a case that only
# sometimes happens is not evidence, it is a coin toss with a SKIP on one face.
#
# So `cp` and `cmp` are shadowed on PATH for these runs only. The harness calls
# both unqualified, so it picks up the stand-ins, which do the real thing by
# default and misbehave only where they are told to. This is the same tactic as
# faultproxy.py for RPC: break the one operation under test, pass everything
# else through, and write down what was actually done.
SHIM="$SANDBOX/shim"
SHIM_LOG="$SANDBOX/shim.log"
mkdir -p "$SHIM"
REAL_CP=$(command -v cp)
REAL_CMP=$(command -v cmp)

cat > "$SHIM/cp" <<EOF
#!/bin/sh
# Writes down every copy, so "nothing was restored" can be READ rather than
# guessed at from a file that happens to look unchanged.
echo "cp \$1 -> \$2" >> "\$SHIM_LOG"
if [ -n "\$SHIM_BREAK_DST" ] && [ "\$2" = "\$SHIM_BREAK_DST" ]; then
  head -c "\$SHIM_BREAK_BYTES" "\$1" > "\$2"
  echo "  half-wrote \$SHIM_BREAK_BYTES bytes of \$1 into \$2, then failed" >> "\$SHIM_LOG"
  echo "cp: error writing '\$2': injected short write" >&2
  exit 1
fi
exec $REAL_CP "\$@"
EOF

cat > "$SHIM/cmp" <<EOF
#!/bin/sh
# Counts comparisons, so a fault can be injected at a NAMED point in the
# harness rather than after a guessed number of milliseconds.
n=0
[ -f "\$SHIM_CMP_COUNT" ] && n=\$(cat "\$SHIM_CMP_COUNT")
n=\$((n + 1))
echo "\$n" > "\$SHIM_CMP_COUNT"
$REAL_CMP "\$@"; rc=\$?
if [ -n "\$SHIM_STEAL_AFTER_CMP" ] && [ "\$n" = "\$SHIM_STEAL_AFTER_CMP" ]; then
  echo "a-stranger" > "\$SHIM_STEAL_LOCK/owner"
  echo "  took the claim over after cmp #\$n" >> "\$SHIM_LOG"
fi
exit \$rc
EOF
# AND npx IS STOPPED FROM EVER REACHING THE REAL SUITE.
#
# A run that refuses never gets as far as the browser suite. A run with one of
# its guards removed does - and the suite starts a fork node of its own, which
# the kill at the 60s bound then leaves listening on 8549 with nobody to stop
# it. The next real run finds the port taken and refuses, which is how one
# mutation experiment cost a whole 20-minute end-to-end run.
#
# So npx blocks instead. The mutated run still carries on, still gets caught by
# the bound and by the assertions below, but no node is ever started - and it
# never reaches the case that rewrites the REAL web/app.js by name.
cat > "$SHIM/npx" <<'NPXEOF'
#!/bin/sh
echo "the self-test's npx: refusing to start a real browser suite" >&2
sleep 300
NPXEOF
chmod +x "$SHIM/cp" "$SHIM/cmp" "$SHIM/npx"

# BOTH CASES MUST STOP WITHIN SECONDS. A run that refuses gets no further than
# its first restore; one that does not refuse walks on into the browser suite,
# where the mutation scripts write to the REAL web/app.js by name. So the bound
# is an assertion in its own right, and it also stops a mutation of the harness
# from doing damage while it is being shown to fail.
must_have_stopped() {   # must_have_stopped <name> <rc>
  if [ "$2" = 124 ]; then
    bad "$1: it did not stop - still going after 60s, so it was carrying on"
  else
    ok "$1: it stopped straight away rather than carrying on"
  fi
}

no_source_was_written() {   # no_source_was_written <name>
  if grep -q -- "-> $S_APP\$" "$SHIM_LOG" || grep -q -- "-> $S_SPEC\$" "$SHIM_LOG"; then
    bad "$1: something was copied back over a source file"
    grep -- "-> $S_APP\$\|-> $S_SPEC\$" "$SHIM_LOG" | sed 's/^/          /'
  else
    ok "$1: no copy was made back over either source"
  fi
}

# ---- 6. a backup left half written is never restored from ------------------
#
# app.original is copied in full; spec.original gets 64 bytes of a ~4 KB file
# and then the copy errors. That is the state the harness has to survive, and
# it is the reason the gate is a FLAG set after both copies were compared and
# not a test that the two files exist: at this moment BOTH files DO exist, and
# a `-f` test would have called that a backup and copied the 64-byte stub back
# over the spec on the way out.
rm -rf "$S_WORK" "$S_LOCK"
printf 'THE REAL APP\n' > "$S_APP"
: > "$S_SPEC"
i=0; while [ "$i" -lt 200 ]; do printf 'THE REAL SPEC, LINE %03d\n' "$i" >> "$S_SPEC"; i=$((i + 1)); done
: > "$SHIM_LOG"
out=$(env PATH="$SHIM:$PATH" SHIM_LOG="$SHIM_LOG" \
    SHIM_BREAK_DST="$S_WORK/spec.original" SHIM_BREAK_BYTES=64 \
    MUTCOST_APP="$S_APP" MUTCOST_SPEC="$S_SPEC" \
    MUTCOST_WORKDIR="$S_WORK" MUTCOST_LOCK="$S_LOCK" timeout 60 bash "$HARNESS" 2>&1); rc=$?
must_have_stopped "half backup" "$rc"

if grep -q "half-wrote 64 bytes" "$SHIM_LOG"; then
  ok "half backup: the second backup really was left part written"
else
  bad "half backup: the injected short write never happened - case tested nothing"
fi
if [ "$rc" != 0 ] && echo "$out" | grep -qi "copy the originals"; then
  ok "half backup: refused, and said the originals could not be copied"
else
  bad "half backup: rc=$rc, said: $(echo "$out" | head -1)"
fi
if echo "$out" | grep -q "=== 0"; then
  bad "half backup: it went on to run a case with no verified backup"
else
  ok "half backup: it stopped before running anything"
fi
no_source_was_written "half backup"
if [ "$(cat "$S_APP")" = "THE REAL APP" ]; then
  ok "half backup: the app source is still what it was"
else
  bad "half backup: the app source was overwritten"
fi
if [ "$(wc -c < "$S_SPEC")" -gt 4000 ]; then
  ok "half backup: the spec source is still whole, not the 64-byte stub"
else
  bad "half backup: the spec source was replaced by the part-written backup"
fi
if [ ! -d "$S_LOCK" ]; then ok "half backup: the claim was released"
else bad "half backup: the claim was left behind"; rm -rf "$S_LOCK"; fi

# ---- 7. a claim taken over mid-run stops every write ------------------------
#
# The stranger's name lands in the lock at a fixed point: immediately after the
# SECOND backup is verified, which is the statement before the harness makes
# its first restore. From there the run owns nothing, and both of its writes
# have to stop - the restore between cases, and the restore on the way out.
# The stranger's claim and the backups must be exactly where they were, because
# releasing the claim would hand files in an unknown state to the next run and
# deleting the backups would throw away the only good copies of them.
rm -rf "$S_WORK" "$S_LOCK"
printf 'THE REAL APP\n' > "$S_APP"
printf 'THE REAL SPEC\n' > "$S_SPEC"
: > "$SHIM_LOG"
rm -f "$SANDBOX/cmpcount"
out=$(env PATH="$SHIM:$PATH" SHIM_LOG="$SHIM_LOG" \
    SHIM_CMP_COUNT="$SANDBOX/cmpcount" SHIM_STEAL_AFTER_CMP=2 SHIM_STEAL_LOCK="$S_LOCK" \
    MUTCOST_APP="$S_APP" MUTCOST_SPEC="$S_SPEC" \
    MUTCOST_WORKDIR="$S_WORK" MUTCOST_LOCK="$S_LOCK" timeout 60 bash "$HARNESS" 2>&1); rc=$?
must_have_stopped "takeover" "$rc"

if grep -q "took the claim over after cmp #2" "$SHIM_LOG"; then
  ok "takeover: the claim really did change hands mid-run"
else
  bad "takeover: the injection never fired - case tested nothing"
fi
if echo "$out" | grep -qi "not ours any more"; then
  ok "takeover: the restore between cases refused to write"
else
  bad "takeover: the restore between cases did not notice: $(echo "$out" | tail -2 | head -1)"
fi
if [ "$rc" != 0 ] && echo "$out" | grep -qi "NOT restoring and NOT releasing"; then
  ok "takeover: the restore on the way out refused too, and the run failed"
else
  bad "takeover: rc=$rc, on the way out it said: $(echo "$out" | tail -1)"
fi
no_source_was_written "takeover"
if [ "$(cat "$S_LOCK/owner" 2>/dev/null)" = "a-stranger" ]; then
  ok "takeover: the stranger's claim was left untouched"
else
  bad "takeover: the stranger's claim was taken back or deleted"
fi
if [ -f "$S_WORK/app.original" ] && [ -f "$S_WORK/spec.original" ]; then
  ok "takeover: the backups were kept"
else
  bad "takeover: a run that owned nothing deleted the backups"
fi

rm -rf "$SANDBOX"

SUMS_AFTER=$(sums)
if [ "$SUMS_BEFORE" = "$SUMS_AFTER" ]; then
  ok "web/app.js and the spec are byte for byte what they were"
else
  bad "a refused or aborted run modified a source file"
fi

echo
echo "${PASS} passed, ${FAILED} failed."
[ "$FAILED" = 0 ] || exit 1
