#!/usr/bin/env bash
# THE SIZE AND CODE GATE: what the build would put on chain, checked before
# anything is deployed. No chain, no key.
#
#   bash script/b20/size-gate.sh              builds (base-forge build --sizes), then checks out/
#   bash script/b20/size-gate.sh --no-build   checks out/ as it already is
#   bash script/b20/size-gate.sh --selftest   fixed artifacts through the same checks
#   bash script/b20/size-gate.sh --identity <out/File.sol/Name.json>
#                                             prints one artifact's code identity
#   bash script/b20/size-gate.sh --deployed <rpc> <address> <ContractName>
#                                             the code identity of what is AT an
#                                             address, against the pinned one (or,
#                                             for a contract with none, against
#                                             what this build would deploy)
#
# THREE CHECKS, each against a number written down in the repository:
#
# 1. RUNTIME SIZE AGAINST ITS BUDGET (core v2 design, E.4). A contract over
#    EIP-170's 24,576 bytes cannot be deployed at all, and the budgets keep a
#    margin under that so an edit that grows a contract is seen when it is
#    made, not on the day of the deployment. Every contract under src/ is held
#    to EIP-170; the ones below to their own budget.
#
# 2. THE CONTRACTS CORE V2 LEAVES UNCHANGED ARE BYTE-IDENTICAL to the build
#    they were reviewed in. The bonding curve, the fee escrow, the launch
#    token, the fee policy and the buyback vault are compared by their CODE
#    IDENTITY: keccak256 of the runtime code with its immutables zeroed (as the
#    compiler writes them into the artifact) and its metadata trailer cut off.
#    The metadata hash covers source paths and comments, which change with the
#    checkout without changing a byte of code; the immutables are what each
#    deployment fills in. What is left is the code. The expected identities are
#    script/DeployCurb.s.sol's IDENTITY_* constants, which DeployCurb checks
#    against the build before it sends anything - one place for each number.
#    After a deployment, --deployed asks the same question of the chain: the
#    code at an address with ITS immutables zeroed, where the artifact says
#    they are, and its trailer cut (ADDRESSES.txt's read-back uses it).
#
# 3. THE ROUTER'S RUNTIME CODE HASHES TO script/DeployRouter.s.sol's
#    EXPECTED_RUNTIME_CODEHASH. The router is deployed with CREATE2 and the page
#    pins its address, so a router that built differently would land somewhere
#    the page never calls. It has no immutables and no metadata hash, so its
#    whole runtime code is compared.
#
# It reads the artifacts, not the --sizes table: the table is printed for the
# reader, and the numbers checked are the artifacts' own lengths.
set -uo pipefail
unset CDPATH
cd "$(dirname "$0")/../.." || { echo "cannot enter the repository root"; exit 1; }

CAST="${CAST_BIN:-$HOME/.foundry/bin/base-cast}"
OUT_DIR="${SIZE_GATE_OUT:-out}"
EIP170=24576

# The budgets, design E.4. Name, budget in bytes.
# LaunchRegistry's was 6200 until register() began asking a record's curve
# whether the record is its own (the curve-reuse finding of the 2026-10-08
# audit): 6,094 B before that, 6,616 B with it.
BUDGETS="CurbLaunchFactory 23876
Graduator 21000
PositionLock 4700
FeeHook 11800
LaunchRegistry 6700
LaunchLens 3900
SharingCatalog 2500
HolderDistributorFactory 6500
HolderFeeDistributor 16000"

# The unchanged contracts: name, the IDENTITY_* constant in DeployCurb.s.sol.
UNCHANGED="PonsV2BondingCurve IDENTITY_BONDING_CURVE
FeeEscrow IDENTITY_FEE_ESCROW
CurbLaunchToken IDENTITY_LAUNCH_TOKEN
FeePolicy IDENTITY_FEE_POLICY
PonsV2BuybackVault IDENTITY_BUYBACK_VAULT"

fail_count=0
bad() { printf '  FAIL  %s\n' "$1"; fail_count=$((fail_count + 1)); }
good() { printf '  ok    %s\n' "$1"; }

# EVERY ARTIFACT OF A CONTRACT UNDER src/, one line each: name, path, runtime
# length. Read once per run, in one interpreter. An artifact belongs to src/
# when its compilation target is a src/ file - a test that merely imports src/
# lists src/ among its sources, so the sources are not asked.
scan_src() { # out dir
  python3 - "$1" <<'PY'
import json, os, sys
for root, _, files in sorted(os.walk(sys.argv[1])):
    for f in sorted(files):
        if not f.endswith(".json"):
            continue
        p = os.path.join(root, f)
        try:
            d = json.load(open(p))
            target = d["metadata"]["settings"]["compilationTarget"]
            o = d["deployedBytecode"]["object"]
        except Exception:
            continue
        if not any(k.startswith("src/") for k in target):
            continue
        o = o[2:] if o.startswith("0x") else o
        print("%s\t%s\t%d" % (f[:-5], p, len(o) // 2))
PY
}

# The artifact of a contract under src/, by contract name, from the scan. One
# file per name is required: two src/ contracts of one name would make "the"
# artifact a guess.
SCAN=""
artifact_of() { # name
  local hits
  hits=$(printf '%s\n' "$SCAN" | awk -F'\t' -v n="$1" '$1 == n { print $2 }')
  [ "$(printf '%s\n' "$hits" | grep -c .)" = "1" ] || return 1
  printf '%s\n' "$hits"
}

# Runtime length in bytes, and the code identity's preimage as 0x-hex: the
# deployed bytecode, every immutable reference zeroed, metadata trailer cut.
runtime_len() { # artifact
  python3 - "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
o = d["deployedBytecode"]["object"]
o = o[2:] if o.startswith("0x") else o
print(len(o) // 2)
PY
}
identity_preimage() { # artifact
  python3 - "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
db = d["deployedBytecode"]
o = db["object"]
c = bytearray.fromhex(o[2:] if o.startswith("0x") else o)
for refs in (db.get("immutableReferences") or {}).values():
    for r in refs:
        s, n = int(r["start"]), int(r["length"])
        if s + n > len(c):
            sys.exit("an immutable reference runs past the code")
        c[s:s + n] = bytes(n)
if len(c) < 2:
    sys.exit("no code")
meta = (c[-2] << 8) | c[-1]
if meta + 2 > len(c):
    sys.exit("the metadata length runs past the code")
print("0x" + c[: len(c) - meta - 2].hex())
PY
}
identity_of() { # artifact
  local pre
  pre=$(identity_preimage "$1") || return 1
  "$CAST" keccak "$pre"
}
full_hash_of() { # artifact
  local o
  o=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1]))["deployedBytecode"]["object"]; print(o if o.startswith("0x") else "0x"+o)' "$1") || return 1
  "$CAST" keccak "$o"
}

# THE CODE IDENTITY OF WHAT IS DEPLOYED: the runtime code read off the chain,
# each immutable the artifact names zeroed in it, the trailer cut. The code
# must be exactly as long as the artifact's: a different length is different
# code, whatever the hash of the rest would say.
deployed_preimage() { # artifact, 0x-code
  python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
db = d["deployedBytecode"]
o = db["object"]
art = bytes.fromhex(o[2:] if o.startswith("0x") else o)
code = sys.argv[2]
if not code.startswith("0x") or len(code) % 2:
    sys.exit("the code read is not hex")
c = bytearray.fromhex(code[2:])
if len(c) == 0:
    sys.exit("no code at that address")
if len(c) != len(art):
    sys.exit("the code there is %d bytes and this build's is %d" % (len(c), len(art)))
for refs in (db.get("immutableReferences") or {}).values():
    for r in refs:
        s, n = int(r["start"]), int(r["length"])
        c[s:s + n] = bytes(n)
meta = (c[-2] << 8) | c[-1]
if meta + 2 > len(c):
    sys.exit("the metadata length runs past the code")
print("0x" + c[: len(c) - meta - 2].hex())
PY
}
deployed_identity() { # rpc address artifact
  local code pre
  code=$("$CAST" code "$2" --rpc-url "$1" 2>/dev/null) || { echo "could not read the code at $2 from $1" >&2; return 1; }
  pre=$(deployed_preimage "$3" "$code") || return 1
  "$CAST" keccak "$pre"
}

# --deployed: one address against the pinned identity of its contract, or,
# for a contract with none pinned, against what this build would deploy.
check_deployed() { # rpc address name [deploy script]
  local rpc="$1" at="$2" name="$3" deploy="${4:-script/DeployCurb.s.sol}" art got want from f n
  SCAN=$(scan_src "$OUT_DIR") || { echo "the artifacts under $OUT_DIR could not be read"; return 1; }
  art=$(artifact_of "$name") || { echo "no single artifact of a src/ contract named $name under $OUT_DIR"; return 1; }
  got=$(deployed_identity "$rpc" "$at" "$art") || return 1
  want=""
  while read -r n f; do
    [ "$n" = "$name" ] && { want=$(constant_in "$deploy" "$f"); from="$f in $deploy"; }
  done <<<"$UNCHANGED"
  if [ -z "$want" ]; then
    want=$(identity_of "$art") || { echo "the identity of $art could not be computed"; return 1; }
    from="this build's $name"
  fi
  if [ "${got,,}" = "${want,,}" ]; then
    echo "ok    $name at $at is $got, as $from"
    return 0
  fi
  echo "FAIL  $name at $at is $got, and $from is $want"
  return 1
}

# The value of a bytes32 constant in a Solidity file: `NAME = 0x...;`, or the
# value on the line after `NAME =`.
constant_in() { # file name
  awk -v n="$2" '
    found && match($0, /0x[0-9a-fA-F]{64}/) { print substr($0, RSTART, RLENGTH); exit }
    $0 ~ ("[ \t]" n "[ \t]*=") { found = 1; if (match($0, /0x[0-9a-fA-F]{64}/)) { print substr($0, RSTART, RLENGTH); exit } }
  ' "$1"
}

check_all() { # deploy script, router script
  local deploy="$1" router="$2" name budget art len id want f
  SCAN=$(scan_src "$OUT_DIR") || { bad "the artifacts under $OUT_DIR could not be read"; return; }
  [ -n "$SCAN" ] || { bad "no artifact of a src/ contract under $OUT_DIR: build first"; return; }
  echo "1. RUNTIME SIZES"
  while read -r name budget; do
    art=$(artifact_of "$name") || { bad "$name: no single artifact under $OUT_DIR for a src/ contract of that name"; continue; }
    len=$(runtime_len "$art") || { bad "$name: its artifact could not be read"; continue; }
    if [ "$len" -le "$budget" ]; then
      good "$(printf '%-26s %6s B, budget %6s (%s to spare)' "$name" "$len" "$budget" "$((budget - len))")"
    else
      bad "$(printf '%-26s %6s B, OVER its budget of %s by %s' "$name" "$len" "$budget" "$((len - budget))")"
    fi
  done <<<"$BUDGETS"
  # EVERY src/ CONTRACT AGAINST EIP-170, not only the budgeted ones.
  while IFS=$'\t' read -r name f len; do
    [ -n "$len" ] && [ "$len" -gt "$EIP170" ] && bad "$name: $len B, over EIP-170's $EIP170"
  done <<<"$SCAN"
  echo
  echo "2. THE UNCHANGED CONTRACTS, BY CODE IDENTITY"
  while read -r name f; do
    want=$(constant_in "$deploy" "$f")
    [ -n "$want" ] || { bad "$name: $deploy holds no $f"; continue; }
    art=$(artifact_of "$name") || { bad "$name: no single artifact under $OUT_DIR"; continue; }
    id=$(identity_of "$art") || { bad "$name: its identity could not be computed"; continue; }
    if [ "${id,,}" = "${want,,}" ]; then good "$name $id"; else bad "$name is $id, and $f is $want: its code changed"; fi
  done <<<"$UNCHANGED"
  echo
  echo "3. THE ROUTER'S RUNTIME CODE HASH"
  want=$(constant_in "$router" EXPECTED_RUNTIME_CODEHASH)
  if [ -z "$want" ]; then
    bad "$router holds no EXPECTED_RUNTIME_CODEHASH"
  elif ! art=$(artifact_of CurbRouter); then
    bad "CurbRouter: no single artifact under $OUT_DIR"
  else
    id=$(full_hash_of "$art") || id="unreadable"
    if [ "${id,,}" = "${want,,}" ]; then good "CurbRouter $id"; else bad "CurbRouter hashes to $id, and EXPECTED_RUNTIME_CODEHASH is $want"; fi
  fi
}

# ---------------------------------------------------------------- selftest
# Fixed artifacts through the same functions: each case is a way the gate
# could pass what it exists to stop.
selftest() {
  local t n=0 failed=0 got
  t=$(mktemp -d)
  trap 'rm -rf "$t"' RETURN
  sc() { # name expected got
    n=$((n + 1))
    if [ "$2" = "$3" ]; then printf '  pass  %s\n' "$1"; else printf '  FAIL  %s\n        expected: %s\n        got:      %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi
  }
  mk() { # dir name hexcode immutableRefsJson [src path]
    mkdir -p "$t/out/$1"
    printf '{"deployedBytecode":{"object":"0x%s","immutableReferences":%s},"metadata":{"settings":{"compilationTarget":{"%s":"%s"}}}}' \
      "$3" "$4" "${5:-src/$1}" "$2" >"$t/out/$1/$2.json"
  }
  # a 10-byte body, a 3-byte metadata trailer (a1 b2 c3) and its length 0x0003
  mk A.sol A "6080604052aabbccddeea1b2c30003" '{}'
  mk B.sol B "6080604052aabbccddeea1b2c30003" '{"7":[{"start":5,"length":3}]}'
  mk C.sol C "6080604052000000ddeea1b2c30003" '{}'
  mk D.sol D "6080604052aabbccddeeffffff0003" '{}'
  got=$(identity_preimage "$t/out/A.sol/A.json")
  sc "the metadata trailer is cut, by the length in the last two bytes" "0x6080604052aabbccddee" "$got"
  got=$(identity_preimage "$t/out/B.sol/B.json")
  sc "each immutable reference is zeroed" "0x6080604052" "${got:0:12}"
  sc "an immutable is zeroed in place, keeping the length" "0x6080604052000000ddee" "$got"
  sc "zeroing the immutables gives the code that holds zeros there (the control)" \
    "$(identity_preimage "$t/out/C.sol/C.json")" "$got"
  sc "a different metadata trailer is the same identity" "$(identity_preimage "$t/out/A.sol/A.json")" \
    "$(identity_preimage "$t/out/D.sol/D.json")"
  mk E.sol E "6080604052aabbccddeea1b2c300ff" '{}'
  identity_preimage "$t/out/E.sol/E.json" >/dev/null 2>&1 && got=accepted || got=refused
  sc "a metadata length past the code is refused" "refused" "$got"
  mk F.sol F "60806040aa" '{"1":[{"start":4,"length":32}]}'
  identity_preimage "$t/out/F.sol/F.json" >/dev/null 2>&1 && got=accepted || got=refused
  sc "an immutable reference past the code is refused" "refused" "$got"
  got=$(runtime_len "$t/out/A.sol/A.json")
  sc "the runtime length is the artifact's own" "15" "$got"
  # constant_in, both layouts DeployCurb and DeployRouter use
  printf '    bytes32 internal constant IDENTITY_X = 0x%s;\n    bytes32 public constant Y =\n        0x%s;\n' \
    "$(printf '1%.0s' {1..64})" "$(printf '2%.0s' {1..64})" >"$t/K.sol"
  sc "a constant on its own line is read" "0x$(printf '1%.0s' {1..64})" "$(constant_in "$t/K.sol" IDENTITY_X)"
  sc "a constant on the line after its name is read" "0x$(printf '2%.0s' {1..64})" "$(constant_in "$t/K.sol" Y)"
  sc "a constant that is not there is empty" "" "$(constant_in "$t/K.sol" IDENTITY_Z)"
  # artifact_of: one src/ artifact of the name, and only from src/
  OUT_DIR="$t/out"
  SCAN=$(scan_src "$OUT_DIR")
  sc "the artifact of a src/ contract is found" "$t/out/A.sol/A.json" "$(artifact_of A)"
  mk T.sol G "6080" '{}' "test/T.sol"
  SCAN=$(scan_src "$OUT_DIR")
  artifact_of G >/dev/null && got=found || got=none
  sc "a contract compiled from test/ is not taken for a src/ one" "none" "$got"
  mk A2.sol A "6080" '{}' "src/A2.sol"
  SCAN=$(scan_src "$OUT_DIR")
  artifact_of A >/dev/null && got=found || got=none
  sc "two src/ contracts of one name are refused, not guessed between" "none" "$got"
  rm -rf "$t/out/A2.sol"
  # the whole gate on a fixed tree: budgets, identities and the router
  local id_b
  id_b=$(identity_of "$t/out/B.sol/B.json")
  mkdir -p "$t/out/FeeEscrow.sol" && cp "$t/out/B.sol/B.json" "$t/out/FeeEscrow.sol/FeeEscrow.json"
  sed -i 's#"src/B.sol":"B"#"src/FeeEscrow.sol":"FeeEscrow"#' "$t/out/FeeEscrow.sol/FeeEscrow.json"
  for nm in CurbLaunchFactory Graduator PositionLock FeeHook LaunchRegistry LaunchLens SharingCatalog \
            HolderDistributorFactory HolderFeeDistributor PonsV2BondingCurve CurbLaunchToken FeePolicy \
            PonsV2BuybackVault CurbRouter; do
    mk "$nm.sol" "$nm" "6080604052aabbccddeea1b2c30003" '{}' "src/$nm.sol"
  done
  local id_a router_hash
  id_a=$(identity_of "$t/out/A.sol/A.json")
  router_hash=$("$CAST" keccak 0x6080604052aabbccddeea1b2c30003)
  {
    for f in IDENTITY_BONDING_CURVE IDENTITY_LAUNCH_TOKEN IDENTITY_FEE_POLICY IDENTITY_BUYBACK_VAULT; do
      printf '    bytes32 internal constant %s = %s;\n' "$f" "$id_a"
    done
    printf '    bytes32 internal constant IDENTITY_FEE_ESCROW = %s;\n' "$id_b"
  } >"$t/Deploy.sol"
  printf '    bytes32 public constant EXPECTED_RUNTIME_CODEHASH =\n        %s;\n' "$router_hash" >"$t/Router.sol"
  fail_count=0
  check_all "$t/Deploy.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "a tree within every budget, with every identity and the router's hash as pinned, passes (the control)" "0" "$fail_count"
  mk Graduator.sol Graduator "$(printf '00%.0s' {1..20999})0000" '{}' "src/Graduator.sol"
  fail_count=0
  check_all "$t/Deploy.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "a contract one byte over its budget fails" "1|1" "$fail_count|$(grep -c 'Graduator .*OVER its budget of 21000 by 1' "$t/run.log")"
  mk Graduator.sol Graduator "$(printf '00%.0s' {1..20998})0000" '{}' "src/Graduator.sol"
  fail_count=0
  check_all "$t/Deploy.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "a contract exactly at its budget passes" "0" "$fail_count"
  mk Other.sol Other "$(printf '00%.0s' {1..24575})0000" '{}' "src/Other.sol"
  fail_count=0
  check_all "$t/Deploy.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "an unbudgeted src/ contract over EIP-170 fails" "1|1" "$fail_count|$(grep -c 'Other: 24577 B, over EIP-170' "$t/run.log")"
  rm -rf "$t/out/Other.sol"
  mk FeePolicy.sol FeePolicy "6080604052aabbccddefa1b2c30003" '{}' "src/FeePolicy.sol"
  fail_count=0
  check_all "$t/Deploy.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "an unchanged contract whose code moved by one byte fails" "1|1" "$fail_count|$(grep -c 'FeePolicy is .*its code changed' "$t/run.log")"
  mk FeePolicy.sol FeePolicy "6080604052aabbccddeea1b2c30003" '{}' "src/FeePolicy.sol"
  mk FeeEscrow.sol FeeEscrow "6080604052aabbccddeea1b2c30003" '{}' "src/FeeEscrow.sol"
  fail_count=0
  check_all "$t/Deploy.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "an immutable that became plain code fails (the identity zeroes only what the artifact says)" "1" "$fail_count"
  cp "$t/out/B.sol/B.json" "$t/out/FeeEscrow.sol/FeeEscrow.json"
  sed -i 's#"src/B.sol":"B"#"src/FeeEscrow.sol":"FeeEscrow"#' "$t/out/FeeEscrow.sol/FeeEscrow.json"
  mk CurbRouter.sol CurbRouter "6080604052aabbccddeea1b2c40003" '{}' "src/CurbRouter.sol"
  fail_count=0
  check_all "$t/Deploy.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "a router whose metadata byte moved fails: its whole code is compared" "1|1" "$fail_count|$(grep -c 'CurbRouter hashes to' "$t/run.log")"
  mk CurbRouter.sol CurbRouter "6080604052aabbccddeea1b2c30003" '{}' "src/CurbRouter.sol"
  grep -v IDENTITY_FEE_POLICY "$t/Deploy.sol" >"$t/Deploy2.sol"
  fail_count=0
  check_all "$t/Deploy2.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "a missing pinned identity fails rather than passing unchecked" "1|1" "$fail_count|$(grep -c 'holds no IDENTITY_FEE_POLICY' "$t/run.log")"
  rm -f "$t/out/SharingCatalog.sol/SharingCatalog.json"
  fail_count=0
  check_all "$t/Deploy.sol" "$t/Router.sol" >"$t/run.log" 2>&1
  sc "a budgeted contract with no artifact fails rather than passing unmeasured" "1|1" "$fail_count|$(grep -c 'SharingCatalog: no single artifact' "$t/run.log")"
  # --deployed, against a cast that answers with fixed code: the artifact's
  # code with its immutable filled in is the artifact's identity; one byte of
  # code changed, a length changed, or no code at all is not.
  mkdir -p "$t/bin"
  printf '#!/usr/bin/env bash\ncase "$1" in code) cat "%s/code.hex";; keccak) exec "%s" keccak "$2";; esac\n' \
    "$t" "$CAST" >"$t/bin/cast"
  chmod +x "$t/bin/cast"
  local real_cast="$CAST" id_art
  id_art=$(identity_of "$t/out/B.sol/B.json")
  CAST="$t/bin/cast"
  printf '0x6080604052c0ffeeddeea1b2c30003' >"$t/code.hex"
  got=$(deployed_identity rpc 0xdead "$t/out/B.sol/B.json")
  sc "deployed code with its immutable filled in has the artifact's identity" "$id_art" "$got"
  printf '0x6080604052c0ffeeddefa1b2c30003' >"$t/code.hex"
  got=$(deployed_identity rpc 0xdead "$t/out/B.sol/B.json")
  [ "$got" != "$id_art" ] && got=differs || got=same
  sc "one byte of code outside the immutables changed is another identity" "differs" "$got"
  printf '0x6080604052c0ffeeddeea1b2c3000003' >"$t/code.hex"
  deployed_identity rpc 0xdead "$t/out/B.sol/B.json" >/dev/null 2>&1 && got=accepted || got=refused
  sc "code of another length is refused, not hashed" "refused" "$got"
  printf '0x' >"$t/code.hex"
  got=$(deployed_identity rpc 0xdead "$t/out/B.sol/B.json" 2>&1) && got="accepted: $got"
  sc "no code at the address is refused, and said to be no code rather than a length" "no code at that address" "$got"
  # check_deployed: the pinned constant decides for an unchanged contract
  printf '0x6080604052c0ffeeddeea1b2c30003' >"$t/code.hex"
  OUT_DIR="$t/out"
  check_deployed rpc 0xdead FeeEscrow "$t/Deploy.sol" >/dev/null 2>&1 && got=ok || got=fail
  sc "an escrow deployed from the pinned code passes --deployed (the control)" "ok" "$got"
  sed 's/IDENTITY_FEE_ESCROW = 0x[0-9a-f]*/IDENTITY_FEE_ESCROW = 0x'"$(printf '3%.0s' {1..64})"'/' "$t/Deploy.sol" >"$t/Deploy3.sol"
  check_deployed rpc 0xdead FeeEscrow "$t/Deploy3.sol" >/dev/null 2>&1 && got=ok || got=fail
  sc "an escrow whose code is not the pinned identity fails --deployed" "fail" "$got"
  CAST="$real_cast"
  echo
  if [ "$failed" -eq 0 ]; then echo "size-gate selftest: all $n checks passed"; return 0; fi
  echo "size-gate selftest: $failed of $n checks FAILED"; return 1
}

case "${1:-}" in
  --selftest) selftest; exit $? ;;
  --identity) identity_of "${2:?--identity needs an artifact path}"; exit $? ;;
  --deployed) check_deployed "${2:?--deployed needs an rpc}" "${3:?--deployed needs an address}" "${4:?--deployed needs a contract name}"; exit $? ;;
  --no-build) ;;
  "")
    # shellcheck disable=SC1091
    source script/b20/env.sh >/dev/null
    # A LOG OF ITS OWN FOR EACH RUN, as the demo scripts keep theirs: two
    # runs at once in two checkouts would otherwise read each other's.
    build_log=$(mktemp /tmp/curb-size-gate-build.XXXXXX)
    base-forge build --sizes >"$build_log" 2>&1 \
      || { tail -20 "$build_log"; echo "the build failed"; exit 1; }
    ;;
  *) echo "unknown argument: $1"; exit 2 ;;
esac

echo "=== THE SIZE AND CODE GATE, over $OUT_DIR/ ==="
check_all script/DeployCurb.s.sol script/DeployRouter.s.sol
echo
if [ "$fail_count" -eq 0 ]; then echo "size gate passed"; exit 0; fi
echo "size gate: $fail_count check(s) FAILED"
exit 1
