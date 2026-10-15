#!/usr/bin/env bash
# Prints which run holds the claim on RPC_PORT, or nothing at all.
#
# A PORT ANSWERING IS NOT A PORT YOU OWN. A run that fails to claim the port
# still finds it answering a moment later - because the run that DID claim it
# has started its node there - and without this it goes on to prepare against
# somebody else's chain. Two runs then deploy into one node and both fail, which
# is what happened the first time two real runs were raced.
set -euo pipefail
source "$(dirname "$0")/env.sh"

LOCK="${NODE_LOCK_DIR:-/tmp/curb-node-${RPC_PORT}.lock}"
[ -d "$LOCK" ] || exit 0
cut -d' ' -f1 "${LOCK}/owner" 2>/dev/null || true
