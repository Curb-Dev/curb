// The deployment files hold rules too: the image (non-root, tini, the
// healthcheck, a pinned base), the compose file (read-only, no privileges,
// the keys only where they belong, separate data volumes) and the two
// GitHub workflows (main only, never on pull requests, pinned actions, one
// run at a time, environment-scoped secrets, the verifier without keys).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const REPO = join(ROOT, '..', '..');
const wf = (name: string) => readFileSync(join(REPO, '.github', 'workflows', name), 'utf8');

/** Every secret file the service reads (secrets.ts, docker-compose.yml, RUNBOOK 8.2). */
const SECRET_FILES = ['publisher_key', 'pusher_key', 'guardian_key', 'rpc_urls', 'verifier_rpc_urls', 'data_repo_token', 'pin_tokens', 'alert_webhooks'];

function git(args: string[]): { status: number | null; out: string } | null {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  if (r.error) return null; // no git here (not a checkout): nothing to hold
  return { status: r.status, out: r.stdout };
}

test('secrets are never committed: secrets/ and every secret file name are ignored, and none is tracked', (t) => {
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top || top.status !== 0) return t.skip('not a git checkout');
  // the runbook's own layout, and the same folder anywhere else
  for (const p of ['services/sharer/secrets/publisher_key', 'services/sharer/secrets/rpc_urls', 'secrets/pin_tokens', 'services/sharer/deploy/secrets/x']) {
    assert.equal(git(['check-ignore', '-q', '--no-index', p])!.status, 0, `${p} is not ignored`);
  }
  for (const f of SECRET_FILES) assert.equal(git(['check-ignore', '-q', '--no-index', `services/sharer/${f}`])!.status, 0, `a loose ${f} is not ignored`);
  const tracked = git(['ls-files', '-z'])!.out.split('\0').filter(Boolean);
  const bad = tracked.filter((p) => /(^|\/)secrets\//.test(p) || SECRET_FILES.includes(p.split('/').at(-1)!));
  assert.deepEqual(bad, [], 'tracked secret paths');
});

/** The text of one top-level compose service (until the next service). */
function service(compose: string, name: string): string {
  const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z]+:\\n|\\n[a-z]+:\\n|$)`).exec(compose);
  assert.ok(m, `no service ${name}`);
  return m![1];
}

test('the image: a digest-pinned node:22-alpine, the unprivileged user, tini, /data, the healthcheck', () => {
  const d = read('Dockerfile');
  assert.match(d, /^ARG NODE_IMAGE=node:22-alpine@sha256:[0-9a-f]{64}$/m);
  assert.match(d, /^USER node$/m);
  assert.match(d, /^ENTRYPOINT \["\/sbin\/tini", "--", "node", "\/app\/src\/cli\.ts"\]$/m);
  assert.match(d, /^VOLUME \/data$/m);
  assert.match(d, /^HEALTHCHECK [^\n]*\\\n\s+CMD \["node", "\/app\/bin\/healthcheck\.mjs"\]/m);
  assert.match(d, /npm ci --omit=dev --ignore-scripts/);
  assert.ok(!/COPY \.\s/.test(d), 'never the whole context (no tests, no secrets folder)');
  const ign = read('.dockerignore');
  for (const x of ['secrets', 'test', 'node_modules', 'deploy']) assert.match(ign, new RegExp(`^${x}$`, 'm'));
});

test('compose: read-only, no new privileges, all capabilities dropped; keys only in the keeper; one data volume each', () => {
  const c = read('docker-compose.yml');
  const anchor = /x-sharer: &sharer\n([\s\S]*?)\nservices:/.exec(c)![1];
  assert.match(anchor, /read_only: true/);
  assert.match(anchor, /no-new-privileges:true/);
  assert.match(anchor, /cap_drop:\n\s+- ALL/);
  assert.match(anchor, /restart: unless-stopped/);
  assert.match(anchor, /max-size/);
  const keeper = service(c, 'keeper');
  const verifier = service(c, 'verifier');
  assert.match(keeper, /command: \["keeper", "--loop", "--interval=300"\]/);
  assert.match(keeper, /- publisher_key/);
  assert.match(keeper, /- pusher_key/);
  assert.match(verifier, /command: \["verify", "--loop"/);
  assert.ok(!/_key/.test(verifier), 'the verifier holds no key');
  assert.match(verifier, /source: verifier_rpc_urls\n\s+target: rpc_urls/, 'the verifier reads other providers');
  assert.match(keeper, /- keeper-data:\/data/);
  assert.match(verifier, /- verifier-data:\/data/);
  assert.ok(!/guardian/.test(c.replace(/^#.*$/gm, '')), 'the guardian is not run next to the keeper');
  assert.match(service(c, 'ipfs'), /profiles: \["ipfs"\]/);
  assert.match(service(c, 'ipfs'), /image: ipfs\/kubo:v[0-9.]+@sha256:[0-9a-f]{64}/);
});

for (const name of ['sharing-keeper.yml', 'sharing-verify.yml']) {
  test(`${name}: scheduled and manual only, default branch only, pinned actions, one at a time, 20 minutes, read-only token`, () => {
    const y = wf(name).replace(/^\s*#.*$/gm, ''); // the rules, not the comments
    const on =/\non:\n([\s\S]*?)\n\S/.exec(y)![1];
    assert.ok(!/pull_request/.test(y), 'never on a pull request');
    assert.ok(!/\bpush:/.test(on) && !/workflow_run|issue|repository_dispatch/.test(on), 'no other trigger');
    assert.match(on, /schedule:\n\s+- cron:/);
    assert.match(on, /workflow_dispatch/);
    assert.match(y, /\npermissions:\n\s+contents: read\n\n/);
    assert.match(y, /\nconcurrency:\n\s+group: sharing-(keeper|verify)\n\s+cancel-in-progress: false/);
    // the repository's default branch, never a branch name written down: a
    // master-default repository skipped every run of `refs/heads/main`
    const cond = /\n    if: (.+)\n/.exec(y)?.[1];
    assert.equal(cond, "github.event_name == 'schedule' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)", 'the job condition');
    assert.ok(!/refs\/heads\/(main|master)/.test(y), 'no branch name is hard-coded');
    assert.match(y, /timeout-minutes: 20/);
    const uses = [...y.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length >= 4);
    for (const u of uses) assert.match(u, /^actions\/[a-z-]+(\/(restore|save))?@[0-9a-f]{40}$/, `${u} is pinned to a commit`);
    assert.match(y, /persist-credentials: false/);
    assert.ok(!/secrets\.\w+/.test(y.split('steps:')[0]), 'no secret outside a step');
    // GitHub refuses the whole file at startup when a job's env names the
    // runner context ("Unrecognized named-value: 'runner'"): the first run of
    // both, 17 October 2026, never started. A step sets /data instead.
    assert.ok(!/\$\{\{\s*runner\./.test(y.split('steps:')[0]), 'no runner context outside a step');
    assert.match(y, /\n\s+run: echo "CURB_SHARER_DATA=\$RUNNER_TEMP\/sharer-data" >> "\$GITHUB_ENV"\n/, 'a step says where /data lives');
  });

  test(`${name}: /data is restored first and SAVED EVEN WHEN THE RUN FAILS`, () => {
    const y = wf(name).replace(/^\s*#.*$/gm, '');
    assert.ok(!/uses: actions\/cache@/.test(y), 'not the combined action: it saves only after a job that succeeded');
    const steps = y.split(/\n      - /).slice(1);
    const restore = steps.findIndex((s) => /uses: actions\/cache\/restore@/.test(s));
    const save = steps.findIndex((s) => /uses: actions\/cache\/save@/.test(s));
    const run = steps.findIndex((s) => /run: node src\/cli\.ts (keeper|verify) --once/.test(s));
    assert.ok(restore >= 0 && save >= 0 && run >= 0, 'restore, the tick and save are all there');
    assert.ok(restore < run && run < save, 'restore before the tick, save after it');
    assert.match(steps[save], /\n\s+if: always\(\)\n/, 'the save runs whether or not the tick failed');
    const key = (s: string) => /\n\s+key: (.+)/.exec(s)?.[1];
    assert.equal(key(steps[save]), key(steps[restore]), 'saved under the key the next run restores from');
    assert.match(key(steps[save])!, /-\$\{\{ github\.run_id \}\}$/, 'a fresh key per run (a cache entry is never overwritten)');
    assert.match(steps[restore], /restore-keys: \|\n\s+sharing-(keeper|verify)-data-\n/);
    assert.equal(/\n\s+path: (.+)/.exec(steps[save])?.[1], '${{ runner.temp }}/sharer-data');
  });
}

test('the keeper workflow: the sharing-mainnet environment, the standby flag, the keys from secrets', () => {
  const y = wf('sharing-keeper.yml');
  assert.match(y, /environment: sharing-mainnet/);
  assert.match(y, /run: node src\/cli\.ts keeper --once --standby/);
  assert.match(y, /CURB_SHARER_PUBLISHER_KEY: \$\{\{ secrets\.SHARING_PUBLISHER_KEY \}\}/);
  assert.match(y, /CURB_SHARER_PUSHER_KEY: \$\{\{ secrets\.SHARING_STANDBY_PUSHER_KEY \}\}/);
  assert.match(y, /npm ci --omit=dev --ignore-scripts/);
});

test("the repository's test gate runs the keeper's suite from the lockfile, and stops when it fails", () => {
  const sh = readFileSync(join(REPO, 'script', 'b20', 'test-all.sh'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.match(sh, /\(cd services\/sharer && npm ci [^\n&]*&& npm run check\) \\\n\s+\|\| die /, 'npm ci, then npm run check, or the gate dies');
  assert.ok(sh.indexOf('npm run check') < sh.indexOf('base-forge test'), 'before the forge suites (it needs no node)');
});

test('the verify workflow: its own environment, no key, verify --once', () => {
  const y = wf('sharing-verify.yml');
  assert.match(y, /environment: sharing-verify/);
  assert.match(y, /run: node src\/cli\.ts verify --once/);
  assert.ok(!/_KEY\b/.test(y), 'no key of any kind');
});
