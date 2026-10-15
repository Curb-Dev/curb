// Alerts (design D.2.6 step 6, D.2.7, D.2.8): low ETH, a missing price, a
// veto, an RPC disagreement, a stalled distributor, income waiting in the
// core, a frozen factory, and every role or catalog change announced on chain
// (VetoerRemovalAnnounced, UnfreezeAnnounced, PublisherAnnounced,
// KeeperPayeeAnnounced, FactoryProposed, VetoerSet). A guardian alert carries
// ready-to-sign calldata for the Safe signers.
//
// Each alert has a key; the same key is not sent again within the cooldown
// (the record survives restarts in /data). Every alert is also a log line.
// A sink that fails is logged, never fatal: an alert can never stop the
// keeper from doing its job. A host with NO sink keeps every page in its own
// log, so `check` refuses that, and `alert-test` proves each sink by hand.
//
// Sinks (the alert_webhooks secret, JSON):
//   { "telegram": { "token": "<bot token>", "chatId": "<chat>" },
//     "discord":  "<webhook url>",
//     "webhook":  "<url>"  or { "url": "<url>", "bearer": "<token>" },
//     "email":    { "url": "https://api.resend.com/emails", "key": "<api key>",
//                   "from": "keeper@example.org", "to": ["a@example.org"] } }

import type { Logger } from './log.ts';
import { request, type HttpOptions } from './http.ts';
import { redact } from './secrets.ts';
import type { Store } from './store.ts';

export type Severity = 'info' | 'warn' | 'page';

export interface ReadyCall {
  /** What signing this does, in a sentence. */
  what: string;
  to: string;
  data: string;
}

export interface Alert {
  key: string;
  severity: Severity;
  title: string;
  text: string;
  distributor?: string;
  calls?: ReadyCall[];
}

export interface AlertSink {
  readonly name: string;
  send(a: Alert, rendered: string): Promise<void>;
}

export function render(a: Alert): string {
  const lines = [`[${a.severity.toUpperCase()}] ${a.title}`, a.text];
  if (a.distributor) lines.push(`distributor: ${a.distributor}`);
  for (const c of a.calls ?? []) lines.push('', `Ready to sign - ${c.what}`, `  to:    ${c.to}`, `  value: 0`, `  data:  ${c.data}`);
  return redact(lines.join('\n'));
}

export class TelegramSink implements AlertSink {
  readonly name = 'telegram';
  private readonly token: string;
  private readonly chatId: string;
  private readonly http: HttpOptions;
  constructor(token: string, chatId: string, http: HttpOptions = {}) {
    this.token = token;
    this.chatId = chatId;
    this.http = http;
  }
  async send(_a: Alert, text: string): Promise<void> {
    const res = await request(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }) }, this.http);
    if (!res.ok) throw new Error(`telegram answered ${res.status}`);
  }
}

export class DiscordSink implements AlertSink {
  readonly name = 'discord';
  private readonly url: string;
  private readonly http: HttpOptions;
  constructor(url: string, http: HttpOptions = {}) {
    this.url = url;
    this.http = http;
  }
  async send(_a: Alert, text: string): Promise<void> {
    const res = await request(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }) }, this.http);
    if (!res.ok) throw new Error(`discord answered ${res.status}`);
  }
}

export class WebhookSink implements AlertSink {
  readonly name = 'webhook';
  private readonly url: string;
  private readonly bearer: string | null;
  private readonly http: HttpOptions;
  constructor(url: string, bearer: string | null, http: HttpOptions = {}) {
    this.url = url;
    this.bearer = bearer;
    this.http = http;
  }
  async send(a: Alert, text: string): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const res = await request(this.url, { method: 'POST', headers, body: JSON.stringify({ ...a, text: redact(a.text), rendered: text }) }, this.http);
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
  }
}

export class EmailSink implements AlertSink {
  readonly name = 'email';
  private readonly o: { url: string; key: string; from: string; to: string[] };
  private readonly http: HttpOptions;
  constructor(o: { url: string; key: string; from: string; to: string[] }, http: HttpOptions = {}) {
    this.o = o;
    this.http = http;
  }
  async send(a: Alert, text: string): Promise<void> {
    const res = await request(this.o.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.key}` }, body: JSON.stringify({ from: this.o.from, to: this.o.to, subject: `[curb-sharer ${a.severity}] ${a.title}`.slice(0, 200), text }) }, this.http);
    if (!res.ok) throw new Error(`email API answered ${res.status}`);
  }
}

/** Builds the sinks from the alert_webhooks secret's JSON. */
export function makeSinks(raw: unknown, http: HttpOptions = {}): AlertSink[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('alert_webhooks must be a JSON object');
  const o = raw as Record<string, any>;
  const out: AlertSink[] = [];
  for (const k of Object.keys(o)) if (!['telegram', 'discord', 'webhook', 'email'].includes(k)) throw new Error(`alert_webhooks: unknown sink "${k}"`);
  if (o.telegram) {
    if (typeof o.telegram.token !== 'string' || (typeof o.telegram.chatId !== 'string' && typeof o.telegram.chatId !== 'number')) throw new Error('alert_webhooks.telegram needs token and chatId');
    out.push(new TelegramSink(o.telegram.token, String(o.telegram.chatId), http));
  }
  if (o.discord) {
    if (typeof o.discord !== 'string') throw new Error('alert_webhooks.discord must be the webhook URL');
    out.push(new DiscordSink(o.discord, http));
  }
  if (o.webhook) {
    const w = typeof o.webhook === 'string' ? { url: o.webhook, bearer: null } : o.webhook;
    if (typeof w.url !== 'string') throw new Error('alert_webhooks.webhook needs a url');
    out.push(new WebhookSink(w.url, typeof w.bearer === 'string' ? w.bearer : null, http));
  }
  if (o.email) {
    const e = o.email;
    if (typeof e.key !== 'string' || typeof e.from !== 'string' || !Array.isArray(e.to) || e.to.length === 0) throw new Error('alert_webhooks.email needs key, from and to');
    out.push(new EmailSink({ url: typeof e.url === 'string' ? e.url : 'https://api.resend.com/emails', key: e.key, from: e.from, to: e.to.map(String) }, http));
  }
  return out;
}

export interface AlerterOptions {
  sinks: AlertSink[];
  store: Store;
  log: Logger;
  cooldownSec: number;
  now?: () => number;
}

export class Alerter {
  private readonly o: AlerterOptions;
  private readonly now: () => number;
  /** Every alert raised in this process (tests and the status file read it). */
  readonly raised: Alert[] = [];

  constructor(o: AlerterOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** Sends `a` unless the same key went out within the cooldown. Returns
   *  whether it was sent. Never throws. */
  async raise(a: Alert, opts: { cooldownSec?: number } = {}): Promise<boolean> {
    const nowS = Math.floor(this.now() / 1000);
    const seen = this.o.store.get<Record<string, number>>('alertsSent', {});
    const last = seen[a.key];
    const cd = opts.cooldownSec ?? this.o.cooldownSec;
    const logFields = { alert: a.key, severity: a.severity, title: a.title, text: a.text, distributor: a.distributor, calls: a.calls };
    if (last !== undefined && nowS - last < cd) {
      this.o.log.debug('alert held back (cooldown)', logFields);
      return false;
    }
    this.raised.push(a);
    (a.severity === 'page' ? this.o.log.error : this.o.log.warn)('ALERT', logFields);
    seen[a.key] = nowS;
    // keep the record bounded: drop entries older than a week past cooldown
    for (const [k, t] of Object.entries(seen)) if (nowS - t > cd + 7 * 86400) delete seen[k];
    this.o.store.set('alertsSent', seen);
    await deliver(this.o.sinks, a, this.o.log);
    return true;
  }

  /** The sinks this host sends to (their names; `check` reports them). */
  get sinkNames(): string[] {
    return this.o.sinks.map((s) => s.name);
  }

  /** Sends `a` to every sink now, past any cooldown, and says what each did
   *  (`alert-test` and `check --probe`). */
  async test(a: Alert): Promise<Delivery[]> {
    this.o.log.info('test alert', { alert: a.key, sinks: this.sinkNames });
    return deliver(this.o.sinks, a, this.o.log);
  }
}

export interface Delivery {
  sink: string;
  ok: boolean;
  error?: string;
}

/** `a` to every sink in turn. A sink that fails is logged and reported, never
 *  thrown: one broken sink cannot keep an alert from the others. */
export async function deliver(sinks: AlertSink[], a: Alert, log: Logger): Promise<Delivery[]> {
  const text = render(a);
  const out: Delivery[] = [];
  for (const s of sinks) {
    try {
      await s.send(a, text);
      out.push({ sink: s.name, ok: true });
    } catch (e) {
      const error = redact((e as Error).message);
      log.warn('an alert sink failed', { sink: s.name, error });
      out.push({ sink: s.name, ok: false, error });
    }
  }
  return out;
}

/** The alert `alert-test` sends: it says which host it came from, so each
 *  host's sinks are proven one by one. Its key is unique, so no cooldown
 *  ever holds one back. */
export function testAlert(host: string, mode: string, at: Date, note?: string): Alert {
  return {
    key: `test:${host}:${at.getTime()}`,
    severity: 'info',
    title: `Test alert from ${host}`,
    text: `curb-sharer (${mode}) on ${host} sent this at ${at.toISOString()}. If you read it, this host's alerts reach you here.${note ? ` Note: ${note}` : ''}`,
  };
}
