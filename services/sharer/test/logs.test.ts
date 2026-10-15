// The adaptive eth_getLogs window: which refusals shrink it, which ceilings
// hold, which grow back, and what is asked again after a pause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, custom } from 'viem';
import { classifyLogError, getLogsAdaptive, LogWindow, LogWindowError } from '../src/chain/logs.ts';
import { RpcError } from '../src/chain/rpc.ts';
import { MockChain } from './mock-chain.ts';

const TOKEN = '0x70ce000000000000000000000000000000000001';
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const noSleep = { sleep: async () => {} };

/** A chain with one log every `every` blocks over [1, n]. */
function chainWithLogs(n: number, every = 1, perBlock = 1): MockChain {
  const c = new MockChain();
  c.faults.maxLogCalls = 2000;
  for (let b = 1; b <= n; b += every) {
    for (let i = 0; i < perBlock; i++) {
      c.addLog({ address: TOKEN, topics: [TOPIC], data: '0x', block: BigInt(b), logIndex: BigInt(i), txHash: '0x' + b.toString(16).padStart(64, '0') });
    }
  }
  return c;
}

const windows = (c: MockChain) => c.calls.filter((x) => x.method === 'eth_getLogs').map((x) => Number(BigInt(x.params[0].toBlock) - BigInt(x.params[0].fromBlock) + 1n));

// ------------------------------------------------------------- classification

const INFURA = 'query returned more than 10000 results. Try with this block range [0x1, 0x2a].';
const ALCHEMY =
  'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response.';

test('classifyLogError: result-size refusals, including the ones that name a block range', () => {
  assert.equal(classifyLogError(new RpcError(INFURA, { code: -32005 })), 'size');
  assert.equal(classifyLogError(new RpcError(INFURA, { code: -32600 })), 'size');
  assert.equal(classifyLogError(new RpcError(ALCHEMY, { code: -32602 })), 'size');
  assert.equal(classifyLogError(new RpcError('limit exceeded', { code: -32005 })), 'size');
  assert.equal(classifyLogError(new RpcError('too many logs', { code: -32000 })), 'size');
});

test('classifyLogError: block-range refusals', () => {
  assert.equal(classifyLogError(new RpcError('eth_getLogs is limited to a 2,000 range', { code: -32600 })), 'range');
  assert.equal(classifyLogError(new RpcError('block range is too wide', { code: -32000 })), 'range');
  assert.equal(classifyLogError(new RpcError('exceed maximum block range: 50000', { code: -32000 })), 'range');
  assert.equal(classifyLogError(new RpcError('too many blocks requested', { code: -32000 })), 'range');
});

test('classifyLogError: busy - rate limits, timeouts, non-JSON pages, unknown errors', () => {
  assert.equal(classifyLogError(new RpcError('HTTP 429', { status: 429 })), 'busy');
  assert.equal(classifyLogError(new RpcError('slow down', { code: 429 })), 'busy');
  assert.equal(classifyLogError(new RpcError('rate limit exceeded for this block range')), 'busy');
  assert.equal(classifyLogError(new RpcError('request timed out')), 'busy');
  assert.equal(classifyLogError(new RpcError('the endpoint answered HTTP 502 with no JSON', { status: 502 })), 'busy');
  assert.equal(classifyLogError(new Error('something else')), 'busy');
});

test('classifyLogError reads through viem-wrapped errors', async () => {
  const mk = (err: unknown) =>
    createPublicClient({ transport: custom({ request: async () => { throw err; } }, { retryCount: 0 }) });
  const caught = async (err: unknown) => {
    try {
      await mk(err).request({ method: 'eth_getLogs', params: [{}] } as any);
    } catch (e) {
      return e;
    }
    throw new Error('no error');
  };
  assert.equal(classifyLogError(await caught({ code: -32602, message: ALCHEMY })), 'size');
  assert.equal(classifyLogError(await caught({ code: -32600, message: 'eth_getLogs is limited to a 2,000 range' })), 'range');
  assert.equal(classifyLogError(await caught({ code: -32005, message: 'limit exceeded' })), 'size');
});

// ------------------------------------------------------------- the window

test('a range ceiling holds: the window halves under it and never asks above it again', async () => {
  const c = chainWithLogs(20000, 7);
  c.faults.rangeLimit = { max: 1000n, message: 'eth_getLogs is limited to a 1,000 range' };
  const win = new LogWindow({ initial: 2000, ...noSleep });
  const logs = await getLogsAdaptive(c.rpc(), { address: TOKEN, topics: [TOPIC] }, 1n, 20000n, win);
  assert.equal(logs.length, Math.ceil(20000 / 7));
  assert.equal(win.cap, 1000);
  assert.equal(win.capIsSize, false);
  const w = windows(c);
  assert.equal(w[0], 2000); // refused
  assert.ok(w.slice(1).every((x) => x <= 1000), 'never above the range ceiling after it was found');
  assert.equal(w.filter((x) => x > 1000).length, 1);
});

test('a result-size ceiling grows back after enough windows under it (Alchemy wording)', async () => {
  // Dense first 3000 blocks (3 logs each), sparse after.
  const c = chainWithLogs(3000, 1, 3);
  for (let b = 3001; b <= 200000; b += 500) c.addLog({ address: TOKEN, topics: [TOPIC], data: '0x', block: BigInt(b), logIndex: 0n, txHash: '0x' + b.toString(16).padStart(64, '0') });
  c.faults.sizeLimit = { max: 4000, message: ALCHEMY };
  const win = new LogWindow({ initial: 2000, sizeRegrow: 4, ...noSleep });
  const logs = await getLogsAdaptive(c.rpc(), { address: TOKEN, topics: [TOPIC] }, 1n, 200000n, win);
  assert.equal(logs.length, 9000 + Math.floor((200000 - 3001) / 500) + 1);
  assert.equal(win.capIsSize, true);
  // Grew back above the 1000-block window it was cut to.
  assert.ok(Math.max(...windows(c).slice(2)) > 2000, `windows: ${windows(c).slice(0, 30)}`);
  assert.ok(win.cap > 1000);
});

test('Infura wording is a size ceiling too, and grows back', async () => {
  const c = chainWithLogs(3000, 1, 3);
  for (let b = 3001; b <= 100000; b += 400) c.addLog({ address: TOKEN, topics: [TOPIC], data: '0x', block: BigInt(b), logIndex: 0n, txHash: '0x' + b.toString(16).padStart(64, '0') });
  c.faults.sizeLimit = { max: 4000, message: INFURA, code: -32600 };
  const win = new LogWindow({ initial: 2000, sizeRegrow: 4, ...noSleep });
  await getLogsAdaptive(c.rpc(), { address: TOKEN, topics: [TOPIC] }, 1n, 100000n, win);
  assert.equal(win.capIsSize, true);
  assert.ok(win.cap > 1000);
});

test('the window grows from its first size up to the maximum when nothing is refused', async () => {
  const c = chainWithLogs(100000, 1000);
  const win = new LogWindow({ initial: 2000, max: 16000, ...noSleep });
  await getLogsAdaptive(c.rpc(), { address: TOKEN, topics: [TOPIC] }, 1n, 100000n, win);
  assert.deepEqual(windows(c).slice(0, 5), [2000, 4000, 8000, 16000, 16000]);
});

test('a busy refusal asks the same window again after a growing pause, then gives up', async () => {
  const c = chainWithLogs(5000, 10);
  let fails = 2;
  c.faults.before = (m) => {
    if (m === 'eth_getLogs' && fails-- > 0) throw new RpcError('Too Many Requests', { status: 429 });
  };
  const pauses: number[] = [];
  const win = new LogWindow({ initial: 2000, backoffMs: 100, sleep: async (ms) => void pauses.push(ms) });
  const logs = await getLogsAdaptive(c.rpc(), { address: TOKEN, topics: [TOPIC] }, 1n, 5000n, win);
  assert.equal(logs.length, 500);
  assert.deepEqual(pauses, [100, 200]);
  assert.deepEqual(windows(c).slice(0, 3), [2000, 2000, 2000]);
  assert.equal(win.cap, 100000, 'a busy refusal sets no ceiling');

  c.faults.before = (m) => {
    if (m === 'eth_getLogs') throw new RpcError('Too Many Requests', { status: 429 });
  };
  const before = c.count('eth_getLogs');
  await assert.rejects(getLogsAdaptive(c.rpc(), { address: TOKEN, topics: [TOPIC] }, 1n, 5000n, new LogWindow({ tries: 3, ...noSleep })), (e: any) => e instanceof LogWindowError && e.kind === 'busy');
  assert.equal(c.count('eth_getLogs') - before, 4, 'the first ask and three more');
});

test('a refusal at the smallest window is final', async () => {
  const c = chainWithLogs(10, 1, 5);
  c.faults.sizeLimit = { max: 4, message: ALCHEMY };
  await assert.rejects(getLogsAdaptive(c.rpc(), { address: TOKEN, topics: [TOPIC] }, 1n, 10n, new LogWindow({ initial: 8, ...noSleep })), (e: any) => e instanceof LogWindowError && e.kind === 'size');
});

test('answers are checked: outside the window, another address, removed, repeated', async () => {
  const bad = (mutate: (l: any) => any[]) => ({
    label: 'bad',
    request: async ({ params }: any) => mutate({ address: TOKEN, topics: [TOPIC], data: '0x', blockNumber: params[0].fromBlock, blockHash: '0x' + '1'.repeat(64), transactionHash: '0x' + '2'.repeat(64), logIndex: '0x0' }),
  });
  const run = (rpc: any) => getLogsAdaptive(rpc, { address: TOKEN }, 1n, 10n, new LogWindow({ initial: 100, ...noSleep }));
  await assert.rejects(run(bad((l) => [{ ...l, blockNumber: '0x64' }])), /window/);
  await assert.rejects(run(bad((l) => [{ ...l, address: '0x' + '9'.repeat(40) }])), /not asked for/);
  await assert.rejects(run(bad((l) => [{ ...l, removed: true }])), /removed/);
  await assert.rejects(run(bad((l) => [l, l])), /two logs/);
  await assert.rejects(run({ request: async () => ({}) }), /not a list/);
});
