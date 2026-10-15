#!/usr/bin/env bash
# THE DEPLOYMENT, READ BACK OFF THE CHAIN, AGAINST WHAT WAS MEANT.
#
#   bash script/b20/check-deployment.sh <rpc> <run record> [<asset run record>...] [--accepted]
#     with the variables the preflight took, exported as they were for it:
#       CURB_DEPLOYER CURB_PLATFORM_RECIPIENT CURB_POLICY_OWNER
#       CURB_SHARING_PUBLISHER CURB_SHARING_KEEPER_PAYEE CURB_SHARING_VETOERS
#       CURB_FIRST_LAUNCH (1 or 0) and, with 1, every CURB_FIRST_* it names
#     and, only once something has changed since the run, each recorded in
#     ADDRESSES.txt:
#       CURB_HOOK_RECIPIENT   the hook's platform recipient now, once the
#                             policy Safe has executed a change of it
#       CURB_HOOK_SHARE_BPS   the hook's platform share now, likewise
#       CURB_FIRST_INDEX      which launch $CURB is, when it is not launch 0
#                             (DEPLOY.txt, $CURB IS NOT LAUNCH ZERO)
#   bash script/b20/check-deployment.sh --selftest
#     the same checks against a stand-in for cast and a made-up record - no
#     chain, no forge
#   bash script/b20/check-deployment.sh --rehearse
#     a real DeployCurb run, $CURB and all, broadcast onto a scratch fork of
#     the pinned node (REHEARSE_UPSTREAM, default http://127.0.0.1:8551) on a
#     port of its own (REHEARSE_PORT, default 8571), then this check against
#     it - passing, and failing where it should. Never touches the upstream.
#     About forty minutes: it runs the check ten times.
#
# EVERY READ IS ONE base-cast CALL, some four hundred of them: a few minutes
# against a node of your own. The public endpoint rate-limits, and a refused
# read is reported as a failure, never passed - use the keyed endpoint the
# broadcast used.
#
# WHAT IT READS. Every address comes from the run record - forge's
# broadcast/DeployCurb.s.sol/<chain>/run-latest.json, committed as
# deployments/base-mainnet/run.json (DEPLOY.txt STEP 5) - and nowhere else, so
# nothing is transcribed by hand. Every expected value comes from somewhere
# the chain does not: the roles from the variables above, each asset's terms
# from DeployCurb.quoteAssets() in this checkout, the router's pin from
# DeployRouter.s.sol. An asset added later by script/DeployAssetStack.s.sol is
# checked by passing that run's record after the first.
#
# WHAT IT CHECKS. The record is whole (every transaction has a receipt, every
# receipt succeeded, one sender); every contract holds code; the registry's
# launchers are the factories the record admitted, in the order it admitted
# them (the WETH factory first, DeployCurb.admissionOrder), behind the record's
# hook, and with a first launch the WETH factory is the only one the record
# admits before $CURB's launch; every owner, pending owner, role and term
# ADDRESSES.txt lists - hook,
# registry, catalog, Graduator, distributor factory and its implementation,
# lens - and per asset the factory's terms against the list, its escrow, policy
# and vault, the shape (graduation over start, about 13.75) and one factory per
# asset; $CURB - the token its launch's receipt names - as registry.launchAt(0)
# (or CURB_FIRST_INDEX) on the WETH factory with the creator, tax, words and
# sharing named; no other launch in the record on chain 8453; the router at its
# pinned code hash once deployed. It absorbs check-sharing.sh and
# verify-assets.js, which stay for the runner scripts.
#
# EACH CONTRACT AGAINST WHAT IT FROZE, THE HOOK AGAINST WHAT IT HOLDS NOW. A
# factory and a policy keep the platform recipient they were built with, and a
# launch keeps the share and recipient it was stamped with, for good; the hook's
# own pair moves, behind the policy Safe's 24-hour announcement. So each factory
# and policy is checked against its constructor arguments in the record (and
# the run's own stacks against CURB_PLATFORM_RECIPIENT), $CURB against the
# terms its launch call carried, and the hook - and what a launch made now
# would be stamped with, currentPlatformPolicy() - against CURB_HOOK_RECIPIENT
# and CURB_HOOK_SHARE_BPS when set, the run's own values when not. A change
# announced and not yet executed is a note, not a failure. Everything used to
# be compared with the run's values, so after a legitimate change of the
# recipient no answer could pass - the old one failed the hook, the new one
# every factory, policy and $CURB - while DEPLOY.txt asks for this to end ok.
#
# EVERY ADDRESS EXPORTED IS HELD TO ITS EIP-55 CHECKSUM when written in mixed
# case: one mistyped digit in a checksummed address reads as a valid address
# nobody holds, and the chain would have been compared with it.
#
# THE REGISTRY'S HANDOVER IS READ AS IT STANDS. Right after the run it is
# offered to the policy owner and not yet accepted: that passes, and says the
# Safe still has to accept. --accepted asks that it has (DEPLOY.txt, after the
# Safe's acceptOwnership), and fails while the deployer still owns it.
#
# Prints every failure, not the first, and exits 1 if there was any (2 for a
# usage error). A value that could not be read is a failure, never a pass.
set -uo pipefail
unset CDPATH
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)" || exit 2
SELF="$ROOT/script/b20/$(basename "$0")"
export PATH="$HOME/.foundry/bin:$PATH"
CAST="${CAST_BIN:-base-cast}"

command -v python3 >/dev/null 2>&1 && python3 -c 'import decimal, json' >/dev/null 2>&1 \
  || { echo "FAIL: python3 is required (the record is JSON, and the arithmetic is exact)." >&2; exit 2; }

# ------------------------------------------------------------------ rehearse
# FRESH ADDRESSES FOR EVERY ROLE, impersonated on the scratch node. anvil's own
# accounts are well known and may carry code on Base itself (an EIP-7702
# delegation someone set on the public key), which a fork would inherit.
rehearse() {
  local up="${REHEARSE_UPSTREAM:-http://127.0.0.1:8551}" port="${REHEARSE_PORT:-8571}" t pid rpc rec reg n=0 failed=0
  rpc="http://127.0.0.1:$port"
  command -v base-anvil >/dev/null 2>&1 && command -v base-forge >/dev/null 2>&1 \
    || { echo "FAIL: base-anvil and base-forge are needed (WSL; B20_ENVIRONMENT.txt installs them)."; return 2; }
  "$CAST" chain-id --rpc-url "$up" >/dev/null 2>&1 || { echo "FAIL: the upstream $up does not answer."; return 2; }
  if "$CAST" chain-id --rpc-url "$rpc" >/dev/null 2>&1; then
    echo "FAIL: something already answers on $rpc. Give the rehearsal another REHEARSE_PORT."; return 2
  fi
  t="$(mktemp -d)" || return 2
  # CHAIN 31337, NOT BASE'S. The record then cannot be taken for a mainnet one,
  # and the demo launch the rehearsal needs is allowed off chain 8453 only.
  base-anvil --fork-url "$up" --chain-id 31337 --port "$port" --host 127.0.0.1 >"$t/anvil.log" 2>&1 &
  pid=$!
  # shellcheck disable=SC2064
  trap "kill $pid 2>/dev/null; wait $pid 2>/dev/null; rm -rf '$t'" RETURN
  for _ in $(seq 1 60); do "$CAST" chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break; sleep 1; done
  "$CAST" chain-id --rpc-url "$rpc" >/dev/null 2>&1 || { echo "FAIL: the scratch node did not start."; tail -5 "$t/anvil.log"; return 2; }

  # LOWER CASE, so no reader has a checksum to disagree with.
  local D=0xc0de0000000000000000000000000000000000d1 O=0xc0de00000000000000000000000000000000501c
  local R=0xc0de000000000000000000000000000000000fee P=0xc0de000000000000000000000000000000000b11
  local K=0xc0de000000000000000000000000000000000ce1 V=0xc0de000000000000000000000000000000000fe7
  local C=0xc0de000000000000000000000000000000000c0b a
  for a in "$D" "$O"; do
    "$CAST" rpc anvil_impersonateAccount "$a" --rpc-url "$rpc" >/dev/null || { echo "FAIL: cannot impersonate $a"; return 2; }
    "$CAST" rpc anvil_setBalance "$a" 0x56bc75e2d63100000 --rpc-url "$rpc" >/dev/null || { echo "FAIL: cannot fund $a"; return 2; }
  done
  local env_common=(CURB_DEPLOYER="$D" CURB_PLATFORM_RECIPIENT="$R" CURB_POLICY_OWNER="$O"
    CURB_SHARING_PUBLISHER="$P" CURB_SHARING_KEEPER_PAYEE="$K" CURB_SHARING_VETOERS="$V"
    CURB_FIRST_LAUNCH=1 CURB_FIRST_NAME=Curb CURB_FIRST_SYMBOL=CURB CURB_FIRST_URI=ipfs://rehearsal
    CURB_FIRST_TAX_BPS=300 CURB_FIRST_CREATOR="$C" CURB_FIRST_DEV_BUY=300000000000000000 CURB_FIRST_SHARE=1
    CURB_DEMO_LAUNCH=true)
  echo "rehearsal: DeployCurb onto a scratch fork of $up at $rpc (chain 31337), then ten checks - about forty minutes"
  # THE DEMO IS ON BECAUSE THE DEPTH CHECK IS PRICED AGAINST THE PIN, where
  # cbZEC cannot supply a threshold; a demo skips it, and $CURB stays launch 0.
  # EVERY ROLE HERE IS ONE KEY, the $CURB creator too, and each is said.
  (cd "$ROOT" && env "${env_common[@]}" FOUNDRY_BROADCAST="$t/broadcast" \
    CURB_ALLOW_EOA_RECIPIENT=true CURB_ALLOW_EOA_POLICY_OWNER=true CURB_ALLOW_EOA_CREATOR=true \
    base-forge script script/DeployCurb.s.sol --rpc-url "$rpc" --broadcast --unlocked --sender "$D" --slow) \
    >"$t/deploy.log" 2>&1 || { echo "FAIL: the rehearsal's deployment did not complete:"; tail -25 "$t/deploy.log"; return 1; }
  rec="$t/broadcast/DeployCurb.s.sol/31337/run-latest.json"
  [ -s "$rec" ] || { echo "FAIL: no record at $rec"; return 1; }

  sc() { # name expected got
    n=$((n + 1))
    if [ "$2" = "$3" ]; then printf '  pass  %s\n' "$1"
    else printf '  FAIL  %s\n        expected: %s\n        got:      %s\n' "$1" "$2" "$3"; failed=$((failed + 1)); fi
  }
  check() { # extra env assignments, then -- and the check's own arguments; prints the exit status
    local e=() rc
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do e+=("$1"); shift; done
    shift
    env "${env_common[@]}" "${e[@]+"${e[@]}"}" bash "$SELF" "$rpc" "$rec" "$@" >"$t/check.log" 2>&1
    rc=$?
    echo "$rc"
  }
  sc "the rehearsal's own deployment passes the check, the handover pending (the control)" 0 "$(check --)"
  sc "and says the policy owner still has to accept the registry" 1 "$(grep -c 'PENDING' "$t/check.log")"
  sc "a publisher other than the one deployed fails" 1 "$(check CURB_SHARING_PUBLISHER=0xc0de000000000000000000000000000000000b12 --)"
  sc "naming the publisher" 1 "$(grep -c "FAIL  the distributor factory's publisher" "$t/check.log")"
  sc "a \$CURB creator other than the one deployed fails" 1 "$(check CURB_FIRST_CREATOR=0xc0de000000000000000000000000000000000c0c --)"
  sc "a run checked as if it shared nothing fails on \$CURB's sharing" 1 "$(check CURB_FIRST_SHARE=0 --)"
  sc "--accepted fails while the deployer still owns the registry" 1 "$(check -- --accepted)"
  reg="$(python3 -c 'import json,sys
for t in json.load(open(sys.argv[1]))["transactions"]:
    if t.get("transactionType") == "CREATE" and (t.get("contractName") or "").split("\\")[-1].split("/")[-1].split(":")[-1] == "LaunchRegistry":
        print(t["contractAddress"]); break' "$rec")"
  "$CAST" send --unlocked --from "$O" "$reg" "acceptOwnership()" --rpc-url "$rpc" >/dev/null 2>&1
  sc "after the policy owner accepts, --accepted passes" 0 "$(check -- --accepted)"
  sc "and the demo launch, allowed off chain 8453 only when said, fails when not said" 1 "$(check CURB_DEMO_LAUNCH=false -- --accepted)"
  # THE PLATFORM RECIPIENT MOVED, ON A REAL CHAIN: announced (a note), then
  # executed a day later - after which the run's own value fails the hook,
  # and CURB_HOOK_RECIPIENT passes while every factory, policy and $CURB is
  # still checked against what it froze.
  local hook N=0xc0de000000000000000000000000000000005afe
  hook="$(python3 -c 'import json,sys
for t in json.load(open(sys.argv[1]))["transactions"]:
    if t.get("transactionType") == "CREATE2" and (t.get("contractName") or "").split("\\")[-1].split("/")[-1].split(":")[-1] == "FeeHook":
        print(t["contractAddress"]); break' "$rec")"
  "$CAST" send --unlocked --from "$O" "$hook" "announcePlatformRecipient(address)" "$N" --rpc-url "$rpc" >/dev/null 2>&1
  sc "a recipient change announced passes, as a note naming CURB_HOOK_RECIPIENT" "0 1" \
    "$(check -- --accepted) $(grep -c "CURB_HOOK_RECIPIENT=$N exported" "$t/check.log")"
  "$CAST" rpc evm_increaseTime 90000 --rpc-url "$rpc" >/dev/null 2>&1
  "$CAST" rpc evm_mine --rpc-url "$rpc" >/dev/null 2>&1
  "$CAST" send --unlocked --from "$O" "$hook" "executePlatformRecipient()" --rpc-url "$rpc" >/dev/null 2>&1
  sc "once executed, the run's recipient alone fails the hook" 1 "$(check -- --accepted)"
  sc "and with CURB_HOOK_RECIPIENT exported it passes, the frozen ones unchanged" 0 \
    "$(check CURB_HOOK_RECIPIENT="$N" -- --accepted)"
  echo
  if [ "$failed" -eq 0 ]; then echo "check-deployment rehearsal: all $n checks passed"; return 0; fi
  echo "check-deployment rehearsal: $failed of $n checks FAILED. The last check said:"
  tail -20 "$t/check.log"
  return 1
}
if [ "${1:-}" = "--rehearse" ]; then rehearse; exit $?; fi

exec python3 - "$ROOT" "$CAST" "$SELF" "$@" <<'PY'
import json, os, re, subprocess, sys, tempfile, shutil
from decimal import Decimal

ROOT, CAST, SELF = sys.argv[1], sys.argv[2], sys.argv[3]
ARGS = sys.argv[4:]
ZERO = "0x" + "0" * 40
ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


# ============================================================================
# WHAT THE CHECKOUT SAYS: the list, the constants, the router's pin. Parsed,
# not copied: a third copy of the asset list is how two of them fell out of
# step before (ADDRESSES.txt, "THE LIST IS DeployCurb.quoteAssets()").
# ============================================================================
class Refused(Exception):
    pass


def source(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def literal(text):
    """A Solidity number literal - 1.46e18, 0.0463e8, 1_000_000_000e18, 500 - as
    an exact integer, or a refusal."""
    d = Decimal(text.replace("_", ""))
    if d != d.to_integral_value():
        raise Refused(f"the literal {text} is not a whole number of units")
    return int(d)


def constant(src, name):
    m = re.search(r"\b" + name + r"\s*=\s*(?:\w+\()?\s*(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64}|[0-9_.e]+)\s*\)?\s*;", src)
    if not m:
        raise Refused(f"no constant {name} in the source")
    v = m.group(1)
    return v.lower() if v.startswith("0x") else literal(v)


def quote_assets():
    src = source("script/DeployCurb.s.sol")
    m = re.search(r"function quoteAssets\(\)[^{]*\{(.*?)\n    \}", src, re.S)
    if not m:
        raise Refused("could not find quoteAssets() in script/DeployCurb.s.sol")
    body = m.group(1)
    size = re.search(r"new Asset\[\]\((\d+)\)", body)
    rows = re.findall(
        r'list\[(\d+)\]\s*=\s*Asset\(\s*(\w+)\s*,\s*"([^"]+)"\s*,\s*([0-9_.e]+)\s*,\s*([0-9_.e]+)\s*,\s*(true|false)\s*,\s*(\d+)\s*\)',
        body,
    )
    if not size or len(rows) != int(size.group(1)) or sorted(int(r[0]) for r in rows) != list(range(len(rows))):
        raise Refused(
            "quoteAssets() in script/DeployCurb.s.sol does not read as one `list[i] = Asset(...)` line per entry; "
            "this checker parses those lines"
        )
    assets = []
    for idx, ident, label, ph, th, fillable, dec in sorted(rows, key=lambda r: int(r[0])):
        quote = ident.lower() if ident.startswith("0x") else constant(src, ident)
        assets.append({"label": label, "quote": quote, "phantom": literal(ph), "threshold": literal(th),
                       "fillable": fillable == "true", "decimals": int(dec)})
    return assets


def terms():
    src = source("script/DeployCurb.s.sol")
    t = {k: constant(src, k) for k in ("WETH", "POSM", "POOL_FEE", "TICK_SPACING", "SUPPLY", "MAX_INTERNAL_PRICE_IMPACT_BPS")}
    t["POOL_MANAGER"] = constant(src, "POOL_MANAGER")
    t["PERMIT2"] = constant(src, "PERMIT2")
    rsrc = source("script/DeployRouter.s.sol")
    t["ROUTER"] = constant(rsrc, "EXPECTED_ROUTER")
    t["ROUTER_CODEHASH"] = constant(rsrc, "EXPECTED_RUNTIME_CODEHASH")
    return t


# ============================================================================
# THE RECORD: what forge says it sent. Names are cut to the contract's own,
# since forge qualifies one with its file when two share a name - with a
# backslash on Windows ("FeePolicy.sol\FeePolicy").
# ============================================================================
def short(name):
    return re.split(r"[\\/:]", name or "")[-1]


def load_record(path):
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    txs = j.get("transactions") or []
    rec = {"path": path, "txs": txs, "receipts": j.get("receipts") or [], "pending": j.get("pending") or [],
           "chain": j.get("chain"), "commit": j.get("commit"), "creates": {}, "calls": [], "args": {}}
    for t in txs:
        kind = t.get("transactionType")
        if kind in ("CREATE", "CREATE2"):
            a = (t.get("contractAddress") or "").lower()
            rec["creates"].setdefault(short(t.get("contractName")), []).append(a)
            # WHAT IT WAS BUILT WITH: its constructor arguments, as forge wrote
            # them down (frozen_recipient reads the platform recipient there).
            rec["args"][a] = t.get("arguments") or []
        elif kind == "CALL":
            rec["calls"].append(t)
    return rec


# ============================================================================
# THE CHAIN, THROUGH cast. Raw words, decoded here: cast's own formatting of a
# string or a number has changed between versions, the bytes have not.
# ============================================================================
class Unread(Exception):
    pass


# THE SELFTEST'S CHAIN IS A FILE, and only an endpoint named exactly this one
# reads it: no real endpoint can be answered from a file by mistake. Hundreds
# of reads per run through a stand-in process took minutes; the stand-in
# process is still used once, for the control (selftest says why).
SELFTEST_RPC = "selftest.invalid"
_FAKE = {}


def call_key(args):
    return " ".join(args).lower()


def cast(*args):
    if RPC == SELFTEST_RPC:
        if not _FAKE:
            with open(os.environ["CHECK_DEPLOYMENT_SELFTEST_CHAIN"], encoding="utf-8") as f:
                _FAKE.update(json.load(f))
        k = call_key(args)
        if k not in _FAKE:
            raise Unread("execution reverted")
        return _FAKE[k]
    try:
        p = subprocess.run([CAST, *args, "--rpc-url", RPC], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Unread(f"{args[0]} could not run: {e}")
    if p.returncode != 0:
        raise Unread((p.stderr or p.stdout).strip().splitlines()[-1] if (p.stderr or p.stdout).strip() else "no answer")
    return p.stdout.strip()


def raw(to, sig, *a):
    out = cast("call", to, sig, *a)
    if not re.fullmatch(r"0x[0-9a-fA-F]*", out):
        raise Unread(f"{sig} on {to} answered something that is not hex: {out[:60]}")
    return out[2:]


def words(h):
    return [h[i:i + 64] for i in range(0, len(h) - len(h) % 64, 64)]


def as_addr(w):
    if len(w) != 64 or w[:24] != "0" * 24:
        raise Unread("not an address")
    return "0x" + w[24:]


def addr(to, sig, *a):
    w = words(raw(to, sig, *a))
    if not w:
        raise Unread(f"{sig} on {to} returned nothing")
    return as_addr(w[0])


def uint(to, sig, *a):
    w = words(raw(to, sig, *a))
    if not w:
        raise Unread(f"{sig} on {to} returned nothing")
    return int(w[0], 16)


def boolean(to, sig, *a):
    v = uint(to, sig, *a)
    if v not in (0, 1):
        raise Unread(f"{sig} on {to} is not a bool")
    return v == 1


def text(to, sig, *a):
    h = raw(to, sig, *a)
    w = words(h)
    if len(w) < 2:
        raise Unread(f"{sig} on {to} is not a string")
    off = int(w[0], 16) * 2
    n = int(h[off:off + 64], 16)
    return bytes.fromhex(h[off + 64:off + 64 + 2 * n]).decode("utf-8", "replace")


def policy_pair(to):
    """currentPlatformPolicy(): (uint16 share, address recipient), the pair a
    launch created now would be stamped with - read off the hook by the
    factory, the same way launch() reads it."""
    w = words(raw(to, "currentPlatformPolicy()"))
    if len(w) < 2:
        raise Unread(f"currentPlatformPolicy() on {to} is not a (share, recipient) pair")
    return int(w[0], 16), as_addr(w[1])


def codesize(a):
    out = cast("codesize", a)
    if not out.isdigit():
        raise Unread(f"the code size of {a} is not a number: {out[:40]}")
    return int(out)


# ============================================================================
# THE VERDICTS
# ============================================================================
FAILED = []
PASSED = [0]


def bad(msg):
    FAILED.append(msg)
    print("  FAIL  " + msg)


def good():
    PASSED[0] += 1


def same(what, got, want):
    if str(got).lower() == str(want).lower():
        good()
    else:
        bad(f"{what} is {got}, not {want}")


def ask(what, fn, *a):
    """One read, or a failure naming what could not be read."""
    try:
        return fn(*a)
    except Unread as e:
        bad(f"{what} could not be read: {e}")
        return None


def expect(what, fn, args, want):
    got = ask(what, fn, *args)
    if got is not None:
        same(what, got, want)
    return got


def keccak256(data):
    """Keccak-256, as Ethereum hashes (hashlib's sha3_256 pads differently)."""
    M = (1 << 64) - 1
    rate, s = 136, [0] * 25
    data = bytearray(data) + b"\x01"
    data += b"\x00" * (-len(data) % rate)
    data[-1] |= 0x80
    for off in range(0, len(data), rate):
        for i in range(rate // 8):
            s[i] ^= int.from_bytes(data[off + 8 * i:off + 8 * i + 8], "little")
        r = 1
        for _ in range(24):
            c = [s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20] for x in range(5)]
            for x in range(5):
                d = c[(x + 4) % 5] ^ (((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)) & M)
                for y in range(0, 25, 5):
                    s[x + y] ^= d
            x, y, cur = 1, 0, s[1]
            for t in range(24):
                x, y = y, (2 * x + 3 * y) % 5
                n = ((t + 1) * (t + 2) // 2) % 64
                cur, s[x + 5 * y] = s[x + 5 * y], ((cur << n) | (cur >> (64 - n))) & M
            for y in range(0, 25, 5):
                row = s[y:y + 5]
                for x in range(5):
                    s[x + y] = row[x] ^ (~row[(x + 1) % 5] & row[(x + 2) % 5])
            for j in range(7):
                r = ((r << 1) ^ ((r >> 7) * 0x71)) % 256
                if r & 2:
                    s[0] ^= 1 << ((1 << j) - 1)
    return b"".join(v.to_bytes(8, "little") for v in s)[:32]


def checksum_holds(a):
    """An address in one case carries no checksum; one in mixed case must be
    exactly its EIP-55 form."""
    body = a[2:]
    if not (any(ch in "abcdef" for ch in body) and any(ch in "ABCDEF" for ch in body)):
        return True
    h = keccak256(body.lower().encode()).hex()
    return body == "".join(ch.upper() if int(h[i], 16) >= 8 else ch for i, ch in enumerate(body.lower()))


def env_addr(name):
    v = os.environ.get(name, "")
    if not ADDR_RE.match(v):
        raise Refused(f"{name} is not set, or is not an address ('{v}'). Export it as the preflight had it.")
    # A CHECKSUMMED ADDRESS WITH ONE DIGIT MISTYPED is another valid address,
    # and the chain would have been compared with it - the same typo the run
    # took, passing here too.
    if not checksum_holds(v):
        raise Refused(f"{name} is written in mixed case and that is not its EIP-55 checksum ('{v}'): one mistyped "
                      f"character reads like this. Export it again from ADDRESSES.txt.")
    return v.lower()


def env_flag01(name):
    v = os.environ.get(name)
    if v not in ("0", "1"):
        raise Refused(f"{name} must be exactly 1 or 0 here, as for the preflight ('{v}').")
    return v == "1"


def env_digits(name):
    v = os.environ.get(name, "")
    if not re.fullmatch(r"[0-9]+", v):
        raise Refused(f"{name} must be plain decimal digits ('{v}').")
    return int(v)


def expected_from_env():
    e = {"deployer": env_addr("CURB_DEPLOYER"), "platform": env_addr("CURB_PLATFORM_RECIPIENT"),
         "owner": env_addr("CURB_POLICY_OWNER"), "publisher": env_addr("CURB_SHARING_PUBLISHER"),
         "payee": env_addr("CURB_SHARING_KEEPER_PAYEE")}
    vet = os.environ.get("CURB_SHARING_VETOERS", "")
    parts = vet.split(",") if vet else []
    if not parts or not all(ADDR_RE.match(p) for p in parts):
        raise Refused("CURB_SHARING_VETOERS is not a comma-separated list of addresses, as the preflight took it.")
    for p in parts:
        if not checksum_holds(p):
            raise Refused(f"a CURB_SHARING_VETOERS entry is written in mixed case and that is not its EIP-55 "
                          f"checksum ('{p}'). Export it again from ADDRESSES.txt.")
    e["vetoers"] = [p.lower() for p in parts]
    e["first"] = env_flag01("CURB_FIRST_LAUNCH")
    if e["first"]:
        for k in ("CURB_FIRST_NAME", "CURB_FIRST_SYMBOL", "CURB_FIRST_URI"):
            if k not in os.environ:
                raise Refused(f"{k} is not set. With CURB_FIRST_LAUNCH=1 every CURB_FIRST_* the run took is needed.")
        e["first_name"] = os.environ["CURB_FIRST_NAME"]
        e["first_symbol"] = os.environ["CURB_FIRST_SYMBOL"]
        e["first_uri"] = os.environ["CURB_FIRST_URI"]
        e["first_tax"] = env_digits("CURB_FIRST_TAX_BPS")
        e["first_creator"] = env_addr("CURB_FIRST_CREATOR")
        e["first_devbuy"] = env_digits("CURB_FIRST_DEV_BUY")
        e["first_share"] = env_flag01("CURB_FIRST_SHARE")
        # WHICH LAUNCH $CURB IS, when it is not 0: said only after DEPLOY.txt's
        # $CURB IS NOT LAUNCH ZERO, and recorded in ADDRESSES.txt.
        e["first_index"] = env_digits("CURB_FIRST_INDEX") if "CURB_FIRST_INDEX" in os.environ else 0
    e["demo_said"] = os.environ.get("CURB_DEMO_LAUNCH", "") == "true"
    # THE HOOK'S PAIR NOW, once the policy Safe has executed a change of it:
    # unset, the hook is expected to hold the run's own (CURB_PLATFORM_RECIPIENT,
    # and the registry's PLATFORM_FEE_BPS the hook starts with).
    e["hook_recipient"] = env_addr("CURB_HOOK_RECIPIENT") if os.environ.get("CURB_HOOK_RECIPIENT") else None
    e["hook_share"] = env_digits("CURB_HOOK_SHARE_BPS") if os.environ.get("CURB_HOOK_SHARE_BPS") else None
    return e


# ============================================================================
# THE CHECK
# ============================================================================
def one(rec, name):
    got = rec["creates"].get(name, [])
    if len(got) != 1:
        bad(f"the record creates {len(got)} {name}, not one")
        return None
    return got[0]


def check_record_whole(rec, sender):
    """The record is whole and from one sender - CURB_DEPLOYER for the
    deployment's own record, any one key for an asset added later. Returns
    that sender."""
    txs, receipts = rec["txs"], rec["receipts"]
    if not txs:
        bad(f"{rec['path']} holds no transactions")
        return sender
    if len(receipts) != len(txs) or rec["pending"]:
        bad(f"{rec['path']} holds {len(txs)} transactions, {len(receipts)} receipts and {len(rec['pending'])} pending: "
            f"a partial deployment - see DEPLOY.txt, A PARTIAL DEPLOYMENT")
    else:
        good()
    failed = [r.get("transactionHash") for r in receipts if r.get("status") != "0x1"]
    if failed:
        bad(f"{len(failed)} transaction(s) of {rec['path']} reverted on chain: {', '.join(failed[:3])}")
    else:
        good()
    senders = sorted({((t.get("transaction") or {}).get("from") or "").lower() for t in txs})
    if len(senders) != 1:
        bad(f"{rec['path']} was sent by {len(senders)} keys: {', '.join(senders)}")
    elif sender is not None and senders != [sender]:
        bad(f"{rec['path']} was sent by {senders[0]}, not CURB_DEPLOYER {sender}")
    else:
        good()
    return sender if sender is not None else senders[0]


def admitted_launchers(rec, registry):
    """The factories the record's registry calls admitted, in the order sent:
    wire()'s first argument, then each addLauncher()'s."""
    out = []
    for c in rec["calls"]:
        if (c.get("contractAddress") or "").lower() != registry:
            continue
        if c.get("function") in ("wire(address,address)", "addLauncher(address)"):
            a = (c.get("arguments") or [""])[0].lower()
            out.append(a)
    return out


# keccak256("LaunchCreated(address,address,address,uint256,uint16)"), as
# base-cast keccak prints it: CurbLaunchFactory's event, token, curve and
# creator indexed.
LAUNCH_CREATED = "0x0280b3c18566ead1ee0d23f14d7732eeb3b1876056abe38c8548ceaee8ec5ef8"


def receipt_of(rec, tx):
    h = (tx.get("hash") or "").lower()
    return next((r for r in rec["receipts"] if (r.get("transactionHash") or "").lower() == h), None)


def launch_created(rec, tx, factory):
    """(token, curve) from the LaunchCreated log of tx's RECEIPT, emitted by
    `factory` - what the chain made, which the simulation's own addresses
    (additionalContracts) are not once anything launched first: the token's
    address hangs on the curve's, and the curve's on the factory's nonce.
    None when the receipt holds no such log."""
    r = receipt_of(rec, tx)
    for log in (r or {}).get("logs") or []:
        topics = [t.lower() for t in log.get("topics") or []]
        if (log.get("address") or "").lower() == factory and len(topics) == 4 and topics[0] == LAUNCH_CREATED:
            return "0x" + topics[1][-40:], "0x" + topics[2][-40:]
    return None


# ============================================================================
# WHAT EACH CONTRACT FROZE, FROM THE RECORD. A factory and a policy keep the
# platform recipient they were built with, and a launch the share and
# recipient it was stamped with; the hook's own pair moves behind the policy
# Safe's announcement. So those are checked against the record, and the hook
# against what it should hold now.
# ============================================================================
def tuple_fields(text, n):
    """A tuple as forge writes it into a record - "(a, b, c)" - split into its
    last n fields and what comes before them: from the right, since a string
    field earlier in it (a name, a URI) may itself hold ", ". None when it is
    not a tuple of at least n + 1 fields."""
    t = (text or "").strip()
    if not (t.startswith("(") and t.endswith(")")):
        return None
    f = [x.strip() for x in t[1:-1].rsplit(",", n)]
    return f if len(f) == n + 1 else None


def frozen_recipient(s):
    """The platform recipient a stack's factory and policy were built with,
    from their constructor arguments in the record: FeePolicy's first,
    (platform, escrow, max impact), and the protocolFeeRecipient of the
    factory's Terms tuple, its last argument - (supply, quote decimals,
    phantom, threshold, pool fee, tick spacing, hook, protocolFeeRecipient,
    max impact, launch fee). DeployCurb._deployAssetStack builds both from
    one `platform`. None when either cannot be read or the two differ."""
    p, f = s.get("pargs") or [], s.get("fargs") or []
    terms = tuple_fields(f[-1] if f else "", 9)
    if not p or terms is None:
        return None
    a, b = str(p[0]).lower(), terms[7].lower()
    return a if ADDR_RE.match(a) and a == b else None


def launch_terms(tx):
    """(expected platform share, expected platform recipient) from a launch
    call's one argument in the record, the LaunchConfig tuple: (name, symbol,
    URI, salt, refund address, tax, dev buy, creator wallet,
    expectedPlatformBps, expectedPlatformRecipient, holderShareFactory).
    launch() refuses unless they are what it stamps into the record, so they
    are the launch's frozen terms as the run meant them. None when unreadable."""
    args = tx.get("arguments") or []
    f = tuple_fields(args[0] if len(args) == 1 else "", 8)
    if f is None or not f[-3].isdigit() or not ADDR_RE.match(f[-2]):
        return None
    return int(f[-3]), f[-2].lower()


def stamp(ts):
    """A unix time as a date a person reads."""
    import datetime
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def chain_id():
    out = cast("chain-id")
    if not out.isdigit():
        raise Unread(f"not a number: {out[:40]}")
    return int(out)


def main(argv):
    global RPC
    accepted = "--accepted" in argv
    pos = [a for a in argv if a != "--accepted"]
    if len(pos) < 2 or any(a.startswith("--") for a in pos):
        print("usage: check-deployment.sh <rpc> <run record> [<asset run record>...] [--accepted]  |  --selftest  |  --rehearse",
              file=sys.stderr)
        return 2
    RPC, paths = pos[0], pos[1:]
    try:
        e = expected_from_env()
        assets = quote_assets()
        T = terms()
        records = [load_record(p) for p in paths]
    except (Refused, OSError, ValueError) as x:
        print(f"FAIL: {x}", file=sys.stderr)
        return 2

    main_rec, extra = records[0], records[1:]
    print(f"check-deployment: {len(paths)} record(s) against {RPC}")
    print(f"  record commit {main_rec['commit']}, chain {main_rec['chain']}")

    # ---------------------------------------------------------- the records
    print("THE RECORDS")
    chain = ask("the endpoint's chain id", chain_id)
    senders = []
    for i, r in enumerate(records):
        senders.append(check_record_whole(r, e["deployer"] if i == 0 else None))
        if chain is not None and r["chain"] is not None:
            same(f"{r['path']}'s chain", r["chain"], chain)
    registry = one(main_rec, "LaunchRegistry")
    catalog = one(main_rec, "SharingCatalog")
    graduator = one(main_rec, "Graduator")
    hook = one(main_rec, "FeeHook")
    dfactory = one(main_rec, "HolderDistributorFactory")
    lens = one(main_rec, "LaunchLens")
    stacks = []
    for ri, (r, sender) in enumerate(zip(records, senders)):
        f = r["creates"].get("CurbLaunchFactory", [])
        es, ps, vs = (r["creates"].get(k, []) for k in ("FeeEscrow", "FeePolicy", "PonsV2BuybackVault"))
        if not (len(f) == len(es) == len(ps) == len(vs)) or not f:
            bad(f"{r['path']} creates {len(f)} factories, {len(es)} escrows, {len(ps)} policies and {len(vs)} vaults: "
                f"not one whole stack per asset")
            continue
        # "main": BUILT BY THE RUN'S OWN RECORD, the first - not told apart by
        # the sender, since an asset run is sent by the same deployer.
        for i in range(len(f)):
            stacks.append({"factory": f[i], "escrow": es[i], "policy": ps[i], "vault": vs[i], "sender": sender,
                           "main": ri == 0, "fargs": r["args"].get(f[i]), "pargs": r["args"].get(ps[i])})
    for r in extra:
        for shared in ("LaunchRegistry", "FeeHook", "Graduator"):
            if r["creates"].get(shared):
                bad(f"{r['path']} creates a {shared}: an asset run creates one stack and nothing shared")
    if None in (registry, catalog, graduator, hook, dfactory, lens):
        print("  the record does not name every shared contract; nothing more can be read")
        return finish()

    # ---------------------------------------------------------- code
    print("THE CODE")
    named = {"LaunchRegistry": registry, "SharingCatalog": catalog, "Graduator": graduator, "FeeHook": hook,
             "HolderDistributorFactory": dfactory, "LaunchLens": lens}
    for s in stacks:
        named.update({f"factory {s['factory']}": s["factory"], f"escrow {s['escrow']}": s["escrow"],
                      f"policy {s['policy']}": s["policy"], f"vault {s['vault']}": s["vault"]})
    for what, a in named.items():
        n = ask(f"the code at {what}", codesize, a)
        if n is not None:
            good() if n > 0 else bad(f"{what} ({a}) holds no code on this chain")

    # ---------------------------------------------------------- the registry
    print("THE REGISTRY")
    expect("registry.wired()", boolean, (registry, "wired()"), True)
    expect("registry.requiredHook()", addr, (registry, "requiredHook()"), hook)
    # THE LAUNCHERS IN THE ORDER THE RECORD ADMITTED THEM - its wire() first,
    # then each addLauncher() as it was sent - and an asset run's factory after
    # them, which the Safe admits. Not the order the record created them in:
    # the run builds every stack first and admits the WETH factory first
    # (DeployCurb.admissionOrder), and the record is what says so.
    admitted = admitted_launchers(main_rec, registry)
    created = [s["factory"] for s in stacks if s["main"]]
    if sorted(admitted) != sorted(created) or len(set(admitted)) != len(admitted):
        bad(f"the record admits {len(admitted)} launcher(s) and creates {len(created)} factories: "
            f"not each factory it created admitted once")
    else:
        good()
    want_launchers = admitted + [s["factory"] for s in stacks if not s["main"]]
    n = expect("registry.launcherCount()", uint, (registry, "launcherCount()"), len(want_launchers))
    if want_launchers:
        expect("registry.launcher() (the one wired)", addr, (registry, "launcher()"), want_launchers[0])
    for i, f in enumerate(want_launchers):
        if n is not None and i < n:
            expect(f"registry.launcherAt({i})", addr, (registry, "launcherAt(uint256)", str(i)), f)
    owner = ask("registry.owner()", addr, registry, "owner()")
    pending = ask("registry.pendingOwner()", addr, registry, "pendingOwner()")
    offered = [c for c in main_rec["calls"]
               if (c.get("contractAddress") or "").lower() == registry and c.get("function") == "transferOwnership(address)"]
    if e["owner"] == e["deployer"]:
        same("registry.owner() (a one-key run)", owner, e["deployer"])
        same("registry.pendingOwner() (a one-key run)", pending, ZERO)
        if offered:
            bad("the record offers the registry to someone, and the policy owner is the deployer")
    else:
        if len(offered) != 1 or [a.lower() for a in offered[0].get("arguments") or []] != [e["owner"]]:
            bad(f"the record does not offer the registry to CURB_POLICY_OWNER {e['owner']} exactly once")
        else:
            good()
        if owner is not None and pending is not None:
            if owner == e["owner"] and pending == ZERO:
                good()
                print(f"  ok    the policy owner {e['owner']} has accepted the registry")
            elif owner == e["deployer"] and pending == e["owner"]:
                if accepted:
                    bad(f"the policy owner {e['owner']} has not accepted the registry: the deployer still owns it")
                else:
                    good()
                    print(f"  PENDING  the registry is offered to {e['owner']} and not accepted: the Safe sends "
                          f"acceptOwnership() to {registry}, then run this again with --accepted")
            else:
                bad(f"registry.owner() is {owner} and pendingOwner() {pending}: neither the offer to "
                    f"{e['owner']} nor its acceptance")

    # ---------------------------------------------------------- the hook
    print("THE HOOK")
    expect("hook.owner()", addr, (hook, "owner()"), e["owner"])
    expect("hook.pendingOwner()", addr, (hook, "pendingOwner()"), ZERO)
    expect("hook.poolOpener()", addr, (hook, "poolOpener()"), graduator)
    expect("hook.registry()", addr, (hook, "registry()"), registry)
    expect("hook.poolManager()", addr, (hook, "poolManager()"), T["POOL_MANAGER"])
    # WHAT IT HOLDS NOW: the run's pair, or CURB_HOOK_RECIPIENT and
    # CURB_HOOK_SHARE_BPS once a change has been executed (the header says why).
    hook_rcpt = e["hook_recipient"] or e["platform"]
    expect("hook.platformRecipient()" + (" (CURB_HOOK_RECIPIENT)" if e["hook_recipient"]
                                         else " (the run's, CURB_PLATFORM_RECIPIENT)"),
           addr, (hook, "platformRecipient()"), hook_rcpt)
    # THE SHARE THE HOOK STARTED WITH, which the run's launches froze.
    share = ask("registry.PLATFORM_FEE_BPS()", uint, registry, "PLATFORM_FEE_BPS()")
    hook_share = e["hook_share"] if e["hook_share"] is not None else share
    if hook_share is not None:
        expect("hook.platformFeeBps()" + (" (CURB_HOOK_SHARE_BPS)" if e["hook_share"] is not None
                                          else " (the run's, registry.PLATFORM_FEE_BPS())"),
               uint, (hook, "platformFeeBps()"), hook_share)
    # AN ANNOUNCED CHANGE IS A NOTE, NOT A FAILURE: the policy Safe announces,
    # waits 24 hours and executes, and this check is run in between too.
    for what, at_sig, next_sig, read, export in (
            ("platform recipient", "pendingRecipientReadyAt()", "pendingRecipient()", addr, "CURB_HOOK_RECIPIENT"),
            ("platform share", "pendingFeeReadyAt()", "pendingFeeBps()", uint, "CURB_HOOK_SHARE_BPS")):
        at = ask(f"hook.{at_sig}", uint, hook, at_sig)
        if at == 0:
            good()
        elif at is not None:
            nxt = ask(f"hook.{next_sig}", read, hook, next_sig)
            good()
            print(f"  note  the hook has a {what} change to {nxt} announced, executable from {stamp(at)}: it reaches "
                  f"only launches made after it is executed. Once it is, run this with {export}={nxt} exported and "
                  f"record it in ADDRESSES.txt")

    # ---------------------------------------------------------- sharing
    print("HOLDER SHARING")
    expect("graduator.registry()", addr, (graduator, "registry()"), registry)
    expect("graduator.sharingCatalog()", addr, (graduator, "sharingCatalog()"), catalog)
    expect("graduator.poolManager()", addr, (graduator, "poolManager()"), T["POOL_MANAGER"])
    expect("graduator.positionManager()", addr, (graduator, "positionManager()"), T["POSM"])
    expect("graduator.permit2()", addr, (graduator, "permit2()"), T["PERMIT2"])
    expect("catalog.owner()", addr, (catalog, "owner()"), e["owner"])
    expect("catalog.pendingOwner()", addr, (catalog, "pendingOwner()"), ZERO)
    expect("catalog.bootstrapper()", addr, (catalog, "bootstrapper()"), e["deployer"])
    expect("catalog.bootstrapped()", boolean, (catalog, "bootstrapped()"), True)
    expect("catalog.isApproved(<distributor factory>)", boolean, (catalog, "isApproved(address)", dfactory), True)
    expect("catalog.recommended()", addr, (catalog, "recommended()"), dfactory)
    expect("the distributor factory's owner", addr, (dfactory, "owner()"), e["owner"])
    expect("the distributor factory's pendingOwner()", addr, (dfactory, "pendingOwner()"), ZERO)
    expect("the distributor factory's registry", addr, (dfactory, "registry()"), registry)
    expect("the distributor factory's Graduator", addr, (dfactory, "graduator()"), graduator)
    expect("the distributor factory's publisher", addr, (dfactory, "publisher()"), e["publisher"])
    expect("the distributor factory's keeper payee", addr, (dfactory, "keeperPayee()"), e["payee"])
    for v in e["vetoers"] + [e["owner"]]:
        expect(f"the distributor factory's isVetoer({v})", boolean, (dfactory, "isVetoer(address)", v), True)
    expect("the distributor factory's frozen()", boolean, (dfactory, "frozen()"), False)
    impl = ask("the distributor factory's implementation()", addr, dfactory, "implementation()")
    if impl is not None:
        size = ask("the implementation's code", codesize, impl)
        if size is not None:
            good() if size > 0 else bad(f"the distributor implementation {impl} holds no code")
        expect("the implementation's factory", addr, (impl, "factory()"), dfactory)
        expect("the implementation's Graduator", addr, (impl, "graduator()"), graduator)
    expect("lens.registry()", addr, (lens, "registry()"), registry)
    expect("lens.graduator()", addr, (lens, "graduator()"), graduator)

    # ---------------------------------------------------------- per asset
    print("ONE STACK PER ASSET")
    by_quote = {a["quote"]: a for a in assets}
    seen = set()
    quote_of = {}
    lo = ask("registry.MIN_TOTAL_TAX_BPS()", uint, registry, "MIN_TOTAL_TAX_BPS()")
    hi = ask("registry.MAX_TOTAL_TAX_BPS()", uint, registry, "MAX_TOTAL_TAX_BPS()")
    for s in stacks:
        f = s["factory"]
        q = ask(f"factory {f}'s quoteToken()", addr, f, "quoteToken()")
        if q is None:
            continue
        quote_of[f] = q
        a = by_quote.get(q)
        if a is None:
            bad(f"factory {f} quotes {q}, which DeployCurb.quoteAssets() does not list")
            continue
        lab = a["label"]
        if q in seen:
            bad(f"{lab}: a second factory on the same asset ({f})")
        seen.add(q)
        expect(f"{lab}: the asset's decimals()", uint, (q, "decimals()"), a["decimals"])
        expect(f"{lab}: factory.declaredQuoteDecimals()", uint, (f, "declaredQuoteDecimals()"), a["decimals"])
        ph = expect(f"{lab}: factory.phantomQuote()", uint, (f, "phantomQuote()"), a["phantom"])
        th = expect(f"{lab}: factory.graduationThreshold()", uint, (f, "graduationThreshold()"), a["threshold"])
        if ph and th is not None:
            # THE SHAPE, AS verify-assets.js CHECKED IT: graduation over start
            # is ((ph + th) / ph)^2, the dollars cancelled - 55 / 4 = 13.75,
            # within 2.5% each way.
            shape = (ph + th) * (ph + th) * 10000 // (ph * ph)
            good() if 134062 <= shape <= 140937 else bad(
                f"{lab}: graduates at {shape / 10000} times its start, not about 13.75 ($4K to $55K)")
        expect(f"{lab}: factory.supply()", uint, (f, "supply()"), T["SUPPLY"])
        expect(f"{lab}: factory.poolFee()", uint, (f, "poolFee()"), T["POOL_FEE"])
        expect(f"{lab}: factory.tickSpacing()", uint, (f, "tickSpacing()"), T["TICK_SPACING"])
        expect(f"{lab}: factory.launchFee()", uint, (f, "launchFee()"), 0)
        expect(f"{lab}: factory.hooks()", addr, (f, "hooks()"), hook)
        expect(f"{lab}: factory.registry()", addr, (f, "registry()"), registry)
        expect(f"{lab}: factory.graduator()", addr, (f, "graduator()"), graduator)
        # THE RECIPIENT IT WAS BUILT WITH, frozen in the factory and the policy
        # for good: the record's constructor arguments, and for the run's own
        # stacks, CURB_PLATFORM_RECIPIENT. An asset run's stack was built with
        # the hook's recipient of its day, which is said, not assumed.
        fr = frozen_recipient(s)
        if fr is None:
            bad(f"{lab}: the record's constructor arguments for factory {f} and policy {s['policy']} cannot be "
                f"read, or name two platform recipients")
        else:
            if s["main"]:
                same(f"{lab}: the platform recipient the run built it with (its record's constructor arguments)",
                     fr, e["platform"])
            else:
                good()
                print(f"  note  {lab}: built by an asset run to pay {fr}, frozen in its factory and policy "
                      f"(that run's record)")
            expect(f"{lab}: factory.protocolFeeRecipient() (frozen when built)", addr, (f, "protocolFeeRecipient()"),
                   fr)
        # WHAT A LAUNCH ON IT WOULD BE STAMPED WITH NOW (ADDRESSES.txt, "each
        # factory's currentPlatformPolicy() returns the same pair"): the
        # hook's share and recipient now, through the factory's own registry.
        pol = ask(f"{lab}: factory.currentPlatformPolicy()", policy_pair, f)
        if pol is not None:
            if hook_share is not None:
                same(f"{lab}: factory.currentPlatformPolicy()'s share", pol[0], hook_share)
            same(f"{lab}: factory.currentPlatformPolicy()'s recipient", pol[1], hook_rcpt)
        expect(f"{lab}: factory.maxInternalPriceImpactBps()", uint, (f, "maxInternalPriceImpactBps()"),
               T["MAX_INTERNAL_PRICE_IMPACT_BPS"])
        if lo is not None:
            expect(f"{lab}: factory.minTotalTaxBps()", uint, (f, "minTotalTaxBps()"), lo)
        if hi is not None:
            expect(f"{lab}: factory.maxTotalTaxBps()", uint, (f, "maxTotalTaxBps()"), hi)
        expect(f"{lab}: factory.feeEscrow()", addr, (f, "feeEscrow()"), s["escrow"])
        expect(f"{lab}: factory.feePolicy()", addr, (f, "feePolicy()"), s["policy"])
        expect(f"{lab}: factory.buybackVault()", addr, (f, "buybackVault()"), s["vault"])
        expect(f"{lab}: escrow.quoteToken()", addr, (s["escrow"], "quoteToken()"), q)
        expect(f"{lab}: policy.feeEscrow()", addr, (s["policy"], "feeEscrow()"), s["escrow"])
        if fr is not None:
            expect(f"{lab}: policy.protocolFeeRecipient() (frozen when built)", addr,
                   (s["policy"], "protocolFeeRecipient()"), fr)
        expect(f"{lab}: vault.owner()", addr, (s["vault"], "owner()"), s["sender"])
    for a in assets:
        if a["quote"] not in seen:
            bad(f"{a['label']} is listed in DeployCurb.quoteAssets() and no record deploys a factory for it "
                f"(an asset added later: pass its DeployAssetStack record too)")

    # ---------------------------------------------------------- launches
    print("THE LAUNCHES")
    launches = [c for c in main_rec["calls"] if (c.get("function") or "").startswith("launch(")]
    weth_factory = next((f for f, q in quote_of.items() if q == T["WETH"]), None)
    curb_call = None
    if e["first"]:
        if not launches or (launches[0].get("contractAddress") or "").lower() != weth_factory:
            bad("the record's first launch is not a launch on the WETH factory (CURB_FIRST_LAUNCH=1)")
        else:
            good()
            curb_call = launches[0]
        if weth_factory is None:
            bad("no factory of the deployment quotes WETH, and CURB_FIRST_LAUNCH=1 launches $CURB on it")
        # NO FACTORY OPEN BEFORE $CURB'S OWN (DeployCurb's FirstLaunch): the
        # record's one admission before $CURB's launch is the WETH factory's
        # wire(), and every addLauncher() comes after it - so no launch on any
        # other factory can have landed ahead of $CURB, however slowly the run
        # went or wherever it was resumed.
        if curb_call is not None and weth_factory is not None:
            at = next(i for i, c in enumerate(main_rec["calls"]) if c is curb_call)
            early = [(c.get("arguments") or [""])[0].lower() for c in main_rec["calls"][:at]
                     if (c.get("contractAddress") or "").lower() == registry
                     and c.get("function") in ("wire(address,address)", "addLauncher(address)")]
            if early != [weth_factory]:
                bad(f"the record admits {', '.join(early) or 'nothing'} before $CURB's launch: the WETH factory "
                    f"{weth_factory} alone must be, so that no launch on another factory can come before $CURB")
            else:
                good()
        count = ask("registry.launchCount()", uint, registry, "launchCount()")
        if count is not None:
            good() if count >= 1 else bad("registry.launchCount() is 0: $CURB was not launched")
        # $CURB IS THE TOKEN ITS LAUNCH'S RECEIPT NAMES, not launchAt(0) taken
        # on trust and not the simulation's address: the WETH factory is open
        # to anyone for one receipt before $CURB's launch (DeployCurb's
        # FirstLaunch), and a launch that lands in it moves $CURB's token
        # and curve as well as its place.
        token = curve = None
        if curb_call is not None:
            got = launch_created(main_rec, curb_call, weth_factory)
            if got is None:
                bad("the receipt of the record's $CURB launch holds no LaunchCreated from the WETH factory: "
                    "which token is $CURB is unknown")
            else:
                good()
                token, curve = got
                print(f"  $CURB token {token}, curve {curve} - from its launch's receipt; ADDRESSES.txt takes these")
        if token is not None and count is not None:
            look = min(count, 16)
            at = None
            for j in range(look):
                t_j = ask(f"registry.launchAt({j})", addr, registry, "launchAt(uint256)", str(j))
                if t_j is None:
                    break
                if t_j == token:
                    at = j
                    break
            if at is None:
                bad(f"$CURB ({token}) is not among the registry's first {look} launches")
            elif at == e["first_index"]:
                good()
                if at:
                    print(f"  note  $CURB is registry.launchAt({at}), as CURB_FIRST_INDEX says (DEPLOY.txt, $CURB IS "
                          f"NOT LAUNCH ZERO): the launch(es) ahead of it belong in web/config.js hiddenLaunches")
            elif at == 0:
                bad(f"$CURB is registry.launchAt(0), and CURB_FIRST_INDEX says {e['first_index']}: unset it")
            else:
                bad(f"$CURB is registry.launchAt({at}), not launchAt(0): {at} launch(es) landed before it. DEPLOY.txt, "
                    f"IF SOMETHING GOES WRONG, $CURB IS NOT LAUNCH ZERO says what then; once ADDRESSES.txt records "
                    f"it, run this again with CURB_FIRST_INDEX={at} exported")
        if token is not None:
            rec_words = ask("registry.launchOf($CURB)", lambda: words(raw(registry, "launchOf(address)", token)))
            if rec_words is not None and len(rec_words) >= 12:
                same("$CURB's curve", as_addr(rec_words[0]), curve)
                same("$CURB's quote asset", as_addr(rec_words[1]), T["WETH"])
                same("$CURB's beneficiary", as_addr(rec_words[2]), e["first_creator"])
                same("$CURB's refund address", as_addr(rec_words[3]), e["first_creator"])
                same("$CURB's tax", int(rec_words[8], 16), e["first_tax"])
                # THE PAIR IT WAS STAMPED WITH, for good: the one its launch
                # call carried (launch() refuses any other), which was the run's.
                lt = launch_terms(curb_call)
                if lt is None:
                    bad("the record's $CURB launch call carries no platform share and recipient that can be read")
                else:
                    same("$CURB's launch call: the platform recipient it was made with", lt[1], e["platform"])
                    if share is not None:
                        same("$CURB's launch call: the platform share it was made with", lt[0], share)
                    same("$CURB's platform recipient (frozen at launch)", as_addr(rec_words[10]), lt[1])
                    same("$CURB's platform share (frozen at launch)", int(rec_words[9], 16), lt[0])
            elif rec_words is not None:
                bad("registry.launchOf($CURB) is not a whole record")
            expect("$CURB's name", text, (token, "name()"), e["first_name"])
            expect("$CURB's symbol", text, (token, "symbol()"), e["first_symbol"])
            expect("$CURB's tokenURI", text, (token, "tokenURI()"), e["first_uri"])
            d = ask("graduator.holderDistributorOf($CURB)", addr, graduator, "holderDistributorOf(address)", token)
            if d is not None:
                if (d != ZERO) == e["first_share"]:
                    good()
                else:
                    bad("$CURB " + ("does not share with its holders, and CURB_FIRST_SHARE is 1" if e["first_share"]
                                    else "shares with its holders, and CURB_FIRST_SHARE is 0"))
            held = ask("$CURB held by its creator", uint, token, "balanceOf(address)", e["first_creator"])
            if held is not None and e["first_devbuy"] > 0 and held == 0:
                bad("$CURB's creator holds nothing, and the run made a dev buy for it")
            elif held is not None:
                good()
    others = [c for c in launches if c is not curb_call]
    if others:
        where = ", ".join((c.get("contractAddress") or "?") for c in others)
        what = "besides $CURB" if e["first"] else "and CURB_FIRST_LAUNCH is 0"
        if chain == 8453:
            bad(f"the record makes {len(others)} launch(es) {what} on chain 8453 ({where}): a demo on mainnet "
                f"is a permanent record in the registry")
        elif not e["demo_said"]:
            bad(f"the record makes {len(others)} launch(es) {what} ({where}), and CURB_DEMO_LAUNCH is not true")
        else:
            good()
            print(f"  note  {len(others)} demo launch(es) in the record, allowed: chain {chain}, CURB_DEMO_LAUNCH=true")

    # ---------------------------------------------------------- the router
    print("THE ROUTER")
    rsize = ask("the code at the pinned router", codesize, T["ROUTER"])
    if rsize == 0:
        print(f"  note  no router at its pinned address {T['ROUTER']} yet (DEPLOY.txt STEP 4A: script/DeployRouter.s.sol)")
    elif rsize is not None:
        expect("the router's code hash", lambda: cast("codehash", T["ROUTER"]).lower(), (), T["ROUTER_CODEHASH"])

    # ---------------------------------------------------------- the rest
    print("WHAT THIS DOES NOT READ: the code identities, from the deployment's commit after a build")
    for s in stacks:
        for kind, name in (("escrow", "FeeEscrow"), ("policy", "FeePolicy"), ("vault", "PonsV2BuybackVault")):
            print(f"    bash script/b20/size-gate.sh --deployed {RPC} {s[kind]} {name}")
    return finish()


def finish():
    print()
    if FAILED:
        print(f"check-deployment: {len(FAILED)} FAILURE(S), {PASSED[0]} checks passed")
        return 1
    print(f"check-deployment: ok, {PASSED[0]} checks passed")
    return 0


# ============================================================================
# --selftest: a made-up deployment, answered by a stand-in for cast, put
# through the real check - first whole, then with one thing wrong at a time,
# each of which must fail naming that thing.
# ============================================================================
def selftest():
    t = tempfile.mkdtemp()
    try:
        return _selftest(t)
    finally:
        shutil.rmtree(t, ignore_errors=True)


def _selftest(t):
    assets = quote_assets()
    T = terms()
    A = lambda n: "0x" + format(n, "040x")
    D, OWN, PLAT, PUB, PAY, VET, CRE = A(0xD1), A(0x501C0), A(0xFEE), A(0xB11), A(0xCE1), A(0xFE7), A(0xC0B)
    REG, CAT, GRAD, HOOK, DF, IMPL, LENS, TOKEN, CURVE, DIST = (A(0x1000 + i) for i in range(10))
    stacks = [{"factory": A(0x2000 + i), "escrow": A(0x3000 + i), "policy": A(0x4000 + i), "vault": A(0x5000 + i)}
              for i in range(len(assets))]
    # THE RUN'S OWN ORDER (DeployCurb.admissionOrder): every stack built as
    # listed, then WETH's admitted first and every other as listed.
    wi = next(i for i, a in enumerate(assets) if a["quote"] == T["WETH"])
    order = [wi] + [i for i in range(len(assets)) if i != wi]
    WETHF = stacks[wi]["factory"]
    env = {"CURB_DEPLOYER": D, "CURB_PLATFORM_RECIPIENT": PLAT, "CURB_POLICY_OWNER": OWN,
           "CURB_SHARING_PUBLISHER": PUB, "CURB_SHARING_KEEPER_PAYEE": PAY, "CURB_SHARING_VETOERS": VET,
           "CURB_FIRST_LAUNCH": "1", "CURB_FIRST_NAME": "Curb", "CURB_FIRST_SYMBOL": "CURB",
           "CURB_FIRST_URI": "ipfs://x", "CURB_FIRST_TAX_BPS": "300", "CURB_FIRST_CREATOR": CRE,
           "CURB_FIRST_DEV_BUY": "1", "CURB_FIRST_SHARE": "1"}

    w = lambda v: format(v, "064x")
    wa = lambda a: "0" * 24 + a[2:].lower()

    def ws(s):
        b = s.encode().hex()
        return w(32) + w(len(s.encode())) + b + "0" * ((64 - len(b) % 64) % 64)

    def chain(admitted=None):
        """The chain's answers; `admitted` is the order of the stacks in the
        registry's launcher list, the run's own order when not given."""
        admitted = order if admitted is None else admitted
        c = {}
        def put(to, sig, val, *args):
            c[" ".join(["call", to, sig] + list(args)).lower()] = "0x" + val
        put(REG, "wired()", w(1)); put(REG, "requiredHook()", wa(HOOK)); put(REG, "launcherCount()", w(len(stacks)))
        put(REG, "launcher()", wa(stacks[admitted[0]]["factory"]))
        for k, i in enumerate(admitted):
            put(REG, "launcherAt(uint256)", wa(stacks[i]["factory"]), str(k))
        put(REG, "owner()", wa(D)); put(REG, "pendingOwner()", wa(OWN))
        put(REG, "PLATFORM_FEE_BPS()", w(50)); put(REG, "MIN_TOTAL_TAX_BPS()", w(100)); put(REG, "MAX_TOTAL_TAX_BPS()", w(500))
        put(REG, "launchCount()", w(1)); put(REG, "launchAt(uint256)", wa(TOKEN), "0")
        put(REG, "launchOf(address)", wa(CURVE) + wa(T["WETH"]) + wa(CRE) + wa(CRE) + w(0) + w(500) + w(10) + wa(HOOK)
            + w(300) + w(50) + wa(PLAT) + w(1), TOKEN)
        for k, v in (("owner()", wa(OWN)), ("pendingOwner()", wa(ZERO)), ("poolOpener()", wa(GRAD)),
                     ("registry()", wa(REG)), ("poolManager()", wa(T["POOL_MANAGER"])),
                     ("platformRecipient()", wa(PLAT)), ("platformFeeBps()", w(50)),
                     ("pendingRecipient()", wa(ZERO)), ("pendingFeeBps()", w(0)),
                     ("pendingRecipientReadyAt()", w(0)), ("pendingFeeReadyAt()", w(0))):
            put(HOOK, k, v)
        for k, v in (("registry()", wa(REG)), ("sharingCatalog()", wa(CAT)), ("poolManager()", wa(T["POOL_MANAGER"])),
                     ("positionManager()", wa(T["POSM"])), ("permit2()", wa(T["PERMIT2"]))):
            put(GRAD, k, v)
        put(GRAD, "holderDistributorOf(address)", wa(DIST), TOKEN)
        for k, v in (("owner()", wa(OWN)), ("pendingOwner()", wa(ZERO)), ("bootstrapper()", wa(D)),
                     ("bootstrapped()", w(1)), ("recommended()", wa(DF))):
            put(CAT, k, v)
        put(CAT, "isApproved(address)", w(1), DF)
        for k, v in (("owner()", wa(OWN)), ("pendingOwner()", wa(ZERO)), ("registry()", wa(REG)),
                     ("graduator()", wa(GRAD)), ("publisher()", wa(PUB)), ("keeperPayee()", wa(PAY)),
                     ("frozen()", w(0)), ("implementation()", wa(IMPL))):
            put(DF, k, v)
        put(DF, "isVetoer(address)", w(1), VET); put(DF, "isVetoer(address)", w(1), OWN)
        put(IMPL, "factory()", wa(DF)); put(IMPL, "graduator()", wa(GRAD))
        put(LENS, "registry()", wa(REG)); put(LENS, "graduator()", wa(GRAD))
        for a, s in zip(assets, stacks):
            f = s["factory"]
            put(a["quote"], "decimals()", w(a["decimals"]))
            for k, v in (("quoteToken()", wa(a["quote"])), ("declaredQuoteDecimals()", w(a["decimals"])),
                         ("phantomQuote()", w(a["phantom"])), ("graduationThreshold()", w(a["threshold"])),
                         ("supply()", w(T["SUPPLY"])), ("poolFee()", w(T["POOL_FEE"])),
                         ("tickSpacing()", w(T["TICK_SPACING"])), ("launchFee()", w(0)), ("hooks()", wa(HOOK)),
                         ("registry()", wa(REG)), ("graduator()", wa(GRAD)), ("protocolFeeRecipient()", wa(PLAT)),
                         ("currentPlatformPolicy()", w(50) + wa(PLAT)),
                         ("maxInternalPriceImpactBps()", w(T["MAX_INTERNAL_PRICE_IMPACT_BPS"])),
                         ("minTotalTaxBps()", w(100)), ("maxTotalTaxBps()", w(500)), ("feeEscrow()", wa(s["escrow"])),
                         ("feePolicy()", wa(s["policy"])), ("buybackVault()", wa(s["vault"]))):
                put(f, k, v)
            put(s["escrow"], "quoteToken()", wa(a["quote"]))
            put(s["policy"], "feeEscrow()", wa(s["escrow"])); put(s["policy"], "protocolFeeRecipient()", wa(PLAT))
            put(s["vault"], "owner()", wa(D))
        put(TOKEN, "name()", ws("Curb")); put(TOKEN, "symbol()", ws("CURB")); put(TOKEN, "tokenURI()", ws("ipfs://x"))
        put(TOKEN, "balanceOf(address)", w(5), CRE)
        code = [REG, CAT, GRAD, HOOK, DF, IMPL, LENS] + [s[k] for s in stacks for k in ("factory", "escrow", "policy", "vault")]
        for a in code:
            c["codesize " + a.lower()] = "100"
        c["codesize " + T["ROUTER"].lower()] = "0"
        c["chain-id"] = "8453"
        return c

    def stack_txs(tx, s, platform=PLAT):
        """A stack's four creations, with the constructor arguments forge
        records: the policy's (platform, escrow, max impact), and the factory's
        six addresses and its Terms tuple, the platform recipient eighth."""
        a = assets[stacks.index(s)]
        tx("CREATE", "FeeEscrow", s["escrow"], args=[a["quote"]])
        tx("CREATE", "FeePolicy.sol\\FeePolicy", s["policy"], args=[platform, s["escrow"], "500"])
        tx("CREATE", "PonsV2BuybackVault.sol\\PonsV2BuybackVault", s["vault"], args=[D, s["policy"], s["escrow"]])
        tx("CREATE", "CurbLaunchFactory", s["factory"],
           args=[REG, GRAD, a["quote"], s["policy"], s["escrow"], s["vault"],
                 f"({T['SUPPLY']}, {a['decimals']}, {a['phantom']}, {a['threshold']}, 500, 10, {HOOK}, {platform}, 500, 0)"])

    def record(skip=None, admit_early=None):
        """The run's record; `skip` leaves one stack out of it, for an asset
        run (asset_record) to add later; `admit_early` (a stack index) is
        admitted before $CURB's launch, as the run before 9 October 2026 left
        every factory but the last."""
        txs, n = [], [0]
        def tx(kind, name, address, fn=None, args=None, extra=None):
            n[0] += 1
            txs.append({"hash": "0x" + format(n[0], "064x"), "transactionType": kind, "contractName": name,
                        "contractAddress": address, "function": fn, "arguments": args,
                        "transaction": {"from": D}, "additionalContracts": extra or []})
        # IN DeployCurb's ORDER: the shared contracts, the distributor factory
        # admitted and the lens; every stack built, none admitted; the dev buy
        # wrapped and approved; the WETH factory wired; $CURB; every other
        # factory added; the registry offered.
        tx("CREATE", "LaunchRegistry", REG, args=[D]); tx("CREATE", "SharingCatalog", CAT)
        tx("CREATE", "Graduator", GRAD); tx("CREATE2", "FeeHook", HOOK)
        tx("CREATE", "HolderDistributorFactory", DF); tx("CALL", "SharingCatalog", CAT, "admitInitial(address)", [DF])
        tx("CREATE", "LaunchLens", LENS)
        admitted = [i for i in order if i != skip]
        for i in range(len(assets)):
            if i != skip:
                stack_txs(tx, stacks[i])
        tx("CALL", None, T["WETH"], "deposit()", [])
        tx("CALL", None, T["WETH"], "approve(address,uint256)", [WETHF, "1"])
        later = []
        for k, i in enumerate(admitted):
            if k == 0 or i == admit_early:
                tx("CALL", "LaunchRegistry", REG, "wire(address,address)" if k == 0 else "addLauncher(address)",
                   [stacks[i]["factory"]])
            else:
                later.append(i)
        # THE LAUNCH CALL'S ONE ARGUMENT, AS forge RECORDS A TUPLE: name, symbol,
        # URI, salt, refund address, tax, dev buy, creator wallet, the platform
        # share and recipient it expects, the sharing factory.
        tx("CALL", "CurbLaunchFactory", WETHF, "launch((string,string,string,bytes32,address,uint16,uint256,address,uint16,address,address))",
           [f"(Curb, CURB, ipfs://x, 0x{'00' * 31}01, {CRE}, 300, 1, {CRE}, 50, {PLAT}, {DF})"],
           [{"transactionType": "CREATE", "address": CURVE}, {"transactionType": "CREATE2", "address": TOKEN}])
        for i in later:
            tx("CALL", "LaunchRegistry", REG, "addLauncher(address)", [stacks[i]["factory"]])
        tx("CALL", "LaunchRegistry", REG, "transferOwnership(address)", [OWN])
        receipts = [{"transactionHash": x["hash"], "status": "0x1"} for x in txs]
        # THE LAUNCH'S RECEIPT NAMES WHAT THE CHAIN MADE (launch_created).
        launch_hash = next(x["hash"] for x in txs if (x.get("function") or "").startswith("launch("))
        next(r for r in receipts if r["transactionHash"] == launch_hash)["logs"] = [
            {"address": WETHF, "topics": [LAUNCH_CREATED, "0x" + wa(TOKEN), "0x" + wa(CURVE), "0x" + wa(CRE)],
             "data": "0x" + w(10**27) + w(300)}]
        return {"transactions": txs, "receipts": receipts, "pending": [], "chain": 8453, "commit": "selftest"}

    def asset_record(i, platform=PLAT):
        """DeployAssetStack's record for stack i: its four contracts, sent by
        the same deployer and built to pay the hook's recipient of its day,
        and nothing admitted - the Safe admits it."""
        txs, n = [], [0]
        def tx(kind, name, address, fn=None, args=None):
            n[0] += 1
            txs.append({"hash": "0xa" + format(n[0], "063x"), "transactionType": kind, "contractName": name,
                        "contractAddress": address, "function": fn, "arguments": args, "transaction": {"from": D}})
        stack_txs(tx, stacks[i], platform)
        return {"transactions": txs, "receipts": [{"transactionHash": x["hash"], "status": "0x1"} for x in txs],
                "pending": [], "chain": 8453, "commit": "selftest"}

    # A STAND-IN FOR cast, AS A PROCESS: what the check runs on a real chain -
    # the arguments, --rpc-url, a refusal's exit status - asked once, for the
    # control and a refused read. Every other case reads the same answers in
    # process (SELFTEST_RPC), which is the difference between minutes and
    # seconds.
    fake = os.path.join(t, "cast")
    with open(fake, "w") as f:
        f.write("#!/usr/bin/env bash\n"
                "a=()\n"
                "while [ $# -gt 0 ] && [ \"$1\" != --rpc-url ]; do a+=(\"$1\"); shift; done\n"
                "k=\"${a[*]}\"\n"
                "awk -F'\\t' -v k=\"${k,,}\" '$1 == k { print $2; f = 1; exit } END { exit !f }' \"$(dirname \"$0\")/table\" "
                "|| { echo 'execution reverted' >&2; exit 1; }\n")
    os.chmod(fake, 0o755)
    n, failed = [0], [0]

    def run(c, r, extra_env=None, flags=(), stand_in=False, more=()):
        with open(os.path.join(t, "chain.json"), "w") as f:
            json.dump(c, f)
        with open(os.path.join(t, "run.json"), "w") as f:
            json.dump(r, f)
        # AN ASSET RUN'S RECORDS, after the run's own (`more`).
        paths = []
        for j, m in enumerate(more):
            paths.append(os.path.join(t, f"asset-{j}.json"))
            with open(paths[-1], "w") as f:
                json.dump(m, f)
        flags = (*paths, *flags)
        e = dict(os.environ)
        for k in list(e):
            if k.startswith("CURB_"):
                del e[k]
        e.update(env)
        e.update(extra_env or {})
        if stand_in:
            with open(os.path.join(t, "table"), "w") as f:
                f.writelines(f"{key}\t{val}\n" for key, val in c.items())
            e["CAST_BIN"] = fake
            rpc = "http://stand-in.invalid"
        else:
            e["CHECK_DEPLOYMENT_SELFTEST_CHAIN"] = os.path.join(t, "chain.json")
            rpc = SELFTEST_RPC
        p = subprocess.run(["bash", SELF, rpc, os.path.join(t, "run.json"), *flags],
                           capture_output=True, text=True, env=e)
        return p.returncode, p.stdout + p.stderr

    def sc(name, want, got):
        n[0] += 1
        if want == got:
            print(f"  pass  {name}")
        else:
            failed[0] += 1
            print(f"  FAIL  {name}\n        expected: {want}\n        got:      {got}")

    def refused(name, must_say, c=None, r=None, extra_env=None, flags=(), stand_in=False, more=()):
        rc, out = run(c or chain(), r or record(), extra_env, flags, stand_in, more)
        sc(name, "refused, saying it", "refused, saying it" if rc == 1 and must_say in out else f"exit {rc}: {out[-400:]}")

    def answer(c, key, val):
        assert key in c, key
        c[key] = val
        return c

    rc, out = run(chain(), record(), stand_in=True)
    sc("a deployment whose every answer is the one meant passes, the handover pending (the control, through a stand-in cast)",
       "0 PENDING", f"{rc} {'PENDING' if 'PENDING' in out else out[-600:]}")
    rc, out = run(chain(), record())
    sc("and the same answers read in process pass the same way (the control for every case below)", "0 PENDING",
       f"{rc} {'PENDING' if 'PENDING' in out else out[-600:]}")
    k = lambda to, sig, *a: " ".join(["call", to, sig] + list(a)).lower()
    W = lambda v: "0x" + w(v)
    WA = lambda a: "0x" + wa(a)
    refused("--accepted while the deployer still owns the registry", "has not accepted the registry", flags=("--accepted",))
    c = chain(); answer(c, k(REG, "owner()"), WA(OWN)); answer(c, k(REG, "pendingOwner()"), WA(ZERO))
    rc, out = run(c, record(), flags=("--accepted",))
    sc("the registry accepted by the policy owner passes --accepted (the control)", 0, rc)
    c = chain(); answer(c, k(REG, "pendingOwner()"), WA(ZERO))
    refused("a registry never offered to the policy owner", "neither the offer", c=c)
    r = record(); r["transactions"] = [x for x in r["transactions"] if x.get("function") != "transferOwnership(address)"]
    r["receipts"] = r["receipts"][:len(r["transactions"])]
    refused("a record that does not offer the registry", "does not offer the registry", r=r)
    refused("a hook owned by someone else", "hook.owner()", c=answer(chain(), k(HOOK, "owner()"), WA(A(0xBAD))))
    refused("a hook handed on and not accepted", "hook.pendingOwner()", c=answer(chain(), k(HOOK, "pendingOwner()"), WA(A(0xBAD))))
    refused("another platform recipient", "hook.platformRecipient()", c=answer(chain(), k(HOOK, "platformRecipient()"), WA(A(0xBAD))))
    # A CHANGE ANNOUNCED AND NOT EXECUTED: a note, never a failure - the check
    # is run inside the 24 hours too.
    NEW = A(0x5AFE)
    c = answer(chain(), k(HOOK, "pendingRecipient()"), WA(NEW)); answer(c, k(HOOK, "pendingRecipientReadyAt()"), W(1800000000))
    answer(c, k(HOOK, "pendingFeeBps()"), W(40)); answer(c, k(HOOK, "pendingFeeReadyAt()"), W(1800000000))
    rc, out = run(c, record())
    sc("a recipient and a share change announced are notes, not failures, each naming what to export once executed",
       "0 2", f"{rc} {out.count('announced, executable from 2027-01-15 08:00 UTC')}"
       if rc == 0 else f"{rc}: {out[-600:]}")
    sc("and they name CURB_HOOK_RECIPIENT and CURB_HOOK_SHARE_BPS", "1 1",
       f"{out.count(f'CURB_HOOK_RECIPIENT={NEW}')} {out.count('CURB_HOOK_SHARE_BPS=40')}")
    refused("a catalog whose bootstrap was never used", "catalog.bootstrapped()", c=answer(chain(), k(CAT, "bootstrapped()"), W(0)))
    refused("another publisher", "the distributor factory's publisher", c=answer(chain(), k(DF, "publisher()"), WA(A(0xBAD))))
    refused("a vetoer named that is not one", f"isVetoer({VET})", c=answer(chain(), k(DF, "isVetoer(address)", VET), W(0)))
    refused("the policy owner not a vetoer", f"isVetoer({OWN})", c=answer(chain(), k(DF, "isVetoer(address)", OWN), W(0)))
    refused("a frozen distributor factory", "frozen()", c=answer(chain(), k(DF, "frozen()"), W(1)))
    refused("an implementation of another factory", "the implementation's factory", c=answer(chain(), k(IMPL, "factory()"), WA(A(0xBAD))))
    refused("a lens on another Graduator", "lens.graduator()", c=answer(chain(), k(LENS, "graduator()"), WA(A(0xBAD))))
    a0, f1 = assets[1], stacks[1]["factory"]
    refused("a factory whose phantom is not the list's", f"{a0['label']}: factory.phantomQuote()",
            c=answer(chain(), k(f1, "phantomQuote()"), W(a0["phantom"] + 1)))
    refused("a factory whose threshold is not the list's, and the shape with it", "times its start",
            c=answer(chain(), k(f1, "graduationThreshold()"), W(a0["threshold"] * 2)))
    refused("a factory charging a launch fee", "launchFee()", c=answer(chain(), k(f1, "launchFee()"), W(1)))
    refused("a factory whose current platform policy names another recipient",
            f"{a0['label']}: factory.currentPlatformPolicy()'s recipient",
            c=answer(chain(), k(f1, "currentPlatformPolicy()"), "0x" + w(50) + wa(A(0xBAD))))
    refused("a factory whose current platform policy names another share",
            f"{a0['label']}: factory.currentPlatformPolicy()'s share",
            c=answer(chain(), k(f1, "currentPlatformPolicy()"), "0x" + w(49) + wa(PLAT)))
    refused("an escrow for another asset", "escrow.quoteToken()", c=answer(chain(), k(stacks[1]["escrow"], "quoteToken()"), WA(A(0xBAD))))
    refused("a vault owned by someone other than the deployer", "vault.owner()", c=answer(chain(), k(stacks[1]["vault"], "owner()"), WA(A(0xBAD))))
    refused("one launcher fewer than the record's factories", "registry.launcherCount()",
            c=answer(chain(), k(REG, "launcherCount()"), W(len(stacks) - 1)))
    refused("the launchers in another order", "registry.launcherAt(1)",
            c=answer(chain(), k(REG, "launcherAt(uint256)", "1"), WA(WETHF)))
    # THE WETH FACTORY ADMITTED LAST, as the run before this one did: the
    # registry's order is the record's, and the record admits it first.
    refused("the WETH factory admitted last while the record admits it first", "registry.launcher() (the one wired)",
            c=chain([i for i in order if i != wi] + [wi]))
    # ANOTHER FACTORY ADMITTED BEFORE $CURB'S LAUNCH, the chain agreeing with
    # the record: a launch on it could have come first (DeployCurb's
    # FirstLaunch), so the record itself is refused.
    early = order[1]
    refused("a record that admits another factory before $CURB's launch", "before $CURB's launch: the WETH factory",
            c=chain([wi, early] + [i for i in order if i not in (wi, early)]), r=record(admit_early=early))
    r = record()
    wire = next(x for x in r["transactions"] if x.get("function") == "wire(address,address)")
    wire["arguments"] = [A(0xBAD), HOOK]
    refused("a record whose wire() names a factory it did not create", "not each factory it created admitted once", r=r)
    # AN ASSET ADDED LATER BY THE SAME DEPLOYER: its stack is the asset run's,
    # admitted after the run's own by the Safe - not one the run's record had
    # to admit.
    sp = next(i for i, a in enumerate(assets) if a["label"] == "SPCXc")
    later = [i for i in order if i != sp] + [sp]
    rc, out = run(chain(later), record(skip=sp), more=(asset_record(sp),))
    sc("an asset added later by the same deployer, admitted last by the Safe, passes (the control)", "0", f"{rc}"
       if rc == 0 else f"{rc}: {out[-600:]}")
    refused("and an asset run's factory the registry does not list last", "registry.launcherAt(",
            c=chain(order), r=record(skip=sp), more=(asset_record(sp),))
    # THE RECIPIENT CHANGED, EXECUTED (finding: the check could never pass
    # again): the hook and every factory's currentPlatformPolicy() name the
    # new one, every factory and policy keeps the one it was built with, and
    # so does $CURB.
    def moved(rcpt=NEW, bps=50):
        c = answer(chain(), k(HOOK, "platformRecipient()"), WA(rcpt))
        answer(c, k(HOOK, "platformFeeBps()"), W(bps))
        for s in stacks:
            answer(c, k(s["factory"], "currentPlatformPolicy()"), "0x" + w(bps) + wa(rcpt))
        return c
    rc, out = run(moved(), record(), {"CURB_HOOK_RECIPIENT": NEW})
    sc("after a recipient change, CURB_HOOK_RECIPIENT exported, the deployment passes (the control)", 0,
       rc if rc == 0 else f"{rc}: {out[-600:]}")
    refused("after a recipient change, without CURB_HOOK_RECIPIENT, the hook fails, naming it",
            "hook.platformRecipient() (the run's, CURB_PLATFORM_RECIPIENT)", c=moved())
    refused("and CURB_HOOK_RECIPIENT exported while the hook still holds the run's", "hook.platformRecipient() (CURB_HOOK_RECIPIENT)",
            extra_env={"CURB_HOOK_RECIPIENT": NEW})
    rc, out = run(moved(PLAT, 40), record(), {"CURB_HOOK_SHARE_BPS": "40"})
    sc("after a share change, CURB_HOOK_SHARE_BPS exported, it passes; $CURB keeps the share it froze (the control)", 0,
       rc if rc == 0 else f"{rc}: {out[-600:]}")
    refused("after a share change, without CURB_HOOK_SHARE_BPS, the hook fails", "hook.platformFeeBps()", c=moved(PLAT, 40))
    # WHAT IT FROZE, against the record.
    refused("a factory paying another recipient than the record built it with", f"{a0['label']}: factory.protocolFeeRecipient() (frozen when built)",
            c=answer(chain(), k(f1, "protocolFeeRecipient()"), WA(NEW)))
    refused("a policy paying another recipient than the record built it with", f"{a0['label']}: policy.protocolFeeRecipient() (frozen when built)",
            c=answer(chain(), k(stacks[1]["policy"], "protocolFeeRecipient()"), WA(NEW)))
    r = record()
    for x in r["transactions"]:
        if (x.get("contractAddress") or "").lower() == stacks[1]["policy"]:
            x["arguments"] = [NEW, stacks[1]["escrow"], "500"]
    refused("a record whose policy and factory were built with two recipients", "name two platform recipients", r=r)
    r = record()
    for x in r["transactions"]:
        if (x.get("contractAddress") or "").lower() in (stacks[1]["policy"], stacks[1]["factory"]):
            x["arguments"] = [str(v).replace(PLAT, NEW) for v in x["arguments"]]
    refused("a run's stack built with another recipient than CURB_PLATFORM_RECIPIENT",
            f"{a0['label']}: the platform recipient the run built it with",
            c=answer(answer(chain(), k(f1, "protocolFeeRecipient()"), WA(NEW)), k(stacks[1]["policy"], "protocolFeeRecipient()"), WA(NEW)),
            r=r)
    # AN ASSET ADDED AFTER THE CHANGE is built with the new recipient, and says so.
    later_c = moved()
    later_c = {**later_c, **{key: val for key, val in chain(later).items() if key.startswith("call " + REG + " launcher")}}
    answer(later_c, k(stacks[sp]["factory"], "protocolFeeRecipient()"), WA(NEW))
    answer(later_c, k(stacks[sp]["policy"], "protocolFeeRecipient()"), WA(NEW))
    rc, out = run(later_c, record(skip=sp), {"CURB_HOOK_RECIPIENT": NEW}, more=(asset_record(sp, NEW),))
    sc("an asset added after the change, built with the new recipient, passes and says what it pays (the control)",
       "0 noted", f"{rc} {'noted' if f'built by an asset run to pay {NEW}' in out else out[-600:]}")
    # $CURB'S FROZEN PAIR, against its launch call.
    refused("$CURB stamped with another recipient than its launch call carried", "$CURB's platform recipient (frozen at launch)",
            c=answer(chain(), k(REG, "launchOf(address)", TOKEN), "0x" + wa(CURVE) + wa(T["WETH"]) + wa(CRE) + wa(CRE)
                     + w(0) + w(500) + w(10) + wa(HOOK) + w(300) + w(50) + wa(NEW) + w(1)))
    r = record()
    for x in r["transactions"]:
        if (x.get("function") or "").startswith("launch("):
            x["arguments"] = [x["arguments"][0].replace(f"50, {PLAT}", f"50, {NEW}")]
    refused("a $CURB launch call made with another recipient than the run's", "$CURB's launch call: the platform recipient", r=r)
    refused("a factory with no code", "holds no code", c=answer(chain(), "codesize " + f1.lower(), "0"))
    c = chain(); del c[k(DF, "keeperPayee()")]
    refused("a read that fails is a failure, never a pass", "keeper payee could not be read", c=c)
    refused("and so is a read the stand-in cast refuses, as a real one would", "keeper payee could not be read: execution reverted",
            c=c, stand_in=True)
    refused("$CURB for another creator", "$CURB's beneficiary", extra_env={"CURB_FIRST_CREATOR": A(0xBAD)})
    refused("$CURB with another symbol", "$CURB's symbol", extra_env={"CURB_FIRST_SYMBOL": "CRB"})
    refused("$CURB not shared, when it was meant to be", "does not share",
            c=answer(chain(), k(GRAD, "holderDistributorOf(address)", TOKEN), WA(ZERO)))
    refused("launchAt(0) not the token the record's launch made", "is not among the registry's first 1 launches",
            c=answer(chain(), k(REG, "launchAt(uint256)", "0"), WA(A(0xBAD))))
    # BEATEN TO LAUNCH 0 in the one receipt the run leaves open (DeployCurb's
    # FirstLaunch): somebody's launch is launchAt(0) and $CURB launchAt(1).
    def beaten():
        c = answer(chain(), k(REG, "launchCount()"), W(2))
        answer(c, k(REG, "launchAt(uint256)", "0"), WA(A(0x1A1)))
        c[k(REG, "launchAt(uint256)", "1")] = WA(TOKEN)
        return c
    refused("$CURB beaten to launch 0 by somebody else's launch", "not launchAt(0): 1 launch(es) landed before it", c=beaten())
    rc, out = run(beaten(), record(), {"CURB_FIRST_INDEX": "1"})
    sc("and, once recorded, the same with CURB_FIRST_INDEX=1 passes, saying so (the control)", "0 note",
       f"{rc} {'note' if 'as CURB_FIRST_INDEX says' in out else out[-600:]}")
    refused("CURB_FIRST_INDEX=1 while $CURB is launch 0", "and CURB_FIRST_INDEX says 1: unset it",
            extra_env={"CURB_FIRST_INDEX": "1"})
    r = record()
    for x in r["receipts"]:
        x.pop("logs", None)
    refused("a $CURB launch whose receipt names no token", "holds no LaunchCreated from the WETH factory", r=r)
    refused("$CURB's record naming another curve than its launch's receipt", "$CURB's curve",
            c=answer(chain(), k(REG, "launchOf(address)", TOKEN), "0x" + wa(A(0xBAD)) + wa(T["WETH"]) + wa(CRE) + wa(CRE)
                     + w(0) + w(500) + w(10) + wa(HOOK) + w(300) + w(50) + wa(PLAT) + w(1)))
    r = record(); r["receipts"][5]["status"] = "0x0"
    refused("a reverted transaction in the record", "reverted on chain", r=r)
    r = record(); r["receipts"] = r["receipts"][:-3]
    refused("a record with transactions and no receipts (a partial run)", "a partial deployment", r=r)
    r = record(); r["transactions"][3]["transaction"]["from"] = A(0xBAD)
    refused("a record sent by two keys", "was sent by 2 keys", r=r)
    refused("a record sent by a key other than CURB_DEPLOYER", "not CURB_DEPLOYER", extra_env={"CURB_DEPLOYER": A(0xBAD)})
    r = record(); r["chain"] = 31337
    refused("a record from another chain", "'s chain is 31337, not 8453", r=r)
    r = record()
    r["transactions"].insert(-1, {"hash": "0xdemo", "transactionType": "CALL", "contractName": "CurbLaunchFactory",
                                  "contractAddress": stacks[4]["factory"], "function": "launch((...))",
                                  "transaction": {"from": D}, "additionalContracts": []})
    r["receipts"].append({"transactionHash": "0xdemo", "status": "0x1"})
    refused("a demo launch on chain 8453, even when said", "a demo on mainnet", r=r, extra_env={"CURB_DEMO_LAUNCH": "true"})
    refused("a policy owner other than the one deployed", "hook.owner()", extra_env={"CURB_POLICY_OWNER": A(0xBAD)})
    rc, out = run(chain(), record(), {"CURB_FIRST_LAUNCH": "yes"})
    sc("CURB_FIRST_LAUNCH other than 1 or 0 is a usage error", 2, rc)
    rc, out = run(chain(), record(), {"CURB_SHARING_VETOERS": ""})
    sc("no vetoer named is a usage error", 2, rc)
    # THE EIP-55 CHECKSUM: A6's recorded recipient with one letter's case
    # flipped is refused before anything is read; checksummed, it is taken
    # (and then compared, failing here only because this chain pays PLAT).
    rc, out = run(chain(), record(), {"CURB_FIRST_CREATOR": "0x52483b53c8c08Ece00932A65DaE70487dcCD21E0"})
    sc("an address exported in mixed case with a wrong checksum is a usage error, naming it", "2 named",
       f"{rc} {'named' if 'CURB_FIRST_CREATOR is written in mixed case and that is not its EIP-55 checksum' in out else out[-300:]}")
    rc, out = run(chain(), record(), {"CURB_SHARING_VETOERS": VET + ",0x52483b53c8c08Ece00932A65DaE70487dcCD21E0"})
    sc("and so is a vetoer entry with a wrong checksum", 2, rc)
    rc, out = run(chain(), record(), {"CURB_FIRST_CREATOR": "0x52483b53c8C08Ece00932A65DaE70487dcCD21E0"})
    sc("the same address checksummed is taken, and compared (the control)", "1 compared",
       f"{rc} {'compared' if 'beneficiary' in out else out[-300:]}")
    print()
    if failed[0] == 0:
        print(f"check-deployment selftest: all {n[0]} checks passed")
        return 0
    print(f"check-deployment selftest: {failed[0]} of {n[0]} checks FAILED")
    return 1


RPC = ""
if ARGS[:1] == ["--selftest"]:
    sys.exit(selftest())
sys.exit(main(ARGS))
PY
