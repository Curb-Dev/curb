#!/usr/bin/env bash
# Starts the pinned Base fork node, or FAILS. It must never silently attach to
# a node someone else left running: an unpinned node sitting at the height it
# forked at answers identically to a pinned one, so a stale node produces
# results that look correct and are not reproducible.
source "$(dirname "$0")/env.sh"

if ss -ltn 2>/dev/null | grep -q ":${RPC_PORT} "; then
  echo "FAIL: port ${RPC_PORT} is already in use." >&2
  echo "      Something is already listening. Identify and stop it first:" >&2
  echo "        ss -ltnp | grep ${RPC_PORT}" >&2
  echo "      Note: pkill -f base-anvil does NOT work. base-anvil execs anvil," >&2
  echo "      so the process is named 'anvil'. Kill it by PID." >&2
  echo "      Refusing to continue rather than attach to an unknown node." >&2
  exit 1
fi

# THE PORT IS CLAIMED ATOMICALLY, AND THE CLAIM SAYS WHOSE IT IS.
#
# mkdir either creates the directory or fails - there is no window between
# looking and taking, which a pidfile named after the port had: two runs
# starting together would overwrite each other's record, and the loser would go
# on to stop a node it did not own.
#
# The claim records the run, the pid, and the process START TIME. That last one
# is what a reused pid cannot reproduce, and without it "pid 14135 is an anvil
# on this port" can be true of somebody else's process.
if [ -n "${NODE_RUN_ID:-}" ]; then
  LOCK="${NODE_LOCK_DIR:-/tmp/curb-node-${RPC_PORT}.lock}"
  if ! mkdir "$LOCK" 2>/dev/null; then
    # The winner creates the directory and writes the owner a moment later, so a
    # loser that reads immediately sees nothing. Give it that moment before
    # reporting who holds it.
    holder=""
    for _ in 1 2 3 4 5; do
      holder=$(cut -d' ' -f1 "${LOCK}/owner" 2>/dev/null || true)
      [ -n "$holder" ] && break
      sleep 0.2
    done
    echo "FAIL: port ${RPC_PORT} is already claimed by run ${holder:-<still being taken>}." >&2
    echo "      Not starting, and not touching theirs." >&2
    exit 1
  fi
  # Read before exec: exec keeps both the pid and the start time.
  STARTED=$(cut -d')' -f2- "/proc/$$/stat" | awk '{print $20}')
  printf '%s %s %s
' "${NODE_RUN_ID}" "$$" "${STARTED}" > "${LOCK}/owner"
  echo "claimed port ${RPC_PORT} for run ${NODE_RUN_ID} (pid $$, started ${STARTED})"
fi

echo "starting base-anvil, fork pinned to block ${FORK_BLOCK}, serving chain id ${SERVE_CHAIN_ID}"
exec base-anvil \
  --fork-url "${UPSTREAM_RPC}" \
  --fork-block-number "${FORK_BLOCK}" \
  --chain-id "${SERVE_CHAIN_ID}" \
  --port "${RPC_PORT}" --host 0.0.0.0
