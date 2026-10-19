import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNOUNCER_SCHEMA,
  END_OF_BLOCK,
  TelegramSender,
  launchMessage,
  parseTelegramConfig,
  processEvents,
  type AnnouncerState,
  type ChainEvent,
  type LaunchRecord,
} from '../src/announcer.ts';

const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const FACTORY = '0x3333333333333333333333333333333333333333';
const TX = '0x' + '44'.repeat(32);

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

test('HTML escapes attacker-controlled metadata, clips names, and emits only CURB/Basescan links', () => {
  const bad = launch({
    name: '<b>&' + 'N'.repeat(80),
    symbol: '<script>alert(1)</script>',
    quoteSymbol: 'ETH<a href="https://evil.example">x</a>',
  });
  const message = launchMessage('https://curbfun.xyz', bad);
  assert.match(message, /&lt;b&gt;&amp;/);
  assert.doesNotMatch(message, /<script>|evil\.example/);
  assert.match(message, new RegExp(`https://curbfun\\.xyz/token/${TOKEN}`));
  assert.match(message, new RegExp(`https://basescan\\.org/token/${TOKEN}`));
  assert.equal((message.match(/https:\/\//g) ?? []).length, 2);
  const displayedName = message.match(/<b>(.*?)<\/b> \(<code>/)?.[1] ?? '';
  assert.ok(Array.from(displayedName.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')).length <= 40);
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
