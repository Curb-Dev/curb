// What the site tells AI agents (web/agents/deployment.json, web/llms.txt,
// web/agents/curb.md, the "For AI agents" part of web/docs.md) held to the
// files it is taken from: config.js, prices.js, app.js, prefill.js,
// ADDRESSES.txt and the hosts' own files. A drift between the guide and the
// site would send an agent's user to the wrong contract or a link the form
// refuses. The chain side is script/b20/check-agent-deployment.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.ts';

const REPO = join(ROOT, '..', '..');
const WEB = join(REPO, 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
const D = JSON.parse(read('agents/deployment.json'));

/** A browser script's window, as the file sets it. */
function windowOf(file: string, extra: Record<string, unknown> = {}): any {
  const box: any = { TextEncoder, window: { CurbKeccak: { keccak256: () => "0x00" }, ...extra } };
  vm.runInNewContext(read(file), box, { filename: file });
  return box.window;
}
// COPIED INTO THIS REALM (as JSON): the sandbox's arrays are not this one's.
const SITE = JSON.parse(JSON.stringify(windowOf('config.js').CURB_SITE));
const FEEDS: Record<string, [string, string]> = JSON.parse(JSON.stringify(windowOf('prices.js').CurbPrices.USD_FEEDS));
const APP = read('app.js');
const EQUITIES = new Set([...(/const EQUITIES = new Set\(\[([\s\S]*?)\]\);/.exec(APP)![1]).matchAll(/"(0x[0-9a-fA-F]{40})"/g)].map((m) => m[1].toLowerCase()));
const appNumber = (name: string) => Number(new RegExp(`^const ${name} = (\\d+)n?;`, 'm').exec(APP)![1]);
const lc = (s: string) => String(s).toLowerCase();
/** Raw units placed by decimals, no trailing zeros. */
function units(raw: string, decimals: number): string {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return frac ? whole + '.' + frac : whole;
}

/** A1's rule for the hidden marks, on any config.js and deployment.json. */
function hiddenMarksAgree(site: any, d: any): string | null {
  const hidden = (site.hiddenFactories || []).map(lc);
  const factories = (site.factories || []).map(lc);
  for (const f of hidden) if (!factories.includes(f)) return `hidden factory ${f} is not one of config.js's factories`;
  for (const a of d.assets) {
    if (a.hidden !== hidden.includes(a.factory)) return `${a.symbol}: hidden is ${a.hidden}, config.js ${hidden.includes(a.factory) ? 'hides' : 'offers'} it`;
  }
  return null;
}

/** A copy of config.js and deployment.json with nothing hidden: where A1
 *  shows its rule by example, whatever an incident hides in the real files. */
const unhidden = (site: any, d: any) => ({
  site: { ...site, hiddenFactories: [] },
  d: { ...d, assets: d.assets.map((a: any) => ({ ...a, hidden: false })) },
});

/** A1, on any config.js and deployment.json: the real ones, and A10's. */
function checkA1(site: any, d: any): void {
  assert.equal(d.schema, 'curb.deployment/1');
  assert.equal(d.chainId, site.chainId);
  assert.equal(d.contracts.lens, lc(site.lens));
  assert.equal(d.contracts.registry, lc(site.registry));
  assert.deepEqual(d.assets.map((a: any) => a.factory), site.factories.map(lc));
  const tokens = d.assets.map((a: any) => a.token);
  assert.equal(new Set(tokens).size, tokens.length, 'two factories on one asset');
  // A FACTORY config.js HIDES STAYS (the registry keeps it, and
  // check-agent-deployment.js holds the file to the registry) with hidden: true,
  // so agents leave it out; every hidden factory is one of config.js's, so
  // index-launches.ts finds its asset here with no read.
  for (const a of d.assets) assert.equal(typeof a.hidden, 'boolean', a.symbol);
  assert.equal(hiddenMarksAgree(site, d), null);
  // THE RULE ITSELF, on a copy with nothing hidden (INCIDENT.txt may have
  // hidden assets in the real files): hide NVDAc's factory in config.js.
  const c = unhidden(site, d);
  const nvda = c.d.assets.find((a: any) => a.symbol === 'NVDAc');
  const incident = { ...c.site, hiddenFactories: [nvda.factory.toUpperCase().replace('0X', '0x')] };
  assert.match(String(hiddenMarksAgree(incident, c.d)), /^NVDAc: hidden is false, config.js hides it$/);
  const marked = { ...c.d, assets: c.d.assets.map((a: any) => (a === nvda ? { ...a, hidden: true } : a)) };
  assert.equal(hiddenMarksAgree(incident, marked), null);
  assert.match(String(hiddenMarksAgree(c.site, marked)), /^NVDAc: hidden is true, config.js offers it$/);
  assert.match(String(hiddenMarksAgree({ ...c.site, hiddenFactories: ['0x' + '12'.repeat(20)] }, c.d)), /is not one of config\.js's factories/);
  // AND THE CONTRACTS AS ADDRESSES.txt RECORDS THEM.
  const book = readFileSync(join(REPO, 'ADDRESSES.txt'), 'utf8');
  const named = (label: string) => lc(new RegExp('^\\s*' + label.replace('$', '\\$') + '\\s+(0x[0-9a-fA-F]{40})\\s*$', 'm').exec(book)![1]);
  assert.deepEqual(d.contracts, {
    registry: named('LaunchRegistry'), lens: named('LaunchLens'), graduator: named('Graduator'), feeHook: named('FeeHook'),
    router: named('CurbRouter'), sharingCatalog: named('SharingCatalog'), curbToken: named('$CURB token'),
  });
  for (const a of Object.values(d.contracts) as string[]) assert.match(a, /^0x[0-9a-f]{40}$/);
  for (const a of d.assets) for (const k of ['token', 'factory']) assert.match(a[k], /^0x[0-9a-f]{40}$/);
}

test('A1: deployment.json names config.js\'s chain, lens, registry and exactly its factories, in its order, one asset each, marked hidden exactly as config.js hides them', () => {
  checkA1(SITE, D);
});

test('A2: each asset\'s dollar feed is prices.js\'s for its token, and kind is "stock" exactly for app.js\'s equities', () => {
  for (const a of D.assets) {
    const f = FEEDS[a.token];
    assert.ok(f, `prices.js has no feed for ${a.symbol}`);
    assert.equal(a.usdFeed.address, lc(f[0]), a.symbol);
    assert.equal(a.usdFeed.description, f[1], a.symbol);
    assert.ok(Number.isInteger(a.usdFeed.decimals) && a.usdFeed.decimals > 0, a.symbol);
    assert.equal(a.kind, EQUITIES.has(a.token) ? 'stock' : 'coin', a.symbol);
    assert.equal(a.usdFeed.marketHours, a.kind === 'stock', a.symbol);
    assert.equal(a.display, a.symbol === 'WETH' ? 'ETH' : a.symbol);
  }
  assert.ok(D.assets.some((a: any) => a.kind === 'stock') && D.assets.some((a: any) => a.kind === 'coin'));
});

test('A3: each launchUrl is the site\'s launch form with that factory and nothing more', () => {
  for (const a of D.assets) assert.equal(a.launchUrl, 'https://curbfun.xyz/launchpad?factory=' + a.factory);
  assert.equal(D.site, 'https://curbfun.xyz');
  assert.equal(D.launchLink.base, 'https://curbfun.xyz/launchpad');
  assert.equal(D.tokenPage, 'https://curbfun.xyz/token/{token}');
});

test('A4: graduationThresholdUnits is graduationThreshold placed by decimals', () => {
  for (const a of D.assets) {
    assert.match(a.graduationThreshold, /^[1-9][0-9]*$/);
    assert.equal(a.graduationThresholdUnits, units(a.graduationThreshold, a.decimals), a.symbol);
  }
  assert.match(D.launchTerms.supply, /^[1-9][0-9]*$/);
  assert.deepEqual(D.launchTerms.taxBps, { min: appNumber('TAX_MIN_BPS'), max: appNumber('TAX_MAX_BPS') });
});

test('deployment.json carries reads only: view functions, no selector that moves funds, no Builder Code', () => {
  for (const f of D.readAbi) assert.match(f, /^function \w+\([^)]*\) view returns /);
  const text = JSON.stringify(D);
  assert.ok(!/bc_|builder|calldata|"data":\s*"0x/i.test(text), 'something of a send is in the file');
  for (const fn of ['buy', 'sell', 'launch(', 'approve', 'transfer', 'swap', 'claim', 'sweep']) {
    assert.ok(!D.readAbi.some((f: string) => f.startsWith('function ' + fn)), fn);
  }
});

/** The site's own files and the data paths the hosts rewrite (vercel.json). */
function served(url: string): boolean {
  const u = new URL(url.replace('{token}', '0x' + '00'.repeat(20)));
  if (u.host !== 'curbfun.xyz') return false;
  const p = u.pathname;
  if (/^\/sharing\/8453\/(stats|launches)\.json$/.test(p) || /^\/sharing\/8453\/history\/(0x[0-9a-f]{40}|checked)\.json$/.test(p)) return true;
  if (/^\/token\/0x[0-9a-f]{40}$/.test(p)) return true;
  const clean: Record<string, string> = { '/': 'browse.html', '/launchpad': 'app.html', '/launches': 'browse.html', '/curb': 'curb.html',
    '/docs': 'docs.html', '/migrate': 'migrate.html', '/terms': 'terms.html', '/sharing': 'sharing.html' };
  return existsSync(join(WEB, clean[p] ?? p.slice(1)));
}

test('the data URLs deployment.json names are the site\'s files or the data paths the hosts rewrite', () => {
  for (const u of Object.values(D.data) as string[]) assert.ok(served(u), u);
  assert.ok(served(D.guide), D.guide);
  const v = JSON.parse(read('vercel.json'));
  assert.ok(v.rewrites.some((r: any) => r.source === '/sharing/:chain(\\d+)/:path*' &&
    r.destination === 'https://raw.githubusercontent.com/Curb-Dev/curb-sharing-data/main/sharing/:chain/:path*'));
});

const LLMS = read('llms.txt');
const GUIDE = read('agents/curb.md');
const DOCS = read('docs.md');
/** docs.md's "For AI agents" section, up to the next heading or rule. */
const DOCS_AGENTS = (() => {
  const at = DOCS.indexOf('\n## For AI agents\n');
  assert.ok(at >= 0, 'docs.md has no "For AI agents" section');
  const rest = DOCS.slice(at + '\n## For AI agents\n'.length);
  const end = rest.search(/\n(#{2,3} |---)/);
  return rest.slice(0, end < 0 ? undefined : end);
})();
/** Every curbfun.xyz URL in a text, without trailing punctuation. */
const urlsIn = (s: string) => [...s.matchAll(/https:\/\/curbfun\.xyz[^\s)`"'<>|\]]*/g)].map((m) => m[0].replace(/[.,:;]+$/, ''));

test('A5: every curbfun.xyz link in llms.txt, curb.md and docs.md\'s agent part is a file in web/ or a data path the hosts rewrite', () => {
  for (const [name, text] of [['llms.txt', LLMS], ['curb.md', GUIDE], ['docs.md', DOCS_AGENTS]] as const) {
    const urls = urlsIn(text);
    assert.ok(urls.length >= 3, name);
    for (const u of urls) assert.ok(served(u), `${name}: ${u} is not served`);
  }
  assert.match(DOCS_AGENTS, /https:\/\/curbfun\.xyz\/llms\.txt/);
  assert.match(DOCS_AGENTS, /https:\/\/curbfun\.xyz\/agents\/curb\.md/);
  // EVERY ASSET THE FILE LISTS, a hidden one too (it says hidden on itself).
  assert.match(LLMS, new RegExp(`the ${D.assets.length} paired assets`));
  assert.match(GUIDE, new RegExp(`one per paired asset \\(${D.assets.length} today\\)`));
  // llmstxt.org: an H1, then a blockquote summary.
  assert.match(LLMS, /^# CURB\n\n> /);
});

/** curb.md's frontmatter, read as the plugin spec writes it (flat keys, one level of requires). */
function frontmatter(md: string): Record<string, any> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(m, 'curb.md has no frontmatter');
  const out: Record<string, any> = {};
  let parent: Record<string, any> | null = null;
  const value = (v: string): any => {
    v = v.trim();
    if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
    if (/^".*"$/.test(v)) return v.slice(1, -1);
    if (v === 'null') return null;
    return v;
  };
  for (const line of m![1].split('\n')) {
    const top = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    const sub = /^  ([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (top) {
      parent = null;
      if (top[2] === '') { out[top[1]] = {}; parent = out[top[1]]; } else out[top[1]] = value(top[2]);
    } else if (sub && parent) parent[sub[1]] = value(sub[2]);
    else assert.fail('a frontmatter line this test cannot read: ' + line);
  }
  return out;
}

test('A6: curb.md has the plugin spec\'s frontmatter with valid values, and its headings in the canonical order', () => {
  const f = frontmatter(GUIDE);
  assert.match(f.title, /^\S.* Plugin$/);
  assert.equal(typeof f.description, 'string');
  assert.ok(f.description.length > 20 && !f.description.includes('\n'));
  assert.ok(f.tags.length >= 3 && f.tags.length <= 5 && f.tags.every((t: string) => /^[a-z]+(-[a-z]+)*$/.test(t)));
  assert.match(f.name, /^[a-z][a-z0-9-]*$/);
  assert.match(f.version, /^\d+\.\d+\.\d+$/);
  assert.equal(f.integration, 'http-api');
  assert.ok(Array.isArray(f.chains) && f.chains.every((c: string) => ['arbitrum', 'avalanche', 'base', 'base-sepolia', 'bsc', 'ethereum', 'optimism', 'polygon'].includes(c)));
  assert.deepEqual(f.chains, [], 'chains: [] - nothing goes through Wallet MCP');
  assert.equal(f.requires.shell, 'none');
  assert.deepEqual(f.requires.allowlist, ['curbfun.xyz']);
  assert.equal(f.requires.externalMcp, null);
  assert.equal(f.requires.cliPackage, null);
  assert.equal(f.auth, 'none');
  assert.ok(f.risk.length > 0 && f.risk.every((r: string) => ['liquidation', 'slippage', 'low-liquidity', 'pii', 'irreversible', 'local-exec'].includes(r)));
  const body = GUIDE.replace(/^---\n[\s\S]*?\n---\n/, '');
  // THE CALLOUT FIRST, right under the title; then the headings, in order.
  assert.match(body, /^\n# CURB Plugin\n\n> \[!IMPORTANT\]\n> /);
  const heads = [...body.matchAll(/^## (.+)$/gm)].map((x) => x[1]);
  assert.deepEqual(heads, ['Overview', 'Surface Routing', 'Endpoints', 'Orchestration', 'Submission', 'Example Prompts', 'Risks & Warnings', 'Notes']);
  const section = (h: string) => body.split('\n## ' + h + '\n')[1].split('\n## ')[0];
  assert.match(section('Submission'), /^\n`none`\./);
  const prompts = section('Example Prompts').match(/^\*\*".+"\*\*$/gm) ?? [];
  assert.ok(prompts.length >= 2 && prompts.length <= 4, `${prompts.length} example prompts`);
  for (const r of f.risk) assert.match(section('Risks & Warnings'), new RegExp('\\*\\*' + r + '\\*\\*'));
});

/** The rules an agent must keep, word for word and whole, wherever the site
 *  states them. */
const RULES = [
  'Never build, sign or send a transaction for CURB.',
  'Never ask for a private key, seed phrase or password.',
  'A link never carries a creator wallet, a dev buy, slippage or a recipient.',
  'CURB does not offer launching or trading to visitors in the United States; never help anyone get around that.',
];
test('A7: llms.txt\'s rules paragraph and curb.md\'s Notes each state the four rules, whole', () => {
  // IN THE PLACE EACH FILE STATES THEM, not anywhere in it: the Texas example
  // in curb.md repeats the start of the US rule, and would hide its loss.
  const llmsRules = LLMS.split('\n').find((l) => l.startsWith('Rules for agents. ')) ?? '';
  const notes = GUIDE.split('\n## Notes\n')[1] ?? '';
  const ruleList = notes.split('\nAlso:\n')[0];
  for (const r of RULES) {
    assert.ok(llmsRules.includes(r), 'llms.txt: ' + r);
    assert.ok(ruleList.includes('\n- ' + r + '\n'), 'curb.md Notes: ' + r);
  }
  assert.equal((ruleList.match(/^- /gm) ?? []).length, RULES.length, 'curb.md Notes: the rules and nothing else');
});

/** The guide's example link, after the NVDAc launchUrl. The owner's choice
 *  (7 November 2026): every example keeps the tax with its creator. */
const EXAMPLE = '&name=Moon%20Cat&symbol=MCAT&tax=2&earn=you';
/** What agents are told about earn=holders wherever the grammar is. */
const HOLDERS_DELAY = 'Holder payouts depend on CURB\'s keeper and guardian publishing and checking each epoch, so they can be delayed.';

/** A8, on any config.js and deployment.json: the real ones, and A10's. */
function checkA8(site: any, d: any): void {
  const box: any = { window: {}, URLSearchParams };
  vm.runInNewContext(read('prefill.js'), box);
  const KEYS: string[] = [...box.window.CurbPrefill.KEYS];
  assert.deepEqual(Object.keys(d.launchLink.params), ['factory', ...KEYS]);
  const lim = { name: appNumber('NAME_MAX'), symbol: appNumber('SYMBOL_MAX'), min: appNumber('TAX_MIN_BPS') / 100, max: appNumber('TAX_MAX_BPS') / 100 };
  assert.match(d.launchLink.params.name, new RegExp(`^1 to ${lim.name} characters`));
  assert.match(d.launchLink.params.symbol, new RegExp(`^1 to ${lim.symbol} characters`));
  assert.match(d.launchLink.params.tax, new RegExp(`${lim.min} to ${lim.max}, at most 2 decimals`));
  assert.equal(d.launchLink.params.earn, 'you or holders. ' + HOLDERS_DELAY);
  for (const n of ['creator wallet', 'dev buy', 'slippage', 'recipient', 'rpc', 'lens', 'token']) assert.ok(d.launchLink.never.includes(n), n);
  // curb.md's table of keys.
  const table = GUIDE.split('### Launch link')[1].split('\n### ')[0];
  const keys = [...table.matchAll(/^\| `(\w+)` \|/gm)].map((x) => x[1]);
  assert.deepEqual(keys, ['factory', ...KEYS]);
  assert.match(table, new RegExp(`\\| \`name\` \\| 1 to ${lim.name} characters`));
  assert.match(table, new RegExp(`\\| \`symbol\` \\| 1 to ${lim.symbol} characters`));
  assert.match(table, new RegExp(`\\| \`tax\` \\| The creator tax in percent, ${lim.min} to ${lim.max}, at most 2 decimals`));
  assert.match(table, /\| `earn` \| `you` .* or `holders`/);
  // HOLDERS STAYS A CHOICE, said with its delay where the grammar is.
  const earnRow = table.split('\n').find((l) => l.startsWith('| `earn` |')) ?? '';
  assert.ok(earnRow.endsWith(' ' + HOLDERS_DELAY + ' |'), earnRow);
  // THE LINK THE GUIDE'S EXAMPLE BUILDS is one prefill.js fills whole - while
  // its asset is offered. Hidden (INCIDENT.txt), agents leave it out (Hand off
  // a launch, step 1) and the form fills nothing from it, so there is nothing
  // to check; A1 says whether the two files agree that it is hidden.
  const nvda = d.assets.find((a: any) => a.symbol === 'NVDAc');
  const hidden = nvda.hidden || (site.hiddenFactories || []).map(lc).includes(nvda.factory);
  if (!hidden) {
    const link = new URL(nvda.launchUrl + EXAMPLE);
    const r = box.window.CurbPrefill.parse(link.searchParams, { production: true, tokenView: false, formThere: true, readsSitePair: true,
      siteFactories: site.factories, hiddenFactories: site.hiddenFactories, nameMax: lim.name, symbolMax: lim.symbol, taxMinBps: lim.min * 100, taxMaxBps: lim.max * 100 });
    assert.deepEqual([...r.filled], ['factory', 'name', 'symbol', 'tax', 'earn']);
    assert.equal(r.values.earn, 'you');
  }
  assert.ok(GUIDE.includes('`' + EXAMPLE + '`'));
  // EVERY EXAMPLE LINK THE KIT GIVES KEEPS THE TAX WITH ITS CREATOR: an earn=
  // in a link is earn=you, in every file an agent reads and in prefill.js's own.
  const kit: [string, string][] = [['llms.txt', LLMS], ['curb.md', GUIDE], ['docs.md', DOCS_AGENTS],
    ['deployment.json', JSON.stringify(d)], ['prefill.js', read('prefill.js')]];
  for (const [name, text] of kit) {
    // (curb.md's grammar line, earn=<you|holders>, is no example.)
    for (const m of text.matchAll(/[?&]earn=(?!<you\|holders>)([^&\s`"')]*)/g)) assert.equal(m[1], 'you', `${name}: ${m[0]}`);
  }
  assert.ok([...GUIDE.matchAll(/[?&]earn=you\b/g)].length >= 1 && [...read('prefill.js').matchAll(/[?&]earn=you\b/g)].length === 1);
}

test('A8: the link grammar in deployment.json and curb.md is exactly prefill.js\'s keys and the factory, with app.js\'s limits', () => {
  checkA8(SITE, D);
});

test('A10: following INCIDENT.txt - an asset hidden in config.js and deployment.json alike, TSLAc, NVDAc (the guide\'s example) or both - keeps A1 and A8 green; hidden in one file only, A1 names it', () => {
  /** The real files with `symbols` hidden in config.js, in deployment.json, or both. */
  const hide = (symbols: string[], where: 'both' | 'config' | 'deployment' = 'both') => {
    const factories = D.assets.filter((a: any) => symbols.includes(a.symbol)).map((a: any) => a.factory);
    assert.equal(factories.length, symbols.length, symbols.join());
    return {
      site: where === 'deployment' ? SITE : { ...SITE, hiddenFactories: [...(SITE.hiddenFactories || []), ...factories] },
      d: where === 'config' ? D : { ...D, assets: D.assets.map((a: any) => (symbols.includes(a.symbol) ? { ...a, hidden: true } : a)) },
    };
  };
  for (const symbols of [['TSLAc'], ['NVDAc'], ['TSLAc', 'NVDAc']]) {
    const { site, d } = hide(symbols);
    checkA1(site, d);
    checkA8(site, d);
  }
  // HALF THE STEP: A1 is red and says which asset and which way.
  const configOnly = hide(['TSLAc'], 'config');
  assert.throws(() => checkA1(configOnly.site, configOnly.d), /TSLAc: hidden is false, config\.js hides it/);
  const deploymentOnly = hide(['NVDAc'], 'deployment');
  assert.throws(() => checkA1(deploymentOnly.site, deploymentOnly.d), /NVDAc: hidden is true, config\.js offers it/);
});

test('A9: vercel.json and _headers send Access-Control-Allow-Origin: * for /llms.txt and /agents/*', () => {
  const v = JSON.parse(read('vercel.json'));
  for (const source of ['/llms.txt', '/agents/(.*)']) {
    assert.ok(v.headers.some((h: any) => h.source === source && h.headers.some((x: any) => x.key === 'Access-Control-Allow-Origin' && x.value === '*')), source);
  }
  const blocks: Record<string, string[]> = {};
  let at = '';
  for (const raw of read('_headers').split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    if (!/^\s/.test(raw)) { at = raw.trim(); blocks[at] = []; continue; }
    blocks[at].push(raw.trim());
  }
  assert.deepEqual(blocks['/llms.txt'], ['Access-Control-Allow-Origin: *']);
  assert.deepEqual(blocks['/agents/*'], ['Access-Control-Allow-Origin: *']);
});
