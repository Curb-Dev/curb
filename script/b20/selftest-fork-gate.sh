#!/usr/bin/env bash
# Does the fork gate check THE NODE THAT WILL BE DEPLOYED TO?
#
# It did not. verify-fork.sh read FORK_RPC out of env.sh - always
# 127.0.0.1:8546 - while demo-waiting.sh deployed to its own overridable $RPC.
# With the pinned node running on the default port, pointing RPC somewhere else
# verified node A and deployed to node B, and the gate reported success.
#
# So this starts a SECOND node, forked from a different block, and requires:
#   - the default node still passes          (the gate is not simply broken)
#   - the wrong node is rejected             (the gate follows --rpc)
#   - demo-waiting.sh with RPC=wrong refuses (the plumbing is connected)
#   - AND that node's height does not move   (nothing of ours was mined)
#
# The last one is the point. "It exited non-zero" is not the same as "nothing
# reached the chain", and a gate that rejects a node after deploying to it has
# protected nothing. Read it for exactly what it is, though: the node mines a
# block per transaction, so an unmoved height means no transaction of ours was
# INCLUDED. Whether a send was ATTEMPTED is a different claim, and it would
# need a record of the RPC calls made - nothing here keeps one.
#
# IT LEAVES THE PINNED NODE ONE BLOCK FURTHER ON, because telling
# REQUIRE_FRESH=0 apart from REQUIRE_FRESH=1 needs a node that is not fresh.
# Restart it before running the Solidity fork suite, which asserts on constants
# measured from the starting state:  bash script/b20/start-node.sh
source "$(dirname "$0")/env.sh"

HERE="$(dirname "$0")"
WRONG_PORT="${WRONG_PORT:-8547}"
WRONG_RPC="http://127.0.0.1:${WRONG_PORT}"
WRONG_BLOCK=$((FORK_BLOCK - 1000))
WRONG_PID=""

cleanup() { [ -n "$WRONG_PID" ] && kill "$WRONG_PID" 2>/dev/null; return 0; }
trap cleanup EXIT

pass() { echo "  ok   $*"; }
step() { echo; echo "$*"; }

# A REJECTION HAS TO BE REJECTED FOR THE RIGHT REASON.
# "not the pinned fork" is printed for a metadata mismatch AND for a node that
# cannot be reached at all, so a test that only looks for that string passes
# just as happily when the node it was meant to reject has simply gone away.
# Every negative case below names the sentence it expects.
because() {
  local want="$1" where="$2"
  grep -qF -- "$want" "$where" || {
    echo "--- $where ---" >&2; cat "$where" >&2
    die "it failed, but not for the expected reason: wanted \"$want\""
  }
}

# ---------------------------------------------------------------- preconditions
$CAST block-number --rpc-url "$FORK_RPC" >/dev/null 2>&1 \
  || die "the pinned node is not running on ${FORK_RPC}. Start it with start-node.sh."
if ss -ltn 2>/dev/null | grep -q ":${WRONG_PORT} "; then
  die "port ${WRONG_PORT} is in use; this test needs it for the second node."
fi

step "1. the pinned node passes, so a rejection below means something"
bash "$HERE/verify-fork.sh" --rpc "$FORK_RPC" --identity >/dev/null \
  || die "the pinned node itself did not pass - fix that before reading anything else here"
pass "verify-fork.sh --rpc ${FORK_RPC} --identity"

step "2. a second node, forked from block ${WRONG_BLOCK} instead of ${FORK_BLOCK}"
base-anvil --fork-url "$UPSTREAM_RPC" --fork-block-number "$WRONG_BLOCK" \
  --port "$WRONG_PORT" --host 127.0.0.1 > /tmp/curb-wrong-node.log 2>&1 &
WRONG_PID=$!
for _ in $(seq 1 60); do
  $CAST block-number --rpc-url "$WRONG_RPC" >/dev/null 2>&1 && break
  sleep 1
done
$CAST block-number --rpc-url "$WRONG_RPC" >/dev/null 2>&1 \
  || die "the second node never came up; see /tmp/curb-wrong-node.log"
pass "it answers on ${WRONG_RPC}"

step "3. the verifier follows --rpc rather than the default"
if bash "$HERE/verify-fork.sh" --rpc "$WRONG_RPC" --identity >/tmp/curb-gate-step3.log 2>&1; then
  die "the wrong-fork node PASSED. The verifier is still checking the default node."
fi
# The fork POINT is what must have been noticed - not an unreachable node, and
# not the chain id, which both nodes share.
because "node reports fork block ${WRONG_BLOCK}, expected ${FORK_BLOCK}" /tmp/curb-gate-step3.log
pass "rejected, naming fork block ${WRONG_BLOCK} against the expected ${FORK_BLOCK}"

step "4. demo-waiting.sh refuses, and processes no transaction on that node"
before=$($CAST block-number --rpc-url "$WRONG_RPC")
if RPC="$WRONG_RPC" bash "$HERE/demo-waiting.sh" >/tmp/curb-gate-step4.log 2>&1; then
  die "demo-waiting.sh DEPLOYED to a node that is not the pinned fork."
fi
after=$($CAST block-number --rpc-url "$WRONG_RPC")

# WHAT THIS SHOWS, EXACTLY. The node mines a block per transaction, so an
# unchanged height means no transaction of ours was INCLUDED. It is not the
# same as "no send was attempted": proving that needs a record of the RPC calls
# made, which nothing here keeps. The narrower claim is the one being made.
[ "$before" = "$after" ] \
  || die "it refused, but a transaction was mined first: block moved ${before} -> ${after}"
because "node reports fork block ${WRONG_BLOCK}, expected ${FORK_BLOCK}" /tmp/curb-gate-step4.log
because "the node is not the pinned fork" /tmp/curb-gate-step4.log
pass "refused on the fork-point mismatch, with the node still at block ${after}"

step "5. REQUIRE_FRESH is read as a VALUE, not as \"is it set\""
# ${REQUIRE_FRESH:+--fresh} turned REQUIRE_FRESH=0 into a demand for a fresh
# node - the opposite of what setting it to 0 means. Telling the two readings
# apart needs a node that is NOT fresh, so one block is mined here if it still
# is.
#
# CHECK_ONLY stops demo-waiting.sh straight after the gate, so this asks which
# mode was chosen without paying for a deployment to find out. RPC is pinned to
# the good node explicitly: these three cases are about the MODE, and a mode
# test that accidentally ran against another node would prove nothing about it.
if [ "$($CAST block-number --rpc-url "$FORK_RPC")" = "$FORK_BLOCK" ]; then
  $CAST rpc anvil_mine --rpc-url "$FORK_RPC" >/dev/null
  echo "  (mined one block: on a fresh node the two readings cannot be told apart)"
fi
now=$($CAST block-number --rpc-url "$FORK_RPC")

REQUIRE_FRESH=0 RPC="$FORK_RPC" CHECK_ONLY=1 bash "$HERE/demo-waiting.sh" >/dev/null 2>&1 ||
  die "REQUIRE_FRESH=0 was treated as --fresh"
pass "REQUIRE_FRESH=0 behaves as unset"

# env -u, NOT just leaving it out. A value inherited from whoever ran this
# script would otherwise decide the "unset" case, and it would be the one case
# that silently tested something else.
env -u REQUIRE_FRESH RPC="$FORK_RPC" CHECK_ONLY=1 bash "$HERE/demo-waiting.sh" >/dev/null 2>&1 ||
  die "unset REQUIRE_FRESH demanded a fresh node"
pass "unset behaves as unset, with the variable actually removed"

if REQUIRE_FRESH=1 RPC="$FORK_RPC" CHECK_ONLY=1 bash "$HERE/demo-waiting.sh" >/tmp/curb-gate-step5.log 2>&1; then
  die "REQUIRE_FRESH=1 did NOT demand a fresh node - the flag does nothing"
fi
# And for the freshness reason, not because the node went missing.
because "--fresh requires an untouched node at ${FORK_BLOCK}" /tmp/curb-gate-step5.log
pass "REQUIRE_FRESH=1 refused this used node (at ${now}) as not untouched"

echo
echo "fork gate OK: it checks the node it is told to check, rejects the wrong fork, and no transaction was mined"
