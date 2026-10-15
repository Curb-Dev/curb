// JSON-RPC transport. An Rpc is anything with an EIP-1193 `request`: the
// HTTP transport below, a viem client (`client.request`), or the test suite's
// mock chain. A failure carries what kind it was - the HTTP status and the
// endpoint's error code - because the log reader treats a refused range
// differently from a request that was merely refused NOW (see logs.ts).

export interface Rpc {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  /** A short name for messages (never the URL, which may hold a key). */
  readonly label?: string;
}

export class RpcError extends Error {
  code?: number;
  status?: number;
  data?: unknown;
  constructor(message: string, opts: { code?: number; status?: number; data?: unknown } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = opts.code;
    this.status = opts.status;
    this.data = opts.data;
  }
}

export interface HttpRpcOptions {
  label?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** A plain JSON-RPC over HTTP transport. No retries here: the callers decide
 *  what a failure means (logs.ts for eth_getLogs, reader.ts for the rest). */
export function httpRpc(url: string, opts: HttpRpcOptions = {}): Rpc {
  let id = 0;
  const f = opts.fetch ?? fetch;
  return {
    label: opts.label ?? 'rpc',
    async request({ method, params = [] }) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: ctl.signal,
        });
      } catch (e) {
        throw new RpcError(ctl.signal.aborted ? `${method}: request timed out` : `${method}: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      let body: any;
      try {
        body = await res.json();
      } catch {
        throw new RpcError(`${method}: the endpoint answered HTTP ${res.status} with no JSON`, { status: res.status });
      }
      if (body && body.error) {
        throw new RpcError(body.error.message || JSON.stringify(body.error), { code: body.error.code, status: res.status, data: body.error.data });
      }
      if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`, { status: res.status });
      return body.result;
    },
  };
}

/** Wraps a viem client (or any EIP-1193 provider) as an Rpc. */
export function fromEip1193(p: { request(args: any): Promise<unknown> }, label = 'rpc'): Rpc {
  return { label, request: (args) => p.request(args) };
}
