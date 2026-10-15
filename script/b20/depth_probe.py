# -*- coding: utf-8 -*-
"""
THE MEASUREMENT HALF OF measure-depth.sh.

measure-depth.sh owns the port lock, the node and the block; this owns every
question asked of the chain. It is a separate file for one reason: A FAILED RPC
CALL MUST NEVER BECOME A NUMBER, and that rule is only checkable if there is
exactly one place where a call's outcome is decided.

    THE BUG THIS FILE EXISTS TO PREVENT. The first version ran every call as
    `base-cast call ... 2>/dev/null` and read the empty output as an answer. A
    failed tier query became "that tier is not enabled". A failed token query
    became "that address is not a token". A failed getPool became "no pool". And
    in the cost-limit search a failed quote became "zero output", which reads as
    "infinitely expensive", which pushed the search DOWN - so a network hiccup
    would have produced a quiet, plausible, WRONG "this pool is shallow".

    THREE OUTCOMES, NEVER TWO
      ok          the contract answered
      reverted    the contract answered BY REVERTING. That is data: a pool that
                  does not exist, a token with no symbol().
      failed      anything else - transport, timeout, rate limit, a JSON-RPC
                  error that is not a revert. That is OURS. It is never data.
    Only `execution reverted` counts as a revert. Anything unrecognised is
    treated as our failure, because the safe direction is to report less.

WHAT A FAILURE DOES depends on what was being asked:
    a structural read     the run STOPS. slot0, balanceOf, getPool and
                          feeAmountTickSpacing cannot legitimately fail, so a
                          failure means the measurement is not happening.
    a ladder row          that ROW is printed as failed. No cost, no percentage.
    a search              that SEARCH is abandoned and says so. No number.
    and in every case the run exits non-zero at the end, so a caller cannot
    treat a partially-failed measurement as a measurement.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- selectors
SLOT0 = "0x3850c7bd"
LIQUIDITY = "0x1a686502"
BALANCE_OF = "0x70a08231"
SYMBOL = "0x95d89b41"
DECIMALS = "0x313ce567"
GET_POOL = "0x1698ee82"
FEE_TICK_SPACING = "0x22afcccb"
QUOTE_EXACT_IN = "0xc6a5026a"
QUOTE_EXACT_OUT = "0xbd21704a"

# The bounds QuoterV2 passes to the pool when it is given no explicit price
# limit. A swap that ends EXACTLY on one of them stopped because it ran out of
# room, not because it ran out of input.
MIN_SQRT_LIMIT = 4295128740
MAX_SQRT_LIMIT = 1461446703485210103287273052203988822378723970341


class RpcFailed(Exception):
    """Ours: transport, timeout, rate limit, an unrecognised JSON-RPC error."""


class Reverted(Exception):
    """The contract's: it answered by reverting. This is data."""


# THE ONE CONDITION WORTH RETRYING, AND IT IS NARROW ON PURPOSE.
#
# A fork node serves state it has not cached by fetching it from upstream, and
# a large batch of cold reads can outrun what the public endpoint will give it.
# It says so in its own words - a -32603 carrying "failed to get storage" - and
# that is a self-identifying, transient, upstream-side condition. Retrying it is
# not papering over a failure; it is the same question asked again.
#
# NOTHING ELSE IS RETRIED. Not a plain rate-limit code, not an unrecognised
# JSON-RPC error. Retrying broadly would turn "the tool refuses to guess" into
# "the tool keeps asking until it gets a number", which is the same disease in
# a different costume - and it would quietly defeat
# script/b20/faultinject-depth.sh, whose injected faults must still be fatal.
#
# EVERY RETRY IS COUNTED AND PRINTED, so a flaky run cannot look like a clean
# one. If the retries run out, the call fails and the rule holds.
RETRYABLE = ("failed to get storage", "failed to get account",
             "failed to get code", "Fork Error")
MAX_RETRIES = 4


class Rpc:
    def __init__(self, url, block):
        self.url = url
        self.block = block
        self.calls = 0
        self.failures = 0
        self.retries = 0

    @staticmethod
    def _looks_transient(text):
        return any(marker in text for marker in RETRYABLE)

    def _post_once(self, payload):
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise RpcFailed("transport: %s" % e)

    def _post(self, payload):
        last = None
        for attempt in range(MAX_RETRIES):
            try:
                out = self._post_once(payload)
            except RpcFailed as e:
                last = e
                if attempt + 1 < MAX_RETRIES:
                    self.retries += 1
                    time.sleep(0.5 * (attempt + 1))
                    continue
                self.failures += 1
                raise
            # A response can carry a transient upstream failure inside it.
            text = json.dumps(out)
            if self._looks_transient(text) and "execution reverted" not in text:
                last = RpcFailed("upstream fetch: %s" % text[:160])
                if attempt + 1 < MAX_RETRIES:
                    self.retries += 1
                    time.sleep(0.5 * (attempt + 1))
                    continue
                self.failures += 1
                raise last
            return out
        self.failures += 1
        raise last

    @staticmethod
    def _is_revert(err):
        text = json.dumps(err) if not isinstance(err, str) else err
        return "execution reverted" in text

    def call(self, to, data, override=None):
        """One eth_call. Returns hex result, or raises Reverted / RpcFailed.

        `override` is an eth_call state override: it exists only for the
        duration of this one call, nothing is mined and no transaction is
        created. It is how SwapDeltaProbe gets its code somewhere it can be
        called from - see real_swap()."""
        self.calls += 1
        params = [{"to": to, "data": data}, self.block]
        if override is not None:
            params.append(override)
        out = self._post({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                          "params": params})
        if not isinstance(out, dict):
            self.failures += 1
            raise RpcFailed("malformed response: %r" % (out,)[:200])
        if "error" in out:
            if self._is_revert(out["error"]):
                raise Reverted(json.dumps(out["error"])[:160])
            self.failures += 1
            raise RpcFailed("json-rpc error: %s" % json.dumps(out["error"])[:160])
        if "result" not in out:
            self.failures += 1
            raise RpcFailed("no result field: %s" % json.dumps(out)[:160])
        return out["result"]

    def call_batch(self, items):
        """items: [(to, data)]. Returns [("ok", hex) | ("reverted", msg)].
        A transport failure raises - one bad batch is not partial data."""
        self.calls += len(items)
        payload = [{"jsonrpc": "2.0", "id": i, "method": "eth_call",
                    "params": [{"to": to, "data": data}, self.block]}
                   for i, (to, data) in enumerate(items)]
        out = self._post(payload)
        if not isinstance(out, list) or len(out) != len(items):
            self.failures += 1
            raise RpcFailed("batch of %d came back as %s of %s"
                            % (len(items), type(out).__name__,
                               len(out) if hasattr(out, "__len__") else "?"))
        by_id = {}
        for item in out:
            if not isinstance(item, dict) or "id" not in item:
                self.failures += 1
                raise RpcFailed("batch item without an id: %r" % (item,))
            by_id[item["id"]] = item
        results = []
        for i in range(len(items)):
            item = by_id.get(i)
            if item is None:
                self.failures += 1
                raise RpcFailed("batch item %d missing from the response" % i)
            if "error" in item:
                if self._is_revert(item["error"]):
                    results.append(("reverted", json.dumps(item["error"])[:120]))
                    continue
                self.failures += 1
                raise RpcFailed("batch item %d: %s" % (i, json.dumps(item["error"])[:160]))
            if "result" not in item:
                self.failures += 1
                raise RpcFailed("batch item %d has no result" % i)
            results.append(("ok", item["result"]))
        return results


# ------------------------------------------------------------ encode/decode
def enc_addr(a):
    return "%064x" % int(a, 16)


def enc_uint(n):
    return "%064x" % n


def words(hexstr):
    h = hexstr[2:] if hexstr.startswith("0x") else hexstr
    return [int(h[i:i + 64], 16) for i in range(0, len(h) - len(h) % 64, 64)]


def to_int256(w):
    return w - (1 << 256) if w >= (1 << 255) else w


def decode_string(hexstr):
    h = hexstr[2:] if hexstr.startswith("0x") else hexstr
    if len(h) < 128:
        raise ValueError("too short for a string")
    length = int(h[64:128], 16)
    raw = bytes.fromhex(h[128:128 + length * 2])
    return raw.decode("utf-8", "replace")


class Abort(Exception):
    """A structural read failed. The measurement is not happening."""


def must(rpc, what, to, data, allow_revert=False):
    """A read that cannot legitimately fail. Anything but an answer stops the
    run - printing a number derived from a failed call is the whole thing this
    file exists to prevent."""
    try:
        return rpc.call(to, data)
    except Reverted as e:
        if allow_revert:
            return None
        raise Abort("%s REVERTED, which this contract should never do: %s" % (what, e))
    except RpcFailed as e:
        raise Abort("%s did not answer: %s" % (what, e))


# ------------------------------------------------------------------- quotes
class Quote:
    __slots__ = ("out", "sqrt_after", "hit_bound")

    def __init__(self, out, sqrt_after, hit_bound):
        self.out = out
        self.sqrt_after = sqrt_after
        self.hit_bound = hit_bound


def bound_for(token_in, token_out):
    return MIN_SQRT_LIMIT if token_in.lower() < token_out.lower() else MAX_SQRT_LIMIT


def quote_exact_in(rpc, quoter, token_in, token_out, amount_in, fee):
    """Raises Reverted (the swap is impossible - data) or RpcFailed (ours)."""
    data = (QUOTE_EXACT_IN + enc_addr(token_in) + enc_addr(token_out)
            + enc_uint(amount_in) + enc_uint(fee) + enc_uint(0))
    w = words(rpc.call(quoter, data))
    if len(w) < 2:
        raise RpcFailed("quoteExactInputSingle returned %d words" % len(w))
    return Quote(w[0], w[1], w[1] == bound_for(token_in, token_out))


def quote_exact_out(rpc, quoter, token_in, token_out, amount_out, fee):
    data = (QUOTE_EXACT_OUT + enc_addr(token_in) + enc_addr(token_out)
            + enc_uint(amount_out) + enc_uint(fee) + enc_uint(0))
    w = words(rpc.call(quoter, data))
    if not w:
        raise RpcFailed("quoteExactOutputSingle returned nothing")
    return w[0]


# ============================================================================
# THE ONE THING QuoterV2 WILL NOT TELL YOU: what the swap actually spent
# ============================================================================
#
# quoteExactInputSingle returns the output, the ending price and the ticks
# crossed. It does NOT return the input the swap consumed. So "77.6% of the
# input was spent" could not be read off the call it was describing, and an
# earlier version of this file estimated it instead - by bisecting on the price
# bound across MANY simulations of DIFFERENT amounts from the same state. That
# is a reasonable estimate of a boundary. It is not a measurement of the swap
# in front of you, and it was being printed as though it were.
#
# THE POOL ITSELF RETURNS BOTH DELTAS. script/b20/SwapDeltaProbe.sol calls
# pool.swap and hands back what was really paid and really received, for that
# one swap. Its deployed bytecode is installed through this call's own state
# override at an address that ALREADY HOLDS the input token - NVDAc cannot be
# minted into a fresh address, it is not an ordinary ERC20 with ordinary
# storage - and the override vanishes when the call returns. Nothing is mined.
#
# THE CALLBACK PAYS FOR REAL, which is what makes it evidence: an unpaid pool
# reverts, so deltas coming back mean the swap really happened in that state.
PROBE_HOST = "0x498581fF718922c3f8e6A244956aF099B2652b2b"   # Uniswap v4 PoolManager
PROBE_SELECTOR = "0x0844924d"      # probe(address,bool,int256,uint160)
PROBE_ARTIFACT = "out/SwapDeltaProbe.sol/SwapDeltaProbe.json"


def load_probe_code(path=PROBE_ARTIFACT):
    """The probe's runtime bytecode, or a refusal to measure without it."""
    try:
        with open(path) as f:
            code = json.load(f)["deployedBytecode"]["object"]
    except (OSError, KeyError, ValueError, TypeError) as e:
        raise Abort("cannot read the swap probe at %s (%s).\n"
                    "       Build it first:  base-forge build script/b20/SwapDeltaProbe.sol"
                    % (path, e))
    if not isinstance(code, str) or not code.startswith("0x") or len(code) < 10:
        raise Abort("%s carries no deployed bytecode" % path)
    return code


def real_swap(rpc, code, pool, token_in, token_out, amount_in):
    """What this swap REALLY spent and REALLY received, from the pool's own
    returned deltas. Same swap, same state - not a second simulation.

    Raises Reverted (the swap could not happen, or the host could not pay) or
    RpcFailed (ours), like everything else here."""
    zero_for_one = token_in.lower() < token_out.lower()
    limit = MIN_SQRT_LIMIT if zero_for_one else MAX_SQRT_LIMIT
    data = (PROBE_SELECTOR + enc_addr(pool) + enc_uint(1 if zero_for_one else 0)
            + enc_uint(amount_in) + enc_uint(limit))
    w = words(rpc.call(PROBE_HOST, data, override={PROBE_HOST: {"code": code}}))
    if len(w) < 4:
        raise RpcFailed("the swap probe returned %d words, wanted 4" % len(w))
    return w[2], w[3]          # spent, received


def host_balance(rpc, token):
    """What the probe host holds. A probe asking for more than this reverts
    because it cannot pay, and that must not be mistaken for a pool limit."""
    return words(must(rpc, "balanceOf of the probe host", token,
                      BALANCE_OF + enc_addr(PROBE_HOST)))[0]


# ============================================================================
# 0. the tier domain - probed, and named as a probe
# ============================================================================
def probe_tiers(rpc, factory, out):
    """Every enabled fee tier among a PROBED DOMAIN, in batches.

    THIS IS A PROBE, NOT AN ENUMERATION, and the report says so. The complete
    answer is the factory's FeeAmountEnabled logs, which this upstream refuses:
    eth_getLogs is capped at a 2,000-block range there and Base is past block
    51,000,000, so a full scan is ~25,000 requests. The domain below is wide
    enough that the difference is unlikely to matter and narrow enough to run
    in one batch - and if a call in it fails, the run stops rather than
    recording "not enabled"."""
    domain = (list(range(1, 1001))
              + list(range(1010, 20001, 10))
              + [25000, 30000, 50000, 100000, 200000, 500000, 1000000])
    enabled = []
    CHUNK = 100
    for i in range(0, len(domain), CHUNK):
        part = domain[i:i + CHUNK]
        items = [(factory, FEE_TICK_SPACING + enc_uint(f)) for f in part]
        try:
            results = rpc.call_batch(items)
        except RpcFailed as e:
            raise Abort("the fee-tier probe failed, so no tier can be called "
                        "enabled or not: %s" % e)
        for fee, (kind, value) in zip(part, results):
            if kind == "reverted":
                raise Abort("feeAmountTickSpacing(%d) reverted, which this "
                            "factory should never do: %s" % (fee, value))
            spacing = words(value)[0] if words(value) else 0
            if spacing:
                enabled.append((fee, to_int256(spacing)))

    out("  FEE TIERS - PROBED, NOT ENUMERATED")
    out("    domain probed   every fee from 1 to 1,000, every 10 up to 20,000,")
    out("                    and 25k 30k 50k 100k 200k 500k 1M - %d values" % len(domain))
    out("    method          feeAmountTickSpacing(uint24) != 0, in batches")
    out("    NOT the factory's FeeAmountEnabled logs. That is the complete")
    out("    answer and this upstream will not serve it: eth_getLogs is capped")
    out("    at a 2,000-block range and Base is past block 51,000,000. So this")
    out("    is 'the enabled tiers WITHIN THIS DOMAIN', and a tier outside it")
    out("    would not be seen.")
    out("    ENABLED:")
    for fee, spacing in enabled:
        out("      %-8d tick spacing %d" % (fee, spacing))
    out("")
    return [fee for fee, _ in enabled]


# ============================================================================
# 1. the quote tokens, and what each pool contract holds
# ============================================================================
def confirm_tokens(rpc, candidates, out):
    """A token is confirmed by symbol() and decimals(). A REVERT means the
    address does not answer them - that is data, and the address is skipped
    with a reason. An RPC FAILURE stops the run: 'we could not ask' and 'it is
    not a token' are not the same sentence."""
    out("  QUOTE TOKENS, each confirmed on chain:")
    confirmed = []
    for addr in candidates:
        try:
            sym_raw = rpc.call(addr, SYMBOL)
            symbol = decode_string(sym_raw)
        except Reverted:
            out("    %-44s does not answer symbol() - skipped" % addr)
            continue
        except RpcFailed as e:
            raise Abort("symbol() on %s did not answer: %s" % (addr, e))
        except ValueError:
            out("    %-44s symbol() is not a string - skipped" % addr)
            continue
        try:
            dec = words(rpc.call(addr, DECIMALS))[0]
        except Reverted:
            out("    %-44s answers symbol() but not decimals() - skipped" % addr)
            continue
        except RpcFailed as e:
            raise Abort("decimals() on %s did not answer: %s" % (addr, e))
        out("    %-44s %-8s %d decimals" % (addr, symbol, dec))
        confirmed.append((symbol, addr, dec))
    out("")
    return confirmed


def survey_pools(rpc, factory, nvdac, tokens, tiers, out):
    out("  WHAT EACH POOL CONTRACT HOLDS, at this block")
    out("    THIS IS A BALANCE SHEET, NOT A DEPTH. It is what the CONTRACT")
    out("    holds - every tick, in range and out, plus uncollected fees. It")
    out("    bounds what any trade could ever extract; section 3 measures what")
    out("    a trade actually gets.")
    out("    %-7s %-7s %-44s %14s %18s %s"
        % ("pair", "tier", "pool", "NVDAc", "other", "in-range liquidity"))
    found = []
    for symbol, addr, dec in tokens:
        for tier in tiers:
            data = GET_POOL + enc_addr(nvdac) + enc_addr(addr) + enc_uint(tier)
            raw = must(rpc, "getPool(NVDAc, %s, %d)" % (symbol, tier), factory, data)
            pool_word = words(raw)[0] if words(raw) else 0
            if pool_word == 0:
                continue
            pool = "0x%040x" % pool_word
            nvb = words(must(rpc, "NVDAc balanceOf(%s)" % pool, nvdac,
                             BALANCE_OF + enc_addr(pool)))[0]
            otb = words(must(rpc, "%s balanceOf(%s)" % (symbol, pool), addr,
                             BALANCE_OF + enc_addr(pool)))[0]
            liq = words(must(rpc, "liquidity() of %s" % pool, pool, LIQUIDITY))[0]
            out("    %-7s %-7d %-44s %14.2f %18.4f %d"
                % (symbol, tier, pool, nvb / 1e8, otb / 10 ** dec, liq))
            found.append((symbol, addr, dec, tier, pool, nvb, otb, liq))
    out("")
    return found


def read_mid(rpc, pool, nvdac, other, other_dec):
    """other-per-NVDAc, from the pool's own slot0."""
    sqrt_x96 = words(must(rpc, "slot0() of %s" % pool, pool, SLOT0))[0]
    p = (sqrt_x96 / (1 << 96)) ** 2
    raw = p if nvdac.lower() < other.lower() else 1 / p
    return raw * (10 ** 8) / (10 ** other_dec)


# ============================================================================
# 2. what the pool gives and what it takes - OBSERVED, and MEASURED
# ============================================================================
#
# THREE DIFFERENT KINDS OF STATEMENT LIVE HERE, AND THEY ARE NOT INTERCHANGEABLE.
#
#   OBSERVED CEILING   the highest output seen across the amounts tried. It is
#                      a floor under the true ceiling and an upper bound on
#                      nothing: a finite sweep cannot prove a plateau is final.
#                      Written as "observed", with the range that was tried.
#   MEASURED BOUNDARY  the input a swap REALLY consumed when asked for more
#                      than it could take, read from the pool's own returned
#                      deltas via SwapDeltaProbe. One swap, one call, no
#                      inference.
#   ESTIMATED BOUNDARY the same quantity from bisection on QuoterV2's price
#                      bound - many simulations of DIFFERENT amounts from the
#                      same state. An estimate. Kept because agreeing with the
#                      measurement is worth something, and labelled as what it
#                      is. An earlier version printed only this, as though it
#                      were the consumed input of the row it sat next to.
#
# AND A SWAP THAT STOPS EARLY IS A PARTIAL FILL, NOT A REFUSAL. The call
# succeeds, the pool takes what it can and pays for it, and the rest of the
# input is simply never spent. An earlier version said the pool "REFUSES an
# input over ~36.6 NVDAc", which describes a revert. Nothing reverts.
GROWTH_CEILING = 1 << 200


class Limits:
    __slots__ = ("out_max", "in_at_out_max", "largest_tried", "bound_in",
                 "bound_from", "cross_check", "measured_spent",
                 "measured_request", "measured_received", "measured_note",
                 "notes")

    def __init__(self):
        self.out_max = None
        self.in_at_out_max = None
        self.largest_tried = None
        self.bound_in = None
        self.bound_from = None
        self.cross_check = None
        self.measured_spent = None
        self.measured_request = None
        self.measured_received = None
        self.measured_note = ""
        self.notes = []


def measure_limits(rpc, quoter, token_in, token_out, fee, seed, failures, label):
    """Returns Limits, or None if an RPC failure made it unmeasurable."""
    lim = Limits()
    seed = max(seed, 1)

    def q(amount):
        return quote_exact_in(rpc, quoter, token_in, token_out, amount, fee)

    # ---- 1. grow. Track the observed output ceiling and the price bound.
    lo_unbounded = 0
    hi_bounded = None
    best_out = 0
    probe = seed
    saturated_at = None
    while probe < GROWTH_CEILING:
        lim.largest_tried = probe
        try:
            r = q(probe)
        except Reverted:
            lim.bound_from = "revert"
            lim.notes.append("the quote REVERTED at %d before any price bound "
                             "was reached, so no input bound is estimated" % probe)
            break
        except RpcFailed as e:
            failures.append("%s growth probe: %s" % (label, e))
            return None
        if r.out > best_out:
            best_out = r.out
            saturated_at = None
        elif saturated_at is None:
            saturated_at = probe
        if r.hit_bound:
            hi_bounded = probe
            lim.bound_from = "price bound"
            break
        lo_unbounded = probe
        probe *= 2

    lim.out_max = best_out

    # ---- 2. the smallest input that still reaches that observed ceiling.
    if best_out > 0 and saturated_at is not None:
        lo, hi = 0, saturated_at
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            try:
                r = q(mid)
            except Reverted:
                lo = mid
                break
            except RpcFailed as e:
                failures.append("%s ceiling bisection: %s" % (label, e))
                return None
            if r.out >= best_out:
                hi = mid
            else:
                lo = mid
        lim.in_at_out_max = hi

    # ---- 3. the ESTIMATED boundary, only where a price bound was reached.
    if hi_bounded is not None:
        lo, hi = lo_unbounded, hi_bounded
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            try:
                r = q(mid)
            except Reverted:
                hi = mid
                continue
            except RpcFailed as e:
                failures.append("%s bound bisection: %s" % (label, e))
                return None
            if r.hit_bound:
                hi = mid
            else:
                lo = mid
        lim.bound_in = lo
        try:
            out_at = q(lo).out
            lim.cross_check = quote_exact_out(rpc, quoter, token_in, token_out,
                                              out_at, fee)
        except Reverted:
            lim.cross_check = None
        except RpcFailed as e:
            failures.append("%s cross-check: %s" % (label, e))
    elif lim.bound_from is None:
        lim.notes.append("NO PRICE BOUND was reached at any amount tried, up to "
                         "%d raw units. That is a finite sweep, not a proof that "
                         "none exists." % (lim.largest_tried or 0))

    return lim


def measure_boundary(rpc, code, pool, token_in, token_out, host_bal, failures, label):
    """The input a swap REALLY consumed, read from the pool's own deltas.

    ASKED FOR THE LARGEST AMOUNT THE HOST CAN ACTUALLY PAY. If the probe were
    asked for more than the host holds, a revert would mean "we could not fund
    it", which is not a fact about the pool - and mistaking one for the other
    is the whole failure mode this file keeps running into."""
    if host_bal == 0:
        return ("unfunded", 0, None, None)
    try:
        spent, received = real_swap(rpc, code, pool, token_in, token_out, host_bal)
    except Reverted as e:
        return ("reverted", host_bal, None, str(e)[:120])
    except RpcFailed as e:
        failures.append("%s measured boundary: %s" % (label, e))
        return None
    return ("ok", host_bal, spent, received)


# ============================================================================
# 3. the cost ladder
# ============================================================================
def ladder(rpc, quoter, code, legs, sizes, out, failures):
    out("  THE SIZES ROADMAP PHASE 0 B NAMES, same absolute notional both ways.")
    out("")
    out("  cost        WHAT THE TRADE THAT ACTUALLY HAPPENED COST, in bps:")
    out("                  1 - received / (mid value of the input REALLY SPENT)")
    out("              Both sides come from the same probe call. Includes the")
    out("              30 bps LP fee; the rest is price impact. OUR tax is zero.")
    out("  filled      the input really spent, as a share of the amount asked")
    out("              for - measured on that swap, not inferred. Below 100% the")
    out("              swap FILLED PARTIALLY: the call succeeded, the pool took")
    out("              what it could and paid for it, and the rest of the input")
    out("              STAYED WITH THE TRADER. Unspent money is not a cost.")
    out("  shortfall   only on partial fills, and it is NOT a trade cost: how")
    out("              far the output falls below the mid value of the WHOLE")
    out("              offer. An earlier version printed this as the cost, which")
    out("              charged the trader for money they still had - the $50,000")
    out("              ETH row read 8246 bps when the trade that happened cost a")
    out("              small fraction of that.")
    out("")
    out("              100% FILLED IS NOT THE SAME AS A GOOD TRADE - the")
    out("              NVDAc->USDC rows spend everything and return about the")
    out("              same ~10,800 USD whatever you feed them.")
    out("")
    for leg in legs:
        out("  %s   (%s%% tier, pool %s)"
            % (leg["label"], leg["fee"] / 10000.0, leg["pool"]))
        out("    %-9s %13s %9s %12s  %s"
            % ("notional", "cost", "filled", "shortfall", "note"))
        for usd in sizes:
            amount_in, expected_whole = leg["size_for"](usd)

            # THE QUOTER IS THE CROSS-CHECK, NOT THE MEASUREMENT. It is asked
            # first so that a disagreement with the probe can stop the row.
            try:
                q = quote_exact_in(rpc, quoter, leg["token_in"], leg["token_out"],
                                   amount_in, leg["fee"])
            except Reverted:
                out("    $%-8d %13s %9s %12s  QUOTE REVERTED - this swap is not "
                    "possible" % (usd, "-", "-", "-"))
                continue
            except RpcFailed as e:
                failures.append("%s at $%d: %s" % (leg["label"], usd, e))
                out("    $%-8d %13s %9s %12s  RPC CALL FAILED - NOT A "
                    "MEASUREMENT: %s" % (usd, "-", "-", "-", e))
                continue

            if amount_in > leg.get("host_balance", 0):
                out("    $%-8d %13s %9s %12s  NOT MEASURED: the probe host holds "
                    "less of this token than the trade asks for"
                    % (usd, "-", "-", "-"))
                continue
            try:
                spent, received = real_swap(rpc, code, leg["pool"],
                                            leg["token_in"], leg["token_out"],
                                            amount_in)
            except Reverted as e:
                out("    $%-8d %13s %9s %12s  the swap probe REVERTED: %s"
                    % (usd, "-", "-", "-", str(e)[:70]))
                continue
            except RpcFailed as e:
                failures.append("%s spent at $%d: %s" % (leg["label"], usd, e))
                out("    $%-8d %13s %9s %12s  NOT MEASURED - the probe call "
                    "failed: %s" % (usd, "-", "-", "-", e))
                continue

            # TWO SIMULATIONS THAT DISAGREE PRODUCE NO NUMBER. Taking the cost
            # from one and the fill from the other would be reporting a trade
            # that neither of them simulated.
            if received != q.out:
                failures.append("%s at $%d: probe and quoter disagree on the "
                                "output, %d vs %d" % (leg["label"], usd, received, q.out))
                out("    $%-8d %13s %9s %12s  PROBE AND QUOTER DISAGREE on the "
                    "output (%d vs %d) - no figure is reported"
                    % (usd, "-", "-", "-", received, q.out))
                continue
            if spent == 0 or received == 0:
                out("    $%-8d %13s %9s %12s  nothing was spent or nothing came "
                    "back" % (usd, "-", "-", "-"))
                continue

            # THE COST IS AGAINST WHAT WAS SPENT, not against what was offered.
            expected_spent = leg["mid_out"](spent)
            cost = (1 - received / expected_spent) * 10_000
            fill = spent / amount_in * 100
            note, shortfall = "", "-"
            if fill < 99.999:
                shortfall = "%.0f bps" % ((1 - received / expected_whole) * 10_000)
                note = ("PARTIAL FILL - the trade that happened was $%s. The "
                        "other $%s was never spent."
                        % (format(usd * fill / 100, ",.0f"),
                           format(usd * (1 - fill / 100), ",.0f")))

            out("    $%-8d %10.0f bps %8.1f%% %12s  %s"
                % (usd, cost, fill, shortfall, note))
        out("")


# ============================================================================
# 4. depth at a cost
# ============================================================================
def largest_under(rpc, quoter, code, leg, limit_bps, failures):
    """The largest notional that is consumed IN FULL and costs under limit_bps.

    BOTH HALVES COME FROM THE SAME SWAP. An earlier version took the cost from
    the quoter and the fill from the probe, and threw the probe's output away -
    so the answer was assembled from two simulations, and a disagreement
    between them could not have been noticed. The probe's own `received` is the
    cost now, and the quoter is a cross-check that STOPS the search when it
    disagrees rather than a second opinion nobody reads.

    FULL CONSUMPTION IS PART OF THE CONDITION. Without it the answer reads
    "this whole amount trades at this cost" for a size the pool only partly
    fills - a friendlier claim than the truth.

    A FAILED QUOTE ABANDONS THE SEARCH. It does not count as "too expensive".
    An earlier version read a failed call as zero output, which reads as
    infinite cost, which drove the search DOWNWARDS - so a network fault
    produced a low number that looked like a shallow pool."""
    lo, hi = 0.0, 200000.0
    for _ in range(18):
        mid = (lo + hi) / 2
        amount_in, expected_whole = leg["size_for"](mid)
        if amount_in <= 0:
            lo = mid
            continue
        try:
            q = quote_exact_in(rpc, quoter, leg["token_in"], leg["token_out"],
                               amount_in, leg["fee"])
        except Reverted:
            hi = mid          # the swap is impossible at this size: real data
            continue
        except RpcFailed as e:
            failures.append("%s search at %d bps: %s" % (leg["label"], limit_bps, e))
            return None
        if amount_in > leg.get("host_balance", 0):
            failures.append("%s search at %d bps: cannot measure at this size, "
                            "the probe host holds too little" % (leg["label"], limit_bps))
            return None
        try:
            spent, received = real_swap(rpc, code, leg["pool"], leg["token_in"],
                                        leg["token_out"], amount_in)
        except Reverted:
            hi = mid
            continue
        except RpcFailed as e:
            failures.append("%s search at %d bps: %s" % (leg["label"], limit_bps, e))
            return None
        if received != q.out:
            failures.append("%s search at %d bps: probe and quoter disagree on "
                            "the output, %d vs %d - the search cannot produce a "
                            "number" % (leg["label"], limit_bps, received, q.out))
            return None
        if spent < amount_in:
            hi = mid          # it does not fill, so this size is not an answer
            continue
        cost = (1 - received / leg["mid_out"](spent)) * 10_000 if received else None
        if cost is not None and cost <= limit_bps:
            lo = mid
        else:
            hi = mid
    return lo


def depth_at_a_cost(rpc, quoter, code, legs, limits, out, failures):
    out("  THE LARGEST TRADE THAT IS BOTH FULLY CONSUMED AND UNDER A GIVEN COST")
    out("    in USD. This is the number a balance sheet was standing in for.")
    header = "    %-13s" % "leg"
    for limit in limits:
        header += "%16s" % ("under %d bps" % limit)
    out(header)
    for leg in legs:
        row = "    %-13s" % leg["label"]
        for limit in limits:
            value = largest_under(rpc, quoter, code, leg, limit, failures)
            row += "%16s" % ("ABANDONED" if value is None
                             else format(value, ",.0f"))
        out(row)
    out("")


# ============================================================================
# THE EXIT LEG - selling NVDAc, at amounts somebody else's table decides
# ============================================================================
#
# WHY THIS IS A SEPARATE ENTRY POINT. Leaving a launch is MEME -> NVDAc -> ETH,
# and the SECOND leg is sized by what the FIRST one returned - the NET NVDAc,
# after our pool's tax and impact - not by the nominal trade size. So the
# amounts cannot be known here: they come out of the Solidity grid, and are
# handed in.
#
# THE BUY-SIDE CONVERSION TABLE CANNOT BE REUSED FOR THIS. ETH -> NVDAc and
# NVDAc -> ETH are different sides of the same pool and they do not cost the
# same: at $5,000 the same block gives 166 bps buying and 191 bps selling.
def conversion_legs(rpc, out, entry_spec, sell_spec, failures):
    code = load_probe_code()
    try:
        amounts = sorted({int(a) for a in sell_spec.split(",") if a.strip()})
        notionals = sorted({float(a) for a in entry_spec.split(",") if a.strip()})
    except ValueError:
        raise Abort("--sell-amounts takes raw integers and --entry-usd takes numbers")
    if not amounts and not notionals:
        raise Abort("nothing to measure")

    def pool_of(other, fee):
        raw = must(rpc, "getPool for the exit leg", V3_FACTORY,
                   GET_POOL + enc_addr(NVDAC) + enc_addr(other) + enc_uint(fee))
        w = words(raw)[0] if words(raw) else 0
        return None if w == 0 else "0x%040x" % w

    usdc_pool = pool_of(USDC, 3000)
    weth_pool = pool_of(WETH, 3000)
    if usdc_pool is None or weth_pool is None:
        raise Abort("one of the two 0.30%% pools does not exist")

    usdc_per_nvdac = read_mid(rpc, usdc_pool, NVDAC, USDC, 6)
    eth_per_nvdac = read_mid(rpc, weth_pool, NVDAC, WETH, 18)
    out("  MID PRICES, each read from its own pool's slot0:")
    out("    1 NVDAc = %.4f USDC        1 NVDAc = %.8f ETH"
        % (usdc_per_nvdac, eth_per_nvdac))
    out("")
    host = {NVDAC: host_balance(rpc, NVDAC), WETH: host_balance(rpc, WETH),
            USDC: host_balance(rpc, USDC)}

    # ---- THE ENTRY LEG, and what matters is the NET it produces -------------
    #
    # A user arriving with $X of ETH does not end up holding $X of NVDAc. They
    # hold what the swap actually returned, and THAT is the amount our own pool
    # then trades. Quoting our pool at the nominal $X overstates it - by 31 to
    # 41 bps at $5,000 - which is exactly the error that made a "sells are 10
    # bps cheaper" claim look true. So the net is measured and printed, to be
    # fed back into the Solidity grid.
    if notionals:
        out("  THE ENTRY LEG - buying NVDAc. `net NVDAc` is what the swap really")
        out("  returned, and it is the size our own pool is then measured at.")
        out("    %10s %8s %14s %16s %10s"
            % ("notional", "via", "cost", "net NVDAc (raw)", "filled"))
        for usd in notionals:
            for name, token, dec in (("ETH", WETH, 18), ("USDC", USDC, 6)):
                mid = eth_per_nvdac if token == WETH else usdc_per_nvdac
                pool = weth_pool if token == WETH else usdc_pool
                amount_in = int(usd / usdc_per_nvdac * mid * 10 ** dec) if token == WETH \
                    else int(usd * 10 ** dec)
                if amount_in > host[token]:
                    out("    %10s %8s %14s %16s %10s"
                        % ("$%g" % usd, name, "host too poor", "-", "-"))
                    continue
                try:
                    q = quote_exact_in(rpc, QUOTER, token, NVDAC, amount_in, 3000)
                    spent, received = real_swap(rpc, code, pool, token, NVDAC, amount_in)
                except Reverted:
                    out("    %10s %8s %14s %16s %10s"
                        % ("$%g" % usd, name, "reverted", "-", "-"))
                    continue
                except RpcFailed as e:
                    failures.append("entry leg $%g via %s: %s" % (usd, name, e))
                    out("    %10s %8s %14s %16s %10s"
                        % ("$%g" % usd, name, "RPC FAILED", "-", "-"))
                    continue
                if received != q.out:
                    failures.append("entry leg $%g via %s: probe and quoter "
                                    "disagree, %d vs %d" % (usd, name, received, q.out))
                    out("    %10s %8s %14s %16s %10s"
                        % ("$%g" % usd, name, "DISAGREE", "-", "-"))
                    continue
                expected = spent / 10 ** dec / mid * 1e8
                cost = (1 - received / expected) * 10_000 if expected else None
                out("    %10s %8s %11.0f bps %16d %9.1f%%"
                    % ("$%g" % usd, name, cost, received, spent / amount_in * 100))
        out("")

    if not amounts:
        out("  %d eth_calls, %d retried, %d failed outright."
            % (rpc.calls, rpc.retries, rpc.failures))
        if failures:
            out("")
            out("  *** THIS RUN IS NOT A CLEAN MEASUREMENT ***")
            for f in failures:
                out("    - %s" % f)
            return 1
        return 0

    out("  THE EXIT LEG - selling NVDAc. Cost is the shortfall against mid on")
    out("  the amount REALLY SPENT, and `filled` is measured on that same swap.")
    # THE RAW AMOUNT IS PRINTED, not just the human one. These rows get
    # matched back against the amounts that produced them, and 8 decimals
    # rounded to 6 is a different number - the first version of this table could
    # not be joined to its own input.
    out("    %14s %14s %12s %12s %10s %12s %10s"
        % ("NVDAc sold", "raw", "~USD", "into ETH", "filled", "into USDC", "filled"))

    for amount in amounts:
        cells = []
        for other, dec_out in ((WETH, 18), (USDC, 6)):
            pool = weth_pool if other == WETH else usdc_pool
            mid = eth_per_nvdac if other == WETH else usdc_per_nvdac
            if amount > host[NVDAC]:
                cells.append(("host too poor", "-"))
                continue
            try:
                q = quote_exact_in(rpc, QUOTER, NVDAC, other, amount, 3000)
                spent, received = real_swap(rpc, code, pool, NVDAC, other, amount)
            except Reverted as e:
                cells.append(("reverted", "-"))
                continue
            except RpcFailed as e:
                failures.append("exit leg at %d: %s" % (amount, e))
                cells.append(("RPC FAILED", "-"))
                continue
            if received != q.out:
                failures.append("exit leg at %d: probe and quoter disagree, "
                                "%d vs %d" % (amount, received, q.out))
                cells.append(("DISAGREE", "-"))
                continue
            expected = spent / 1e8 * mid * 10 ** dec_out
            cost = (1 - received / expected) * 10_000 if expected else None
            cells.append(("%.0f bps" % cost if cost is not None else "-",
                          "%.1f%%" % (spent / amount * 100)))
        out("    %14.8f %14d %12s %12s %10s %12s %10s"
            % (amount / 1e8, amount,
               "~%s" % format(amount / 1e8 * usdc_per_nvdac, ",.0f"),
               cells[0][0], cells[0][1], cells[1][0], cells[1][1]))

    out("")
    out("  %d eth_calls, %d retried, %d failed outright."
        % (rpc.calls, rpc.retries, rpc.failures))
    if failures:
        out("")
        out("  *** THIS RUN IS NOT A CLEAN MEASUREMENT ***")
        for f in failures:
            out("    - %s" % f)
        return 1
    return 0


# ============================================================================
# main
# ============================================================================
NVDAC = "0xb20000000000000000000078ee7ce2fE4908108C"
WETH = "0x4200000000000000000000000000000000000006"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"
V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"
CANDIDATES = [
    WETH, USDC,
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",   # USDbC
    "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",   # USDT
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",   # DAI
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",   # cbBTC
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",   # cbETH
]
SIZES = [50, 100, 500, 1000, 5000, 10000, 50000]
LIMITS = [50, 100, 300]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", required=True)
    ap.add_argument("--block", default="latest")
    ap.add_argument("--sell-amounts", default="",
                    help="comma-separated RAW NVDAc amounts: what it costs to "
                         "sell each of them into ETH and into USDC.")
    ap.add_argument("--entry-usd", default="",
                    help="comma-separated USD notionals: what it costs to buy "
                         "NVDAc with that much ETH or USDC, and - the point of "
                         "it - the NET NVDAc each one really produces.")
    args = ap.parse_args()

    lines = []
    def out(s):
        lines.append(s)
        print(s, flush=True)

    rpc = Rpc(args.rpc, args.block)
    failures = []

    if args.sell_amounts.strip() or args.entry_usd.strip():
        # BOTH IN ONE RUN, so both directions are read at the SAME BLOCK. A
        # claim that one direction costs a few bps more than the other cannot
        # rest on two measurements taken minutes apart.
        return conversion_legs(rpc, out, args.entry_usd, args.sell_amounts, failures)

    tiers = probe_tiers(rpc, V3_FACTORY, out)
    tokens = confirm_tokens(rpc, CANDIDATES, out)
    survey_pools(rpc, V3_FACTORY, NVDAC, tokens, tiers, out)

    # The two pools the ladder runs on, looked up rather than hardcoded.
    def pool_of(other, fee):
        raw = must(rpc, "getPool for the ladder", V3_FACTORY,
                   GET_POOL + enc_addr(NVDAC) + enc_addr(other) + enc_uint(fee))
        w = words(raw)[0] if words(raw) else 0
        return None if w == 0 else "0x%040x" % w

    usdc_pool = pool_of(USDC, 3000)
    weth_pool = pool_of(WETH, 3000)
    if usdc_pool is None or weth_pool is None:
        raise Abort("one of the two 0.30%% pools does not exist: USDC=%s WETH=%s"
                    % (usdc_pool, weth_pool))

    usdc_per_nvdac = read_mid(rpc, usdc_pool, NVDAC, USDC, 6)
    eth_per_nvdac = read_mid(rpc, weth_pool, NVDAC, WETH, 18)
    out("  MID PRICES, each read from its own pool's slot0:")
    out("    1 NVDAc = %.4f USDC        1 NVDAc = %.8f ETH"
        % (usdc_per_nvdac, eth_per_nvdac))
    out("    1 ETH   = %.4f NVDAc       and so 1 ETH = %.2f USDC by these two"
        % (1 / eth_per_nvdac, usdc_per_nvdac / eth_per_nvdac))
    out("")

    def sizer(kind):
        def f(usd):
            nv = usd / usdc_per_nvdac
            if kind == "NVDAc->USDC":
                return int(nv * 1e8), nv * usdc_per_nvdac * 1e6
            if kind == "USDC->NVDAc":
                return int(usd * 1e6), nv * 1e8
            if kind == "NVDAc->ETH":
                return int(nv * 1e8), nv * eth_per_nvdac * 1e18
            return int(nv * eth_per_nvdac * 1e18), nv * 1e8
        return f

    def mid_outer(kind):
        """What the mid price says a RAW input amount should return, in the
        output token's raw units. The cost of a partial fill is measured
        against this applied to the amount actually SPENT - the unspent
        remainder never left the trader and is not a cost."""
        def f(raw_in):
            if kind == "NVDAc->USDC":
                return raw_in / 1e8 * usdc_per_nvdac * 1e6
            if kind == "USDC->NVDAc":
                return raw_in / 1e6 / usdc_per_nvdac * 1e8
            if kind == "NVDAc->ETH":
                return raw_in / 1e8 * eth_per_nvdac * 1e18
            return raw_in / 1e18 / eth_per_nvdac * 1e8
        return f

    usd_per_unit = {"NVDAc": usdc_per_nvdac, "USDC": 1.0,
                    "ETH": usdc_per_nvdac / eth_per_nvdac}
    legs = []
    for label, tin, tout, dec_in, pool in (
            ("NVDAc->USDC", NVDAC, USDC, 8, usdc_pool),
            ("USDC->NVDAc", USDC, NVDAC, 6, usdc_pool),
            ("NVDAc->ETH", NVDAC, WETH, 8, weth_pool),
            ("ETH->NVDAc", WETH, NVDAC, 18, weth_pool)):
        legs.append({"label": label, "token_in": tin, "token_out": tout,
                     "dec_in": dec_in, "fee": 3000, "pool": pool,
                     "size_for": sizer(label), "mid_out": mid_outer(label)})

    code = load_probe_code()
    out("  WHAT EACH POOL GIVES AND WHAT IT TAKES")
    out("    Three kinds of statement, kept apart because they are not the same")
    out("    kind of fact:")
    out("      OBSERVED    the highest output seen over the amounts tried. A")
    out("                  finite sweep cannot prove a plateau is final, so the")
    out("                  range tried is printed with it.")
    out("      MEASURED    the input a swap REALLY consumed, from the pool's own")
    out("                  returned deltas for that one swap. No inference.")
    out("      ESTIMATED   the same quantity from bisecting the price bound over")
    out("                  MANY simulations of DIFFERENT amounts. An estimate,")
    out("                  kept only because agreeing with the measurement is")
    out("                  worth something.")
    out("    A swap that stops early FILLS PARTIALLY - the call succeeds and the")
    out("    unspent input is simply never taken. Nothing reverts.")
    out("")
    for leg in legs:
        unit_in, unit_out = leg["label"].split("->")
        dec_in = leg["dec_in"]
        dec_out = 8 if unit_out == "NVDAc" else (6 if unit_out == "USDC" else 18)
        leg["host_balance"] = host_balance(rpc, leg["token_in"])

        seed, _ = leg["size_for"](1000)
        lim = measure_limits(rpc, QUOTER, leg["token_in"], leg["token_out"],
                             leg["fee"], seed, failures, leg["label"])
        leg["limits"] = lim
        out("    %s" % leg["label"])
        out("      probe host holds %.6f %s, so any trade up to that can be"
            % (leg["host_balance"] / 10 ** dec_in, unit_in))
        out("                       measured rather than estimated")
        if lim is None:
            out("      MEASUREMENT FAILED - no number is reported for this leg")
            continue

        if lim.out_max:
            out("      OBSERVED ceiling %.6f %s  (~%s USD) - the highest output"
                % (lim.out_max / 10 ** dec_out, unit_out,
                   format(lim.out_max / 10 ** dec_out * usd_per_unit[unit_out], ",.0f")))
            out("                       seen over inputs up to %.4g %s. Not a"
                % ((lim.largest_tried or 0) / 10 ** dec_in, unit_in))
            out("                       proven ceiling - just the largest seen.")
        if lim.in_at_out_max:
            out("      first reached at %.6f %s  (~%s USD) of input"
                % (lim.in_at_out_max / 10 ** dec_in, unit_in,
                   format(lim.in_at_out_max / 10 ** dec_in * usd_per_unit[unit_in], ",.0f")))

        meas = measure_boundary(rpc, code, leg["pool"], leg["token_in"],
                                leg["token_out"], leg["host_balance"],
                                failures, leg["label"])
        if meas is None:
            out("      MEASURED         the probe call failed - no figure")
        else:
            kind, request, spent, extra = meas
            if kind == "reverted":
                out("      MEASURED         the probe reverted at %.4f %s: %s"
                    % (request / 10 ** dec_in, unit_in, extra))
            elif kind == "unfunded":
                out("      MEASURED         the probe host holds none of this token")
            elif spent >= request:
                out("      MEASURED         %.6f %s asked for and ALL of it spent."
                    % (request / 10 ** dec_in, unit_in))
                out("                       No boundary at or below that - which is")
                out("                       the largest amount the host could fund,")
                out("                       not a statement about larger ones.")
            else:
                out("      MEASURED bound   %.6f %s really consumed out of a"
                    % (spent / 10 ** dec_in, unit_in))
                out("                       %.4f %s request (~%s USD spent)"
                    % (request / 10 ** dec_in, unit_in,
                       format(spent / 10 ** dec_in * usd_per_unit[unit_in], ",.0f")))

        if lim.bound_in:
            agree = ""
            if meas and meas[0] == "ok" and meas[2] is not None and meas[2] < meas[1]:
                gap = abs(meas[2] - lim.bound_in) / max(meas[2], 1)
                agree = (" - agrees with the measurement to %.4f%%" % (gap * 100)
                         if gap < 0.01 else
                         " - DISAGREES with the measurement by %.2f%%" % (gap * 100))
            out("      ESTIMATED bound  %.6f %s, by bisection%s"
                % (lim.bound_in / 10 ** dec_in, unit_in, agree))
            if lim.cross_check:
                out("      exact-output     %.6f %s, a second simulation of a"
                    % (lim.cross_check / 10 ** dec_in, unit_in))
                out("                       different question - context, not proof")
        for note in lim.notes:
            out("      NOTE             %s" % note)
    out("")

    ladder(rpc, QUOTER, code, legs, SIZES, out, failures)
    depth_at_a_cost(rpc, QUOTER, code, legs, LIMITS, out, failures)

    out("  %d eth_calls, %d retried after a transient upstream fetch failure, "
        "%d failed outright." % (rpc.calls, rpc.retries, rpc.failures))
    if failures:
        out("")
        out("  *** THIS RUN IS NOT A CLEAN MEASUREMENT ***")
        for f in failures:
            out("    - %s" % f)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Abort as e:
        print("\nFAIL: %s" % e, file=sys.stderr)
        print("Nothing above this line should be read as a measurement.",
              file=sys.stderr)
        sys.exit(2)
