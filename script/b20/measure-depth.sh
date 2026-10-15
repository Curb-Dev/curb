#!/usr/bin/env bash
# WHAT DOES IT COST TO TRADE NVDAc ON UNISWAP v3 ON BASE, TODAY?
#
#   bash script/b20/measure-depth.sh
#
# WHAT THIS IS FOR. ROADMAP Phase 0 B asks what a trade actually costs at real
# sizes, in BOTH directions, after fees rather than in slippage alone. This
# measures the half that depends on somebody else's liquidity. The other half -
# our own graduated pool - is a function of parameters WE choose and is measured
# in test/fork/B20Graduation.t.sol, not here.
#
# THIS FILE OWNS THE PORT, THE NODE AND THE BLOCK. Every question asked of the
# chain lives in script/b20/depth_probe.py, and that split is deliberate: a
# failed RPC call must never become a number, and that rule is only checkable if
# there is exactly one place where a call's outcome is decided. See the header
# of depth_probe.py, and script/b20/faultinject-depth.sh, which breaks the RPC
# on purpose and checks the tool reports a failure where a number would go.
#
# ON ITS OWN FORK, AT A CURRENT BLOCK. The pinned block the suite uses is months
# of liquidity out of date for this question, so this takes a fresh fork and
# RECORDS THE BLOCK NUMBER AND HASH it read - a depth figure without those is
# not a measurement, it is an anecdote. It claims its own port and leaves any
# hand-driven session alone.
#
# READ-ONLY. Every question is an eth_call. Nothing is sent, nothing is mined,
# no state is changed on the fork or anywhere else.
#
# ONE DEFINITION OF COST, AND IT IS THE ONE THE SOLIDITY TABLES USE TOO
#     cost  =  1  -  (what the trade returned) / (what the mid says it should
#                                                 have returned)
# A SHORTFALL AGAINST MID. It reads the same on a buy and on a sell, and it
# cannot exceed 100%. An earlier version used that formula here and "price paid
# over mid" in the pool tables, printed both under one "bps" heading, and
# compared them. They are not the same number: the second is the first divided
# by (1 - the first), so 48 against 48 is harmless and 7745 against 7745 is a
# factor of four. The costLimit tests still assert on the price-over-mid form on
# purpose; wherever that figure appears it is NAMED.
#
# WHAT IT DOES NOT DO. It does not decide anything. "A trade of this size costs
# this much" is a measurement; WHICH COST IS ACCEPTABLE is a product decision
# that has to be made separately and written down as one.
set -uo pipefail
cd "$(dirname "$0")/../.."
source script/b20/env.sh

PORT="${DEPTH_PORT:-8553}"
RPC="http://127.0.0.1:${PORT}"
# THE RUN ID HAS TO BE UNIQUE ACROSS TIME, NOT JUST ACROSS LIVE PROCESSES.
# "depth-$$" is a pid, pids are reused, and a lock left behind by a dead run
# can carry the same one a later run computes for itself. start-node.sh
# already learned this and records the process START TIME beside the pid;
# same thing here, read before anything else can fork.
RUN="depth-$$-$(cut -d')' -f2- "/proc/$$/stat" 2>/dev/null | awk '{print $20}')"
LOCK="/tmp/curb-node-${PORT}.lock"

# WE OWN NOTHING UNTIL WE HAVE CLAIMED IT, AND WE REMOVE NOTHING WE DO NOT OWN.
#
# The first version of this installed the EXIT trap before taking the claim and
# then removed the lock unconditionally. A run refused because the port was busy
# - or because somebody else held the claim - deleted the INCUMBENT lock on its
# way out. That is the bug stop-node.sh was fixed for twice, arriving in a new
# file, so the fix is the same one: a flag set only by a successful mkdir, and a
# removal guarded on both that flag and the name written inside the lock.
# script/b20/mutate-depth-lock.sh deletes each guard in turn and checks it.
HELD=0
cleanup() {
  if [ -n "${NODE_PID:-}" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  if [ "$HELD" = 1 ] && [ -d "$LOCK" ]; then
    owner=$(cat "${LOCK}/owner" 2>/dev/null || true)
    if [ "$owner" = "$RUN" ]; then
      rm -rf "$LOCK"
    else
      echo "NOT releasing ${LOCK}: it says ${owner:-<unreadable>}, we are ${RUN}" >&2
    fi
  fi
}
trap cleanup EXIT

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "FAIL: port ${PORT} is already in use - not touching it." >&2
  exit 1
fi
mkdir "$LOCK" 2>/dev/null || { echo "FAIL: port ${PORT} is already claimed." >&2; exit 1; }
HELD=1
echo "$RUN" > "${LOCK}/owner"

echo "forking Base at its LATEST block on port ${PORT} (upstream ${UPSTREAM_RPC})"
# base-anvil supplies --base itself; passing it again is an error.
base-anvil --fork-url "$UPSTREAM_RPC" --chain-id 8453 --port "$PORT" --host 127.0.0.1 --silent &
NODE_PID=$!
for _ in $(seq 1 60); do
  base-cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
base-cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "FAIL: the node did not come up" >&2; exit 1; }

BLOCK=$(base-cast block-number --rpc-url "$RPC")
case "${BLOCK:-}" in
  ''|*[!0-9]*) echo "FAIL: could not read the block number: '${BLOCK:-<empty>}'" >&2; exit 1 ;;
esac

# THE HASH IS FETCHED WITHOUT THE TRANSACTIONS, and then checked.
#
# `base-cast block N --json` asks for the FULL block, and the public endpoint
# answered a Base block with "backend response too large". The hash came back
# empty, python died on the empty string, and the run ended on a traceback -
# which is the same failure this whole tool exists to refuse: an RPC problem
# turning into something other than a clear statement that the measurement did
# not happen. eth_getBlockByNumber with `false` returns transaction hashes
# only, and the result is validated rather than trusted.
BLOCK_HEX_NUM=$(printf '0x%x' "$BLOCK")
HASH=$(base-cast rpc eth_getBlockByNumber "$BLOCK_HEX_NUM" false --rpc-url "$RPC" 2>/dev/null        | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("hash", ""))
except Exception:
    print("")')
case "${HASH:-}" in
  0x????????????????????????????????????????????????????????????????) ;;
  *)
    echo "FAIL: could not read block ${BLOCK}'s hash - got '${HASH:-<empty>}'." >&2
    echo "      A measurement without the block it was taken at is an anecdote," >&2
    echo "      so this run stops here rather than printing one." >&2
    exit 1 ;;
esac
NOW=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

# WHY THE QUESTIONS ARE ASKED AT "latest" AND THAT IS STILL ONE FIXED STATE.
#
# A fork started without --fork-block-number forks at the upstream's head and
# then STAYS there: it does not follow upstream, so "latest" on this node is one
# block for the whole run - the one printed above.
#
# NAMING THE BLOCK NUMBER EXPLICITLY DOES NOT WORK, and it was tried: anvil
# treats a numbered block as a historical query and answers
#   "failed to get storage for 0x3312...FDfD at <slot>"
# for anything it has not already cached. The probe correctly refused to
# measure rather than work around it, which is how this was found.
#
# SO THE PINNING IS CHECKED INSTEAD OF ASSUMED: the block number is read again
# after the probe, and if it moved, the run is not one state and is not a
# measurement.
BLOCK_HEX=latest

echo
echo "================================================================================"
echo "NVDAc ON UNISWAP v3 / BASE, MEASURED $NOW"
echo "================================================================================"
echo "  fork of        Base mainnet via ${UPSTREAM_RPC}"
echo "  block          $BLOCK"
echo "  block hash     $HASH"
echo "  measured by    eth_call only - nothing was sent, nothing was mined"
echo "  every figure below is read at block ${BLOCK}, not at 'latest'"
echo

PROBE_ARGS=(--rpc "$RPC" --block "$BLOCK_HEX")
# THE EXIT LEG IS SIZED BY SOMEBODY ELSE. Selling out of a launch is
# MEME -> NVDAc -> ETH, and the second leg trades the NET NVDAc the first
# one returned - a number that comes out of the Solidity grid, not from
# here. DEPTH_SELL_AMOUNTS carries those raw amounts in.
if [ -n "${DEPTH_SELL_AMOUNTS:-}" ]; then
  PROBE_ARGS+=(--sell-amounts "$DEPTH_SELL_AMOUNTS")
fi
# AND THE ENTRY LEG IN THE SAME RUN, so both directions are read at one block.
# Comparing them across blocks cannot support a claim measured in basis points.
if [ -n "${DEPTH_ENTRY_USD:-}" ]; then
  PROBE_ARGS+=(--entry-usd "$DEPTH_ENTRY_USD")
fi
python3 script/b20/depth_probe.py "${PROBE_ARGS[@]}"
PROBE_RC=$?

BLOCK_AFTER=$(base-cast block-number --rpc-url "$RPC" 2>/dev/null)
if [ "${BLOCK_AFTER:-}" != "$BLOCK" ]; then
  echo
  echo "  *** THE NODE MOVED DURING THE RUN: started at ${BLOCK}, ended at" >&2
  echo "  *** ${BLOCK_AFTER:-<unreadable>}. The rows above are not one state." >&2
  PROBE_RC=3
fi

echo
if [ "$PROBE_RC" = 0 ]; then
  cat <<'NOTE'
  WHAT THIS IS, AND WHAT IT IS NOT
    It is ONE factory's pools - Uniswap v3 - for the quote tokens listed at the
    top, at one block. It is NOT "NVDAc's liquidity on Base": ROADMAP 7.1 names
    Aerodrome and nothing here looks there, other venues are not looked at
    either, and a real router would split across them. Somebody who wants NVDAc
    is also not obliged to buy it in these pools at all - it can be held
    already, bought at Coinbase, or bridged in.
    What it DOES settle is what OUR ETH route costs, because that route goes
    through exactly one of these pools at exactly this tier.

  EVERY ROW IS READ FROM THE SAME UNTOUCHED STATE. They are alternatives, not a
  sequence. Doing the 500 USD trade seven times does not cost seven times the
  500 USD figure: each one moves the price for the next, and the seventh is
  quoted against a pool the first six have already worked through.

  NOT A PRODUCT DECISION. Which of these costs is acceptable - and therefore
  what graduation threshold and what LP tier our own launches should use - is a
  decision nobody has made. A measurement cannot make it.
NOTE
else
  echo "  *** THE PROBE EXITED ${PROBE_RC}. Nothing above is a clean measurement."
  echo "  *** Do not copy any figure out of this run."
fi
exit "$PROBE_RC"
