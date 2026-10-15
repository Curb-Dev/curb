#!/usr/bin/env bash
# Is web/abi.js's output the same bytes `cast abi-encode` produces?
#
# The two calls this demo cannot make without an encoder - the factory's
# fifteen-field launch() and UniversalRouter's nested execute() - fail in ways
# that are not readable when an offset is wrong: a revert inside someone else's
# contract, with no hint that the calldata was the problem. ROUTER_ACCESS.txt
# records a day lost to exactly that.
#
# So every shape the app encodes is compared, byte for byte, against a second
# implementation that was not written here.
source "$(dirname "$0")/env.sh"

NODE="${NODE:-node.exe}"
command -v "$NODE" >/dev/null 2>&1 || NODE=node
command -v "$NODE" >/dev/null 2>&1 || die "no node found; set NODE=/path/to/node"

WEB="$(cd "$(dirname "$0")/../../web" && pwd)"

# The Foundry tools live in WSL and Node lives on Windows, so the path handed
# to require() has to be one Windows Node can open. wslpath -m gives
# C:/Users/... with forward slashes, which needs no escaping inside a JS string.
ABI_JS="$WEB/abi.js"
case "$NODE" in
  *.exe) command -v wslpath >/dev/null 2>&1 && ABI_JS=$(wslpath -m "$ABI_JS") ;;
esac

fail=0

# $1 label, $2 cast signature, $3.. cast args -- then JS on stdin
check () {
  local label="$1" sig="$2"; shift 2
  local args=() js
  while [ "$1" != "--" ]; do args+=("$1"); shift; done
  shift
  js="$1"

  local want got
  want=$($CAST abi-encode "$sig" "${args[@]}") || { echo "  $label: cast could not encode"; fail=1; return; }
  got=$("$NODE" -e "
    globalThis.window = undefined;
    require('$ABI_JS');
    const { T, encode } = globalThis.CurbAbi;
    process.stdout.write($js);
  ") || { echo "  $label: abi.js threw"; fail=1; return; }

  if [ "$want" = "$got" ]; then
    printf "  ok   %s (%s bytes)\n" "$label" "$(( (${#want} - 2) / 2 ))"
  else
    printf "  FAIL %s\n    cast   %s\n    abi.js %s\n" "$label" "$want" "$got"
    fail=1
  fi
}

echo "web/abi.js vs cast abi-encode:"

check "flat statics" "f(address,uint256,bool)" \
  0x70997970c51812dc3a010c7d01b50e0d17dc79c8 12345678901234567890 true -- \
  "encode([T.address, T.uint(256), T.bool], ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8', 12345678901234567890n, true])"

# In a tuple, because a bare -60 on the command line reads as a flag to cast.
check "a negative int24" "f((int24,uint24))" "(-60,3000)" -- \
  "encode([T.tuple([T.int(24), T.uint(24)])], [[-60n, 3000n]])"

check "strings and bytes32" "f(string,string,bytes32)" \
  "Curb Demo" "DEMO" 0x0000000000000000000000000000000000000000000000000000000000000001 -- \
  "encode([T.string, T.string, T.bytesN(32)], ['Curb Demo', 'DEMO', '0x0000000000000000000000000000000000000000000000000000000000000001'])"

# The launch config, in full. This is the encoding that has to be right.
LAUNCH_SIG="f((string,string,string,bytes32,uint256,address,address,uint256,uint256,uint256,uint256,uint256,uint24,int24,address),(address,uint16,uint16,uint16,uint16))"
LAUNCH_CFG="(Curb Demo,DEMO,ipfs://demo,0x0000000000000000000000000000000000000000000000000000000000000001,1000000000000000000000000000,0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266,0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266,6000000000,6000000000,100,300,15552000,3000,60,0x0000000000000000000000000000000000000abc)"
LAUNCH_SNAP="(0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266,2000,0,0,500)"
check "factory launch(config, snapshot)" "$LAUNCH_SIG" "$LAUNCH_CFG" "$LAUNCH_SNAP" -- \
  "encode(
     [T.tuple([T.string, T.string, T.string, T.bytesN(32), T.uint(256), T.address, T.address,
               T.uint(256), T.uint(256), T.uint(256), T.uint(256), T.uint(256), T.uint(24), T.int(24), T.address]),
      T.tuple([T.address, T.uint(16), T.uint(16), T.uint(16), T.uint(16)])],
     [['Curb Demo', 'DEMO', 'ipfs://demo', '0x' + '00'.repeat(31) + '01', 10n ** 27n,
       '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
       6000000000n, 6000000000n, 100n, 300n, 15552000n, 3000n, 60n, '0x0000000000000000000000000000000000000abc'],
      ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 2000n, 0n, 0n, 500n]])"

# The router's swap parameters - the LEGACY layout, without minHopPriceX36.
# ROUTER_ACCESS.txt: the deployed router rejects the vendored 1.0.4 layout.
SWAP_SIG="f(((address,address,uint24,int24,address),bool,uint128,uint128,bytes))"
SWAP_ARG="((0xb20000000000000000000078ee7ce2fE4908108C,0x00000000000000000000000000000000000000ff,3000,60,0x0000000000000000000000000000000000000abc),true,1000000,987000,0x)"
check "router ExactInputSingle (legacy)" "$SWAP_SIG" "$SWAP_ARG" -- \
  "encode(
     [T.tuple([T.tuple([T.address, T.address, T.uint(24), T.int(24), T.address]),
               T.bool, T.uint(128), T.uint(128), T.bytes])],
     [[['0xb20000000000000000000078ee7ce2fE4908108C'.toLowerCase(), '0x00000000000000000000000000000000000000ff', 3000n, 60n,
        '0x0000000000000000000000000000000000000abc'],
       true, 1000000n, 987000n, '0x']])"

# An empty string and empty bytes: the case most likely to be got wrong, and
# the one cast cannot express inside a tuple.
check "an empty string and empty bytes" "f(string,bytes,uint256)" "" 0x 7 -- \
  "encode([T.string, T.bytes, T.uint(256)], ['', '0x', 7n])"

check "execute(bytes,bytes[],uint256)" "f(bytes,bytes[],uint256)" \
  0x10 "[0xdeadbeef,0x00]" 1700000000 -- \
  "encode([T.bytes, T.array(T.bytes), T.uint(256)], ['0x10', ['0xdeadbeef', '0x00'], 1700000000n])"

echo
echo "web/keccak.js vs cast keccak:"

KECCAK_JS="$WEB/keccak.js"
case "$NODE" in
  *.exe) command -v wslpath >/dev/null 2>&1 && KECCAK_JS=$(wslpath -m "$KECCAK_JS") ;;
esac

# $1 label, $2 the bytes to hash (0x-hex, or a string for cast to hash as text)
khash () {
  local label="$1" input="$2"
  local want got hexin
  want=$($CAST keccak "$input") || { echo "  $label: cast could not hash"; fail=1; return; }
  case "$input" in
    0x*) hexin="$input" ;;
    *)   hexin="0x$(printf %s "$input" | od -An -v -tx1 | tr -dc "0-9a-f")" ;;
  esac
  got=$("$NODE" -e "
    globalThis.window = undefined;
    require('$KECCAK_JS');
    process.stdout.write(globalThis.CurbKeccak.keccak256('$hexin'));
  ") || { echo "  $label: keccak.js threw"; fail=1; return; }
  if [ "$want" = "$got" ]; then
    printf "  ok   %s\n" "$label"
  else
    printf "  FAIL %s\n    cast      %s\n    keccak.js %s\n" "$label" "$want" "$got"
    fail=1
  fi
}

khash "the empty input" 0x
khash "one byte" 0x61
# 135, 136 and 137 bytes: keccak-256 absorbs 136 at a time, so these are the
# lengths where the padding is got wrong.
khash "135 bytes (rate - 1)" "0x$(printf 'ab%.0s' $(seq 1 135))"
khash "136 bytes (exactly the rate)" "0x$(printf 'cd%.0s' $(seq 1 136))"
khash "137 bytes (rate + 1)" "0x$(printf 'ef%.0s' $(seq 1 137))"
khash "an event signature" "Graduated(address,address,uint256,uint160,uint128,uint256)"

# THE POOL ID, which is what this is really for: keccak over the encoded
# PoolKey. Both halves have to be right at once - the encoding and the hash.
POOLKEY_ENC=$($CAST abi-encode "f((address,address,uint24,int24,address))" \
  "(0xb20000000000000000000078ee7ce2fE4908108C,0x00000000000000000000000000000000000000ff,3000,60,0x0000000000000000000000000000000000000abc)")
khash "a pool id (keccak of the encoded PoolKey)" "$POOLKEY_ENC"

got=$("$NODE" -e "
  globalThis.window = undefined;
  require('$ABI_JS'); require('$KECCAK_JS');
  const { T, encode } = globalThis.CurbAbi;
  const enc = encode([T.tuple([T.address, T.address, T.uint(24), T.int(24), T.address])],
    [['0xb20000000000000000000078ee7ce2fe4908108c', '0x00000000000000000000000000000000000000ff', 3000n, 60n,
      '0x0000000000000000000000000000000000000abc']]);
  process.stdout.write(globalThis.CurbKeccak.keccak256(enc));
")
want=$($CAST keccak "$POOLKEY_ENC")
if [ "$want" = "$got" ]; then
  printf "  ok   %s\n" "the same pool id, end to end through abi.js"
else
  printf "  FAIL %s\n    cast %s\n    js   %s\n" "end-to-end pool id" "$want" "$got"
  fail=1
fi

echo
[ "$fail" -eq 0 ] || die "the page's coders do not agree with cast"
echo "abi.js and keccak.js agree with cast on every shape this app uses"
