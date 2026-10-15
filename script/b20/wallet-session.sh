#!/usr/bin/env bash
# A REAL WALLET, DRIVEN BY HAND - AND A GATE THAT READS THE CHAIN, NOT THE PAGE.
#
# Everything web/app.html does has so far been exercised through a stub this
# repository wrote. The stub forwards real transactions to a real fork, so what
# it proves about the CONTRACTS is sound; what it cannot prove is anything about
# a real wallet, because the stub is the part that would have to be wrong. A
# real wallet picks its own error codes, its own confirmation dialog, its own
# idea of which network it is on, and it signs with a key the page never sees.
#
# So this does not automate a wallet. It prepares the chain, hands over a
# checklist (web/REAL_WALLET_TEST.txt), and then JUDGES THE RESULT FROM THE
# CHAIN: which transactions were mined, who sent them, what they called, and
# what moved. Nothing here reads the page's own account of what happened - the
# page is the thing under test.
#
#   bash script/b20/wallet-session.sh prepare --wallet 0xYOURTESTADDRESS
#   ... follow web/REAL_WALLET_TEST.txt, running `mark <name>` where it says to
#   bash script/b20/wallet-session.sh verify
#
# `verify` exits non-zero when any required step is missing. It is a gate, not
# a report.
set -euo pipefail
cd "$(dirname "$0")/../.."
source script/b20/env.sh

RPC="${RPC:-$FORK_RPC}"
# THE OTHER LOCAL CHAIN, for the wrong-network step. See scratch-node.sh.
SCRATCH_RPC="${SCRATCH_RPC:-http://127.0.0.1:8547}"
SESSION="${SESSION:-script/b20/.wallet-session.json}"

# Base mainnet deployments - the same ones web/app.js uses.
UNIVERSAL_ROUTER=0x6fF5693b99212Da76ad316178A184AB56D299b43
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
WHALE=0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9
# 2,000 NVDAc: many times over a 50-threshold launch, with a balance left to
# trade the pool with afterwards.
FUND="${FUND:-200000000000}"
# 1,000 ETH. Gas only; the fork's ETH is not money.
GAS_WEI=0x3635C9ADC5DEA00000

lower() { tr 'A-Z' 'a-z' <<<"$1"; }

rpc() { # method params-json
  local out
  out=$(curl -s -X POST -H 'content-type: application/json' \
    --data "$(printf '{"jsonrpc":"2.0","id":1,"method":"%s","params":%s}' "$1" "$2")" "$RPC") \
    || die "the endpoint $RPC did not answer"
  [ -n "$out" ] || die "the endpoint $RPC returned nothing for $1"
  if [ "$(jq -r 'has("error")' <<<"$out")" = "true" ]; then
    die "$1 failed: $(jq -c .error <<<"$out")"
  fi
  jq -r '.result' <<<"$out"
}

# The same, against some other endpoint. `local RPC` shadows the global for the
# whole call, which is how the scratch chain is reached without a second copy of
# every helper.
rpc_at() { local RPC="$1"; shift; rpc "$@"; }

# ------------------------------------------ impersonation, and putting it back
# AN ACCOUNT UNLOCKED HERE MUST BE LOCKED AGAIN EVEN WHEN THIS FAILS.
#
# The gate's first claim is that every transaction came from the wallet, and
# that only means the WALLET SIGNED THEM while nothing on this machine can send
# from the address without its key. The stopImpersonating calls used to sit
# inline after the work, so `set -e` made "the deployment failed" and "the
# funding failed" both end with the account still unlocked - the one outcome
# that quietly voids the gate's first claim, arrived at by the most ordinary
# path there is.
IMPERSONATED=()
impersonate() {
  rpc anvil_impersonateAccount "$(jq -cn --arg a "$1" '[$a]')" >/dev/null
  IMPERSONATED+=("$1")
}
unimpersonate() {
  rpc anvil_stopImpersonatingAccount "$(jq -cn --arg a "$1" '[$a]')" >/dev/null
  local keep=() a
  for a in ${IMPERSONATED+"${IMPERSONATED[@]}"}; do [ "$a" = "$1" ] || keep+=("$a"); done
  IMPERSONATED=(${keep+"${keep[@]}"})
}
cleanup_impersonation() {
  local a
  for a in ${IMPERSONATED+"${IMPERSONATED[@]}"}; do
    echo "locking $a again" >&2
    rpc anvil_stopImpersonatingAccount "$(jq -cn --arg a "$a" '[$a]')" >/dev/null 2>&1 || true
  done
  IMPERSONATED=()
}
trap cleanup_impersonation EXIT

# A HOOK THAT EXISTS TO BE FAILED AT. selftest-wallet-gate.sh sets this to check
# that a prepare which dies mid-way still locks what it unlocked. Nothing else
# reads it, and it does nothing when unset.
fail_point() {
  [ "${CURB_PREPARE_FAIL_AT:-}" = "$1" ] || return 0
  die "injected failure at $1 (CURB_PREPARE_FAIL_AT)"
}

# eth_call at a specific block, returning the raw word.
call_at() { # to data block-number-decimal-or-latest
  local blk=$3
  [ "$blk" = latest ] || blk=$(printf '0x%x' "$blk")
  rpc eth_call "$(jq -cn --arg to "$1" --arg data "$2" --arg b "$blk" '[{to:$to,data:$data},$b]')"
}

# ARBITRARY WIDTH, BECAUSE BALANCES ARE uint256 AND THE SHELL IS NOT.
# `[ x -gt y ]` and `$((x - y))` are 64-bit, and a token balance with 18
# decimals passes that in the first thousand tokens. Comparing them with the
# shell does not overflow quietly - it errors and takes the FALSE branch, so
# every balance check reported its step as broken. Every comparison on a chain
# value goes through python.
big() { python3 -c 'import sys; print(int(sys.argv[1],0))' "$1"; }
num_gt() { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) > int(sys.argv[2]) else 1)' "$1" "$2"; }
num_lt() { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) < int(sys.argv[2]) else 1)' "$1" "$2"; }
num_sub() { python3 -c 'import sys; print(int(sys.argv[1]) - int(sys.argv[2]))' "$1" "$2"; }

word_addr() { echo "0x${1: -40}"; }
pad_addr() { echo "0x000000000000000000000000$(lower "${1#0x}")"; }
require_addr() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$2 is not an address: $1"; }

# ---------------------------------------------------------------- selectors
# COMPUTED, NEVER COPIED. A selector pasted from somewhere else is a selector
# that can quietly stop standing for the signature it was taken from.
#
# launch() IS READ OFF THE BUILD, NOT TYPED. This line used to hold the
# signature of a launch() from before LaunchConfig - fifteen fields and a fee
# snapshot - so the gate looked for a selector no factory had, and "the wallet
# created a launch" could not pass for any session. The artifact is the code
# prepare deployed, so its selector is the one the wallet's transaction carries.
launch_selector() {
  local art=out/CurbLaunchFactory.sol/CurbLaunchFactory.json sel
  [ -f "$art" ] || die "no build artifact at $art - run prepare (it builds) before verify"
  sel=$(jq -r '[.methodIdentifiers | to_entries[] | select(.key | startswith("launch("))] |
    if length == 1 then "0x" + .[0].value else empty end' "$art")
  [[ "$sel" =~ ^0x[0-9a-f]{8}$ ]] || die "the factory's artifact does not hold exactly one launch(...) function"
  echo "$sel"
}
selectors() {
  SEL_LAUNCH=$(launch_selector)
  SEL_BUY=$(base-cast sig "buy(uint256,uint256,address)")
  SEL_SELL=$(base-cast sig "sell(uint256,uint256,address)")
  SEL_GRADUATE=$(base-cast sig "graduate(address)")
  SEL_EXECUTE=$(base-cast sig "execute(bytes,bytes[],uint256)")
  TOPIC_CREATED=$(base-cast sig-event "LaunchCreated(address,address,address,uint256,uint16)")
  TOPIC_GRADUATED=$(base-cast sig-event "Graduated(address,address,uint256,uint160,uint128)")
  TOPIC_BURNED=$(base-cast sig-event "RemainderBurned(address,uint256)")
}

# ---------------------------------------------------------------- prepare
do_prepare() {
  local wallet=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --wallet) wallet="${2:-}"; shift 2 ;;
      --rpc) RPC="${2:-}"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  [ -n "$wallet" ] || die "prepare needs --wallet 0x... - the address YOUR TEST WALLET holds"
  require_addr "$wallet" "the wallet address"

  # THE NODE VERIFIED MUST BE THE NODE DEPLOYED TO. Answering is not evidence
  # of being the pinned fork; the same reasoning as demo-app.sh.
  bash script/b20/verify-fork.sh --rpc "$RPC" --identity >/dev/null \
    || { bash script/b20/verify-fork.sh --rpc "$RPC" --identity || true; die "the node is not the pinned fork"; }

  local chainid
  chainid=$(rpc eth_chainId '[]')

  echo "funding ${wallet} with gas..."
  rpc anvil_setBalance "$(jq -cn --arg a "$wallet" --arg v "$GAS_WEI" '[$a,$v]')" >/dev/null

  # THE WALLET DEPLOYS, AND IS THE PLATFORM RECIPIENT AND THE POLICY OWNER.
  # launch() is open to anyone now, so this is no longer what lets the wallet
  # create a launch - it used to be owner-only, and this comment said so. It
  # keeps one identity across the flow: the fees the flow earns come back to
  # the wallet that signed it.
  echo "deploying the stack, protocol fees to ${wallet}..."
  impersonate "$wallet"
  fail_point deploy
  local out=/tmp/curb-wallet-deploy.log
  # THE PLATFORM'S FEE RECIPIENT IS SET HERE, DELIBERATELY. DeployCurb requires
# it rather than defaulting to the deployer: every launch freezes the recipient
# in force into its own record, so a deployment that guessed it leaves those
# launches paying the guess for good (the hook's own copy can be moved later,
# for later launches only). This is TEST CONFIGURATION - the wallet this
# session drives, impersonated: one key, as recipient and as policy owner -
# written where a reader can see it, with the opt-ins DeployCurb refuses to
# run without.
#
# FOUNDRY_BROADCAST=broadcast/local, BECAUSE THIS NODE SERVES CHAIN 8453. forge
# files a broadcast under broadcast/<script>/<chain id>/, and 8453 is where the
# mainnet run records itself - the preflight refuses to find a run there. The
# browser suite's own runners (demo-app.sh, demo-waiting.sh) do the same; a
# hand-driven session here would otherwise leave a run in that directory.
#
# THE HOLDER SHARING ROLES ARE ANVIL'S ACCOUNTS 5, 6 AND 7, not the wallet:
# a keeper rehearsal on this fork has to publish with a key it holds, and the
# wallet's key is only ever in the wallet. Test configuration, as demo-app.sh
# names it. The wallet, as the policy owner, is a vetoer besides.
  local sharing_publisher=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
  local sharing_keeper=0x976EA74026E726554dB657fA54763abd0C3a0aa9
  local sharing_vetoer=0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
FOUNDRY_BROADCAST=broadcast/local CURB_DEMO_LAUNCH=true CURB_ALLOW_EOA_RECIPIENT=true CURB_ALLOW_EOA_POLICY_OWNER=true CURB_ALLOW_SAME_RECIPIENT_AND_OWNER=true CURB_PLATFORM_RECIPIENT="$wallet" CURB_SHARING_PUBLISHER="$sharing_publisher" CURB_SHARING_KEEPER_PAYEE="$sharing_keeper" CURB_SHARING_VETOERS="$sharing_vetoer" base-forge script script/DeployCurb.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$wallet" \
    > "$out" 2>&1 || { tail -30 "$out"; die "the deployment did not run"; }
  grep -q "ONCHAIN EXECUTION COMPLETE" "$out" || { tail -30 "$out"; die "the deployment did not complete"; }
  # IMPERSONATION IS TURNED OFF AGAIN, and that matters to the gate: with it
  # left on, anything on this machine could send from the wallet's address
  # without its key, and "every transaction came from the wallet" would stop
  # meaning the wallet signed it. The EXIT trap does the same for a prepare
  # that never gets here.
  unimpersonate "$wallet"

  local factory lens graduator hook registry catalog distributorFactory
  factory=$(grep -m1 '^  CurbLaunchFactory' "$out" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
  lens=$(grep -m1 '^  LaunchLens' "$out" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
  graduator=$(grep -m1 '^  Graduator' "$out" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
  hook=$(grep -m1 '^  FeeHook' "$out" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
  registry=$(grep -m1 '^  LaunchRegistry' "$out" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
  catalog=$(grep -m1 '^  SharingCatalog' "$out" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
  distributorFactory=$(grep -m1 '^  HolderDistributorFactory' "$out" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
  local n
  for n in factory lens graduator hook registry catalog distributorFactory; do
    [ -n "${!n}" ] || die "could not read $n out of the deployment output"
    [ "$(base-cast codesize "${!n}" --rpc-url "$RPC")" -gt 0 ] || die "$n ${!n} has no code on $RPC"
  done
  bash script/b20/check-sharing.sh "$RPC" "$graduator" "$catalog" "$distributorFactory" \
    "$sharing_publisher" "$sharing_keeper" "$sharing_vetoer" "$wallet" \
    || die "the holder sharing contracts are not what this session asked for"

  # THE CURB ROUTER, through the deployment script the real one uses: it lands
  # at the address the page pins, or this stops (deploy-router.sh says why).
  # On a fork that already holds it, it is found there and named again. Before
  # the session window opens, from a sender of its own, so the gate's "every
  # transaction came from the wallet" is about the session alone.
  local routerOut curbRouter
  routerOut=$(RPC="$RPC" bash script/b20/deploy-router.sh) || die "the CURB router was not deployed"
  curbRouter=$(printf '%s\n' "$routerOut" | awk '$1 == "router" { print $2 }')
  [ -n "$curbRouter" ] || die "could not read the router's address out of deploy-router.sh"

  echo "funding ${wallet} with NVDAc..."
  rpc anvil_setBalance "$(jq -cn --arg a "$WHALE" '[$a,"0xde0b6b3a7640000"]')" >/dev/null
  impersonate "$WHALE"
  fail_point fund
  base-cast send "$NVDAC" "transfer(address,uint256)" "$wallet" "$FUND" \
    --from "$WHALE" --unlocked --rpc-url "$RPC" >/dev/null
  unimpersonate "$WHALE"

  local bal
  bal=$(big "$(call_at "$NVDAC" "$(base-cast calldata 'balanceOf(address)' "$wallet")" latest)")
  [ "$bal" -ge "$FUND" ] || die "the wallet holds $bal NVDAc, expected at least $FUND"

  # ---- THE OTHER CHAIN, and why it is recorded rather than assumed away.
  #
  # A page that wrongly sends while the wallet is on the wrong network sends it
  # THERE, not here. Looking only at the fork would then find nothing missing
  # and call the step passed. So the scratch chain is part of the session, and
  # the wallet is funded on it ON PURPOSE: an unfunded account cannot pay for
  # the mistake, and the check would pass because the node refused rather than
  # because the page did.
  local scratchJson='null' scratchChain scratchBlock
  if scratchChain=$(rpc_at "$SCRATCH_RPC" eth_chainId '[]' 2>/dev/null); then
    [ "$scratchChain" != "$chainid" ] \
      || die "the chain at $SCRATCH_RPC serves chain id $(big "$chainid"), the same as the fork - the wrong-network step needs a different one"
    rpc_at "$SCRATCH_RPC" anvil_setBalance "$(jq -cn --arg a "$wallet" --arg v "$GAS_WEI" '[$a,$v]')" >/dev/null
    scratchBlock=$(big "$(rpc_at "$SCRATCH_RPC" eth_blockNumber '[]')")
    scratchJson=$(jq -cn --arg rpc "$SCRATCH_RPC" --arg c "$scratchChain" --argjson b "$scratchBlock" \
      '{rpc:$rpc,chainId:$c,startBlock:$b}')
    echo "scratch chain at $SCRATCH_RPC, chain id $(big "$scratchChain")"
  else
    echo "WARNING: nothing answered at $SCRATCH_RPC." >&2
    echo "         The wrong-network step has no other chain to be checked on, and" >&2
    echo "         verify will REFUSE it rather than pass it on the fork alone." >&2
    echo "         Start it with: bash script/b20/scratch-node.sh" >&2
  fi

  # THE WINDOW OPENS HERE. Everything mined after this block is the session,
  # and the gate requires all of it to have come from the wallet.
  local start
  start=$(big "$(rpc eth_blockNumber '[]')")

  jq -n --arg rpc "$RPC" --arg chainId "$chainid" --arg wallet "$(lower "$wallet")" \
    --arg factory "$factory" --arg lens "$lens" --arg graduator "$graduator" \
    --arg hook "$hook" --arg registry "$registry" --arg nvdac "$NVDAC" \
    --arg router "$UNIVERSAL_ROUTER" --arg permit2 "$PERMIT2" --argjson start "$start" \
    --arg catalog "$catalog" --arg distributorFactory "$distributorFactory" --arg curbRouter "$curbRouter" \
    --argjson scratch "$scratchJson" \
    '{rpc:$rpc,chainId:$chainId,wallet:$wallet,factory:$factory,lens:$lens,graduator:$graduator,
      hook:$hook,registry:$registry,nvdac:$nvdac,router:$router,permit2:$permit2,
      catalog:$catalog,distributorFactory:$distributorFactory,curbRouter:$curbRouter,
      startBlock:$start,scratch:$scratch,marks:[]}' > "$SESSION"

  cat <<EOF

READY. The session file is $SESSION

  1. In a SEPARATE browser profile with a THROWAWAY wallet, add both networks:
       Name         CURB local fork          CURB scratch
       RPC URL      $RPC        http://127.0.0.1:8547
       Chain ID     $(big "$chainid")                     31337
       Symbol       ETH                      ETH
     The scratch chain is only for the wrong-network step, and it needs
     script/b20/scratch-node.sh running. Start on CURB local fork.

  2. The wallet's account must be
       $wallet
     and nothing else is funded. This address owns the factory on this fork.

  3. Serve the page and open it:
       node web/e2e/serve.js          (in another terminal)
       http://127.0.0.1:8778/app.html?factory=$factory&lens=$lens&rpc=$RPC

  4. Follow web/REAL_WALLET_TEST.txt. It says where to run
       bash script/b20/wallet-session.sh mark <name>

  5. Then:
       bash script/b20/wallet-session.sh verify

  rpc        $RPC   (chain $(big "$chainid"))
  factory    $factory
  lens       $lens
  graduator  $graduator
  hook       $hook
  catalog    $catalog
  sharing    $distributorFactory   (publisher $sharing_publisher)
  router     $curbRouter
  wallet     $wallet   ($bal raw NVDAc, 1000 ETH for gas)
EOF
}

# ---------------------------------------------------------------- mark
do_mark() {
  [ $# -ge 1 ] || die "mark needs a name"
  local name=$1
  [ -f "$SESSION" ] || die "no session: run prepare first"
  RPC=$(jq -r .rpc "$SESSION")
  local wallet blk nonce tmp srpc scratchJson='null' sblk snonce
  wallet=$(jq -r .wallet "$SESSION")
  blk=$(big "$(rpc eth_blockNumber '[]')")
  nonce=$(big "$(rpc eth_getTransactionCount "$(jq -cn --arg a "$wallet" '[$a,"latest"]')")")

  # BOTH CHAINS, because a mistaken send during the wrong-network step goes to
  # the other one and the fork would look untouched.
  srpc=$(jq -r '.scratch.rpc // empty' "$SESSION")
  if [ -n "$srpc" ]; then
    sblk=$(big "$(rpc_at "$srpc" eth_blockNumber '[]')")
    snonce=$(big "$(rpc_at "$srpc" eth_getTransactionCount "$(jq -cn --arg a "$wallet" '[$a,"latest"]')")")
    scratchJson=$(jq -cn --argjson b "$sblk" --argjson n "$snonce" '{block:$b,nonce:$n}')
  fi

  tmp=$(mktemp)
  jq --arg n "$name" --argjson b "$blk" --argjson c "$nonce" --argjson s "$scratchJson" \
    '.marks += [{name:$n, fork:{block:$b, nonce:$c}, scratch:$s}]' "$SESSION" > "$tmp" && mv "$tmp" "$SESSION"
  echo "mark $name: fork block $blk nonce $nonce${srpc:+, scratch block $sblk nonce $snonce}"
}

# ---------------------------------------------------------------- verify
PASS=0
FAIL=0
check() { # ok|bad  name  [detail]
  if [ "$1" = ok ]; then
    PASS=$((PASS + 1)); printf '  PASS  %s\n' "$2"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        %s\n' "$2" "${3:-}"
  fi
}

# jq has no hex literals and block numbers come back as "0x...". Decimal block
# heights are far inside what a double represents exactly, so this is safe for
# blockNumber and for nothing else - balances are done in python.
JQ_HEX='def hexdec: ltrimstr("0x") | if . == "" then 0 else (explode | reduce .[] as $c (0; . * 16 + (if $c >= 48 and $c <= 57 then $c - 48 elif $c >= 97 then $c - 87 else $c - 55 end))) end;'

# Every transaction in [from,to] with its receipt and a decimal `bn`.
window_txs() { # from to
  local from=$1 to=$2 body="[" n i=0 blocks txs n_tx receipts h
  if [ "$from" -gt "$to" ]; then echo "[]"; return; fi
  for ((n = from; n <= to; n++)); do
    [ $i -gt 0 ] && body+=","
    body+=$(printf '{"jsonrpc":"2.0","id":%d,"method":"eth_getBlockByNumber","params":["0x%x",true]}' "$n" "$n")
    i=$((i + 1))
  done
  body+="]"
  blocks=$(curl -s -X POST -H 'content-type: application/json' --data "$body" "$RPC")
  txs=$(jq -c "$JQ_HEX"'[.[] | .result | select(. != null) | .transactions[] | . + {bn: (.blockNumber | hexdec)}]' <<<"$blocks")
  n_tx=$(jq 'length' <<<"$txs")
  if [ "$n_tx" -eq 0 ]; then echo "[]"; return; fi
  body="["; i=0
  while read -r h; do
    [ $i -gt 0 ] && body+=","
    body+=$(printf '{"jsonrpc":"2.0","id":%d,"method":"eth_getTransactionReceipt","params":["%s"]}' "$i" "$h")
    i=$((i + 1))
  done < <(jq -r '.[].hash' <<<"$txs")
  body+="]"
  receipts=$(curl -s -X POST -H 'content-type: application/json' --data "$body" "$RPC")
  jq -c --argjson r "$receipts" \
    '[. as $t | range(0; length) as $i | ($t[$i] + {receipt: ($r | map(select(.id == $i)) | .[0].result)})]' <<<"$txs"
}

window_txs_at() { local RPC="$1"; shift; window_txs "$@"; }

# Everything the wallet had mined on one endpoint, in (lo, hi].
mined_by_wallet() { # rpc lo hi
  local out
  out=$(window_txs_at "$1" $(($2 + 1)) "$3")
  jq -r --arg w "$WALLET" '[.[] | select((.from | ascii_downcase) == $w) | .hash] | join(" ")' <<<"$out"
}

# Marks that must bracket a step where NOTHING may reach a block.
#
# WHAT THIS MEASURES, AND WHAT IT DOES NOT. It is about what entered a block on
# the chains this session knows. It is NOT proof that the wallet's dialog never
# opened, that a request never left the page, or that the button was pressed at
# all - a transaction can sit in a mempool or be refused by a node and leave no
# trace here. The person following the runbook saw those; the chain did not.
quiet_between() { # before-mark after-mark title needs-scratch(yes|no)
  local a b title="$3" needScratch="${4:-no}"
  a=$(jq -c --arg n "$1" '[.marks[] | select(.name == $n)] | .[0] // empty' <<<"$S")
  b=$(jq -c --arg n "$2" '[.marks[] | select(.name == $n)] | .[0] // empty' <<<"$S")
  if [ -z "$a" ] || [ -z "$b" ]; then
    check bad "$title" "the marks $1 and $2 were not both recorded - the step was not run"
    return
  fi

  local reasons=() notes=()
  # ---- the fork.
  # TWO INDEPENDENT READINGS. The nonce is what the chain thinks the account has
  # sent; the scan is what was actually mined. A transaction that reverted on
  # chain still moves the nonce, so a page that sent something and got a revert
  # cannot pass this by having it fail.
  local fb fa fnb fna mined
  fb=$(jq -r .fork.block <<<"$a"); fa=$(jq -r .fork.block <<<"$b")
  fnb=$(jq -r .fork.nonce <<<"$a"); fna=$(jq -r .fork.nonce <<<"$b")
  mined=$(mined_by_wallet "$RPC" "$fb" "$fa")
  [ "$fnb" = "$fna" ] || reasons+=("on the fork the wallet's nonce moved $fnb -> $fna")
  [ -z "$mined" ] || reasons+=("on the fork these were mined from the wallet: $mined")
  notes+=("fork nonce $fnb over blocks $fb..$fa")

  # ---- the other chain, which is where a wrong-network send would land.
  local srpc sb sa snb sna smined
  srpc=$(jq -r '.scratch.rpc // empty' <<<"$S")
  if [ -z "$srpc" ]; then
    [ "$needScratch" != yes ] || reasons+=(
      "the scratch chain was not running when this session was prepared, so the one chain a wrong-network send would have reached was never looked at")
  else
    sb=$(jq -r '.scratch.block // empty' <<<"$a"); sa=$(jq -r '.scratch.block // empty' <<<"$b")
    snb=$(jq -r '.scratch.nonce // empty' <<<"$a"); sna=$(jq -r '.scratch.nonce // empty' <<<"$b")
    if [ -z "$sb" ] || [ -z "$sa" ]; then
      reasons+=("these marks carry no reading of $srpc")
    else
      smined=$(mined_by_wallet "$srpc" "$sb" "$sa")
      [ "$snb" = "$sna" ] || reasons+=("on the scratch chain the wallet's nonce moved $snb -> $sna")
      [ -z "$smined" ] || reasons+=("on the scratch chain these were mined from the wallet: $smined")
      notes+=("scratch nonce $snb over blocks $sb..$sa")
    fi
  fi

  if [ ${#reasons[@]} -eq 0 ]; then
    check ok "$title - $(IFS=';'; echo "${notes[*]}" | sed 's/;/; /g')"
  else
    check bad "$title" "$(IFS=';'; echo "${reasons[*]}" | sed 's/;/; /g')"
  fi
}

do_verify() {
  [ -f "$SESSION" ] || die "no session: run prepare first"
  RPC=$(jq -r .rpc "$SESSION")
  selectors
  S=$(cat "$SESSION")
  WALLET=$(jq -r .wallet <<<"$S")
  local factory lens graduator nvdac router start latest count strangers
  factory=$(lower "$(jq -r .factory <<<"$S")")
  lens=$(jq -r .lens <<<"$S")
  graduator=$(lower "$(jq -r .graduator <<<"$S")")
  nvdac=$(jq -r .nvdac <<<"$S")
  router=$(lower "$(jq -r .router <<<"$S")")
  start=$(jq -r .startBlock <<<"$S")

  latest=$(big "$(rpc eth_blockNumber '[]')")
  TX=$(window_txs $((start + 1)) "$latest")
  count=$(jq 'length' <<<"$TX")

  echo "session window: blocks $((start + 1))..$latest, $count transactions"
  echo

  # ---- EVERY TRANSACTION CAME FROM THE WALLET.
  # The point of the exercise is that a real wallet signed these. A transaction
  # from any other sender means something else was driving the chain, and every
  # check below would be measuring that instead.
  strangers=$(jq -r --arg w "$WALLET" \
    '[.[] | select((.from | ascii_downcase) != $w) | "\(.hash) from \(.from)"] | join("; ")' <<<"$TX")
  if [ "$count" -eq 0 ]; then
    check bad "every transaction in the session came from the wallet" "the window is empty - nothing was sent at all"
  elif [ -n "$strangers" ]; then
    check bad "every transaction in the session came from the wallet" "$strangers"
  else
    check ok "every transaction in the session came from the wallet ($count of them)"
  fi

  # ---- CREATE
  local created token curve
  created=$(jq -c --arg to "$factory" --arg sel "$SEL_LAUNCH" --arg t "$TOPIC_CREATED" \
    --arg w "$(pad_addr "$WALLET")" '
    [ .[] | select((.to // "") | ascii_downcase == $to)
          | select(.input | startswith($sel))
          | select(.receipt.status == "0x1")
          | . as $tx
          | (.receipt.logs[] | select(.topics[0] == $t and ((.topics[3] // "") | ascii_downcase) == $w)) as $log
          | {hash: $tx.hash, bn: $tx.bn, token: $log.topics[1], curve: $log.topics[2]} ] | .[0] // empty' <<<"$TX")
  if [ -z "$created" ]; then
    check bad "the wallet created a launch" \
      "no successful launch() to $factory emitting LaunchCreated with the wallet as creator"
  else
    token=$(word_addr "$(jq -r .token <<<"$created")")
    curve=$(word_addr "$(jq -r .curve <<<"$created")")
    check ok "the wallet created a launch - token $token, curve $curve"
  fi

  # Everything below needs the curve the create produced. Without it there is
  # nothing to look for and saying so once is better than five repetitions.
  if [ -z "${curve:-}" ]; then
    echo
    echo "$PASS passed, $FAIL failed"
    exit 1
  fi

  local balSel supSel gradBlock
  balSel=$(base-cast calldata 'balanceOf(address)' "$WALLET")
  supSel=$(base-cast calldata 'totalSupply()')

  # ---- BUY: the wallet called it, and the tokens arrived.
  local buy b before after
  buy=$(jq -c --arg to "$(lower "$curve")" --arg sel "$SEL_BUY" \
    '[.[] | select((.to // "") | ascii_downcase == $to) | select(.input | startswith($sel))
          | select(.receipt.status == "0x1") | {hash, bn}] | .[0] // empty' <<<"$TX")
  if [ -z "$buy" ]; then
    check bad "the wallet bought on the curve" "no successful buy() to $curve"
  else
    b=$(jq -r .bn <<<"$buy")
    before=$(big "$(call_at "$token" "$balSel" $((b - 1)))")
    after=$(big "$(call_at "$token" "$balSel" "$b")")
    if num_gt "$after" "$before"; then
      check ok "the wallet bought on the curve - its balance went $before -> $after in block $b"
    else
      check bad "the wallet bought on the curve" "buy() succeeded but the balance did not rise: $before -> $after"
    fi
    # SELLING WAS A REAL STATE, at a real block, read from the lens the page
    # reads. The page having drawn the word is not evidence of anything.
    local sellingAt
    sellingAt=$(big "$(call_at "$lens" "$(base-cast calldata 'statusOf(address)' "$token")" "$b")")
    if [ "$sellingAt" = 1 ]; then
      check ok "the lens said Selling (1) at the block of that buy"
    else
      check bad "the lens said Selling (1) at the block of that buy" "it said $sellingAt"
    fi
  fi

  # ---- SELL: and the tokens went back, against NVDAc returning.
  local sell tb ta qb qa
  sell=$(jq -c --arg to "$(lower "$curve")" --arg sel "$SEL_SELL" \
    '[.[] | select((.to // "") | ascii_downcase == $to) | select(.input | startswith($sel))
          | select(.receipt.status == "0x1") | {hash, bn}] | .[0] // empty' <<<"$TX")
  if [ -z "$sell" ]; then
    check bad "the wallet sold on the curve" "no successful sell() to $curve"
  else
    b=$(jq -r .bn <<<"$sell")
    tb=$(big "$(call_at "$token" "$balSel" $((b - 1)))"); ta=$(big "$(call_at "$token" "$balSel" "$b")")
    qb=$(big "$(call_at "$nvdac" "$balSel" $((b - 1)))"); qa=$(big "$(call_at "$nvdac" "$balSel" "$b")")
    if num_lt "$ta" "$tb" && num_gt "$qa" "$qb"; then
      check ok "the wallet sold on the curve - tokens $tb -> $ta, NVDAc $qb -> $qa"
    else
      check bad "the wallet sold on the curve" \
        "sell() succeeded but the balances do not show it: tokens $tb -> $ta, NVDAc $qb -> $qa"
    fi
  fi

  # ---- GRADUATION: the wallet pressed it, the chain says Graduated, the LP is
  # locked, and the burn is exactly the amount the event names.
  local grad lock status holds liq burned sBefore sAfter
  grad=$(jq -c --arg to "$graduator" --arg sel "$SEL_GRADUATE" --arg t "$TOPIC_GRADUATED" \
    --arg tok "$(pad_addr "$token")" '
    [ .[] | select((.to // "") | ascii_downcase == $to)
          | select(.input | startswith($sel))
          | select(.receipt.status == "0x1")
          | . as $tx
          | (.receipt.logs[] | select(.topics[0] == $t and ((.topics[1] // "") | ascii_downcase) == $tok)) as $log
          | {hash: $tx.hash, bn: $tx.bn, lock: $log.topics[2], data: $log.data,
             logs: $tx.receipt.logs} ] | .[0] // empty' <<<"$TX")
  if [ -z "$grad" ]; then
    # WHY THIS CAN BE MISSING EVEN THOUGH THE LAUNCH GRADUATED. The curve calls
    # the graduator itself on the buy that crosses the threshold, and when that
    # succeeds there is no Waiting state and no button to press. The page's
    # permissionless button only has work to do when the automatic attempt
    # FAILED - which is why the runbook says to hand-set a tight gas limit on
    # the crossing buy. Whether that failure was an out-of-gas one is not in
    # the event or the receipt - the catch keeps no reason - and this gate does
    # not go looking for it in a trace either. What it checks is only that a
    # launch which graduated inside a buy does not satisfy this.
    check bad "the wallet graduated the launch with the permissionless button" \
      "no successful graduate($token) to $graduator emitting Graduated - if it graduated inside the crossing buy, the curve's own attempt succeeded and the Waiting state never existed"
  else
    gradBlock=$(jq -r .bn <<<"$grad")
    lock=$(word_addr "$(jq -r .lock <<<"$grad")")
    check ok "the wallet graduated the launch with the permissionless button - $(jq -r .hash <<<"$grad") in block $gradBlock, lock $lock"

    # AND IT WAS WAITING BEFORE IT. The button is the whole reason that state
    # has a name; a graduation that came out of Selling never went through it.
    local waitingAt
    waitingAt=$(big "$(call_at "$lens" "$(base-cast calldata 'statusOf(address)' "$token")" $((gradBlock - 1)))")
    if [ "$waitingAt" = 2 ]; then
      check ok "the lens said Waiting (2) in the block before the button was pressed"
    else
      check bad "the lens said Waiting (2) in the block before the button was pressed" "it said $waitingAt"
    fi

    status=$(big "$(call_at "$lens" "$(base-cast calldata 'statusOf(address)' "$token")" latest)")
    if [ "$status" = 3 ]; then
      check ok "the lens reports Graduated (3)"
    else
      check bad "the lens reports Graduated (3)" "it reports $status"
    fi

    # LOCKED FOREVER: the lock holds the position and its liquidity, and has
    # no unlock time to read - the Graduated event carries none either.
    holds=$(big "$(call_at "$lock" "$(base-cast calldata 'holdsPosition()')" latest)")
    liq=$(big "$(call_at "$lock" "$(base-cast calldata 'lockedLiquidity()')" latest)")
    if [ "$holds" = 1 ] && [ "$liq" != 0 ]; then
      check ok "the LP position is held by the lock $lock, locked forever ($liq liquidity)"
    else
      check bad "the LP position is locked" "holdsPosition=$holds lockedLiquidity=$liq"
    fi

    # THE BURN IS MEASURED, not taken from the event alone: total supply on
    # either side of the graduation block must differ by exactly what
    # RemainderBurned says it burned.
    burned=$(jq -r --arg t "$TOPIC_BURNED" --arg tok "$(pad_addr "$token")" \
      '[.logs[] | select(.topics[0] == $t and ((.topics[1] // "") | ascii_downcase) == $tok) | .data] | .[0] // ""' <<<"$grad")
    if [ -z "$burned" ]; then
      check bad "the remainder was burned" "no RemainderBurned log for $token"
    else
      burned=$(big "$burned")
      sBefore=$(big "$(call_at "$token" "$supSel" $((gradBlock - 1)))")
      sAfter=$(big "$(call_at "$token" "$supSel" "$gradBlock")")
      if [ "$(num_sub "$sBefore" "$sAfter")" = "$burned" ]; then
        check ok "the remainder was burned - supply fell by exactly $burned ($sBefore -> $sAfter)"
      else
        check bad "the remainder was burned" "the event says $burned but supply moved $sBefore -> $sAfter"
      fi
    fi
  fi

  # ---- POOL TRADE, after graduation, through the router.
  local pool
  pool=$(jq -c --arg to "$router" --arg sel "$SEL_EXECUTE" --argjson after "${gradBlock:-0}" \
    '[.[] | select((.to // "") | ascii_downcase == $to) | select(.input | startswith($sel))
          | select(.receipt.status == "0x1") | select(.bn > $after) | {hash, bn}] | .[0] // empty' <<<"$TX")
  if [ -z "${gradBlock:-}" ]; then
    check bad "the wallet traded the pool after graduation" "there is no graduation to place a trade after"
  elif [ -z "$pool" ]; then
    check bad "the wallet traded the pool after graduation" \
      "no successful execute() to the UniversalRouter at $router in a block after $gradBlock"
  else
    b=$(jq -r .bn <<<"$pool")
    tb=$(big "$(call_at "$token" "$balSel" $((b - 1)))"); ta=$(big "$(call_at "$token" "$balSel" "$b")")
    qb=$(big "$(call_at "$nvdac" "$balSel" $((b - 1)))"); qa=$(big "$(call_at "$nvdac" "$balSel" "$b")")
    if [ "$ta" != "$tb" ] && [ "$qa" != "$qb" ]; then
      check ok "the wallet traded the pool in block $b - tokens $tb -> $ta, NVDAc $qb -> $qa"
    else
      check bad "the wallet traded the pool after graduation" \
        "execute() succeeded but nothing moved: tokens $tb -> $ta, NVDAc $qb -> $qa"
    fi
  fi

  # ---- THE TWO REFUSALS.
  echo
  echo "  the two checks below are about what ENTERED A BLOCK. The chain cannot"
  echo "  show whether the wallet's dialog opened, whether a request left the"
  echo "  page, or whether the button was pressed at all."
  quiet_between reject-before reject-after "declining in the wallet put nothing in a block" no
  quiet_between network-before network-after \
    "a wallet on the wrong network put nothing in a block on either chain" yes

  echo
  echo "$PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ] || exit 1
}

case "${1:-}" in
  prepare) shift; do_prepare "$@" ;;
  mark) shift; do_mark "$@" ;;
  verify) shift; do_verify "$@" ;;
  show) [ -f "$SESSION" ] && jq . "$SESSION" || die "no session" ;;
  *) echo "usage: $0 prepare --wallet 0x... | mark <name> | verify | show" >&2; exit 2 ;;
esac
