#!/usr/bin/env bash
# STOPS THE NODE THIS RUN CLAIMED, AND NOTHING ELSE.
#
# THREE THINGS THIS HAS BEEN WRONG ABOUT, in order.
#
#   It found a process with `grep -- "--port 8549"` and killed it. That ends a
#   node somebody else started - a second test run, or a session being driven by
#   hand - and the match is not even exact, since "--port 8549" is a substring
#   of "--port 85490".
#
#   It then recorded a pid in a file named after the PORT. Two runs starting at
#   once share that file: one overwrites the other's record, and the loser goes
#   on to stop a node it does not own.
#
#   And a pid alone is not an identity. Pids are reused; a new anvil on the same
#   port answers "is this still my node?" with yes.
#
# So: the port is claimed ATOMICALLY with mkdir, the claim records WHICH RUN
# holds it, and the node is identified by pid AND the process start time the
# kernel gives it - which a reused pid cannot reproduce.
set -euo pipefail
source "$(dirname "$0")/env.sh"

RUN_ID="${NODE_RUN_ID:-}"
[ -n "$RUN_ID" ] || die "stop-node.sh needs NODE_RUN_ID. It does not stop nodes it did not claim."
LOCK="${NODE_LOCK_DIR:-/tmp/curb-node-${RPC_PORT}.lock}"

if [ ! -d "$LOCK" ]; then
  echo "no claim on port ${RPC_PORT}: nothing of ours to stop"
  exit 0
fi

owner=""; pid=""; started=""
read -r owner pid started < "${LOCK}/owner" || true
if [ "$owner" != "$RUN_ID" ]; then
  die "port ${RPC_PORT} is claimed by run ${owner:-unknown}, not ${RUN_ID} - refusing to touch it"
fi

release() { rm -rf "$LOCK"; }

if [ ! -r "/proc/${pid}/stat" ]; then
  echo "our node (pid ${pid}) is already gone; releasing the claim on ${RPC_PORT}"
  release
  exit 0
fi

# THE START TIME IS THE PART THAT SURVIVES PID REUSE. Field 22 of /proc/<pid>/stat,
# read after the comm field's closing parenthesis because a command name may
# contain spaces.
now_started=$(cut -d')' -f2- "/proc/${pid}/stat" | awk '{print $20}')
if [ "$now_started" != "$started" ]; then
  echo "pid ${pid} is a DIFFERENT process now (started ${now_started}, ours started ${started});" \
       "our node is gone. Releasing the claim without signalling anything."
  release
  exit 0
fi

# And it must still be the thing we started: an anvil serving exactly this port.
mapfile -d '' -t args < "/proc/${pid}/cmdline"
is_anvil=0
serves_port=0
for i in "${!args[@]}"; do
  case "${args[$i]}" in *anvil) is_anvil=1 ;; esac
  if [ "${args[$i]}" = "--port" ] && [ "${args[$((i + 1))]:-}" = "${RPC_PORT}" ]; then serves_port=1; fi
done
if [ "$is_anvil" != 1 ] || [ "$serves_port" != 1 ]; then
  die "pid ${pid} has the right start time but is not an anvil on port ${RPC_PORT}: ${args[*]}"
fi

kill "$pid"
for _ in $(seq 1 40); do
  if ! kill -0 "$pid" 2>/dev/null; then
    release
    echo "stopped the node on ${RPC_PORT} (pid ${pid}, run ${RUN_ID})"
    exit 0
  fi
  sleep 0.25
done
die "the node on ${RPC_PORT} (pid ${pid}) did not stop"
