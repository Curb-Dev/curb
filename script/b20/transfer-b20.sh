#!/usr/bin/env bash
# Moves real NVDAc on the local fork and asserts both sides moved by exactly
# the amount. A check, not a demonstration: any mismatch exits non-zero.
set -euo pipefail
source "$(dirname "$0")/env.sh"

WHALE="${WHALE:-0x4446adc0b8136ffc55ddb7a488ba5509ace2a5ef}"
DEST="${DEST:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
AMT="${AMT:-100000000}"   # 1.0 NVDAc, 8 decimals

impersonating=0
cleanup () {
  # Must run even when the send fails, or the account is left unlocked and a
  # later step can transact as someone else without meaning to.
  if [ "$impersonating" = "1" ]; then
    $CAST rpc anvil_stopImpersonatingAccount "$WHALE" --rpc-url "$FORK_RPC" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

bal () { $CAST call "$NVDAC" 'balanceOf(address)(uint256)' "$1" --rpc-url "$FORK_RPC" | awk '{print $1}'; }

echo "sender    $WHALE"
echo "recipient $DEST"
echo "amount    $AMT"
echo

w0=$(bal "$WHALE"); d0=$(bal "$DEST")
echo "before  sender=$w0  recipient=$d0"
[ "$w0" -ge "$AMT" ] || die "sender holds $w0, needs $AMT"

$CAST rpc anvil_impersonateAccount "$WHALE" --rpc-url "$FORK_RPC" >/dev/null
impersonating=1
$CAST rpc anvil_setBalance "$WHALE" 0xde0b6b3a7640000 --rpc-url "$FORK_RPC" >/dev/null

TX=$($CAST send "$NVDAC" 'transfer(address,uint256)(bool)' "$DEST" "$AMT" \
       --from "$WHALE" --unlocked --rpc-url "$FORK_RPC" --json)

HASH=$(echo "$TX"   | python3 -c 'import sys,json; print(json.load(sys.stdin)["transactionHash"])')
STATUS=$(echo "$TX" | python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])')
GAS=$(echo "$TX"    | python3 -c 'import sys,json; print(int(json.load(sys.stdin)["gasUsed"],16))')

# Assert, do not just print. A reverted transfer still returns a receipt.
[ "$STATUS" = "0x1" ] || die "transfer reverted: status=$STATUS tx=$HASH"

w1=$(bal "$WHALE"); d1=$(bal "$DEST")
echo "after   sender=$w1  recipient=$d1"
echo
echo "receipt status=$STATUS gasUsed=$GAS"
echo "tx      $HASH"

[ "$(( w0 - w1 ))" = "$AMT" ] || die "sender moved $(( w0 - w1 )), expected $AMT"
[ "$(( d1 - d0 ))" = "$AMT" ] || die "recipient moved $(( d1 - d0 )), expected $AMT"
echo "OK: both sides moved exactly $AMT"
