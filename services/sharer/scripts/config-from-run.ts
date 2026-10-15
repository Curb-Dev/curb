// Fills the keeper's config from the deployment's own broadcast record, not by
// hand (gap item 38).
//
//   node scripts/config-from-run.ts --run ../../deployments/base-mainnet/run.json \
//     [--run <a later DeployAssetStack run>]... [--from deploy/sharer.example.json] \
//     [--out deploy/sharer.json] [--keeper-key 0x<pusher>]... [--bump]
//
// RUNBOOK part 7 had the graduator, its block, the factory, the catalog and
// every exclusion copied by hand from the DeployCurb output; a swapped address
// passed `check` and failed at the first epoch, and a missed exclusion can be
// fixed only through the stop-everything rules change. This reads them from
// the record forge wrote of what was actually sent (DEPLOY.txt STEP 5 commits
// it as deployments/base-mainnet/run.json):
//
//   sharing.graduator, sharing.graduatorFromBlock (its creation's block),
//   distributorFactory, catalog, registry, hook, lens, policyOwner (the
//   factory's owner argument), launchers (every CurbLaunchFactory created),
//   and the exclusions RUNBOOK 7 lists - each CurbLaunchFactory with its
//   FeeEscrow, FeePolicy and BuybackVault, the LaunchRegistry, the LaunchLens,
//   the owner Safe and the platform recipient - plus the publisher in
//   rules.keeperKeys (pushers with --keeper-key).
//
// It only ever ADDS to the exclusions and keeper keys. When the sharing block
// of a config that is already live (its graduator set) would change, it
// refuses unless --bump raises rules.version, and the change must then reach
// every host at once (RUNBOOK 7.1). The vetoers other than the owner Safe are
// printed, not excluded: which of them is Safe B is a person's call. `check`
// then reads every address back from the chain.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseOpsConfig, publicSharingConfig } from '../src/ops/config.ts';

type Json = Record<string, any>;

interface Tx {
  transactionType?: string;
  contractName?: string | null;
  contractAddress?: string | null;
  function?: string | null;
  arguments?: unknown[] | null;
  hash?: string;
}

export interface FromRunResult {
  config: Json;
  /** What was set or added, for the operator to read. */
  report: string[];
  /** Addresses a person must decide on. */
  decide: string[];
}

export class RunError extends Error {}

const ADDR = /0x[0-9a-fA-F]{40}/g;
const lc = (x: unknown): string => String(x).toLowerCase();
const addrsIn = (x: unknown): string[] => (String(x ?? '').match(ADDR) ?? []).map(lc);
/** forge names a contract "Name", "File.sol\\Name" or "path/File.sol:Name". */
const nameOf = (t: Tx): string => String(t.contractName ?? '').split(/[\\/:]/).pop()!;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The deployment's addresses, gathered over every run given. */
function gather(runs: Json[], chainId: string) {
  const one: Record<string, { address: string; args: unknown[]; block: bigint | null }> = {};
  const stacks: { factory: string; quote: string; escrow: string; policy: string; vault: string | null }[] = [];
  const escrows: { address: string; quote: string }[] = [];
  const policies: { address: string; escrow: string }[] = [];
  const vaults: { address: string; policy: string; escrow: string }[] = [];
  for (const run of runs) {
    if (run.chain !== undefined && String(run.chain) !== chainId) throw new RunError(`a run is for chain ${run.chain}, the config for chain ${chainId}`);
    const blockOf = (addr: string): bigint | null => {
      const rc = (run.receipts ?? []).find((r: Json) => lc(r.contractAddress) === addr);
      return rc && rc.blockNumber !== undefined ? BigInt(rc.blockNumber) : null;
    };
    for (const t of (run.transactions ?? []) as Tx[]) {
      if (t.transactionType !== 'CREATE' && t.transactionType !== 'CREATE2') continue;
      const name = nameOf(t);
      const address = lc(t.contractAddress);
      const args = t.arguments ?? [];
      if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
      if (['Graduator', 'HolderDistributorFactory', 'SharingCatalog', 'LaunchRegistry', 'FeeHook', 'LaunchLens'].includes(name)) {
        if (one[name] && one[name].address !== address) throw new RunError(`two ${name} contracts in the runs given (${one[name].address} and ${address}): one deployment at a time`);
        one[name] = { address, args, block: blockOf(address) };
      } else if (name === 'FeeEscrow') escrows.push({ address, quote: addrsIn(args[0])[0] });
      else if (name === 'FeePolicy') policies.push({ address, escrow: addrsIn(args[1])[0] });
      else if (name === 'PonsV2BuybackVault') vaults.push({ address, policy: addrsIn(args[1])[0], escrow: addrsIn(args[2])[0] });
      else if (name === 'CurbLaunchFactory') {
        const quote = addrsIn(args[2])[0];
        const policy = addrsIn(args[3])[0];
        const escrow = addrsIn(args[4])[0];
        stacks.push({ factory: address, quote, escrow, policy, vault: null });
      }
    }
  }
  for (const s of stacks) s.vault = vaults.find((v) => v.policy === s.policy && v.escrow === s.escrow)?.address ?? null;
  return { one, stacks, escrows, policies };
}

export function configFromRuns(base: Json, runs: Json[], o: { keeperKeys?: string[]; bump?: boolean } = {}): FromRunResult {
  const cfg: Json = structuredClone(base);
  const report: string[] = [];
  const decide: string[] = [];
  const chainId = String(cfg.sharing?.chainId ?? '8453');
  const { one, stacks, escrows, policies } = gather(runs, chainId);
  const need = (name: string) => {
    const x = one[name];
    if (!x) throw new RunError(`no ${name} was created in the runs given (the DeployCurb run must be one of them)`);
    return x;
  };
  const before = (() => {
    try {
      return JSON.stringify(publicSharingConfig(parseOpsConfig(base)));
    } catch {
      return null;
    }
  })();
  const live = !!base.sharing?.graduator && lc(base.sharing.graduator) !== ZERO;

  const grad = need('Graduator');
  const factory = need('HolderDistributorFactory');
  const set = (path: string, value: unknown) => {
    const keys = path.split('.');
    let at: Json = cfg;
    for (const k of keys.slice(0, -1)) at = at[k] ??= {};
    const last = keys[keys.length - 1];
    if (String(at[last]) !== String(value)) report.push(`${path}: ${at[last] === undefined ? '(none)' : String(at[last])} -> ${String(value)}`);
    at[last] = value;
  };
  set('sharing.graduator', grad.address);
  if (grad.block === null) throw new RunError(`the run has no receipt for the Graduator ${grad.address}: its block is unknown`);
  set('sharing.graduatorFromBlock', grad.block.toString());
  set('distributorFactory', factory.address);
  if (one.SharingCatalog) set('catalog', one.SharingCatalog.address);
  if (one.LaunchRegistry) set('registry', one.LaunchRegistry.address);
  if (one.FeeHook) set('hook', one.FeeHook.address);
  if (one.LaunchLens) set('lens', one.LaunchLens.address);
  // HolderDistributorFactory(registry, graduator, owner, publisher, keeperPayee, vetoers)
  const owner = addrsIn(factory.args[2])[0];
  const publisher = addrsIn(factory.args[3])[0];
  const vetoers = addrsIn(factory.args[5]);
  if (owner) set('policyOwner', owner);
  const platform = one.FeeHook ? addrsIn(one.FeeHook.args[1])[0] : undefined;

  // the launchers: every factory created, kept in the order first seen
  const launchers: string[] = (cfg.launchers ?? []).map(lc);
  for (const s of stacks) {
    if (!launchers.includes(s.factory)) {
      launchers.push(s.factory);
      report.push(`launchers: + ${s.factory} (quote ${s.quote})`);
    }
  }
  cfg.launchers = launchers;

  // the exclusions RUNBOOK 7 lists - added, never removed
  const rules = (cfg.sharing.rules ??= {});
  const excl: { address: string; reason: string }[] = rules.exclusions ?? [];
  const have = new Set(excl.map((x) => lc(x.address)));
  const exclude = (address: string | undefined, reason: string) => {
    if (!address || address === ZERO || have.has(address)) return;
    have.add(address);
    excl.push({ address, reason });
    report.push(`exclusions: + ${address} (${reason})`);
  };
  for (const s of stacks) {
    exclude(s.factory, `the CurbLaunchFactory for ${s.quote}`);
    exclude(s.escrow, `the FeeEscrow for ${s.quote}`);
    exclude(s.policy, `the FeePolicy for ${s.quote}`);
    exclude(s.vault ?? undefined, `the BuybackVault for ${s.quote}`);
  }
  // a stack whose factory is not in these runs still has its escrow excluded
  for (const e of escrows) exclude(e.address, `the FeeEscrow for ${e.quote}`);
  for (const p of policies) exclude(p.address, 'a FeePolicy');
  exclude(one.LaunchRegistry?.address, 'the LaunchRegistry');
  exclude(one.LaunchLens?.address, 'the LaunchLens');
  exclude(owner, 'the owner Safe');
  exclude(platform, 'the platform recipient');
  rules.exclusions = excl;

  // the keeper keys: the publisher, and the pushers given
  const kk: string[] = (rules.keeperKeys ?? []).map(lc);
  for (const k of [publisher, ...(o.keeperKeys ?? []).map(lc)]) {
    if (!k || k === ZERO) continue;
    if (!/^0x[0-9a-f]{40}$/.test(k)) throw new RunError(`--keeper-key ${k} is not an address`);
    if (!kk.includes(k)) {
      kk.push(k);
      report.push(`keeperKeys: + ${k}`);
    }
  }
  rules.keeperKeys = kk;

  for (const v of vetoers) if (v !== owner) decide.push(`vetoer ${v}: if it is Safe B (not the guardian's key), add it to sharing.rules.exclusions yourself`);
  // THE FEED OF EACH QUOTE ASSET is the one thing about a stack the record
  // cannot say: it names the asset, never its Chainlink feed. The example
  // carries the feeds of the fourteen assets of 2026-10-15, so a DeployCurb
  // run of that list needs nothing here; an asset admitted later (RUNBOOK
  // 7.2) gets its feed by hand in step 3, after this ran. A stack without one
  // still runs - its keeper fee prices to 0 and its epochs wait for the 7-day
  // rule - which is why this is a person's call and not a refusal.
  const weth = lc(cfg.sharing.weth ?? '0x4200000000000000000000000000000000000006');
  const fed = new Set(Object.keys(cfg.sharing.feeds ?? {}).map(lc));
  for (const s of stacks) {
    if (!s.quote || s.quote === weth || fed.has(s.quote)) continue;
    fed.add(s.quote);
    decide.push(`sharing.feeds: no Chainlink feed for the quote asset ${s.quote} (the CurbLaunchFactory ${s.factory}): add its <ASSET>/USD feed by hand, checked on chain (RUNBOOK part 7.2 step 3); without it the keeper's fee on its launches prices to 0 and their epochs wait for the 7-day rule`);
  }
  if (!(o.keeperKeys ?? []).length && kk.length < 3) decide.push('sharing.rules.keeperKeys: add the keeper host pusher and the standby pusher (--keeper-key 0x... for each)');

  // the same version for the same block only
  const after = JSON.stringify(publicSharingConfig(parseOpsConfig(cfg)));
  if (live && before !== null && before !== after) {
    if (!o.bump) throw new RunError(`the sharing block of this live config changes (${report.filter((r) => /^(sharing|exclusions|keeperKeys|distributorFactory)/.test(r)).join('; ')}): pass --bump to raise sharing.rules.version, and make the change on every host at once (RUNBOOK part 7.1)`);
    const v = BigInt(rules.version ?? '1') + 1n;
    rules.version = v.toString();
    report.push(`sharing.rules.version -> ${v} (--bump)`);
  }

  // the keys in the order the runbook names them
  const order = ['$comment', 'sharing', 'distributorFactory', 'catalog', 'registry', 'hook', 'lens', 'policyOwner', 'launchers'];
  const out: Json = {};
  for (const k of order) if (k in cfg) out[k] = cfg[k];
  for (const k of Object.keys(cfg)) if (!(k in out)) out[k] = cfg[k];
  parseOpsConfig(out); // refuses anything the service would
  return { config: out, report, decide };
}

function main(argv: string[]): number {
  const runs: string[] = [];
  const keys: string[] = [];
  let from = 'deploy/sharer.example.json';
  let out: string | null = null;
  let bump = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') runs.push(argv[++i]);
    else if (a === '--from') from = argv[++i];
    else if (a === '--out') out = argv[++i];
    else if (a === '--keeper-key') keys.push(argv[++i]);
    else if (a === '--bump') bump = true;
    else {
      console.error(`unknown argument ${a}\nusage: node scripts/config-from-run.ts --run RUN.json [--run RUN2.json] [--from BASE.json] [--out OUT.json] [--keeper-key 0x..] [--bump]`);
      return 2;
    }
  }
  if (!runs.length) {
    console.error('give at least one --run (deployments/base-mainnet/run.json)');
    return 2;
  }
  try {
    const base = JSON.parse(readFileSync(from, 'utf8'));
    const r = configFromRuns(base, runs.map((p) => JSON.parse(readFileSync(p, 'utf8'))), { keeperKeys: keys, bump });
    for (const l of r.report) console.log(l);
    for (const d of r.decide) console.log(`DECIDE: ${d}`);
    const text = JSON.stringify(r.config, null, 2) + '\n';
    if (out) {
      writeFileSync(out, text);
      console.log(`written to ${out}; now run check against it (RUNBOOK part 7)`);
    } else process.stdout.write(text);
    return 0;
  } catch (e) {
    console.error(`NOT DONE: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
