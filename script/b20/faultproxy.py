# -*- coding: utf-8 -*-
"""
AN RPC THAT FAILS WHERE YOU TELL IT TO.

    python3 script/b20/faultproxy.py --upstream http://127.0.0.1:8553 \
        --port 8601 --fail-selector 0xc6a5026a --after 40

It forwards eth_calls to a real node and injects a failure at a chosen point,
so "a failed call never becomes a number" can be TESTED instead of asserted.
Reading the code and agreeing with it is not evidence.

  --fail-selector 0x...   fail only calls whose data starts with this selector
  --after N               let the first N matching calls through, then start
  --every N               fail only every Nth matching call (default: all of
                          them). Intermittent faults are the dangerous kind:
                          a search that mostly works lands on a plausible
                          WRONG number instead of an obvious zero.
  --mode transport        close the connection (looks like a dead node)
  --mode rpcerror         a JSON-RPC error that is NOT a revert (rate limit)
  --mode revert           an `execution reverted` error, which IS data - used
                          to check the tool still treats reverts as answers
  --mode skew             forward the call, then CHANGE the first word of the
                          answer by --skew-by. Nothing errors; the reply is
                          simply not the truth. Used to make the quoter and
                          the swap probe disagree about the same swap, which
                          must stop the tool rather than be reconciled.
  --fail-batch            fail any batched request outright

NOTHING IS SENT ANYWHERE. It sits in front of a local fork and only rewrites
replies.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

ARGS = None
STATE = {"matched": 0, "injected": 0}


def matches(payload):
    """Does this request touch what we were told to break?

    ONLY eth_call IS EVER BROKEN. The node's liveness is left alone, so the
    harness can still tell "the proxy is up" from "the calls are failing" -
    otherwise a transport-mode run looks like a proxy that never started."""
    items = payload if isinstance(payload, list) else [payload]
    for item in items:
        if not isinstance(item, dict) or item.get("method") != "eth_call":
            continue
        if ARGS.fail_selector is None:
            return True
        params = item.get("params") or []
        if params and isinstance(params[0], dict):
            data = params[0].get("data") or ""
            if data.lower().startswith(ARGS.fail_selector.lower()):
                return True
    return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = None

        is_batch = isinstance(payload, list)
        hit = payload is not None and matches(payload)
        if is_batch and ARGS.fail_batch and payload:
            hit = any(isinstance(i, dict) and i.get("method") == "eth_call"
                      for i in payload)

        skewing = False
        if hit:
            STATE["matched"] += 1
            due = (ARGS.every <= 1 or STATE["matched"] % ARGS.every == 0)
            if STATE["matched"] > ARGS.after and due:
                STATE["injected"] += 1
                if ARGS.mode == "skew":
                    skewing = True      # forward first, then bend the answer
                else:
                    return self._inject(payload)

        try:
            req = urllib.request.Request(
                ARGS.upstream, data=raw,
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
        except (urllib.error.URLError, OSError) as e:
            return self._inject(payload, "upstream is unreachable: %s" % e)

        if skewing:
            body = self._skew(body)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _skew(body):
        """Change the first 32-byte word of a successful result. A quoter that
        answers 1 wei more than the pool really pays is not an error anywhere -
        it is two simulations of one swap that no longer agree."""
        try:
            out = json.loads(body)
        except ValueError:
            return body

        def bend(item):
            if not isinstance(item, dict):
                return item
            res = item.get("result")
            if not isinstance(res, str) or len(res) < 66:
                return item
            first = int(res[2:66], 16)
            item["result"] = "0x%064x%s" % (max(first + ARGS.skew_by, 0), res[66:])
            return item

        out = [bend(i) for i in out] if isinstance(out, list) else bend(out)
        return json.dumps(out).encode()

    def _inject(self, payload, why=None):
        if ARGS.mode == "transport":
            # No reply at all. The socket closes; the client sees a dead node.
            try:
                self.close_connection = True
                self.wfile.close()
            except OSError:
                pass
            return
        if ARGS.mode == "revert":
            err = {"code": 3, "message": "execution reverted", "data": "0x"}
        else:
            err = {"code": -32005,
                   "message": why or "injected fault: request limit reached"}

        def one(item):
            return {"jsonrpc": "2.0",
                    "id": item.get("id") if isinstance(item, dict) else None,
                    "error": err}

        out = [one(i) for i in payload] if isinstance(payload, list) else one(payload or {})
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--fail-selector", default=None)
    ap.add_argument("--after", type=int, default=0)
    ap.add_argument("--every", type=int, default=1)
    ap.add_argument("--skew-by", type=int, default=1)
    ap.add_argument("--mode", choices=["transport", "rpcerror", "revert", "skew"],
                    default="rpcerror")
    ap.add_argument("--fail-batch", action="store_true")
    ARGS = ap.parse_args()
    server = HTTPServer(("127.0.0.1", ARGS.port), Handler)
    print("faultproxy on %d -> %s (mode=%s selector=%s after=%d every=%d)"
          % (ARGS.port, ARGS.upstream, ARGS.mode, ARGS.fail_selector,
             ARGS.after, ARGS.every),
          file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
