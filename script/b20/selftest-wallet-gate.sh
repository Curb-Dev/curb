#!/usr/bin/env bash
# CHECKS THE REAL-WALLET GATE, BY WITHHOLDING EACH STEP IN TURN.
#
# script/b20/wallet-session.sh verify decides whether a hand-driven session with
# a real wallet actually did what it claims. A gate that has only ever been seen
# to pass is not a gate: it has to be shown failing, for the right step, with
# everything else still passing.
#
# So this replays the flow one step at a time with script/SelfTestWalletFlow.s.sol
# and runs the gate after each, asserting what must have turned green and what
# must still be red. It ends with four mutations applied to the SAME green
# session: a transaction across the refusal marks on the fork, one on the OTHER
# chain (which the fork cannot see, and which is where a wrong-network send
# would land), a session with no other chain recorded at all, and a transaction
# from somebody who is not the wallet.
#
# It also checks that a prepare which DIES leaves no account unlocked, by
# injecting a failure at the deployment and at the funding in turn. That is not
# a detail: an account left unlocked means anything on this machine can send
# from the wallet's address without its key, and the gate's first claim stops
# meaning the wallet signed anything.
#
# The flow here is broadcast from an unlocked anvil account, not signed by a
# wallet. The gate cannot tell the difference - which is exactly why
# `prepare` turns impersonation back off before a real session starts, and why
# this file is a test OF the gate rather than a substitute FOR the real run.
#
#   bash script/b20/start-node.sh          (in another terminal, fresh)
#   bash script/b20/selftest-wallet-gate.sh
#
# The scratch chain it starts itself, unless one is already on SCRATCH_RPC's
# port (8547 unless SCRATCH_RPC names another).
set -euo pipefail
cd "$(dirname "$0")/../.."
source script/b20/env.sh

RPC="${RPC:-$FORK_RPC}"
GATE="script/b20/wallet-session.sh"
SESSION="${SESSION:-script/b20/.wallet-session.json}"
export SESSION
# Anvil's first two dev accounts. Unlocked without impersonation, which is what
# lets the stages broadcast at all.
WALLET=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
STRANGER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

STAGE=""
fails=0
step() { STAGE="$1"; echo; echo "=== $STAGE ==="; }
bad() { echo "  NOT WHAT WAS EXPECTED [$STAGE]: $*"; fails=$((fails + 1)); }

GATE_OUT=""
GATE_CODE=0
gate() {
  set +e
  GATE_OUT=$(bash "$GATE" verify 2>&1)
  GATE_CODE=$?
  set -e
}

# `PASS <name>` / `FAIL <name>` exactly as the gate prints them, so a check
# that silently stops being emitted cannot be mistaken for one that passed.
# Case-insensitive: the gate prints addresses as the chain gives them, in lower
# case, while forge prints them checksummed.
passed() { grep -qiF "  PASS  $1" <<<"$GATE_OUT" || bad "expected PASS: $1"; }
failed() { grep -qiF "  FAIL  $1" <<<"$GATE_OUT" || bad "expected FAIL: $1"; }
says() { grep -qiF "$1" <<<"$GATE_OUT" || bad "expected the gate to say: $1"; }
red() { [ "$GATE_CODE" -ne 0 ] || bad "the gate exited 0 when it should have refused"; }
green() { [ "$GATE_CODE" -eq 0 ] || bad "the gate exited $GATE_CODE when everything should have passed:
$GATE_OUT"; }

# THE OTHER LOCAL CHAIN. The wrong-network checks look at it, so a run without
# one would be checking half of what it claims to.
SCRATCH_RPC="${SCRATCH_RPC:-http://127.0.0.1:8547}"
export SCRATCH_RPC
# THE PORT IS SCRATCH_RPC'S OWN. It was 8547 written into the check below, so
# a run pointed at a scratch chain of its own (SCRATCH_RPC on another port)
# found 8547 busy - somebody else's chain - reported using it, and started
# nothing on the port it then read from.
SCRATCH_PORT="${SCRATCH_RPC##*:}"
SCRATCH_PORT="${SCRATCH_PORT%%/*}"
[[ "$SCRATCH_PORT" =~ ^[0-9]+$ ]] || die "SCRATCH_RPC names no port: $SCRATCH_RPC"
SCRATCH_PID=""
stop_scratch() { [ -n "$SCRATCH_PID" ] && kill "$SCRATCH_PID" 2>/dev/null; true; }
trap stop_scratch EXIT
start_scratch() {
  if ss -ltn 2>/dev/null | grep -q ":${SCRATCH_PORT} "; then
    echo "using the scratch chain already listening on ${SCRATCH_PORT}"
    return
  fi
  SCRATCH_PORT="$SCRATCH_PORT" nohup bash script/b20/scratch-node.sh >/tmp/curb-gate-scratch.log 2>&1 &
  SCRATCH_PID=$!
  local i
  for i in $(seq 1 40); do
    if curl -s -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$SCRATCH_RPC" >/dev/null 2>&1; then
      echo "started a scratch chain on ${SCRATCH_PORT}"
      return
    fi
    sleep 0.5
  done
  die "the scratch chain did not come up"
}

# DOES THE NODE ACCEPT A TRANSACTION FROM THIS ADDRESS? That is what
# impersonation is, and from outside the node it is the only way to ask.
accepts_send_from() { # rpc address
  local out
  out=$(curl -s -X POST -H 'content-type: application/json' \
    --data "$(jq -cn --arg f "$2" \
      '{jsonrpc:"2.0",id:1,method:"eth_sendTransaction",params:[{from:$f,to:$f,value:"0x0"}]}')" "$1")
  [ "$(jq -r 'has("error")' <<<"$out")" = "false" ]
}

flow() { # sig [extra env assignments already exported]
  base-forge script script/SelfTestWalletFlow.s.sol --sig "$1" \
    --rpc-url "$RPC" --broadcast --unlocked --sender "$WALLET" >/tmp/curb-gate-stage.log 2>&1 \
    || { tail -25 /tmp/curb-gate-stage.log; die "the stage $1 did not run"; }
  grep -q "ONCHAIN EXECUTION COMPLETE" /tmp/curb-gate-stage.log \
    || { tail -25 /tmp/curb-gate-stage.log; die "the stage $1 did not complete on chain"; }
}

# ---------------------------------------------------------------------------
start_scratch

# ---------------------------------------------------------------------------
# A PREPARE THAT DIES MUST NOT LEAVE AN ACCOUNT UNLOCKED. The gate's first claim
# is that every transaction came from the wallet, and that only means the wallet
# SIGNED them while nothing on this machine can send from the address without
# its key. These run before the session window opens, so what they mine is not
# part of it.
step "the probe can tell a locked account from an unlocked one"
# NOT A DEV ACCOUNT. Anvil's own accounts are unlocked whatever impersonation
# says, so one of those could not show the difference.
GHOST=0xC0FFEE0000000000000000000000000000000001
WHALE_ADDR=0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9
# Funded first: an account with no ETH is refused for a reason that has nothing
# to do with the lock, and the probe would then "pass" against anything.
base-cast rpc anvil_setBalance "$GHOST" 0x3635C9ADC5DEA00000 --rpc-url "$RPC" >/dev/null
if accepts_send_from "$RPC" "$GHOST"; then bad "a send from a LOCKED account was accepted"; fi
base-cast rpc anvil_impersonateAccount "$GHOST" --rpc-url "$RPC" >/dev/null
if ! accepts_send_from "$RPC" "$GHOST"; then bad "a send from an UNLOCKED account was refused"; fi
base-cast rpc anvil_stopImpersonatingAccount "$GHOST" --rpc-url "$RPC" >/dev/null

step "a prepare that dies at the DEPLOYMENT locks the wallet again"
set +e
CURB_PREPARE_FAIL_AT=deploy bash "$GATE" prepare --wallet "$GHOST" >/tmp/curb-gate-fail-deploy.log 2>&1
code=$?
set -e
[ "$code" -ne 0 ] || bad "prepare returned 0 with a failure injected at the deployment"
grep -q "injected failure at deploy" /tmp/curb-gate-fail-deploy.log \
  || bad "the deployment stage was not where it died"
if accepts_send_from "$RPC" "$GHOST"; then bad "$GHOST is still unlocked"; fi

step "a prepare that dies at the FUNDING locks the whale again"
set +e
CURB_PREPARE_FAIL_AT=fund bash "$GATE" prepare --wallet "$GHOST" >/tmp/curb-gate-fail-fund.log 2>&1
code=$?
set -e
[ "$code" -ne 0 ] || bad "prepare returned 0 with a failure injected at the funding"
grep -q "injected failure at fund" /tmp/curb-gate-fail-fund.log \
  || bad "the funding stage was not where it died"
if accepts_send_from "$RPC" "$WHALE_ADDR"; then bad "$WHALE_ADDR is still unlocked"; fi
if accepts_send_from "$RPC" "$GHOST"; then bad "$GHOST is still unlocked"; fi

# ---------------------------------------------------------------------------
step "prepare"
bash "$GATE" prepare --wallet "$WALLET" >/tmp/curb-gate-prepare.log 2>&1 \
  || { tail -25 /tmp/curb-gate-prepare.log; die "prepare failed"; }
grep -q "scratch chain at" /tmp/curb-gate-prepare.log \
  || bad "prepare did not record a scratch chain, so the wrong-network checks are half blind"
export CURB_FACTORY CURB_LENS CURB_GRADUATOR CURB_HOOK CURB_STRANGER
CURB_FACTORY=$(jq -r .factory "$SESSION")
CURB_LENS=$(jq -r .lens "$SESSION")
CURB_GRADUATOR=$(jq -r .graduator "$SESSION")
CURB_HOOK=$(jq -r .hook "$SESSION")
CURB_STRANGER="$STRANGER"
echo "  factory $CURB_FACTORY  lens $CURB_LENS"

# ---------------------------------------------------------------------------
step "nothing has happened yet"
gate
red
failed "every transaction in the session came from the wallet"
grep -qF "the window is empty" <<<"$GATE_OUT" || bad "the empty window was not named as the reason"
failed "the wallet created a launch"

# ---------------------------------------------------------------------------
step "create only"
flow "create()"
export CURB_TOKEN
CURB_TOKEN=$(grep -m1 '^  token ' /tmp/curb-gate-stage.log | grep -oE '0x[0-9a-fA-F]{40}')
CURVE=$(grep -m1 '^  curve ' /tmp/curb-gate-stage.log | grep -oE '0x[0-9a-fA-F]{40}')
[ -n "$CURB_TOKEN" ] && [ -n "$CURVE" ] || die "create() did not report a token and a curve"
echo "  token $CURB_TOKEN  curve $CURVE"
gate
red
passed "every transaction in the session came from the wallet"
passed "the wallet created a launch - token $CURB_TOKEN"
failed "the wallet bought on the curve"
failed "the wallet sold on the curve"
failed "the wallet graduated the launch with the permissionless button"
failed "the wallet traded the pool after graduation"

# ---------------------------------------------------------------------------
step "and a buy"
CURB_AMOUNT=1000000000 flow "buy()"   # 10 NVDAc
gate
red
passed "the wallet created a launch - token $CURB_TOKEN"
passed "the wallet bought on the curve"
passed "the lens said Selling (1) at the block of that buy"
failed "the wallet sold on the curve"

# ---------------------------------------------------------------------------
step "and a sell"
# A round number of the launch token, far under what 10 NVDAc bought.
CURB_AMOUNT=1000000000000000000000 flow "sell()"
gate
red
passed "the wallet sold on the curve"
failed "the wallet graduated the launch with the permissionless button"
failed "the wallet traded the pool after graduation"

# ---------------------------------------------------------------------------
step "up to the threshold, but not over it"
# ONE TRANSACTION AT A TIME, DELIBERATELY. This was a Solidity loop broadcast as
# a single forge script run, and forge's multi-transaction broadcast left NONCE
# GAPS on this node: some of the sends never arrived, the rest sat in the
# txpool's queued set, and the run hung forever polling for receipts that could
# not come. Filling the missing nonce by hand released them one at a time, which
# is what identified it.
#   Driving the buys from here removes that entirely, and it is closer to what
#   is being tested anyway - a person with a real wallet confirms one
#   transaction at a time.
# THREE QUARTERS OF THE CURVE'S OWN THRESHOLD, read rather than written here:
# it was a literal 45 of 60, and at the shipped 49.1 (50 since 2026-10-15) a 10 NVDAc step from just
# under 45 crosses it and graduates the launch before the step meant to cross.
# Stopping at three quarters leaves more than one step of room at any threshold
# above 40 NVDAc.
THRESHOLD=$(base-cast call "$CURVE" "graduationThreshold()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
for _ in $(seq 1 8); do
  RESERVE=$(base-cast call "$CURVE" "realQuoteReserve()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
  [ $((RESERVE * 4)) -ge $((THRESHOLD * 3)) ] && break
  base-cast send "$NVDAC" "approve(address,uint256)" "$CURVE" 1000000000 \
    --from "$WALLET" --unlocked --rpc-url "$RPC" >/dev/null
  base-cast send "$CURVE" "buy(uint256,uint256,address)" 1000000000 1 "$WALLET" \
    --from "$WALLET" --unlocked --rpc-url "$RPC" >/dev/null
done
echo "  reserve $RESERVE of $THRESHOLD"
[ $((RESERVE * 2)) -ge "$THRESHOLD" ] || bad "the curve did not get near its threshold: $RESERVE of $THRESHOLD"
STATUS=$(base-cast call "$CURB_LENS" "statusOf(address)(uint8)" "$CURB_TOKEN" --rpc-url "$RPC" | awk '{print $1}')
[ "$STATUS" = 1 ] || bad "the launch should still be Selling before the crossing buy, it is $STATUS"

step "the crossing buy, on a tight gas limit"
# THE ONLY WAY THE WAITING STATE EXISTS. The curve calls the graduator itself
# on the buy that crosses, so with enough gas the launch is Graduated the
# moment it is ready and the permissionless button never has anything to do.
# 900,000 is the limit demo-waiting.sh established on this fork.
base-cast send "$NVDAC" "approve(address,uint256)" "$CURVE" 6600000000 \
  --from "$WALLET" --unlocked --rpc-url "$RPC" >/dev/null
base-cast send "$CURVE" "buy(uint256,uint256,address)" 6600000000 0 "$WALLET" \
  --from "$WALLET" --unlocked --gas-limit 900000 --rpc-url "$RPC" >/dev/null
STATUS=$(base-cast call "$CURB_LENS" "statusOf(address)(uint8)" "$CURB_TOKEN" --rpc-url "$RPC" | awk '{print $1}')
[ "$STATUS" = 2 ] || die "the launch is $STATUS, not Waiting - the gas limit was not tight enough"
gate
red
failed "the wallet graduated the launch with the permissionless button"
says "the Waiting state never existed"

# ---------------------------------------------------------------------------
step "and the button"
flow "graduate()"
gate
red
passed "the wallet graduated the launch with the permissionless button"
passed "the lens said Waiting (2) in the block before the button was pressed"
passed "the lens reports Graduated (3)"
passed "the LP position is held by the lock"
says "  PASS  the remainder was burned - supply fell by exactly"
failed "the wallet traded the pool after graduation"

# ---------------------------------------------------------------------------
step "and the pool trade"
CURB_AMOUNT=500000000 flow "poolTrade()"   # 5 NVDAc
gate
red   # still red: the two refusal steps have no marks
says "  PASS  the wallet traded the pool in block"
failed "declining in the wallet put nothing in a block"
failed "a wallet on the wrong network put nothing in a block on either chain"
says "were not both recorded"

# ---------------------------------------------------------------------------
step "and the two refusals, with nothing sent between the marks"
bash "$GATE" mark reject-before >/dev/null
bash "$GATE" mark reject-after >/dev/null
bash "$GATE" mark network-before >/dev/null
bash "$GATE" mark network-after >/dev/null
gate
green
passed "declining in the wallet put nothing in a block"
passed "a wallet on the wrong network put nothing in a block on either chain"
cp "$SESSION" "$SESSION.green"

# ---------------------------------------------------------------------------
# MUTATION 1 - a transaction across the refusal marks. Same chain, same green
# session, only the marks moved to bracket something that WAS sent.
step "mutation: a transaction between the refusal marks"
jq '.marks |= map(select(.name | startswith("reject-") | not))' "$SESSION.green" > "$SESSION"
bash "$GATE" mark reject-before >/dev/null
flow "noise()"
bash "$GATE" mark reject-after >/dev/null
gate
red
failed "declining in the wallet put nothing in a block"
says "on the fork the wallet's nonce moved"
passed "a wallet on the wrong network put nothing in a block on either chain"
says "  PASS  the wallet traded the pool in block"   # the rest of the flow still passes

step "the same green session is still green with that transaction on chain"
# WITHOUT THIS, the mutation above proves nothing: a gate that went red because
# an extra transaction appeared would look identical.
cp "$SESSION.green" "$SESSION"
gate
green

# ---------------------------------------------------------------------------
# MUTATION 2 - THE ONE THE FORK CANNOT SEE. A page that wrongly sends while the
# wallet is on the other network sends it THERE. With the fork as the only thing
# looked at, the fork is untouched, the nonce has not moved, and the step passes.
step "mutation: a transaction on the SCRATCH chain between the network marks"
jq '.marks |= map(select(.name | startswith("network-") | not))' "$SESSION.green" > "$SESSION"
bash "$GATE" mark network-before >/dev/null
base-cast send "$WALLET" --value 0 --from "$WALLET" --unlocked --rpc-url "$SCRATCH_RPC" >/dev/null
bash "$GATE" mark network-after >/dev/null
gate
red
failed "a wallet on the wrong network put nothing in a block on either chain"
says "on the scratch chain"
passed "declining in the wallet put nothing in a block"
says "  PASS  the wallet traded the pool in block"

step "the same green session is still green with that scratch transaction on chain"
cp "$SESSION.green" "$SESSION"
gate
green

# ---------------------------------------------------------------------------
# MUTATION 3 - no other chain recorded at all. A session prepared while the
# scratch chain was down must REFUSE the wrong-network step rather than pass it
# on the strength of the fork alone, which is the one chain a mistaken send
# would not have gone to.
step "mutation: the session records no scratch chain"
jq 'del(.scratch)' "$SESSION.green" > "$SESSION"
gate
red
failed "a wallet on the wrong network put nothing in a block on either chain"
says "was never looked at"
passed "declining in the wallet put nothing in a block"
cp "$SESSION.green" "$SESSION"

# ---------------------------------------------------------------------------
# MUTATION 4 - somebody who is not the wallet drives the chain. This one is
# last: the transaction cannot be taken back off the fork.
step "mutation: a transaction from an address that is not the wallet"
flow "stranger()"
gate
red
failed "every transaction in the session came from the wallet"
says "from $STRANGER"
passed "the wallet created a launch - token $CURB_TOKEN"

# ---------------------------------------------------------------------------
rm -f "$SESSION.green"
echo
if [ "$fails" -eq 0 ]; then
  echo "the gate passed when the flow happened and refused for each step that had not."
else
  echo "$fails expectation(s) did not hold."
  exit 1
fi
