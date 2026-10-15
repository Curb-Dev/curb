#!/usr/bin/env bash
# DOES THE MEASUREMENT TOOL ACTUALLY REFUSE TO TURN AN RPC FAULT INTO A NUMBER?
#
#   bash script/b20/faultinject-depth.sh          (needs a node on 8553)
#
# The claim being tested is narrow and checkable: when a call fails, the tool
# must print a FAILURE where a number would have gone, and exit non-zero. The
# dangerous case is the cost-limit search - a failed quote used to read as zero
# output, which reads as infinite cost, which drove the search DOWNWARDS and
# produced a low "depth" that looked perfectly plausible.
#
# Each case runs the probe through script/b20/faultproxy.py, which forwards to
# the real fork and breaks exactly what it is told to break.
#
# A REVERT IS NOT A FAULT, and the last case checks the tool still knows that:
# an `execution reverted` is the contract answering, and it must stay data.
set -uo pipefail
cd "$(dirname "$0")/../.."

UPSTREAM="${DEPTH_RPC:-http://127.0.0.1:8553}"
PROXY_PORT="${FAULT_PORT:-8601}"
PROXY="http://127.0.0.1:${PROXY_PORT}"
OUT=$(mktemp -d)
PROXY_PID=""

cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  wait "$PROXY_PID" 2>/dev/null
  rm -rf "$OUT"
}
trap cleanup EXIT

if ! curl -s -m 5 -X POST -H 'Content-Type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
     "$UPSTREAM" >/dev/null 2>&1; then
  echo "FAIL: no node answering at ${UPSTREAM}." >&2
  echo "      Start one first - this harness does not create or stop nodes." >&2
  exit 1
fi

QUOTE_IN=0xc6a5026a      # quoteExactInputSingle
TICK_SPACING=0x22afcccb  # feeAmountTickSpacing
BALANCE=0x70a08231       # balanceOf
SWAP_PROBE=0x0844924d    # SwapDeltaProbe.probe - the real-delta measurement

start_proxy() {   # start_proxy <mode> <selector|none> <after> [extra proxy args]
  local mode="$1" sel="$2" after="$3"; shift 3
  local args=(--upstream "$UPSTREAM" --port "$PROXY_PORT" --mode "$mode" --after "$after")
  [ "$sel" != "none" ] && args+=(--fail-selector "$sel")
  python3 script/b20/faultproxy.py "${args[@]}" "$@" 2>/dev/null &
  PROXY_PID=$!
  for _ in $(seq 1 50); do
    curl -s -m 2 -X POST -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
      "$PROXY" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "  the proxy did not come up" >&2
  return 1
}

stop_proxy() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
  wait "$PROXY_PID" 2>/dev/null
  PROXY_PID=""
}

PASS=0
FAILED=0
check() {   # check <name> <file> <expected exit> <actual exit> <grep that MUST match> <grep that must NOT>
  local name="$1" file="$2" want="$3" got="$4" must="$5" mustnot="$6"
  local ok=1 why=""
  [ "$got" = "$want" ] || { ok=0; why="exit ${got}, wanted ${want}"; }
  if [ -n "$must" ] && ! grep -qE "$must" "$file"; then
    ok=0; why="${why}${why:+; }never said /${must}/"
  fi
  if [ -n "$mustnot" ] && grep -qE "$mustnot" "$file"; then
    ok=0; why="${why}${why:+; }printed a number it should not: /${mustnot}/"
  fi
  if [ "$ok" = 1 ]; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name  ($why)"
    echo "        ---- last lines ----"
    tail -6 "$file" | sed 's/^/        /'
    FAILED=$((FAILED + 1))
  fi
}

run_probe() {   # run_probe <file>
  python3 script/b20/depth_probe.py --rpc "$PROXY" >"$1" 2>&1
  echo $?
}

echo "=== 0. the control: no fault injected, the tool must succeed ==="
start_proxy rpcerror none 1000000 || exit 1
rc=$(run_probe "$OUT/control")
stop_proxy
check "clean run exits 0 and prints a depth table" "$OUT/control" 0 "$rc" \
      "THE LARGEST TRADE THAT IS BOTH FULLY CONSUMED" "ABANDONED|NOT A MEASUREMENT"

echo
echo "=== 1. the node disappears completely ==="
start_proxy transport none 0 || exit 1
rc=$(run_probe "$OUT/dead")
stop_proxy
check "a dead node stops the run before any table" "$OUT/dead" 2 "$rc" \
      "FAIL:|did not answer" "THE LARGEST TRADE THAT IS BOTH FULLY CONSUMED"

echo
echo "=== 2. the fee-tier probe fails - it must NOT read as 'not enabled' ==="
start_proxy rpcerror "$TICK_SPACING" 0 || exit 1
rc=$(run_probe "$OUT/tiers")
stop_proxy
check "a failed tier probe stops the run" "$OUT/tiers" 2 "$rc" \
      "fee-tier probe failed" "ENABLED:"

echo
echo "=== 3. a balance read fails - it must NOT read as an empty pool ==="
start_proxy rpcerror "$BALANCE" 0 || exit 1
rc=$(run_probe "$OUT/balances")
stop_proxy
check "a failed balanceOf stops the run" "$OUT/balances" 2 "$rc" \
      "FAIL:.*did not answer" "THE LARGEST TRADE THAT IS BOTH FULLY CONSUMED"

echo
echo "=== 4. THE DANGEROUS ONE: quotes fail partway, during the searches."
echo "       A failed quote must not read as zero output, because zero output"
echo "       reads as infinite cost and drives the search down to a small,"
echo "       plausible, WRONG depth. The fault is INTERMITTENT here - every"
echo "       fifth quote - which is the case that produces a believable"
echo "       number rather than an obvious zero ==="
start_proxy rpcerror "$QUOTE_IN" 40 --every 5 || exit 1
rc=$(run_probe "$OUT/quotes")
stop_proxy
check "failing quotes abandon the search rather than shrink it" \
      "$OUT/quotes" 1 "$rc" \
      "NOT A CLEAN MEASUREMENT|ABANDONED|MEASUREMENT FAILED" ""

echo
echo "=== 5. a batched request fails wholesale ==="
start_proxy rpcerror none 0 --fail-batch || exit 1
rc=$(run_probe "$OUT/batch")
stop_proxy
check "a failed batch stops the run" "$OUT/batch" 2 "$rc" \
      "fee-tier probe failed" "ENABLED:"

echo
echo "=== 6. and a REVERT is still data, not a fault. Every quote reverts, so"
echo "       the tool must report reverted rows and still finish ==="
start_proxy revert "$QUOTE_IN" 0 || exit 1
rc=$(run_probe "$OUT/revert")
stop_proxy
check "reverting quotes are reported as reverts, not as RPC failures" \
      "$OUT/revert" 0 "$rc" \
      "QUOTE REVERTED" "RPC CALL FAILED"

echo
echo "=== 7b. the SWAP PROBE fails. The spent share is the one figure that is"
echo "        measured rather than inferred, so losing it must leave a blank"
echo "        and a complaint - never a 100% ==="
start_proxy rpcerror "$SWAP_PROBE" 0 || exit 1
rc=$(run_probe "$OUT/swapprobe")
stop_proxy
check "a failed swap probe reports NOT MEASURED, not full consumption"       "$OUT/swapprobe" 1 "$rc"       "NOT MEASURED|ABANDONED" ""

echo
echo "=== 7c. THE QUOTER AND THE PROBE DISAGREE about the same swap. Nothing"
echo "        errors - the quoter simply answers one unit more than the pool"
echo "        really pays. The cost and the fill come from ONE call now, so a"
echo "        disagreement means neither number describes a real swap and the"
echo "        tool must refuse rather than reconcile them ==="
start_proxy skew "$QUOTE_IN" 0 --skew-by 1 || exit 1
rc=$(run_probe "$OUT/skew")
stop_proxy
check "a quoter/probe disagreement produces a refusal, not a bound"       "$OUT/skew" 1 "$rc"       "DISAGREE" "^    [A-Za-z]+->[A-Za-z]+ +[0-9][0-9,]*"

echo
echo "=== 7. THE MUTATION. Put the old behaviour back - a failed quote read as"
echo "       zero output - and the SAME injected fault must now produce a"
echo "       NUMBER where case 4 produced ABANDONED. If it does not, the guard"
echo "       in largest_under() is decoration and case 4 proves nothing ==="
SNAP=$(mktemp -d)
cp script/b20/depth_probe.py "$SNAP/original"
restore_probe() { cp "$SNAP/original" script/b20/depth_probe.py; }
# The working tree is snapshotted and restored from /tmp. An earlier harness in
# this repo used `git checkout --` for this and destroyed two uncommitted
# contracts when a stale index restored them from HEAD.
trap 'restore_probe; rm -rf "$SNAP"; cleanup' EXIT

# THE MUTATION IS APPLIED BY A FILE, NOT A NESTED HEREDOC. The first version of
# this case inlined python inside a heredoc inside a patch script; one level of
# backslash escaping was eaten, the mutation never applied, and the case still
# reported PASS because its grep was matching the BALANCE SHEET rows rather than
# the depth table. A harness that passes without doing anything is worse than no
# harness, so the check below anchors on "->" which only the depth rows carry.
cat > "$SNAP/mutate.py" <<'MUTPY'
import io
p = "script/b20/depth_probe.py"
s = io.open(p, encoding="utf-8").read()

# THE MUTATION PUTS BACK THE OLD SHAPE OF largest_under(), which is two
# separate mistakes working together:
#   - a failed quote was swallowed as zero output
#   - the COST came from the quoter while the FILL came from the probe, and
#     the two were never compared
# Either one alone is now caught by the other guard, so restoring one at a
# time proves nothing. They go back together, as they were.
old_swallow = """        except RpcFailed as e:
            failures.append("%s search at %d bps: %s" % (leg["label"], limit_bps, e))
            return None
        if amount_in > leg.get("host_balance", 0):"""
new_swallow = """        except RpcFailed as e:
            q = Quote(0, 0, False)   # MUTATION: a failed quote read as zero out
        if amount_in > leg.get("host_balance", 0):"""

old_accept = """        if received != q.out:
            failures.append("%s search at %d bps: probe and quoter disagree on "
                            "the output, %d vs %d - the search cannot produce a "
                            "number" % (leg["label"], limit_bps, received, q.out))
            return None
        if spent < amount_in:
            hi = mid          # it does not fill, so this size is not an answer
            continue
        cost = (1 - received / leg["mid_out"](spent)) * 10_000 if received else None
        if cost is not None and cost <= limit_bps:"""
new_accept = """        # MUTATION: no disagreement check, and the cost comes from the
        # quoter against the WHOLE offer rather than from the probe against
        # what was spent.
        cost = (1 - q.out / expected_whole) * 10_000 if q.out else 1e9
        if spent < amount_in:
            hi = mid
            continue
        if cost <= limit_bps:"""

for old, new in ((old_swallow, new_swallow), (old_accept, new_accept)):
    assert s.count(old) == 1, "a mutation target moved - this case is not testing what it says"
    s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8").write(s)
print("mutation applied")
MUTPY
if ! python3 "$SNAP/mutate.py"; then
  echo "  FAIL  the mutation could not be applied, so nothing was tested"
  FAILED=$((FAILED + 1))
else
  start_proxy rpcerror "$QUOTE_IN" 40 --every 5 || exit 1
  rc=$(run_probe "$OUT/mutated")
  stop_proxy
  restore_probe

  # Only the depth-at-a-cost rows carry "->". A number there, under a fault, is
  # exactly the invented measurement the guard exists to prevent.
  rows_mut=$(grep -cE "^    [A-Za-z]+->[A-Za-z]+ +[0-9][0-9,]*" "$OUT/mutated" || true)
  rows_abandoned=$(grep -cE "^    [A-Za-z]+->[A-Za-z]+.*ABANDONED" "$OUT/mutated" || true)
  base_abandoned=$(grep -cE "^    [A-Za-z]+->[A-Za-z]+.*ABANDONED" "$OUT/quotes" || true)

  if [ "$base_abandoned" -gt 0 ] && [ "$rows_mut" -gt 0 ] && [ "$rows_abandoned" = 0 ]; then
    echo "  PASS  the old behaviour invents a depth number from a fault"
    echo "        unmutated, same fault: ${base_abandoned} abandoned searches"
    echo "        mutated,   same fault: ${rows_mut} rows of invented numbers:"
    grep -E "^    [A-Za-z]+->[A-Za-z]+ +[0-9][0-9,]*" "$OUT/mutated" | sed 's/^/          /'
    PASS=$((PASS + 1))
  else
    echo "  FAIL  the mutation changed nothing measurable"
    echo "        unmutated abandoned=${base_abandoned} mutated numeric=${rows_mut} mutated abandoned=${rows_abandoned}"
    tail -8 "$OUT/mutated" | sed 's/^/        /'
    FAILED=$((FAILED + 1))
  fi
fi

echo
echo "${PASS} passed, ${FAILED} failed."
[ "$FAILED" = 0 ] || exit 1
