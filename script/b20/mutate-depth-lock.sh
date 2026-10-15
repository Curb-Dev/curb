#!/usr/bin/env bash
# DOES THE LOCK FIX IN measure-depth.sh ACTUALLY HOLD ANYTHING UP?
#
#   bash script/b20/mutate-depth-lock.sh
#
# The fix has two guards and they catch different things. A fix that is never
# exercised is a comment, so each guard is deleted in turn and the run is
# repeated: if the behaviour does not change, that guard was decoration.
#
# THE WORKING TREE IS SNAPSHOTTED TO /tmp AND RESTORED FROM THERE.
# An earlier harness in this repo used `git checkout --` to undo a mutation and
# destroyed two uncommitted contracts, because a stale index restored them from
# HEAD instead of from the working tree. Never `git checkout` to undo a
# mutation.
#
# NO NODE IS STARTED. Every case below is decided before base-anvil is reached,
# so the script is run with a lock already planted and it exits on the claim.
set -uo pipefail
cd "$(dirname "$0")/../.."

SCRIPT=script/b20/measure-depth.sh
SNAP=$(mktemp -d)
LOCK=/tmp/curb-node-8553.lock
cp "$SCRIPT" "$SNAP/original"

restore() { cp "$SNAP/original" "$SCRIPT"; }
trap 'restore; rm -rf "$SNAP"' EXIT

plant() { rm -rf "$LOCK"; mkdir -p "$LOCK"; echo "somebody-else" > "${LOCK}/owner"; }
verdict() {   # verdict <case> <expected: kept|deleted>
  local got
  if [ -f "${LOCK}/owner" ] && [ "$(cat "${LOCK}/owner")" = "somebody-else" ]; then
    got=kept
  else
    got=deleted
  fi
  if [ "$got" = "$2" ]; then
    echo "  $1: $got  (expected $got)  OK"
  else
    echo "  $1: $got  (expected $2)  *** THIS MUTATION CHANGED NOTHING - the guard is not load-bearing ***"
  fi
  rm -rf "$LOCK"
}

echo "=== 0. the fix as written: a refused run must leave the incumbent alone ==="
plant
bash "$SCRIPT" >/dev/null 2>&1
verdict "unmutated" kept

echo
echo "=== 1. delete the HELD guard, foreign lock. EXPECTED TO SURVIVE ANYWAY -"
echo "       the owner check alone already refuses, because the planted lock"
echo "       does not carry this run's id. This case is here to show WHICH"
echo "       guard is doing the work, and it is not this one ==="
restore
python3 - <<'PY'
import io
p = "script/b20/measure-depth.sh"
s = io.open(p, encoding="utf-8").read()
s = s.replace('if [ "$HELD" = 1 ] && [ -d "$LOCK" ]; then', 'if [ -d "$LOCK" ]; then', 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
PY
plant
bash "$SCRIPT" >/dev/null 2>&1
verdict "HELD deleted, foreign lock" kept

echo
echo "=== 1b. the case the HELD guard is actually for: a STALE lock carrying the"
echo "        SAME run id this run computes for itself. It cannot happen now -"
echo "        the id carries the process start time too - so it is forced here"
echo "        by pinning the id, which is what makes the guard testable ==="
restore
python3 - <<'PY'
import io, re
p = "script/b20/measure-depth.sh"
s = io.open(p, encoding="utf-8").read()
s = re.sub(r'^RUN=.*$', 'RUN="depth-pinned-for-the-mutation"', s, count=1, flags=re.M)
s = s.replace('if [ "$HELD" = 1 ] && [ -d "$LOCK" ]; then', 'if [ -d "$LOCK" ]; then', 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
PY
rm -rf "$LOCK"; mkdir -p "$LOCK"; echo "depth-pinned-for-the-mutation" > "${LOCK}/owner"
bash "$SCRIPT" >/dev/null 2>&1
if [ -d "$LOCK" ]; then
  echo "  id pinned, HELD deleted: kept  (expected deleted)  *** not load-bearing even here ***"
else
  echo "  id pinned, HELD deleted: deleted  (expected deleted)  OK"
fi
rm -rf "$LOCK"

echo
echo "=== 1c. the same stale lock, with HELD back in place ==="
restore
python3 - <<'PY'
import io, re
p = "script/b20/measure-depth.sh"
s = io.open(p, encoding="utf-8").read()
s = re.sub(r'^RUN=.*$', 'RUN="depth-pinned-for-the-mutation"', s, count=1, flags=re.M)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
PY
rm -rf "$LOCK"; mkdir -p "$LOCK"; echo "depth-pinned-for-the-mutation" > "${LOCK}/owner"
bash "$SCRIPT" >/dev/null 2>&1
if [ -d "$LOCK" ]; then
  echo "  id pinned, HELD present: kept  (expected kept)  OK"
else
  echo "  id pinned, HELD present: deleted  (expected kept)  *** HELD did not hold ***"
fi
rm -rf "$LOCK"

echo
echo "=== 2. delete the owner comparison, keeping HELD - a lock we DID take but"
echo "       that somebody else now owns ==="
restore
python3 - <<'PY'
import io
p = "script/b20/measure-depth.sh"
s = io.open(p, encoding="utf-8").read()
old = """    owner=$(cat "${LOCK}/owner" 2>/dev/null || true)
    if [ "$owner" = "$RUN" ]; then
      rm -rf "$LOCK"
    else
      echo "NOT releasing ${LOCK}: it says ${owner:-<unreadable>}, we are ${RUN}" >&2
    fi"""
assert s.count(old) == 1
io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, '    rm -rf "$LOCK"', 1))
PY
# This one needs the lock to be STOLEN while the run holds it, which is the
# only way HELD=1 and the owner is somebody else at the same time. The run is
# started, its claim is overwritten, and it is then stopped.
rm -rf "$LOCK"
bash "$SCRIPT" >/dev/null 2>&1 &
RUNPID=$!
for _ in $(seq 1 100); do [ -f "${LOCK}/owner" ] && break; sleep 0.1; done
echo "somebody-else" > "${LOCK}/owner"
kill "$RUNPID" 2>/dev/null
wait "$RUNPID" 2>/dev/null
sleep 1
verdict "owner check deleted" deleted

echo
echo "=== 3. the same theft, against the fix as written ==="
restore
rm -rf "$LOCK"
bash "$SCRIPT" >/dev/null 2>&1 &
RUNPID=$!
for _ in $(seq 1 100); do [ -f "${LOCK}/owner" ] && break; sleep 0.1; done
echo "somebody-else" > "${LOCK}/owner"
kill "$RUNPID" 2>/dev/null
wait "$RUNPID" 2>/dev/null
sleep 1
verdict "unmutated, lock stolen" kept

echo
echo "=== 4. and the lock is still RELEASED on a clean exit, or the next run"
echo "       could never start ==="
restore
rm -rf "$LOCK"
if bash "$SCRIPT" >/dev/null 2>&1; then
  if [ -d "$LOCK" ]; then
    echo "  clean exit: lock LEFT BEHIND  *** the fix leaks ***"
    rm -rf "$LOCK"
  else
    echo "  clean exit: lock released  OK"
  fi
else
  echo "  clean exit: the run itself failed - cannot judge the release"
  rm -rf "$LOCK"
fi

echo
echo "restored from the snapshot; git diff should be empty for $SCRIPT"
