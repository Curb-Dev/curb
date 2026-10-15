// CHECKS THE GITHUB ENVIRONMENT SECRETS THE WORKFLOWS WILL READ, WITHOUT
// PRINTING ONE OF THEM.
//
//   node scripts/check-secrets.mjs mainnet   (in the sharing-mainnet environment)
//   node scripts/check-secrets.mjs verify    (in the sharing-verify environment)
//
// GitHub never shows a secret again once it is saved, so a value pasted in the
// wrong shape - a token without its bot number, one RPC URL where two lines
// were meant, JSON with a missing quote - is found only when a scheduled run
// fails, possibly days later and at night. This runs each secret through the
// same kind of use the keeper makes of it and prints one line per check: PASS
// or FAIL, with only public facts beside it (the address a key controls, an
// RPC's host and head block, the bot's username). Exit status 1 on any FAIL.
//
// It writes one probe file to the data repository and deletes it again (the
// keeper's own `check --probe` does the same), and the alert check sends one
// Telegram message saying the secrets check reached the chat.

import { privateKeyToAccount } from 'viem/accounts';

const which = process.argv[2];
if (which !== 'mainnet' && which !== 'verify') {
  console.error('usage: check-secrets.mjs mainnet|verify');
  process.exit(2);
}

// The addresses the owner named at deploy (DEPLOY.txt decision 5); a key that
// derives to anything else was pasted from the wrong keystore.
const EXPECT = {
  SHARING_PUBLISHER_KEY: '0x981228C17C63ce1BA18eDE0E2D660aFC281EeFC0',
  SHARING_STANDBY_PUSHER_KEY: '0x0a9a8fF7eEA07F775252dd975C9e24c4e932B112',
};
const DATA_REPO = 'Curb-Dev/curb-sharing-data';
const BASE_CHAIN_ID = 8453;

let failed = 0;
let warned = 0;
const pass = (name, what) => console.log(`PASS  ${name.padEnd(28)} ${what}`);
const warn = (name, what) => { warned++; console.log(`WARN  ${name.padEnd(28)} ${what}`); };
const fail = (name, what) => { failed++; console.log(`FAIL  ${name.padEnd(28)} ${what}`); };
const env = (name) => {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') { fail(name, 'not set, or empty'); return null; }
  return v;
};
const errText = (e) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '<url>').slice(0, 160);

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

function checkKey(name) {
  const v = env(name);
  if (v === null) return;
  const k = v.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) return fail(name, 'not 0x followed by 64 hex digits (paste the whole 0x... line decrypt-keystore printed)');
  let addr;
  try { addr = privateKeyToAccount(k).address; } catch (e) { return fail(name, `not a valid key: ${errText(e)}`); }
  if (addr.toLowerCase() !== EXPECT[name].toLowerCase()) return fail(name, `controls ${addr}, expected ${EXPECT[name]} - wrong keystore`);
  pass(name, `controls ${addr}`);
}

async function checkRpcs(name) {
  const v = env(name);
  if (v === null) return;
  const lines = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length !== 2) return fail(name, `${lines.length} line(s); expected exactly two lines, each only an https:// address (no labels, no notes)`);
  const hosts = [];
  for (const [i, u] of lines.entries()) {
    const label = `${name}[${i + 1}]`;
    let url;
    try { url = new URL(u); } catch { fail(label, 'not a URL'); continue; }
    if (url.protocol !== 'https:') { fail(label, `${url.protocol} - must be https`); continue; }
    hosts.push(url.hostname);
    // Each call names itself in a failure, so "HTTP 403" says which use the
    // provider refused: a key restricted to the site's domain refuses the
    // first one, a plan without archive state refuses the old balance.
    const step = async (what, method, params) => {
      try { return await rpc(u, method, params); } catch (e) { throw new Error(`${what} (${method}): ${errText(e)}`); }
    };
    try {
      const chain = Number(await step('chain id', 'eth_chainId', []));
      if (chain !== BASE_CHAIN_ID) { fail(label, `${url.hostname}: chain ${chain}, not Base (8453)`); continue; }
      const head = Number(await step('head', 'eth_blockNumber', []));
      // archive state: an old block's balance (RUNBOOK part 6)
      await step('archive state', 'eth_getBalance', ['0x4200000000000000000000000000000000000006', '0xf4240']);
      // the safe tag
      await step('the safe tag', 'eth_getBlockByNumber', ['safe', false]);
      // eth_call with no `to` and 15,000,000 gas (the keeper's probe does this)
      await step('eth_call without to', 'eth_call', [{ data: '0x00', gas: '0xe4e1c0' }, 'latest']);
      // getLogs: the services adapt to a provider's range limit by
      // themselves, so the widest window that answers is reported, and only a
      // provider refusing even ten blocks fails.
      // A window of n blocks is from head-n+1 to head: free plans count both
      // ends (Alchemy's free tier allows 10, QuickNode's 5).
      let span = 0;
      for (const n of [2000, 500, 100, 10, 5, 2]) {
        try {
          await rpc(u, 'eth_getLogs', [{ fromBlock: `0x${(head - n + 1).toString(16)}`, toBlock: `0x${head.toString(16)}`, address: '0x4200000000000000000000000000000000000006', topics: ['0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'] }]);
          span = n;
          break;
        } catch { /* try a narrower window */ }
      }
      if (!span) { fail(label, `${url.hostname}: getLogs refuses even a 2-block window`); continue; }
      const what = `${url.hostname}: Base, head ${head}, archive, safe tag, eth_call without to; getLogs over ${span} blocks`;
      if (span >= 500) pass(label, what);
      else warn(label, `${what} - a free plan's ceiling: the services page through it, but replaying a token's history takes thousands of requests; a paid plan or a provider with wide getLogs is needed once launches share with holders`);
    } catch (e) {
      fail(label, `${url.hostname}: ${errText(e)}`);
    }
  }
  if (hosts.length === 2 && hosts[0] === hosts[1]) fail(name, `both lines are ${hosts[0]} - they must be two different providers`);
}

async function checkDataToken(name) {
  const v = env(name);
  if (v === null) return;
  const t = v.trim();
  const h = { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'curb-secrets-check' };
  const path = `ops/secrets-check-probe-${process.env.GITHUB_RUN_ID || 'local'}.txt`;
  const url = `https://api.github.com/repos/${DATA_REPO}/contents/${path}`;
  try {
    const put = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify({ message: 'secrets check: write probe (deleted at once)', content: Buffer.from('probe\n').toString('base64') }) });
    if (put.status === 401) return fail(name, 'GitHub refuses the token (401): pasted wrong or expired');
    if (put.status === 403 || put.status === 404) return fail(name, `HTTP ${put.status}: the token cannot write ${DATA_REPO} (repository access, or Contents: Read and write)`);
    if (!put.ok) return fail(name, `HTTP ${put.status} writing the probe`);
    const sha = (await put.json()).content.sha;
    const del = await fetch(url, { method: 'DELETE', headers: h, body: JSON.stringify({ message: 'secrets check: delete the write probe', sha }) });
    if (!del.ok) return fail(name, `wrote the probe but could not delete it (HTTP ${del.status}): delete ${path} by hand`);
    pass(name, `writes and deletes in ${DATA_REPO}`);
  } catch (e) {
    fail(name, errText(e));
  }
}

function checkPins(name) {
  const v = env(name);
  if (v === null) return;
  let j;
  try { j = JSON.parse(v); } catch (e) { return fail(name, `not valid JSON (${errText(e)}): expected {"pinata": "...", "filebase": "..."}`); }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return fail(name, 'not a JSON object');
  for (const k of ['pinata', 'filebase']) {
    if (typeof j[k] !== 'string' || j[k].trim() === '') { fail(`${name}.${k}`, 'missing or empty'); continue; }
    if (/\s/.test(j[k])) { fail(`${name}.${k}`, 'contains a space or line break'); continue; }
    if (/^(PINATA_JWT|FILEBASE_TOKEN)$/.test(j[k])) { fail(`${name}.${k}`, 'still the placeholder word'); continue; }
    if (k === 'pinata') {
      const parts = j[k].split('.');
      let ok = parts.length === 3;
      try { if (ok) JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { ok = false; }
      if (!ok) { fail(`${name}.pinata`, 'not a JWT (three dot-separated parts, starting eyJ): paste the JWT, not the API key or secret'); continue; }
    }
    pass(`${name}.${k}`, `present, ${j[k].length} characters`);
  }
  const extra = Object.keys(j).filter((k) => !['pinata', 'filebase', 'third'].includes(k));
  if (extra.length) fail(name, `unexpected key(s): ${extra.join(', ')}`);
}

async function checkAlerts(name) {
  const v = env(name);
  if (v === null) return;
  let j;
  try { j = JSON.parse(v); } catch (e) { return fail(name, `not valid JSON (${errText(e)}): expected {"telegram": {"token": "...", "chatId": "..."}}`); }
  const tg = j?.telegram;
  if (!tg || typeof tg !== 'object') return fail(name, 'no "telegram" object');
  const token = String(tg.token ?? '').trim();
  const chatId = String(tg.chatId ?? '').trim();
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) return fail(`${name}.telegram.token`, 'not <bot number>:<code> - paste the whole token, number and colon included');
  if (!/^-?\d+$/.test(chatId)) return fail(`${name}.telegram.chatId`, 'not a number');
  try {
    const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(20_000) })).json();
    if (!me.ok) return fail(`${name}.telegram.token`, `Telegram refuses it: ${me.description || 'unknown'}`);
    const sent = await (await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: `CURB secrets check (${which}): alerts reach this chat.` }), signal: AbortSignal.timeout(20_000) })).json();
    if (!sent.ok) return fail(`${name}.telegram.chatId`, `@${me.result.username} cannot write to that chat: ${sent.description || 'unknown'} (has the chat pressed Start?)`);
    pass(name, `@${me.result.username} wrote to the chat - check Telegram for the message`);
  } catch (e) {
    fail(name, errText(e));
  }
}

console.log(`secrets check: ${which}`);
if (which === 'mainnet') {
  checkKey('SHARING_PUBLISHER_KEY');
  checkKey('SHARING_STANDBY_PUSHER_KEY');
  await checkRpcs('SHARING_RPC_URLS');
  await checkDataToken('SHARING_DATA_REPO_TOKEN');
  checkPins('SHARING_PIN_TOKENS');
  await checkAlerts('SHARING_ALERT_WEBHOOKS');
} else {
  await checkRpcs('SHARING_VERIFY_RPC_URLS');
  await checkAlerts('SHARING_ALERT_WEBHOOKS');
}
console.log(failed ? `\n${failed} check(s) FAILED` : warned ? `\nevery check passed, ${warned} with a warning` : '\nevery check passed');
process.exit(failed ? 1 : 0);
