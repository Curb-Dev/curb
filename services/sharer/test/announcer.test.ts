import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionResult, encodeFunctionResult, parseAbi } from 'viem';
import {
  ANNOUNCER_SCHEMA,
  END_OF_BLOCK,
  MAX_MESSAGES_PER_RUN,
  TelegramSender,
  launchMessage,
  parseAnnouncerState,
  parseTelegramConfig,
  processEvents,
  type AnnouncerState,
  type ChainEvent,
  type LaunchRecord,
} from '../src/announcer.ts';
import { lensView, readRecord, resilientRpc } from '../scripts/announce.ts';
import { RpcError } from '../src/chain/rpc.ts';

const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x3333333333333333333333333333333333333333';
const TX = '0x' + '44'.repeat(32);
const REGISTRY = '0x5555555555555555555555555555555555555555';
const QUOTE = '0x6666666666666666666666666666666666666666';

function launch(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    token: TOKEN,
    curve: CURVE,
    factory: FACTORY,
    name: 'CURB Test',
    symbol: 'CURBT',
    quoteSymbol: 'ETH',
    totalTaxBps: 100,
    threshold: '1000',
    reserve: '0',
    crossed50: false,
    crossed90: false,
    graduated: false,
    hidden: false,
    ...overrides,
  };
}

function state(): AnnouncerState {
  return {
    schema: ANNOUNCER_SCHEMA,
    chainId: 8453,
    cursor: { block: 99, logIndex: END_OF_BLOCK },
    launches: {},
  };
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

test('creator names cannot create Telegram links and remain escaped and clipped', () => {
  const bad = launch({
    name: '<b>&' + 'N'.repeat(80),
    symbol: '<script>alert(1)</script>',
    quoteSymbol: 'evil.example<&',
  });
  const message = launchMessage('https://curbfun.xyz', bad);
  assert.match(message, /<code>&lt;b&gt;&amp;/);
  assert.doesNotMatch(message, /<script>/);
  assert.match(message, /Paired asset: <code>evil\.example&lt;&amp;<\/code>/);
  assert.deepEqual(
    [...message.matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]),
    [`https://curbfun.xyz/token/${TOKEN}`, `https://basescan.org/token/${TOKEN}`],
  );
  const displayedName = message.match(/<code>(.*?)<\/code> \(<code>/)?.[1] ?? '';
  assert.ok(Array.from(displayedName.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')).length <= 40);

  for (const name of ['evil.com', 't.me/x', '@scam', 'a@b.co', 'https://a&evil.com']) {
    const hostile = launchMessage('https://curbfun.xyz', launch({ name }));
    assert.ok(hostile.includes(`<code>${name.replace('&', '&amp;')}</code>`));
    assert.deepEqual(
      [...hostile.matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]),
      [`https://curbfun.xyz/token/${TOKEN}`, `https://basescan.org/token/${TOKEN}`],
    );
  }
});

test('creator text removes line breaks, control characters, zero-width text, and bidi overrides', () => {
  const message = launchMessage('https://curbfun.xyz', launch({ name: 'Line\nBreak\u202Eevil\u200B Name\uFEFF' }));
  const displayedName = message.match(/<code>(.*?)<\/code> \(<code>/)?.[1] ?? '';
  assert.equal(displayedName, 'Line Breakevil Name');
  assert.doesNotMatch(displayedName, /[\n\r\u202E\u200B\uFEFF]/u);
});

test('one dev buy can announce launch, cross 50 and 90, and graduate in one transaction', async () => {
  const events: ChainEvent[] = [
    { kind: 'registered', position: { block: 100, logIndex: 1 }, transactionHash: TX, launch: launch() },
    { kind: 'buy', position: { block: 100, logIndex: 2 }, transactionHash: TX, token: TOKEN, quoteIn: '1000', fee: '10', tax: '40' },
    { kind: 'graduated', position: { block: 100, logIndex: 3 }, transactionHash: TX, token: TOKEN },
    { kind: 'launch', position: { block: 100, logIndex: 4 }, transactionHash: TX, launch: launch() },
  ];
  const sent: string[] = [];
  const out = await processEvents(state(), events, { block: 100, logIndex: END_OF_BLOCK }, {
    dryRun: false,
    siteBase: 'https://curbfun.xyz',
    log() {},
    send: async (m) => { sent.push(m); },
    persist: async () => {},
  });
  assert.equal(sent.length, 4);
  assert.match(sent[0], /New CURB launch/);
  assert.match(sent[1], /crossed <b>50%<\/b>/);
  assert.match(sent[2], /crossed <b>90%<\/b>/);
  assert.match(sent[3], /graduated/);
  assert.equal(out.launches[TOKEN].reserve, '950');
  assert.equal(out.launches[TOKEN].crossed50, true);
  assert.equal(out.launches[TOKEN].crossed90, true);
  assert.equal(out.launches[TOKEN].graduated, true);
});

test('a sale below a threshold and a later recross do not announce the threshold twice', async () => {
  const s = state();
  s.launches[TOKEN] = launch({ reserve: '600', crossed50: true });
  const events: ChainEvent[] = [
    { kind: 'sell', position: { block: 100, logIndex: 1 }, transactionHash: TX, token: TOKEN, quoteOut: '200', fee: '10', tax: '10' },
    { kind: 'buy', position: { block: 101, logIndex: 1 }, transactionHash: TX, token: TOKEN, quoteIn: '300', fee: '10', tax: '10' },
  ];
  const sent: string[] = [];
  const out = await processEvents(s, events, { block: 101, logIndex: END_OF_BLOCK }, {
    dryRun: false,
    siteBase: 'https://curbfun.xyz',
    log() {},
    send: async (m) => { sent.push(m); },
    persist: async () => {},
  });
  assert.equal(sent.filter((m) => m.includes('50%')).length, 0);
  assert.equal(out.launches[TOKEN].reserve, '660');
  assert.equal(out.launches[TOKEN].crossed50, true);
});

test('a sale below 90% and a later recross do not announce 90% twice', async () => {
  const s = state();
  s.launches[TOKEN] = launch({ reserve: '950', crossed50: true, crossed90: true });
  const sent: string[] = [];
  const out = await processEvents(s, [
    { kind: 'sell', position: { block: 100, logIndex: 1 }, transactionHash: TX, token: TOKEN, quoteOut: '100', fee: '0', tax: '0' },
    { kind: 'buy', position: { block: 101, logIndex: 1 }, transactionHash: TX, token: TOKEN, quoteIn: '100', fee: '0', tax: '0' },
  ], { block: 101, logIndex: END_OF_BLOCK }, {
    dryRun: false, siteBase: 'https://curbfun.xyz', log() {},
    send: async (m) => { sent.push(m); }, persist: async () => {},
  });
  assert.equal(sent.filter((m) => m.includes('90%')).length, 0);
  assert.equal(out.launches[TOKEN].reserve, '950');
  assert.equal(out.launches[TOKEN].crossed90, true);
});

test('exactly 90% of the threshold announces the 90% crossing', async () => {
  const s = state();
  s.launches[TOKEN] = launch({ reserve: '899', crossed50: true });
  const sent: string[] = [];
  const out = await processEvents(s, [
    { kind: 'buy', position: { block: 100, logIndex: 1 }, transactionHash: TX, token: TOKEN, quoteIn: '1', fee: '0', tax: '0' },
  ], { block: 100, logIndex: END_OF_BLOCK }, {
    dryRun: false, siteBase: 'https://curbfun.xyz', log() {},
    send: async (m) => { sent.push(m); }, persist: async () => {},
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /crossed <b>90%<\/b>/);
  assert.equal(out.launches[TOKEN].reserve, '900');
});

test('events at or before the cursor cannot mutate launch state', async () => {
  const s = state();
  s.cursor = { block: 100, logIndex: 5 };
  s.launches[TOKEN] = launch({ reserve: '100' });
  const sent: string[] = [];
  const out = await processEvents(s, [
    { kind: 'buy', position: { block: 100, logIndex: 4 }, transactionHash: TX, token: TOKEN, quoteIn: '600', fee: '0', tax: '0' },
    { kind: 'buy', position: { block: 100, logIndex: 5 }, transactionHash: TX, token: TOKEN, quoteIn: '600', fee: '0', tax: '0' },
  ], { block: 100, logIndex: 5 }, {
    dryRun: false, siteBase: 'https://curbfun.xyz', log() {},
    send: async (m) => { sent.push(m); }, persist: async () => {},
  });
  assert.deepEqual(out, s);
  assert.deepEqual(sent, []);
});

test('an event for an unknown launch rejects without moving the durable cursor', async () => {
  let durable = state();
  await assert.rejects(
    processEvents(durable, [
      { kind: 'buy', position: { block: 100, logIndex: 1 }, transactionHash: TX, token: TOKEN, quoteIn: '1', fee: '0', tax: '0' },
    ], { block: 100, logIndex: END_OF_BLOCK }, {
      dryRun: false, siteBase: 'https://curbfun.xyz', log() {}, send: async () => {},
      persist: async (next) => { durable = clone(next); },
    }),
    /event for unknown launch/,
  );
  assert.deepEqual(durable.cursor, { block: 99, logIndex: END_OF_BLOCK });
  assert.deepEqual(durable.launches, {});
});

test('a launch hidden by the site advances state without any public message', async () => {
  const sent: string[] = [];
  const out = await processEvents(state(), [
    { kind: 'registered', position: { block: 100, logIndex: 1 }, transactionHash: TX, launch: launch({ hidden: true }) },
    { kind: 'buy', position: { block: 100, logIndex: 2 }, transactionHash: TX, token: TOKEN, quoteIn: '950', fee: '0', tax: '0' },
    { kind: 'graduated', position: { block: 100, logIndex: 3 }, transactionHash: TX, token: TOKEN },
  ], { block: 100, logIndex: END_OF_BLOCK }, {
    dryRun: false,
    siteBase: 'https://curbfun.xyz',
    log() {},
    send: async (m) => { sent.push(m); },
    persist: async () => {},
  });
  assert.deepEqual(sent, []);
  assert.equal(out.launches[TOKEN].crossed50, true);
  assert.equal(out.launches[TOKEN].crossed90, true);
  assert.equal(out.launches[TOKEN].graduated, true);
  assert.deepEqual(out.cursor, { block: 100, logIndex: END_OF_BLOCK });
});

test('a launch hidden after a failed send is dropped on resume and advances the cursor', async () => {
  const events: ChainEvent[] = [
    { kind: 'registered', position: { block: 100, logIndex: 1 }, transactionHash: TX, launch: launch() },
  ];
  let durable = state();
  await assert.rejects(
    processEvents(durable, events, { block: 100, logIndex: END_OF_BLOCK }, {
      dryRun: false, siteBase: 'https://curbfun.xyz', log() {},
      send: async () => { throw new Error('Telegram unavailable'); },
      persist: async (next) => { durable = clone(next); },
    }),
    /Telegram unavailable/,
  );
  assert.deepEqual(durable.pending?.items, [{ token: TOKEN, kind: 'launch' }]);
  durable.launches[TOKEN].hidden = true;

  const sent: string[] = [];
  durable = await processEvents(durable, events, { block: 100, logIndex: END_OF_BLOCK }, {
    dryRun: false, siteBase: 'https://curbfun.xyz', log() {},
    send: async (m) => { sent.push(m); },
    persist: async (next) => { durable = clone(next); },
  });
  assert.deepEqual(sent, []);
  assert.equal(durable.pending, undefined);
  assert.deepEqual(durable.cursor, { block: 100, logIndex: END_OF_BLOCK });
});

test('state parsing rejects rendered HTML and malformed pending entries', () => {
  const valid = state();
  valid.launches[TOKEN] = launch();
  const rawHtml = { ...valid, pending: { position: { block: 100, logIndex: 1 }, messages: ['<b>owned</b>'], next: 0 } };
  assert.equal(parseAnnouncerState(new Uint8Array(Buffer.from(JSON.stringify(rawHtml))), 8453), null);
  const extraField = { ...valid, pending: { position: { block: 100, logIndex: 1 }, items: [{ token: TOKEN, kind: 'launch', html: '<b>owned</b>' }], next: 0 } };
  assert.equal(parseAnnouncerState(new Uint8Array(Buffer.from(JSON.stringify(extraField))), 8453), null);
  const wrongMark = { ...valid, pending: { position: { block: 100, logIndex: 1 }, items: [{ token: TOKEN, kind: 'progress', mark: 75 }], next: 0 } };
  assert.equal(parseAnnouncerState(new Uint8Array(Buffer.from(JSON.stringify(wrongMark))), 8453), null);
});

test('restart resumes the unsent message and replay remains idempotent', async () => {
  const events: ChainEvent[] = [
    { kind: 'registered', position: { block: 100, logIndex: 1 }, transactionHash: TX, launch: launch() },
    { kind: 'buy', position: { block: 100, logIndex: 2 }, transactionHash: TX, token: TOKEN, quoteIn: '950', fee: '0', tax: '0' },
  ];
  let durable = state();
  let attempts = 0;
  const firstSent: string[] = [];
  await assert.rejects(
    processEvents(durable, events, { block: 100, logIndex: END_OF_BLOCK }, {
      dryRun: false,
      siteBase: 'https://curbfun.xyz',
      log() {},
      send: async (m) => {
        attempts++;
        if (attempts === 3) throw new Error('Telegram unavailable');
        firstSent.push(m);
      },
      persist: async (s) => { durable = clone(s); },
    }),
    /Telegram unavailable/,
  );
  assert.equal(firstSent.length, 2); // launch and 50%; 90% is pending
  assert.equal(durable.pending?.next, 1);

  const resumed: string[] = [];
  durable = await processEvents(durable, events, { block: 100, logIndex: END_OF_BLOCK }, {
    dryRun: false,
    siteBase: 'https://curbfun.xyz',
    log() {},
    send: async (m) => { resumed.push(m); },
    persist: async (s) => { durable = clone(s); },
  });
  assert.equal(resumed.length, 1);
  assert.match(resumed[0], /90%/);
  assert.equal(durable.pending, undefined);

  const replayed: string[] = [];
  await processEvents(durable, events, { block: 100, logIndex: END_OF_BLOCK }, {
    dryRun: false,
    siteBase: 'https://curbfun.xyz',
    log() {},
    send: async (m) => { replayed.push(m); },
    persist: async () => {},
  });
  assert.deepEqual(replayed, []);
});

test('one run sends at most the configured message bound and leaves the remainder pending', async () => {
  const s = state();
  s.launches[TOKEN] = launch();
  s.pending = {
    position: { block: 100, logIndex: 1 },
    items: Array.from({ length: MAX_MESSAGES_PER_RUN + 1 }, () => ({ token: TOKEN, kind: 'launch' as const })),
    next: 0,
  };
  let durable = clone(s);
  const sent: string[] = [];
  durable = await processEvents(durable, [], { block: 100, logIndex: END_OF_BLOCK }, {
    dryRun: false, siteBase: 'https://curbfun.xyz', log() {},
    send: async (m) => { sent.push(m); },
    persist: async (next) => { durable = clone(next); },
  });
  assert.equal(sent.length, MAX_MESSAGES_PER_RUN);
  assert.equal(durable.pending?.next, MAX_MESSAGES_PER_RUN);
  assert.deepEqual(durable.cursor, { block: 99, logIndex: END_OF_BLOCK });
});

test('without a Telegram secret dry-run logs messages and never sends or persists', async () => {
  const logs: string[] = [];
  let sends = 0;
  let persists = 0;
  const out = await processEvents(state(), [
    { kind: 'registered', position: { block: 100, logIndex: 1 }, transactionHash: TX, launch: launch() },
  ], { block: 100, logIndex: END_OF_BLOCK }, {
    dryRun: true,
    siteBase: 'https://curbfun.xyz',
    log: (m) => { logs.push(m); },
    send: async () => { sends++; },
    persist: async () => { persists++; },
  });
  assert.equal(sends, 0);
  assert.equal(persists, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /DRY RUN Telegram @CurbAnnouncements/);
  assert.equal(out.cursor.block, 100);
});

test('Telegram destination is exact, 429 retry_after is honored, and sends stay three seconds apart', async () => {
  assert.equal(parseTelegramConfig(undefined), null);
  assert.throws(
    () => parseTelegramConfig('{"token":"123456:abcdefghijklmnopqrstuvwxyzABCDE","chatId":"@CurbCommunity"}'),
    /exactly @CurbAnnouncements/,
  );
  const cfg = parseTelegramConfig('{"token":"123456:abcdefghijklmnopqrstuvwxyzABCDE","chatId":"@CurbAnnouncements"}');
  assert.ok(cfg);
  let clock = 0;
  const waits: number[] = [];
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let request = 0;
  const sender = new TelegramSender(cfg, {
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      request++;
      return request === 1
        ? new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), { status: 429, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ ok: true, result: { message_id: request } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await sender.send('first');
  await sender.send('second');
  assert.deepEqual(waits, [2_000, 3_000]);
  assert.equal(requests.length, 3);
  for (const r of requests) {
    assert.equal(r.body.chat_id, '@CurbAnnouncements');
    assert.equal(r.body.parse_mode, 'HTML');
    assert.equal(r.body.disable_web_page_preview, true);
  }
});

test('Telegram retry_after above 60 seconds is deferred to the next run', async () => {
  const cfg = parseTelegramConfig('{"token":"123456:abcdefghijklmnopqrstuvwxyzABCDE","chatId":"@CurbAnnouncements"}');
  assert.ok(cfg);
  const waits: number[] = [];
  const sender = new TelegramSender(cfg, {
    sleep: async (ms) => { waits.push(ms); },
    fetch: async () => new Response(
      JSON.stringify({ ok: false, parameters: { retry_after: 61 } }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    ),
  });
  await assert.rejects(sender.send('later'), /retry_after exceeds 60 seconds/);
  assert.deepEqual(waits, []);
});

test('the workflow gives the non-fatal announcer step its own five-minute timeout, and runs it after a failed index', () => {
  const workflow = readFileSync('../../.github/workflows/history-index.yml', 'utf8');
  assert.match(
    workflow,
    /- name: Announce public product events\r?\n\s+if: \$\{\{ !cancelled\(\) \}\}\r?\n\s+continue-on-error: true\r?\n\s+timeout-minutes: 5\r?\n/,
  );
});

test('a busy endpoint is asked again on the next one, and a revert is not asked again', async () => {
  const sleeps: number[] = [];
  const asked: string[] = [];
  const endpoint = (label: string, answers: Array<Error | string>) => ({
    label,
    async request() {
      asked.push(label);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a;
    },
  });
  // The gateway's own words, then a 429: both transient; the second endpoint answers.
  const rpc = resilientRpc([
    endpoint('a', [new RpcError('rate limit exceeded'), new RpcError('busy', { status: 429 })]),
    endpoint('b', [new RpcError('rate limit exceeded'), '0x1']),
  ], { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(await rpc.request({ method: 'eth_blockNumber' }), '0x1');
  assert.deepEqual(asked, ['a', 'b', 'a', 'b']);
  assert.deepEqual(sleeps, [500, 1000, 2000]);

  // A revert is the chain's answer, not a busy endpoint: it is never asked again.
  asked.length = 0;
  const reverting = resilientRpc([endpoint('a', [new RpcError('execution reverted')]), endpoint('b', ['0x2'])], { sleep: async () => {} });
  await assert.rejects(reverting.request({ method: 'eth_call' }), /execution reverted/);
  assert.deepEqual(asked, ['a']);

  // And it gives up after its tries, with the endpoint's error.
  const busy = Array.from({ length: 10 }, () => new RpcError('rate limit exceeded'));
  const tired = resilientRpc([endpoint('a', busy)], { tries: 3, sleep: async () => {} });
  await assert.rejects(tired.request({ method: 'eth_call' }), /rate limit exceeded/);
});

test("the first run reads the lens's launchState struct by field name, as viem decodes it", () => {
  // The first mainnet run stopped here: the struct was read as an array, every
  // index was undefined, and BigInt(undefined) threw. This decodes the same ABI
  // the script uses, from bytes encoded the way the chain answers.
  const lensAbi = parseAbi([
    'function launchState(address) view returns ((uint8 status,address curve,address quoteToken,address beneficiary,uint256 quoteReserve,uint256 tokenReserve,uint256 realQuoteReserve,uint256 graduationThreshold,uint256 totalSupply,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint64 launchedAt,address holderDistributor))',
  ]);
  const zero = '0x0000000000000000000000000000000000000000';
  const value = (status: number) => ({
    status, curve: '0x65CfF633dA0F81924242467D0C1404c6e0FEA7e4', quoteToken: '0x4200000000000000000000000000000000000006',
    beneficiary: zero, quoteReserve: 5n, tokenReserve: 6n, realQuoteReserve: 1386000000000008n, graduationThreshold: 4470000000000000000n,
    totalSupply: 7n, poolKey: { currency0: zero, currency1: zero, fee: 0, tickSpacing: 0, hooks: zero }, launchedAt: 1n, holderDistributor: zero,
  });
  const decoded = (status: number) => decodeFunctionResult({
    abi: lensAbi, functionName: 'launchState',
    data: encodeFunctionResult({ abi: lensAbi, functionName: 'launchState', result: value(status) as never }),
  });
  assert.deepEqual(lensView(decoded(1)), {
    curve: '0x65cff633da0f81924242467d0c1404c6e0fea7e4', quote: '0x4200000000000000000000000000000000000006',
    reserve: 1386000000000008n, threshold: 4470000000000000000n, graduated: false,
  });
  assert.equal(lensView(decoded(3)).graduated, true);
  assert.throws(() => lensView([1, 'a', 'b']), /unexpected shape/);
});

test('a registry-only launch reads tax from launchOf instead of announcing 0%', async () => {
  const registryAbi = parseAbi([
    'function launchOf(address) view returns ((address curve,address quoteToken,address beneficiary,address refundTo,uint256 reservedZero,uint24 fee,int24 tickSpacing,address hooks,uint16 totalTaxBps,uint16 platformBps,address platformRecipient,uint64 launchedAt))',
  ]);
  let registryReads = 0;
  const rpc = {
    request: async ({ method, params }: { method: string; params: any[] }) => {
      const target = String(params?.[0]?.to ?? '').toLowerCase();
      if (method === 'eth_call' && target === REGISTRY.toLowerCase()) {
        registryReads++;
        return encodeFunctionResult({
          abi: registryAbi,
          functionName: 'launchOf',
          result: [CURVE, QUOTE, CURVE, CURVE, 0n, 500, 10, CURVE, 375, 50, CURVE, 0n] as any,
        });
      }
      throw new Error('metadata unavailable');
    },
  };
  const record = await readRecord(
    rpc as any,
    { registry: REGISTRY, sharing: { weth: QUOTE } } as any,
    { launches: new Set(), factories: new Set() },
    TOKEN,
    { token: TOKEN, curve: CURVE, factory: '' },
    { curve: CURVE, quote: QUOTE, reserve: 0n, threshold: 1_000n, graduated: false },
  );
  assert.equal(registryReads, 1);
  assert.equal(record.totalTaxBps, 375);
  assert.match(launchMessage('https://curbfun.xyz', record), /Tax: <b>3\.75%<\/b>/);
});
