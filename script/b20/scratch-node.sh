#!/usr/bin/env bash
# A SECOND LOCAL CHAIN, FOR THE "WRONG NETWORK" STEP AND NOTHING ELSE.
#
# web/app.html refuses to send when the wallet's chain and the RPC box's chain
# disagree. Checking that with a real wallet means switching the wallet to some
# other network - and the obvious other networks are real ones. A page that
# turned out to have the bug would then broadcast to Ethereum or to Base
# mainnet, with a real wallet, for real. The test would have caused the thing it
# was looking for.
#
# So the other network is this: an empty local chain with a chain id that is not
# the fork's, holding nothing and reachable by nobody. A transaction sent to it
# by mistake costs nothing and proves the same point.
#
#   bash script/b20/scratch-node.sh      (leave it running)
#
# Then add it to the test wallet as
#   Name  CURB scratch   RPC  http://127.0.0.1:8547   Chain ID  31337
set -euo pipefail
source "$(dirname "$0")/env.sh"

PORT="${SCRATCH_PORT:-8547}"
CHAIN="${SCRATCH_CHAIN:-31337}"

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "FAIL: port ${PORT} is already in use." >&2
  echo "      ss -ltnp | grep ${PORT}" >&2
  echo "      Refusing to continue rather than attach to an unknown node." >&2
  exit 1
fi

# NOT A FORK. It needs no state at all: the wallet only has to be able to sit on
# it. Forking would make a second copy of Base, which is the one chain id this
# must not have.
echo "starting an empty scratch chain on ${PORT}, chain id ${CHAIN}"
exec base-anvil --port "${PORT}" --host 127.0.0.1 --chain-id "${CHAIN}"
