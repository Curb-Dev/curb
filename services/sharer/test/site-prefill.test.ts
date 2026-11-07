// A prefilled launch link (web/prefill.js), run on its own - the file as the
// site serves it, not a copy - in a sandbox with a bare window: what a link
// may fill in the create form, what it never fills, when it fills nothing,
// and which links are half a link. The page around it is covered by
// web/e2e/prefill.spec.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.ts';

const SRC = readFileSync(join(ROOT, '..', '..', 'web', 'prefill.js'), 'utf8');
const APP = readFileSync(join(ROOT, '..', '..', 'web', 'app.js'), 'utf8');

function load(): any {
  const box: any = { window: {}, URLSearchParams };
  vm.runInNewContext(SRC, box, { filename: 'prefill.js' });
  return box.window.CurbPrefill;
}
const P = load();

/** A number app.js defines, as the file has it. */
function appNumber(name: string): number {
  const m = new RegExp(`^const ${name} = (\\d+)n?;`, 'm').exec(APP);
  assert.ok(m, `app.js defines ${name}`);
  return Number(m![1]);
}
const NAME_MAX = appNumber('NAME_MAX');
const SYMBOL_MAX = appNumber('SYMBOL_MAX');
const TAX_MIN_BPS = appNumber('TAX_MIN_BPS');
const TAX_MAX_BPS = appNumber('TAX_MAX_BPS');

const LISTED = '0x' + 'ab'.repeat(20);
const HIDDEN = '0x' + 'cd'.repeat(20);
const OTHER = '0x' + 'ef'.repeat(20);
/** The page's facts, as app.js passes them in production on the form. */
const PAGE = {
  production: true, tokenView: false, formThere: true, readsSitePair: true,
  siteFactories: [LISTED, HIDDEN], hiddenFactories: [HIDDEN],
  nameMax: NAME_MAX, symbolMax: SYMBOL_MAX, taxMinBps: TAX_MIN_BPS, taxMaxBps: TAX_MAX_BPS,
};
const q = (s: string | Record<string, string>) => new URLSearchParams(s);
const parse = (s: string | Record<string, string>, over: Partial<typeof PAGE> = {}) => P.parse(q(s), { ...PAGE, ...over });
/** The values one key fills, or undefined when it is refused. */
const one = (key: string, v: string) => parse({ [key]: v }).values[key];

test('the limits are app.js\'s own, so a link is held to what the form is', () => {
  assert.equal(NAME_MAX, 32);
  assert.equal(SYMBOL_MAX, 10);
  assert.equal(TAX_MIN_BPS, 100);
  assert.equal(TAX_MAX_BPS, 500);
  assert.deepEqual([...P.KEYS], ['name', 'symbol', 'tax', 'earn']);
});

test('U1: the values a link may carry are filled', () => {
  // LATIN LETTERS, accents and all, and the digits 0-9. The owner's controls
  // (7 November 2026): "St Louis", "Moon Cat" and "Dr. Who" are no web address.
  for (const name of ["Na'vidia", 'Güzel Kedi', 'Moon Cat', 'x'.repeat(32), 'A.B, C-D & E! (F)? +#', 'Dr. Pepper', 'Web3.0',
    'St Louis', 'St. Louis', 'Dr. Who', 'Moon 2.0', 'Polka Dots', 'Œuvre Straße', 'Café Ñandú']) {
    assert.equal(one('name', name), name, `name ${JSON.stringify(name)}`);
  }
  for (const s of ['A', 'MCAT', 'moon', 'Ab1', '0123456789']) assert.equal(one('symbol', s), s, `symbol ${s}`);
  for (const t of ['1', '1.5', '2.25', '5', '5.0', '5.00']) assert.equal(one('tax', t), t, `tax ${t}`);
  for (const e of ['you', 'holders']) assert.equal(one('earn', e), e, `earn ${e}`);
  for (const f of [LISTED, LISTED.toUpperCase().replace('0X', '0x'), '0x' + 'AB'.repeat(20)]) {
    const r = parse({ factory: f, name: 'Moon Cat' });
    assert.equal(r.blocked, null, `factory ${f}`);
    assert.deepEqual([...r.filled], ['factory', 'name']);
  }
  const all = parse({ factory: LISTED, name: 'Moon Cat', symbol: 'MCAT', tax: '2.5', earn: 'holders' });
  assert.deepEqual({ ...all.values }, { name: 'Moon Cat', symbol: 'MCAT', tax: '2.5', earn: 'holders' });
  assert.deepEqual([...all.refused], []);
});

test('U2: each value outside its rule is refused on its own, and the others still fill', () => {
  const bad: Record<string, string[]> = {
    name: ['x'.repeat(33), '', ' Moon', 'Moon ', 'Moon 🐱', '<img>', 'Moon"', 'a/b', 'a@b', '100%', 'a\tb', 'a\nb',
      'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u{200b}b', 'a\u{202e}b', 'a\u{2066}b', '\u{feff}Moon', 'e\u{301}',
      // LETTERS THAT RENDER AS NOTHING (the Hangul fillers), alone or beside others.
      '\u{3164}', '\u{3164}\u{3164}', 'Moon\u{3164}Cat', '\u{115f}', '\u{1160}', 'a\u{ffa0}b',
      // A WEB ADDRESS in a name shown on every card, and the ":" of one.
      'Claim at evil.com', 'evil.co', 'x.рф', 'Go to bit.ly now', 'a:b', 'https:',
      // ... AND ONE SPELLED OUT, spaced or bracketed (the 7 November review's,
      // then more of the same), in any case.
      'evil dot com', 'evil(.)com', 'evil[.]com', 'Claim at evil . com', 'evil .com', 'evil (dot) com', 'evil(dot)com',
      'evil-dot-com', 'EVIL DOT COM', 'evil . COM', 'evil{.}com', 'evil. com', 'Claim at evil. com now',
      // (fullwidth letters are Latin, and read as what they look like: "ｅｖｉｌ ｄｏｔ ｃｏｍ", "evil ｄｏｔ com")
      '\u{ff45}\u{ff56}\u{ff49}\u{ff4c} \u{ff44}\u{ff4f}\u{ff54} \u{ff43}\u{ff4f}\u{ff4d}', 'evil \u{ff44}\u{ff4f}\u{ff54} com',
      // LATIN MIXED WITH ANOTHER SCRIPT: the look-alikes ("Сurb", "Ꮯurb" in Cherokee).
      '\u{0421}urb', 'Moon \u{041a}otik', 'C\u{03bf}in', '\u{13df}urb',
      // ANOTHER SCRIPT ALONE, or a digit other than 0-9 (the person types those by hand).
      '\u{041a}\u{043e}\u{0442}\u{0438}\u{043a} 2', '\u{0393}\u{03ac}\u{03c4}\u{03b1}', '\u{3131} \u{d55c}\u{ae00}',
      'Moon \u{0661}', 'Moon \u{ff11}', 'Moon \u{2160}', 'Moon \u{00b2}'],
    symbol: ['x'.repeat(11), '', 'M CAT', '$CAT', 'CAT!', 'ÇAT'],
    tax: ['0.99', '5.01', '6', '0', '01', '1.', '.5', '1,5', '1.555', '+1', '-1', '1e0', '0x1', '１', 'NaN', 'Infinity', ' 1', '1 '],
    earn: ['Holders', 'HOLDERS', 'creator', '', '1', 'true', 'You'],
  };
  const good: Record<string, string> = { name: 'Moon Cat', symbol: 'MCAT', tax: '2', earn: 'you' };
  for (const [k, vs] of Object.entries(bad)) {
    for (const v of vs) {
      const r = parse({ ...good, [k]: v });
      assert.equal(r.values[k], undefined, `${k} ${JSON.stringify(v)} was filled`);
      assert.deepEqual([...r.refused].map((x: string[]) => [...x]), [[k, 'rule']], `${k} ${JSON.stringify(v)}`);
      for (const other of Object.keys(good)) if (other !== k) assert.equal(r.values[other], good[other], `${other} beside ${k}`);
    }
  }
});

test('U3: a key given twice is not used', () => {
  for (const k of ['name', 'symbol', 'tax', 'earn']) {
    const v = { name: 'Moon', symbol: 'MOON', tax: '2', earn: 'you' }[k]!;
    const r = P.parse(q(`${k}=${encodeURIComponent(v)}&${k}=${encodeURIComponent(v)}`), PAGE);
    assert.equal(r.values[k], undefined, k);
    assert.deepEqual([...r.refused].map((x: string[]) => [...x]), [[k, 'twice']]);
  }
  // A FACTORY NAMED TWICE fills nothing at all: which one would be the asset?
  // And it says so in its own words, not "a factory this site does not offer".
  for (const two of [`factory=${LISTED}&factory=${LISTED}&name=Moon`, `factory=${LISTED}&factory=${OTHER}&name=Moon`]) {
    const r = P.parse(q(two), PAGE);
    assert.equal(r.blocked, 'factories');
    assert.deepEqual([...r.filled], []);
    assert.deepEqual([...P.notice(r, PAGE)], ['This link names more than one factory, so nothing from it was filled in.']);
  }
});

test('U4: the tax band is the caller\'s, not written a second time in prefill.js', () => {
  const narrow = { taxMinBps: 200, taxMaxBps: 300 };
  assert.equal(parse({ tax: '1.5' }, narrow).values.tax, undefined);
  assert.equal(parse({ tax: '3.01' }, narrow).values.tax, undefined);
  assert.equal(parse({ tax: '2.5' }, narrow).values.tax, '2.5');
  assert.equal(parse({ tax: '3' }, narrow).values.tax, '3');
  const wide = { taxMinBps: 50, taxMaxBps: 900 };
  assert.equal(parse({ tax: '0.5' }, wide).values.tax, '0.5');
  assert.equal(parse({ tax: '9' }, wide).values.tax, '9');
  // And the names' and symbols' limits too.
  assert.equal(parse({ name: 'x'.repeat(33) }, { nameMax: 40 }).values.name, 'x'.repeat(33));
  assert.equal(parse({ symbol: 'ABC' }, { symbolMax: 2 }).values.symbol, undefined);
});

/** A small seeded generator, so a failure can be run again. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Every id on the create form, as app.html has them. */
const FORM_IDS = ['nName', 'nSymbol', 'nDesc', 'nImageFile', 'nSite', 'nX', 'nTg', 'nTax', 'earnYouPick', 'nShare', 'earnWho', 'nDevBuy',
  'nDevPct', 'nDevSlider', 'quotePick', 'factory', 'nCreator', 'create', 'slippage', 'poolSlippage', 'rpc', 'lens', 'token'];
const NEVER_KEYS: string[] = P.NEVER.flatMap(([, ks]: [string, string[]]) => ks);
const NOT_FILLED_KEYS: string[] = P.LINK_DOES_NOT_FILL.flatMap(([, ks]: [string, string[]]) => ks);

/** A key written as a stranger might: mixed case, with - and _ put in. */
function scramble(k: string, r: () => number): string {
  let out = '';
  for (const c of k) {
    out += r() < 0.5 ? c.toUpperCase() : c;
    if (r() < 0.15) out += r() < 0.5 ? '-' : '_';
  }
  return out;
}

test('U5a: the keys a link can never set, and what each is called, are written down here too, so a key taken out of NEVER is caught', () => {
  // U5 draws its keys and its expected warnings from NEVER itself, so it
  // cannot see an entry go. This list is its own oracle.
  assert.deepEqual(JSON.parse(JSON.stringify(P.NEVER)), [
    ['the creator wallet', ['creatorwallet', 'creator', 'ncreator', 'beneficiary', 'wallet', 'payto', 'recipient', 'receiver', 'to']],
    ['the dev buy', ['devbuy', 'dev', 'ndevbuy', 'devpct', 'ndevpct', 'devslider', 'ndevslider', 'firstbuy', 'buy', 'amount', 'value']],
    ['slippage', ['slippage', 'poolslippage', 'slip']],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(P.LINK_DOES_NOT_FILL)), [
    ['the description', ['desc', 'ndesc', 'description']],
    ['the links', ['site', 'nsite', 'website', 'x', 'nx', 'twitter', 'tg', 'ntg', 'telegram']],
    ['the image', ['image', 'img', 'logo', 'nimagefile', 'tokenuri', 'uri']],
  ]);
  // AND THE WARNING, FOR EACH ALONE.
  for (const k of ['recipient', 'Beneficiary', 'pay_to', 'receiver', 'to']) {
    assert.match(P.notice(parse({ [k]: OTHER }), PAGE).join(' '), /tried to set the creator wallet\./, k);
  }
  for (const k of ['amount', 'first-buy', 'value']) assert.match(P.notice(parse({ [k]: '1' }), PAGE).join(' '), /tried to set the dev buy\./, k);
  assert.match(P.notice(parse({ slip: '50' }), PAGE).join(' '), /tried to set slippage\./);
});

test('U5: over 2,000 random links, only name, symbol, tax and earn are ever filled, and every key a link can never set is reported', () => {
  const r = rng(20261107);
  const pool = [...FORM_IDS, ...NEVER_KEYS, ...NOT_FILLED_KEYS, 'name', 'symbol', 'tax', 'earn', 'factory', 'utm_source', 'ref', '__proto__', 'constructor'];
  const values = ['Moon', 'MOON', '2', 'you', 'holders', '0x' + 'dead'.repeat(10), '1', '50', 'https://evil.example', '', LISTED];
  for (let i = 0; i < 2000; i++) {
    const n = 1 + Math.floor(r() * 8);
    const sp = new URLSearchParams();
    const sent: string[] = [];
    for (let j = 0; j < n; j++) {
      // EVERY DRAW FROM THE SEEDED r(), so a failure can be run again exactly.
      const base = r() < 0.15 ? Math.floor(r() * 36 ** 5).toString(36) : pool[Math.floor(r() * pool.length)];
      const key = r() < 0.5 ? scramble(base, r) : base;
      // not rpc, lens or token, which fill nothing at all (U6)
      if (/^(rpc|lens|token)$/i.test(key)) continue;
      sp.append(key, values[Math.floor(r() * values.length)]);
      sent.push(key);
    }
    const res = P.parse(sp, PAGE);
    for (const k of Object.keys(res.values)) assert.ok(['name', 'symbol', 'tax', 'earn'].includes(k), `filled ${k} from ${sp}`);
    for (const k of res.filled) assert.ok(['factory', 'name', 'symbol', 'tax', 'earn'].includes(k), `filled ${k} from ${sp}`);
    // A KEY THAT IS NOT EXACTLY ONE OF KEYS NEVER FILLS: "Name" is not "name".
    for (const k of Object.keys(res.values)) assert.equal(sp.getAll(k).length, 1);
    for (const [label, names] of P.NEVER as [string, string[]][]) {
      const present = sent.some((k) => names.includes(k.toLowerCase().replace(/[-_]/g, '')));
      assert.equal(res.never.includes(label), present, `${label} for ${sp}`);
    }
  }
});

test('U6: nothing is filled when the link names rpc, lens or token, an unlisted, hidden or malformed factory, off production, or when the page reads another pair', () => {
  const fill = { name: 'Moon', symbol: 'MOON', tax: '2', earn: 'you' };
  const cases: [string, Record<string, string>, Partial<typeof PAGE>, string][] = [
    ['rpc', { ...fill, rpc: 'https://other.example' }, {}, 'endpoint'],
    ['lens', { ...fill, lens: OTHER }, {}, 'endpoint'],
    ['token', { ...fill, token: OTHER }, {}, 'launch'],
    ['an unlisted factory', { ...fill, factory: OTHER }, {}, 'factory'],
    ['a hidden factory', { ...fill, factory: HIDDEN }, {}, 'factory'],
    ['a malformed factory', { ...fill, factory: LISTED.slice(0, 41) }, {}, 'factory'],
    ['a factory with junk after it', { ...fill, factory: LISTED + 'x' }, {}, 'factory'],
    // WRITTEN OTHER THAN app.js READS IT: the page would read the raw value,
    // which is no factory of the site's (isAddr refuses "0X", and a space is
    // not part of an address).
    ['a listed factory with an upper-case 0X', { ...fill, factory: '0X' + LISTED.slice(2).toUpperCase() }, {}, 'factory'],
    ['a listed factory with a space before it', { ...fill, factory: ' ' + LISTED }, {}, 'factory'],
    ['a listed factory with a space after it', { ...fill, factory: LISTED + ' ' }, {}, 'factory'],
    ['a listed factory with a tab after it', { ...fill, factory: LISTED + '\t' }, {}, 'factory'],
    ['off production', fill, { production: false }, 'production'],
    ['a token page', fill, { tokenView: true }, 'tokenView'],
    ['no form', fill, { formThere: false }, 'tokenView'],
    ['another pair saved', { ...fill, factory: LISTED }, { readsSitePair: false }, 'saved'],
  ];
  for (const [what, link, over, why] of cases) {
    const r = parse(link, over);
    assert.equal(r.blocked, why, what);
    assert.deepEqual({ ...r.values }, {}, what);
    assert.deepEqual([...r.filled], [], what);
  }
  // EACH GIVES ITS OWN SENTENCE, and the two silent ones none.
  const said = (link: Record<string, string>, over: Partial<typeof PAGE> = {}) => P.notice(parse(link, over), { ...PAGE, ...over }).join(' ');
  assert.match(said({ ...fill, rpc: 'https://other.example' }), /names where to read the chain, so nothing from it was filled in/);
  assert.match(said({ ...fill, factory: OTHER }), /names a factory this site does not offer, so nothing from it was filled in/);
  assert.match(said({ ...fill, token: OTHER }), /names a launch, so nothing from it was filled in/);
  assert.match(said({ ...fill, factory: LISTED }, { readsSitePair: false }), /reads another endpoint or lens saved in this browser/);
  assert.equal(said({ ...fill, creatorWallet: OTHER }, { production: false }), '');
  assert.equal(said({ ...fill, creatorWallet: OTHER }, { tokenView: true }), '');
  // THE SITE'S OWN LINKS ARE NOT PREFILLED LINKS: a link that tries to fill
  // nothing is not told that nothing was filled.
  assert.equal(said({ rpc: 'https://other.example', lens: OTHER }), '');
  assert.equal(said({ factory: OTHER }), '');
  // A NEVER KEY IS SAID EVEN WHEN NOTHING IS FILLED: it is the sign of a phishing link.
  assert.match(said({ ...fill, rpc: 'https://other.example', devBuy: '1' }), /tried to set the dev buy/);
});

test('the notice says what was filled and what was not, by rule, and never echoes a value', () => {
  const link = { factory: LISTED, name: 'Moon Cat', symbol: 'M CAT', tax: '2.5', earn: 'Holders', creatorWallet: OTHER, dev_buy: '1', SLIP: '50', desc: 'Qzx desc', image: 'x' };
  const r = parse(link);
  const lines: string[] = [...P.notice(r, PAGE)];
  assert.deepEqual(lines, [
    'Filled in from a link: the paired asset, the name and the creator tax. Check every field before you create. A launch cannot be changed afterwards.',
    'The link\'s symbol was not used: it must be 1 to 10 letters or digits.',
    'The link\'s choice of who earns the tax was not used: it must be you or holders.',
    'This link also tried to set the creator wallet, the dev buy and slippage. A link can never set those, so they were ignored. Be careful with whoever sent it.',
    'A link does not fill the description, the links or the image. Add them yourself if you want them.',
  ]);
  const text = lines.join(' ');
  for (const v of ['Moon Cat', 'M CAT', 'Holders', OTHER, '50', 'Qzx desc']) assert.ok(!text.includes(v), `the notice echoes ${v}`);
  assert.deepEqual([...P.notice(parse({ name: 'A' }), PAGE)], ['Filled in from a link: the name. Check every field before you create. A launch cannot be changed afterwards.']);
  assert.match(P.notice(parse({ tax: '9' }), PAGE).join(' '), /must be a percent from 1 to 5, with at most 2 decimals/);
  const nameRule = 'The link\'s name was not used: it must be 1 to 32 Latin letters (A to Z, accents allowed), digits 0 to 9, ' +
    'spaces or . , \' - & ! ? ( ) + #, with no space at either end and nothing that looks like a web address. You can still ' +
    'type any name in the form yourself.';
  for (const name of ['<b>', 'evil.com', 'evil dot com', '\u{13df}urb']) {
    assert.deepEqual([...P.notice(parse({ name }), PAGE)], [nameRule], name);
  }
  assert.deepEqual([...P.notice(parse({}), PAGE)], []);
  // HOLDERS, CHOSEN BY A LINK, IS SAID ON ITS OWN LINE, right under what was
  // filled: it gives the creator's share to whoever holds the token, for good.
  const holders = 'This link chose Holders: if you keep that, your creator share is 0% for good and goes to whoever holds the ' +
    'token. Choose You to keep it.';
  assert.deepEqual([...P.notice(parse({ factory: LISTED, name: 'Moon', earn: 'holders' }), PAGE)], [
    'Filled in from a link: the paired asset, the name and who earns it. Check every field before you create. A launch cannot be changed afterwards.',
    holders,
  ]);
  assert.ok(!P.notice(parse({ name: 'Moon', earn: 'you' }), PAGE).includes(holders));
  assert.ok(!P.notice(parse({ name: 'Moon', earn: 'Holders' }), PAGE).includes(holders), 'a refused Holders is not said to be chosen');
  assert.ok(!P.notice(parse({ name: 'Moon', earn: 'holders' }, { readsSitePair: false }), PAGE).includes(holders), 'nothing filled, nothing chosen');
  assert.match(P.notice(parse({ to: OTHER }), PAGE).join(' '), /tried to set the creator wallet\. A link can never set that, so it was ignored/);
});

test('U7: parse never throws, on 2,000 random Unicode strings in every position', () => {
  const r = rng(7);
  const ch = () => String.fromCodePoint(Math.floor(r() < 0.7 ? r() * 0x80 : r() < 0.9 ? r() * 0x3000 : r() * 0x10ffff) & 0x10ffff);
  const str = (n: number) => Array.from({ length: n }, () => {
    const c = ch();
    return /[\ud800-\udfff]/.test(c) ? 'x' : c;
  }).join('');
  for (let i = 0; i < 2000; i++) {
    const s = str(Math.floor(r() * 60));
    for (const link of [s, { name: s }, { symbol: s }, { tax: s }, { earn: s }, { factory: s }, { [s]: s }]) {
      const res = parse(link as any);
      assert.ok(res && typeof res === 'object');
      P.notice(res, PAGE);
      for (const k of Object.keys(res.values)) assert.ok(['name', 'symbol', 'tax', 'earn'].includes(k));
    }
  }
});

test('U8: halfLink gives today\'s answer in every case but one: in production, a listed, not hidden factory named once as written and no endpoint or lens, on the site\'s own pair', () => {
  const today = (o: any) => !o.restatesSaved && ((o.namesWhat && !o.rpcNamed) || (o.rpcNamed && !o.namesWhat));
  // EVERY ?factory= VALUE, as app.js loadCfg passes them (q.getAll).
  const factories: [string, string[]][] = [['none', []], ['listed', [LISTED]], ['listed, upper-case hex', ['0x' + 'AB'.repeat(20)]],
    ['unlisted', [OTHER]], ['hidden', [HIDDEN]], ['malformed', [LISTED.slice(0, 30)]],
    ['upper-case 0X', ['0X' + LISTED.slice(2)]], ['a space around it', [' ' + LISTED + ' ']],
    ['listed, twice', [LISTED, LISTED]], ['listed, then unlisted', [LISTED, OTHER]]];
  let exceptions = 0, cases = 0;
  for (const production of [false, true]) for (const rpcNamed of [false, true]) for (const lensNamed of [false, true])
    for (const [fname, named] of factories) for (const restatesSaved of [false, true]) for (const readsSitePair of [false, true]) {
      // AS loadCfg TELLS IT: the first value names a contract.
      const namesWhat = !!named[0] || lensNamed;
      const o = { production, restatesSaved, namesWhat, rpcNamed, lensNamed, factories: named, siteFactories: [LISTED, HIDDEN], hiddenFactories: [HIDDEN], readsSitePair };
      const got = P.halfLink(o);
      const exception = production && !rpcNamed && !lensNamed && (fname === 'listed' || fname === 'listed, upper-case hex') && !restatesSaved && readsSitePair;
      cases++;
      if (exception) {
        exceptions++;
        assert.equal(got, false, `a whole link: ${JSON.stringify(o)}`);
        assert.equal(today(o), true, 'the exception is a case today calls half');
      } else {
        assert.equal(got, today(o), `today's answer: ${JSON.stringify(o)}`);
      }
    }
  assert.equal(cases, 2 * 2 * 2 * 10 * 2 * 2);
  assert.equal(exceptions, 2);
  // NO LIST AT ALL (an old caller): no exception.
  assert.equal(P.halfLink({ production: true, restatesSaved: false, namesWhat: true, rpcNamed: false, lensNamed: false, factory: LISTED,
    siteFactories: [LISTED], hiddenFactories: [], readsSitePair: true }), true);
});
