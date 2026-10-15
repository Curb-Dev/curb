// Secrets: read only from Docker secrets (/run/secrets/<name>) or from the
// environment (CURB_SHARER_<NAME>, or CURB_SHARER_<NAME>_FILE naming a file),
// never from the config file, and never written anywhere.
//
// A Secret is a box. Its value comes out only through reveal(); printing it,
// JSON-encoding it or interpolating it into a string gives "[secret]". Every
// value read is also registered with the redactor, so a message that carries
// one by accident - an error from a library that quoted a URL with an API key
// in it, say - is scrubbed before it reaches a log line or an alert.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SECRET_VALUES = new Set<string>();

/** Registers a value the redactor must scrub (and the longer pieces of it). */
export function registerSecret(value: string): void {
  const v = value.trim();
  if (v.length < 6) return; // too short to scrub safely; such a value is refused below anyway
  SECRET_VALUES.add(v);
  // A private key also appears without its 0x, and a URL with its key path.
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) SECRET_VALUES.add(v.slice(2));
}

/** Replaces every registered secret, and every credential-looking part of a
 *  URL, in `text`. */
export function redact(text: string): string {
  let out = text;
  for (const s of [...SECRET_VALUES].sort((a, b) => b.length - a.length)) {
    if (out.includes(s)) out = out.split(s).join('[secret]');
  }
  // user:password@ in URLs, and bearer tokens that slipped into a message
  out = out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[secret]@');
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[secret]');
  // a Telegram bot token in an API path
  out = out.replace(/\/bot\d+:[A-Za-z0-9_-]{20,}/g, '/bot[secret]');
  return out;
}

export class Secret {
  readonly name: string;
  #value: string;
  constructor(name: string, value: string) {
    this.name = name;
    this.#value = value;
    registerSecret(value);
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[secret]';
  }
  toJSON(): string {
    return '[secret]';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Secret(${this.name})`;
  }
}

export interface SecretSource {
  /** Where Docker mounts secrets; CURB_SHARER_SECRETS_DIR overrides it. */
  dir?: string;
  env?: Record<string, string | undefined>;
}

export class SecretError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SecretError';
  }
}

const envName = (name: string): string => 'CURB_SHARER_' + name.toUpperCase();

/** Reads one secret, or null when it is not provided anywhere. The file wins
 *  over the environment; an empty value counts as not provided. */
export function readSecret(name: string, src: SecretSource = {}): Secret | null {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new SecretError(`bad secret name ${name}`);
  const env = src.env ?? process.env;
  const dir = src.dir ?? env.CURB_SHARER_SECRETS_DIR ?? '/run/secrets';
  const candidates: string[] = [];
  const fileVar = env[envName(name) + '_FILE'];
  if (fileVar) candidates.push(fileVar);
  candidates.push(join(dir, name));
  for (const p of candidates) {
    if (!existsSync(p)) {
      if (p === fileVar) throw new SecretError(`${envName(name)}_FILE names a file that does not exist`);
      continue;
    }
    const v = readFileSync(p, 'utf8').trim();
    if (v) return new Secret(name, v);
  }
  const v = env[envName(name)]?.trim();
  if (v) return new Secret(name, v);
  return null;
}

/** A private key secret, checked for shape (never echoed in the error). */
export function readKey(name: string, src: SecretSource = {}): Secret | null {
  const s = readSecret(name, src);
  if (!s) return null;
  let v = s.reveal();
  if (/^[0-9a-fA-F]{64}$/.test(v)) v = '0x' + v;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new SecretError(`the secret ${name} is not a 32-byte hex private key`);
  return new Secret(name, v);
}

/** A JSON secret (rpc_urls, pin_tokens, alert_webhooks). */
export function readJsonSecret<T>(name: string, src: SecretSource = {}): T | null {
  const s = readSecret(name, src);
  if (!s) return null;
  try {
    const v = JSON.parse(s.reveal()) as T;
    // every string inside is secret material too (URLs carry keys)
    const walk = (x: unknown): void => {
      if (typeof x === 'string') registerSecret(x);
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    };
    walk(v);
    return v;
  } catch {
    throw new SecretError(`the secret ${name} is not valid JSON`);
  }
}

/** The RPC URLs: a JSON array, or one URL per line. They carry API keys, so
 *  they are secrets and are labelled a, b, c... in every message. */
export function readRpcUrls(name = 'rpc_urls', src: SecretSource = {}): Secret[] {
  const s = readSecret(name, src);
  if (!s) return [];
  const raw = s.reveal();
  let list: unknown;
  if (raw.startsWith('[')) {
    try {
      list = JSON.parse(raw);
    } catch {
      throw new SecretError(`the secret ${name} is not valid JSON`);
    }
  } else list = raw.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  if (!Array.isArray(list) || list.some((u) => typeof u !== 'string' || !/^https?:\/\//.test(u))) {
    throw new SecretError(`the secret ${name} must list http(s) URLs`);
  }
  return (list as string[]).map((u, i) => new Secret(`${name}[${i}]`, u));
}
