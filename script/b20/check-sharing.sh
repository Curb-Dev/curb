#!/usr/bin/env bash
# THE HOLDER SHARING CONTRACTS OF A DEPLOYMENT, READ BACK OFF THE CHAIN.
#
#   bash script/b20/check-sharing.sh <rpc> <graduator> <catalog> <distributor factory> \
#     <publisher> <keeper payee> <vetoer>...
#   bash script/b20/check-sharing.sh --selftest
#     the same checks against a stand-in for cast with fixed answers - no chain
#
# The runner scripts (demo-app.sh, demo-waiting.sh, wallet-session.sh) call it
# after DeployCurb, with the roles they asked for. DeployCurb reads its own
# links back before it prints anything, but it compares the contracts with the
# values IT read from the environment; this compares them with the values the
# caller meant to pass, so a role that reached the wrong variable, or a default
# the caller did not expect, stops the run here.
#
# Every address named must hold code where code is expected, and every answer
# must be exactly the one named. Prints one ok line, or names the first
# difference and exits 1.
#
# THE MAINNET READ-BACK IS check-deployment.sh, which asks all of this and the
# rest of the deployment - owners, the catalog's owner and bootstrapper, the
# lens - from the run record. This stays for the runner scripts, which have
# the addresses and no record.
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
CAST="${CAST_BIN:-base-cast}"

die() { echo "FAIL: $*" >&2; exit 1; }
lower() { tr 'A-Z' 'a-z' <<<"$1"; }
call() { # to sig [args] -> the answer, or stop
  local out
  out=$("$CAST" call "$1" "$2" "${@:3}" --rpc-url "$RPC" 2>&1) || die "$2 on $1 did not answer: $out"
  printf '%s' "$out" | awk '{print $1}'
}
same() { # what got want
  [ "$(lower "$2")" = "$(lower "$3")" ] || die "$1 is $2, not $3"
}
has_code() { [ "$("$CAST" codesize "$1" --rpc-url "$RPC" 2>/dev/null)" -gt 0 ] 2>/dev/null; }

check() { # rpc graduator catalog factory publisher keeper vetoer...
  RPC=$1 GRADUATOR=$2 CATALOG=$3 FACTORY=$4 PUBLISHER=$5 KEEPER=$6
  shift 6
  local a v impl
  [ $# -ge 1 ] || die "name at least one vetoer"
  for a in GRADUATOR CATALOG FACTORY; do
    v=${!a}
    [[ "$v" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$a is not an address: $v"
    has_code "$v" || die "$a $v has no code on $RPC"
  done
  same "the Graduator's sharing catalog" "$(call "$GRADUATOR" 'sharingCatalog()(address)')" "$CATALOG"
  same "the catalog's recommended factory" "$(call "$CATALOG" 'recommended()(address)')" "$FACTORY"
  [ "$(call "$CATALOG" 'isApproved(address)(bool)' "$FACTORY")" = true ] || die "the catalog does not approve $FACTORY"
  same "the distributor factory's Graduator" "$(call "$FACTORY" 'graduator()(address)')" "$GRADUATOR"
  same "the distributor factory's publisher" "$(call "$FACTORY" 'publisher()(address)')" "$PUBLISHER"
  same "the distributor factory's keeper payee" "$(call "$FACTORY" 'keeperPayee()(address)')" "$KEEPER"
  for v in "$@"; do
    [ "$(call "$FACTORY" 'isVetoer(address)(bool)' "$v")" = true ] || die "$v is not a vetoer of $FACTORY"
  done
  [ "$(call "$FACTORY" 'frozen()(bool)')" = false ] || die "the distributor factory is frozen"
  impl=$(call "$FACTORY" 'implementation()(address)')
  has_code "$impl" || die "the distributor implementation $impl has no code"
  same "the implementation's factory" "$(call "$impl" 'factory()(address)')" "$FACTORY"
  echo "sharing ok: catalog $CATALOG recommends $FACTORY; publisher $PUBLISHER, keeper payee $KEEPER, $# vetoer(s)"
}

# ---------------------------------------------------------------- selftest
# A stand-in for cast answers from a table: "<address> <signature> [<arg>]"
# and the answer, tab-separated, and holds code where a file lists it. Each
# case breaks one answer of a deployment that passes, and must be refused
# naming that answer.
selftest() {
  local t n=0 failed=0 got
  t=$(mktemp -d)
  trap 'rm -rf "$t"' RETURN
  cat >"$t/cast" <<'CAST'
#!/usr/bin/env bash
T="$(dirname "$0")"
case "$1" in
  codesize) grep -qix -- "$2" "$T/code" && echo 100 || echo 0 ;;
  call)
    key="$2 $3"; [ "${4:-}" != "--rpc-url" ] && key="$key $4"
    awk -F'\t' -v k="$(tr 'A-Z' 'a-z' <<<"$key")" 'tolower($1) == k { print $2; f = 1 } END { exit !f }' "$T/answers" \
      || { echo "execution reverted" >&2; exit 1; } ;;
  *) exit 1 ;;
esac
CAST
  chmod +x "$t/cast"
  local G=0x00000000000000000000000000000000000000a1 C=0x00000000000000000000000000000000000000a2
  local F=0x00000000000000000000000000000000000000a3 I=0x00000000000000000000000000000000000000a4
  local P=0x00000000000000000000000000000000000000b1 K=0x00000000000000000000000000000000000000b2
  local V1=0x00000000000000000000000000000000000000c1 V2=0x00000000000000000000000000000000000000c2
  local X=0x00000000000000000000000000000000000000ee
  good() {
    printf '%s\n' "$G" "$C" "$F" "$I" >"$t/code"
    printf '%s\t%s\n' \
      "$G sharingCatalog()(address)" "$C" \
      "$C recommended()(address)" "$F" \
      "$C isApproved(address)(bool) $F" "true" \
      "$F graduator()(address)" "$G" \
      "$F publisher()(address)" "$P" \
      "$F keeperPayee()(address)" "$K" \
      "$F isVetoer(address)(bool) $V1" "true" \
      "$F isVetoer(address)(bool) $V2" "true" \
      "$F frozen()(bool)" "false" \
      "$F implementation()(address)" "$I" \
      "$I factory()(address)" "$F" >"$t/answers"
  }
  answer() { # key new-answer: replace one answer
    awk -F'\t' -v k="$(tr 'A-Z' 'a-z' <<<"$1")" -v a="$2" 'BEGIN { OFS = "\t" } tolower($1) == k { $2 = a } { print }' \
      "$t/answers" >"$t/answers.new" && mv "$t/answers.new" "$t/answers"
  }
  sc() { # name expected got
    n=$((n + 1))
    if [ "$2" = "$3" ]; then printf '  pass  %s\n' "$1"; else printf '  FAIL  %s\n        expected: %s\n        got:      %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi
  }
  run() { (CAST_BIN="$t/cast"; CAST="$t/cast"; check rpc "$G" "$C" "$F" "$P" "$K" "$V1" "$V2") 2>&1; }
  refused() { # name, what the refusal must say
    local out; out=$(run)
    case "$out" in *"FAIL: "*"$2"*) sc "$1" refused refused ;; *) sc "$1" refused "passed: $out" ;; esac
  }
  good
  case "$(run)" in "sharing ok:"*) got=ok ;; *) got="$(run)" ;; esac
  sc "a deployment whose every answer is the one named passes (the control)" ok "$got"
  good; answer "$G sharingCatalog()(address)" "$X"; refused "the Graduator asking another catalog" "the Graduator's sharing catalog"
  good; answer "$C recommended()(address)" "$X"; refused "the catalog recommending another factory" "recommended factory"
  good; answer "$C isApproved(address)(bool) $F" "false"; refused "the catalog not approving the factory" "does not approve"
  good; answer "$F graduator()(address)" "$X"; refused "the factory on another Graduator" "the distributor factory's Graduator"
  good; answer "$F publisher()(address)" "$X"; refused "another publisher" "the distributor factory's publisher"
  good; answer "$F keeperPayee()(address)" "$X"; refused "another keeper payee" "the distributor factory's keeper payee"
  good; answer "$F isVetoer(address)(bool) $V2" "false"; refused "a named vetoer that is not one" "is not a vetoer"
  good; answer "$F frozen()(bool)" "true"; refused "a frozen factory" "is frozen"
  good; answer "$I factory()(address)" "$X"; refused "an implementation of another factory" "the implementation's factory"
  good; printf '%s\n' "$G" "$C" "$F" >"$t/code"; refused "an implementation with no code" "implementation"
  good; printf '%s\n' "$G" "$F" "$I" >"$t/code"; refused "a catalog with no code" "CATALOG"
  good; printf '%s\n' "$C" "$F" "$I" >"$t/code"; refused "a Graduator with no code" "GRADUATOR"
  good; printf '%s\n' "$G" "$C" "$I" >"$t/code"; refused "a factory with no code" "FACTORY"
  good; sed -i "/frozen()(bool)/d" "$t/answers"; refused "a question that is not answered" "did not answer"
  good; got=$( (CAST="$t/cast"; check rpc "$G" "$C" "$F" "$P" "$K") 2>&1 ) && got=passed || got=refused
  sc "no vetoer named at all is refused" refused "$got"
  echo
  if [ "$failed" -eq 0 ]; then echo "check-sharing selftest: all $n checks passed"; return 0; fi
  echo "check-sharing selftest: $failed of $n checks FAILED"; return 1
}

if [ "${1:-}" = "--selftest" ]; then selftest; exit $?; fi
[ $# -ge 7 ] || { echo "usage: $0 <rpc> <graduator> <catalog> <distributor factory> <publisher> <keeper payee> <vetoer>..." >&2; exit 2; }
check "$@"
