#!/usr/bin/env bash
# Checks the node is the one we think it is, then that it serves real B20.
# Exits non-zero on any mismatch so this can gate later steps.
#
#   verify-fork.sh             identity + B20 reads. Safe after transactions.
#   verify-fork.sh --fresh     additionally demands an untouched node.
#   verify-fork.sh --identity  identity ONLY - no call to Base mainnet.
#   --rpc <url>                check THAT node, not the default one.
#
# --rpc IS NOT A CONVENIENCE. A caller that verifies one node and then sends to
# another has verified nothing, and that is exactly what happened: this script
# took FORK_RPC from env.sh - always 127.0.0.1:8546 - while demo-waiting.sh
# deployed to its own overridable RPC. Point that elsewhere and node A was
# checked while node B received the deployment. The flag is parsed AFTER env.sh
# is sourced, so the default cannot win over an explicit one.
#
# --identity exists for gates. The B20 comparison below reads the SAME calls
# from mainnet to compare against, so it needs the public endpoint every time it
# runs; something that has to pass before every automated run should not depend
# on a third party being up. Identity comes from the local node alone.
#
# The distinction matters. Local transactions mine blocks, so a check that
# demanded height == FORK_BLOCK would reject the correct node the moment
# anything had been sent to it.
#
# Identity comes from the node's OWN fork metadata (anvil_metadata ->
# forkedNetwork), not from re-reading a historical block hash. A node forked
# from a LATER block serves that same historical hash perfectly well, so the
# hash alone proves the chain but not the fork point. The metadata states the
# fork point directly.
source "$(dirname "$0")/env.sh"

MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh|--identity) MODE="$1" ;;
    --rpc)   shift; [ $# -gt 0 ] || die "--rpc needs a URL"; FORK_RPC="$1" ;;
    --rpc=*) FORK_RPC="${1#--rpc=}" ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

$CAST block-number --rpc-url "$FORK_RPC" >/dev/null 2>&1 \
  || die "no node answering on ${FORK_RPC}. Start it with start-node.sh."

meta=$($CAST rpc anvil_metadata --rpc-url "$FORK_RPC" 2>/dev/null) \
  || die "node does not answer anvil_metadata; cannot establish its fork point."

field () { echo "$meta" | python3 -c "import sys,json; n=json.load(sys.stdin).get('forkedNetwork'); print(n['$1'] if n else 'none')"; }
fork_chain=$(field chainId)
fork_number=$(field forkBlockNumber)
fork_hash=$(field forkBlockHash)

# THE CHAIN ID THE NODE SERVES, ASKED TWO WAYS - AND IT IS NOT THE UPSTREAM'S.
#
# anvil_metadata's forkedNetwork.chainId follows --chain-id: override it and
# this field reports the override, not the network the state came from. So this
# line used to compare it to a literal 8453 and say "expected 8453 (Base)",
# which read as "we forked from Base" and never measured that. What ties this
# node to Base is the fork BLOCK and HASH below; those are the identity, and
# they are unaffected by what id the node answers with.
#
# eth_chainId is what a WALLET sees, so it is asked separately. The two must
# agree with each other and with what the rest of the setup expects: a node
# serving something else is a session whose wallet is on a different network
# than the page's reads.
[ "$fork_chain"  = "$SERVE_CHAIN_ID" ] \
  || die "node metadata reports chain ${fork_chain}, expected ${SERVE_CHAIN_ID} (set SERVE_CHAIN_ID if that is deliberate)."
served_chain=$($CAST chain-id --rpc-url "$FORK_RPC")
[ "$served_chain" = "$SERVE_CHAIN_ID" ] \
  || die "node serves chain ${served_chain}, expected ${SERVE_CHAIN_ID} (set SERVE_CHAIN_ID if that is deliberate)."
[ "$fork_number" = "$FORK_BLOCK" ] || die "node reports fork block ${fork_number}, expected ${FORK_BLOCK}."
[ "$fork_hash"   = "$FORK_HASH" ]  || die "node reports fork hash ${fork_hash}, expected ${FORK_HASH}."

actual_block=$($CAST block-number --rpc-url "$FORK_RPC")
[ "$actual_block" -ge "$FORK_BLOCK" ] \
  || die "node is at block ${actual_block}, behind the fork block ${FORK_BLOCK}."

echo "checking ${FORK_RPC}"
if [ "$MODE" = "--fresh" ]; then
  [ "$actual_block" = "$FORK_BLOCK" ] \
    || die "node is at block ${actual_block}; --fresh requires an untouched node at ${FORK_BLOCK}."
  echo "node OK: fresh, forked from Base block ${FORK_BLOCK}, untouched"
else
  echo "node OK: forked from Base block ${FORK_BLOCK} (${FORK_HASH}), now at block ${actual_block}"
fi

# AND THE NODE HAS TO BE USABLE, not merely the right one.
#
# A queued transaction is a nonce gap: something sent with a nonce ahead of the
# chain, so every later send from that account collides with it. Anvil reports
# that as "replacement transaction underpriced" - thirty seconds into a deploy,
# with nothing in the message about the cause. It cost a run here, left behind
# by a browser session driving the node by hand.
#
# Anvil mines on every transaction, so a healthy node has an empty pool.
pool=$($CAST rpc txpool_status --rpc-url "$FORK_RPC" 2>/dev/null || echo '')
if [ -n "$pool" ]; then
  stuck=$(echo "$pool" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(0); raise SystemExit
print(int(d.get('pending', '0x0'), 16) + int(d.get('queued', '0x0'), 16))
" 2>/dev/null || echo 0)
  if [ "${stuck:-0}" -gt 0 ]; then
    die "the node has ${stuck} transaction(s) stuck in its pool ($pool).
      Every later send from that account will collide with the nonce gap, and
      anvil reports that as 'replacement transaction underpriced' long after
      the fact. Restart the node:  bash script/b20/start-node.sh"
  fi
fi

# Identity established. --identity stops here on purpose: everything below
# compares against Base mainnet, and a check that has to pass before every
# automated run should not depend on a third party being reachable.
if [ "$MODE" = "--identity" ]; then
  exit 0
fi
echo

fail=0
check () {
  local label="$1"; shift
  local m f
  m=$($CAST call "$NVDAC" "$@" --block "$FORK_BLOCK" --rpc-url "$MAINNET_RPC" 2>&1 | head -1)
  f=$($CAST call "$NVDAC" "$@" --block "$FORK_BLOCK" --rpc-url "$FORK_RPC" 2>&1 | head -1)
  if [ "$m" = "$f" ]; then
    printf "  %-12s %s\n" "$label" "$f"
  else
    printf "  %-12s MISMATCH mainnet=%s fork=%s\n" "$label" "$m" "$f"
    fail=1
  fi
}

# Both sides read AT the fork block, so local transactions cannot move the
# comparison out from under it.
echo "NVDAc, fork vs mainnet at block ${FORK_BLOCK}:"
check name        'name()(string)'
check symbol      'symbol()(string)'
check decimals    'decimals()(uint8)'
check totalSupply 'totalSupply()(uint256)'
check multiplier  'multiplier()(uint256)'

m=$($CAST codesize "$NVDAC" --block "$FORK_BLOCK" --rpc-url "$MAINNET_RPC")
f=$($CAST codesize "$NVDAC" --block "$FORK_BLOCK" --rpc-url "$FORK_RPC")
if [ "$m" = "$f" ]; then
  printf "  %-12s %s\n" "codesize" "$f"
else
  printf "  %-12s MISMATCH mainnet=%s fork=%s\n" "codesize" "$m" "$f"
  fail=1
fi

echo
[ "$fail" -eq 0 ] || die "fork and mainnet disagree"
echo "fork serves real B20 on all checked reads"
