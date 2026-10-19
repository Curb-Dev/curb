// Public CURB product-event announcements.
//
// The state machine is deliberately separate from the chain reader and from
// Telegram. Before a public message is attempted, the event and its semantic
// delivery items are saved as `pending`. The cursor advances only after every
// item for that event was accepted by Telegram. A retry therefore re-renders
// the unsent item from current launch state instead of trusting stored HTML or
// re-applying the chain event.

export const ANNOUNCER_SCHEMA = 'curb.announcer/1';
export const END_OF_BLOCK = Number.MAX_SAFE_INTEGER;

export interface Position {
  block: number;
  logIndex: number;
}

export interface LaunchRecord {
  token: string;
  curve: string;
  factory: string;
  name: string;
  symbol: string;
  quoteSymbol: string;
  totalTaxBps: number;
  threshold: string;
  reserve: string;
  crossed50: boolean;
  crossed90: boolean;
  graduated: boolean;
  hidden: boolean;
}

export type ChainEvent =
  | { kind: 'registered'; position: Position; transactionHash: string; launch: LaunchRecord }
  | { kind: 'launch'; position: Position; transactionHash: string; launch: LaunchRecord }
  | { kind: 'buy'; position: Position; transactionHash: string; token: string; quoteIn: string; fee: string; tax: string }
  | { kind: 'sell'; position: Position; transactionHash: string; token: string; quoteOut: string; fee: string; tax: string }
  | { kind: 'graduated'; position: Position; transactionHash: string; token: string };

export interface PendingDelivery {
  position: Position;
  items: PendingItem[];
  next: number;
}

export type PendingItem =
  | { token: string; kind: 'launch' }
  | { token: string; kind: 'progress'; mark: 50 | 90 }
  | { token: string; kind: 'graduated' };

export interface AnnouncerState {
  schema: typeof ANNOUNCER_SCHEMA;
  chainId: number;
  cursor: Position;
  launches: Record<string, LaunchRecord>;
  pending?: PendingDelivery;
}

export interface ProcessDeps {
  dryRun: boolean;
  siteBase: string;
  log(line: string): void;
  send(message: string): Promise<void>;
  persist(state: AnnouncerState): Promise<void>;
}

export const MAX_MESSAGES_PER_RUN = 20;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const amount = (x: unknown): x is string => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
const pos = (x: unknown): x is Position => !!x && typeof x === 'object' && Number.isSafeInteger((x as Position).block) &&
  (x as Position).block >= 0 && Number.isSafeInteger((x as Position).logIndex) && (x as Position).logIndex >= 0;

function pendingItem(x: unknown, launches: Record<string, LaunchRecord>): x is PendingItem {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const item = x as Record<string, unknown>;
  if (typeof item.token !== 'string' || !ADDRESS.test(item.token) || item.token !== item.token.toLowerCase() || !launches[item.token]) return false;
  if (item.kind === 'progress') {
    return (item.mark === 50 || item.mark === 90) && Object.keys(item).length === 3;
  }
  return (item.kind === 'launch' || item.kind === 'graduated') && item.mark === undefined && Object.keys(item).length === 2;
}

export function parseAnnouncerState(bytes: Uint8Array | null, chainId: number): AnnouncerState | null {
  if (!bytes) return null;
  try {
    const j = JSON.parse(Buffer.from(bytes).toString('utf8')) as AnnouncerState;
    if (!j || j.schema !== ANNOUNCER_SCHEMA || j.chainId !== chainId || !pos(j.cursor) || !j.launches || typeof j.launches !== 'object') return null;
    const launches: Record<string, LaunchRecord> = {};
    for (const [token, l] of Object.entries(j.launches)) {
      if (!ADDRESS.test(token) || !l || l.token !== token || !ADDRESS.test(l.curve) ||
        !(l.factory === '' || ADDRESS.test(l.factory)) || typeof l.name !== 'string' || typeof l.symbol !== 'string' ||
        typeof l.quoteSymbol !== 'string' || !Number.isSafeInteger(l.totalTaxBps) || l.totalTaxBps < 0 || l.totalTaxBps > 10_000 ||
        !amount(l.threshold) || !amount(l.reserve) || typeof l.crossed50 !== 'boolean' || typeof l.crossed90 !== 'boolean' ||
        typeof l.graduated !== 'boolean' || typeof l.hidden !== 'boolean') return null;
      launches[token] = { ...l };
    }
    let pending: PendingDelivery | undefined;
    if (j.pending !== undefined) {
      if (!j.pending || !pos(j.pending.position) || !Array.isArray(j.pending.items) ||
        j.pending.items.some((item) => !pendingItem(item, launches)) || !Number.isSafeInteger(j.pending.next) ||
        j.pending.next < 0 || j.pending.next > j.pending.items.length) return null;
      pending = { position: { ...j.pending.position }, items: j.pending.items.map((item) => ({ ...item })), next: j.pending.next };
    }
    return { schema: ANNOUNCER_SCHEMA, chainId, cursor: { ...j.cursor }, launches, ...(pending ? { pending } : {}) };
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function clip(value: string, length: number): string {
  return Array.from(value).slice(0, length).join('');
}

function publicField(value: string, length: number): string {
  const clean = value
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return escapeHtml(clip(clean, length));
}

const pct = (reserve: bigint, threshold: bigint): string => {
  if (threshold === 0n) return '0.00';
  const hundredths = reserve * 10_000n / threshold;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
};

const tax = (bps: number): string => bps % 100 === 0 ? `${bps / 100}%` : `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0').replace(/0+$/, '')}%`;

function links(siteBase: string, token: string): string {
  const base = siteBase.replace(/\/+$/, '');
  return `<a href="${base}/token/${token}">Open market</a> · <a href="https://basescan.org/token/${token}">Basescan</a>`;
}

export function launchMessage(siteBase: string, l: LaunchRecord): string {
  const name = publicField(l.name, 40);
  const symbol = publicField(l.symbol, 20);
  const quote = publicField(l.quoteSymbol, 20);
  return `🚀 <b>New CURB launch</b>\n\n<code>${name}</code> (<code>${symbol}</code>)\nTax: <b>${tax(l.totalTaxBps)}</b>\nPaired asset: <code>${quote}</code>\n\n${links(siteBase, l.token)}`;
}

export function progressMessage(siteBase: string, l: LaunchRecord, mark: 50 | 90): string {
  const name = publicField(l.name, 40);
  const symbol = publicField(l.symbol, 20);
  const reserve = BigInt(l.reserve), threshold = BigInt(l.threshold);
  return `📈 <code>${name}</code> (<code>${symbol}</code>) crossed <b>${mark}%</b> of its graduation threshold.\nProgress: <b>${pct(reserve, threshold)}%</b>\n\n${links(siteBase, l.token)}`;
}

export function graduationMessage(siteBase: string, l: LaunchRecord): string {
  const name = publicField(l.name, 40);
  const symbol = publicField(l.symbol, 20);
  return `🎓 <code>${name}</code> (<code>${symbol}</code>) graduated.\nLiquidity is locked.\n\n${links(siteBase, l.token)}`;
}

function renderPending(siteBase: string, item: PendingItem, l: LaunchRecord): string {
  if (item.kind === 'launch') return launchMessage(siteBase, l);
  if (item.kind === 'progress') return progressMessage(siteBase, l, item.mark);
  return graduationMessage(siteBase, l);
}

export function comparePosition(a: Position, b: Position): number {
  return a.block === b.block ? a.logIndex - b.logIndex : a.block - b.block;
}

function cloneState(s: AnnouncerState): AnnouncerState {
  return JSON.parse(JSON.stringify(s)) as AnnouncerState;
}

/** Applies ordered chain events. `finalPosition` says the complete safe range
 * even when it contained no relevant event. */
export async function processEvents(
  initial: AnnouncerState,
  events: ChainEvent[],
  finalPosition: Position,
  d: ProcessDeps,
): Promise<AnnouncerState> {
  const state = cloneState(initial);
  const save = async (): Promise<void> => { if (!d.dryRun) await d.persist(state); };
  let messagesSent = 0;

  const finishPending = async (): Promise<boolean> => {
    const p = state.pending;
    if (!p) return true;
    while (p.next < p.items.length) {
      const item = p.items[p.next];
      const l = state.launches[item.token];
      if (!l) throw new Error(`pending delivery for unknown launch ${item.token}`);
      if (l.hidden) {
        p.next++;
        await save();
        continue;
      }
      if (!d.dryRun && messagesSent >= MAX_MESSAGES_PER_RUN) return false;
      const message = renderPending(d.siteBase, item, l);
      if (d.dryRun) d.log(`DRY RUN Telegram @CurbAnnouncements:\n${message}`);
      else await d.send(message);
      if (!d.dryRun) messagesSent++;
      p.next++;
      await save();
    }
    state.cursor = { ...p.position };
    delete state.pending;
    await save();
    return true;
  };

  // A previous process stopped after recording the event, or between two
  // messages produced by one event. Resume it before reading beyond it.
  if (!await finishPending()) return state;

  for (const e of [...events].sort((a, b) => comparePosition(a.position, b.position))) {
    if (comparePosition(e.position, state.cursor) <= 0) continue;
    const items: PendingItem[] = [];
    const token = (e.kind === 'registered' || e.kind === 'launch' ? e.launch.token : e.token).toLowerCase();

    if (e.kind === 'registered') {
      if (!state.launches[token]) {
        state.launches[token] = { ...e.launch, token };
        // Registration precedes an optional dev buy. Announcing here keeps a
        // same-transaction 50%/90% crossing and graduation in human order.
        // Factory metadata has already been joined by the scanner from that
        // transaction's later LaunchCreated log.
        if (!state.launches[token].hidden) items.push({ token, kind: 'launch' });
      }
    } else if (e.kind === 'launch') {
      const before = state.launches[token];
      state.launches[token] = {
        ...e.launch,
        token,
        reserve: before?.reserve ?? e.launch.reserve,
        crossed50: before?.crossed50 ?? e.launch.crossed50,
        crossed90: before?.crossed90 ?? e.launch.crossed90,
        graduated: before?.graduated ?? e.launch.graduated,
      };
      // LaunchCreated is the authoritative factory/tax metadata source. The
      // public message was queued at the earlier registry log so an optional
      // dev buy cannot make progress/graduation appear before the launch.
    } else {
      const l = state.launches[token];
      if (!l) {
        // A registry/factory outside the configured deployment cannot move
        // the cursor silently; it is an incomplete event set, not a launch to
        // guess about.
        throw new Error(`event for unknown launch ${token} at ${e.position.block}:${e.position.logIndex}`);
      }
      if (e.kind === 'buy') {
        const delta = BigInt(e.quoteIn) - BigInt(e.fee) - BigInt(e.tax);
        if (delta < 0n) throw new Error(`buy fees exceed input for ${token}`);
        l.reserve = (BigInt(l.reserve) + delta).toString();
        const threshold = BigInt(l.threshold), reserve = BigInt(l.reserve);
        if (threshold > 0n && !l.crossed50 && reserve * 100n >= threshold * 50n) {
          l.crossed50 = true;
          if (!l.hidden) items.push({ token, kind: 'progress', mark: 50 });
        }
        if (threshold > 0n && !l.crossed90 && reserve * 100n >= threshold * 90n) {
          l.crossed90 = true;
          if (!l.hidden) items.push({ token, kind: 'progress', mark: 90 });
        }
      } else if (e.kind === 'sell') {
        const delta = BigInt(e.quoteOut) + BigInt(e.fee) + BigInt(e.tax);
        const reserve = BigInt(l.reserve);
        if (delta > reserve) throw new Error(`sell exceeds tracked reserve for ${token}`);
        l.reserve = (reserve - delta).toString();
      } else {
        if (!l.graduated) {
          l.graduated = true;
          if (!l.hidden) items.push({ token, kind: 'graduated' });
        }
      }
    }

    if (items.length) {
      state.pending = { position: { ...e.position }, items, next: 0 };
      await save();
      if (!await finishPending()) return state;
    } else {
      state.cursor = { ...e.position };
    }
  }

  if (comparePosition(finalPosition, state.cursor) > 0) state.cursor = { ...finalPosition };
  await save();
  return state;
}

export interface TelegramConfig {
  token: string;
  chatId: '@CurbAnnouncements';
}

/** Exact destination validation is a safety boundary, not a default. */
export function parseTelegramConfig(raw: string | undefined): TelegramConfig | null {
  if (!raw || !raw.trim()) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new Error('ANNOUNCER_TELEGRAM is not valid JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('ANNOUNCER_TELEGRAM must be a JSON object');
  const o = j as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'token' && k !== 'chatId');
  if (extra.length) throw new Error(`ANNOUNCER_TELEGRAM has unexpected key(s): ${extra.join(', ')}`);
  if (typeof o.token !== 'string' || !/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(o.token)) {
    throw new Error('ANNOUNCER_TELEGRAM.token is not a Telegram bot token');
  }
  if (o.chatId !== '@CurbAnnouncements') {
    throw new Error('ANNOUNCER_TELEGRAM.chatId must be exactly @CurbAnnouncements');
  }
  return { token: o.token, chatId: '@CurbAnnouncements' };
}

export interface TelegramSenderOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class TelegramSender {
  private readonly config: TelegramConfig;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastSentAt = -Infinity;

  constructor(config: TelegramConfig, opts: TelegramSenderOptions = {}) {
    this.config = config;
    this.fetcher = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  async send(text: string): Promise<void> {
    const wait = 3_000 - (this.now() - this.lastSentAt);
    if (wait > 0) await this.sleep(wait);
    for (let tries = 0; tries < 6; tries++) {
      let res: Response;
      try {
        res = await this.fetcher(`https://api.telegram.org/bot${this.config.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.config.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).split(this.config.token).join('[secret]');
        throw new Error(`Telegram request failed: ${message}`);
      }
      let body: any = null;
      try { body = await res.json(); } catch { /* handled below */ }
      if (res.status === 429) {
        const seconds = Number(body?.parameters?.retry_after);
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Telegram rate limit response has no retry_after');
        if (seconds > 60) throw new Error('Telegram retry_after exceeds 60 seconds');
        await this.sleep(Math.ceil(seconds * 1000));
        continue;
      }
      if (!res.ok || body?.ok !== true) {
        const description = typeof body?.description === 'string' ? body.description.slice(0, 200) : `HTTP ${res.status}`;
        throw new Error(`Telegram refused the announcement: ${description}`);
      }
      this.lastSentAt = this.now();
      return;
    }
    throw new Error('Telegram kept rate-limiting the announcement');
  }
}
