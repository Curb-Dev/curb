# curb-sharer

The off-chain half of holder fee sharing (core v2 design, section D.2): the
indexer, the CURB-SHARE v1 calculator, the Merkle tree and the epoch file
`curb.sharing.epoch/1` (the core, `src/calc`, `src/chain`, `src/epoch.ts`,
`src/state.ts`), and the operations built on it (`src/ops`, `src/cli.ts`):
the keeper, the verifier, the guardian, publishing, the lease, alerts, the
Docker image and the GitHub Actions workflows. Node 22.18+ runs the
TypeScript sources directly; there is no build step for the service.

**Operating it: [RUNBOOK.md](RUNBOOK.md)** - the keeper PC (part 8.6), the
guardian and its fallback (part 10), changing the sharing block or adding a
quote asset (part 7), a wrong root that became payable (part 14) and the
rehearsal before launch (part 16).

```
npm ci
npm run check      # typecheck + every golden vector + the test suite
npm run vectors    # every vector in spec/vectors, byte for byte
npm test           # the suite (mock chain, failure injection, determinism)
npm run bundle     # rebuild browser/curb-share.mjs
npm run mutate     # the mutation pass over every guard (about 30 minutes)
npm run config-from-run -- --run ../../deployments/base-mainnet/run.json --out deploy/sharer.json
                   # the keeper config from the deployment's record (RUNBOOK part 7)
SHARER_LIVE_RPC=http://127.0.0.1:<port> npm run test:live
                   # the probe on a real node this run started (an anvil fork of Base)
```

The spec, the reference implementation and the golden vectors live in
[`spec/`](spec/README.md) and are normative. This package must reproduce
every vector byte for byte, and the spec's own independent checks
(`spec/spec.test.mjs`) run against this implementation as well
(`test/spec-port.test.ts`).

## Modes (one image, `node src/cli.ts <mode>`)

| Mode | Signs | What |
|---|---|---|
| `keeper --loop [--interval=300]` | publisher + pusher | the primary on the keeper host (a PC, later a VPS): harvest, publish, activate, push, payKeeper |
| `keeper --once [--standby]` | publisher + pusher | one tick; `--standby` acts only if the primary's heartbeat (or its last clean tick, `lastOkAt`) is older than 45 min and it takes the lease |
| `verify --loop` / `verify --once` | never | recompute every pending root and every active one not yet checked, alert with ready-to-sign calldata |
| `verify --distributor X --epoch N --rpc URL [--rpc URL] --config FILE\|URL` | never | the public CLI for one epoch (exit 0 ok, 1 mismatch, 2 not checkable) |
| `guardian --loop [--interval=60]` | the vetoer key | verify + a `veto` the moment a root inside its hour is judged wrong (retried every pass until it lands), `freeze` on a repeat or a malicious file |
| `rebuild` | never | refill `/data` from the chain and the published files |
| `ack-veto --distributor X --epoch N` | never | let the keeper recompute a vetoed range |
| `check [--probe] [--print-public-config]` | never | the config, the secrets, the chain, the wiring, the launchers and owners, and an alert sink; `--probe` also writes a probe file to the data repo, pins it on every pinner (CIDs compared), reads it back through the site and the gateways, deletes it and sends a test alert; `--print-public-config` prints the sharing block as published |
| `alert-test` | never | one test alert to every configured sink |

The keeper tick (design D.2.6), in order: settle a transaction the last run
left open; read every distributor and the factory on both providers at one
block (abort on any difference); activate a ripe root (never while frozen);
push the active root's leaves that are due (`src/ops/push.ts`: max($0.05,
25 x the marginal leaf cost), the dust rule, PushSkipped claim-only for 30
days or until 10x, batches of <= 200 leaves and <= 8M gas, a gas-price cap);
payKeeper; then, when an epoch is due (no root pending, >= 1 h since the last
T, a pot >= 50 x the estimated epoch cost or 7 days with income - the pot is
read with a simulated harvest, `PREVIEW_CODE`), harvest, wait for `safe`,
compute on both providers, publish the file (data repo + pins + read back
from the site and a gateway, `src/ops/publish.ts` - past 512 accounts every
chunk file first, then the index; a file above the 64 MiB read-back limit is
refused before anything is written, and a launch whose file could not be
published waits a full gap before it is computed again) and send one
`publishMany` for every launch that is due. A file past
`keeper.largeFileBytes` (8 MiB, index and chunks together) or
`keeper.largeFileAccounts` (50,000) pages while there is time to act, and a contract no rule excludes that carries 5%
or more of an epoch's weight is named once (a warning). After a veto it
pages and waits for `ack-veto`.

The guardian pass (`src/ops/verify.ts`): settle the vetoes and the freeze it
owes from earlier passes (each root re-read on both providers first; a
`vetoMany` that would revert or was mined reverted is sent again one root per
transaction); read every distributor's `active()` and `pending()` on both
providers and page where they differ; check the pending roots first, the
one whose hour ends first first, then any active root not yet checked, then
re-hash the site copy of the verified ones. A root's `RootPublished` (its
URI) is looked up in the one block its `payableAt` names, on both providers,
so nothing scans a launch's history. Each check has a deadline
(`guardian.checkTimeoutSec`, 120 s) and the pass another
(`guardian.passTimeoutSec`, 300 s); every download is bounded in time and
size, body included (`src/ops/http.ts`). A check that runs out is
unverifiable; once the pass runs out the pending roots left are vetoed if
they are in their last 15 minutes, and the pass is not clean. Each veto is
decided on a fresh head and sent the moment it is judged; the guardian key
has its own gas-price cap (`guardian.maxGasPriceWei`, 100 gwei). Its
heartbeat is signed with its vetoer key, and a verifier trusts it only when
the signer is a vetoer on chain.

Secrets come only from Docker secrets or the environment (`src/ops/secrets.ts`)
and never reach a log line or an alert (the redactor). Every transaction is
simulated first, priced under a cap, journaled before it is broadcast, and
replaced at the same nonce when stuck (`src/ops/tx.ts`). A keeper that
another holder keeps out of the lease for longer than one standby run plus
the TTL (`lease.blockedAfterSec`, 30 minutes) counts its ticks as failing and
pages, naming that holder (`src/ops/keeper.ts`).

```
npm run test:ops      # the ops suites: simulated chain (test/sim), fake net, failure injection
npm run mutate:ops    # the mutation pass over every ops guard (scripts/mutate-ops.ts)
SHARER_LIVE_RPC=http://127.0.0.1:<port> SHARER_LIVE_STACK=<stack.json> npm run test:live
                      # one full epoch on a real fork with the stack deployed (test/live/keeper.live.test.ts)
docker build -t curb-sharer services/sharer   # Dockerfile; docker-compose.yml for the keeper host
```

## Layout

| Path | What it is |
|---|---|
| `src/calc/` | The calculator: canonical JSON, hashes, the share rules, the tree, the epoch file checks. Browser-safe (no Node built-ins). |
| `src/chain/` | JSON-RPC transport, the adaptive `eth_getLogs` window, typed reads, the indexer. |
| `src/epoch.ts` | One epoch from the chain to the file, read from two providers and compared. |
| `src/state-store.ts` | The complete balance states between epochs: in memory per launch token, and on disk under the data directory (`<data>/states`), each used only when it is exactly the `stateAtEnd` asked for; one rebuild at a time per state. |
| `src/epoch-chunks.ts` | A chunked epoch file read through the service's file sources (cache, site, IPFS gateways), each chunk checked by the sha256 its index gives. |
| `src/state.ts` | A stateless restart from the active epoch's file; the `publishMany` arguments. |
| `src/index.ts` | The module API. |
| `browser/curb-share.mjs` | `src/calc` as one ESM file with no imports, for the web verify panel. Generated; a test fails when it is stale. |
| `test/` | Unit tests, a mock chain built from each golden vector, failure injection, determinism, seeded random launches checked against `spec/reference.mjs`. |
| `scripts/` | `vectors.ts`, `bundle.ts`, `mutate.ts`, `mutate-ops.ts`, `config-from-run.ts` (the config from the deployment's records, `npm run config-from-run`). |
| `src/ops/` | The operations: `keeper.ts` (the tick), `push.ts` (the push planner), `verify.ts` (verifier and guardian), `rebuild.ts` (rebuild and the public verify), `tx.ts` (signing, nonces, fees, replacement, the journal), `publish.ts`, `files.ts`, `github.ts`, `pinners.ts`, `cid.ts` (publishing and fetching epoch files), `lease.ts` (the lease and the heartbeat), `alerts.ts`, `events.ts` (alerts and the role events), `chainview.ts` (what the keeper reads), `config.ts`, `secrets.ts`, `log.ts`, `store.ts`, `server.ts` (/healthz), `runner.ts` (wiring and the loop), `acks.ts`, `graduation.ts` (launches stuck in Waiting), `liveness.ts` (clean ticks and heartbeats), `wiring.ts` (check's read-back of the addresses), `writeprobe.ts` (check --probe), `http.ts` (outbound HTTP, its timeouts and retries; downloads bounded in time and size). |
| `src/cli.ts`, `bin/healthcheck.mjs` | The entry point of every mode; the Docker HEALTHCHECK. |
| `test/sim/` | The simulated chain for the ops tests (the distributor and factory rules, signed transactions, a mempool, a lagging `safe` head, state at every block) and the fake net (GitHub contents API with its sha compare-and-swap, the site, IPFS pinners and gateways). |
| `Dockerfile`, `docker-compose.yml`, `deploy/sharer.example.json`, `RUNBOOK.md` | Deployment. The workflows are in `.github/workflows/sharing-keeper.yml` and `sharing-verify.yml`. |

## Module API (for the ops package)

```ts
import {
  httpRpc, ChainReader,                       // transport and reads
  discoverSharing, readEpochHistory,          // which launches share; published and vetoed roots
  loadActiveState,                            // stateless restart from the active epoch's file
  prepareEpoch, recomputeEpochFile,           // compute an epoch; the verifier's byte check
  publishArgs,                                // publishMany(ds, rs, uris) calldata
  verifyEpochFile, buildTree, multiProofFor, proofOf,   // file checks and proofs for push and claim
} from '@curb/sharer';

const readers = [new ChainReader(httpRpc(urlA, { label: 'a' })),
                 new ChainReader(httpRpc(urlB, { label: 'b' }))];
const { state } = await loadActiveState(readers[0], graduator, distributor, fetchFile, safeBlock);
const { result } = await prepareEpoch(readers, config, { distributor, harvestTx, uri, prev: state });
if (result.result === 'epoch') {
  // result.chunks (none for a file of at most 512 accounts) -> publish each at
  // chunkPath(chainId, distributor, info.sha256) (site + pins), re-fetch, check each sha256;
  // then result.fileBytes (the index) the same way, checked against result.contentHash;
  // then send publishArgs([{ distributor, result, uri }]).data to the factory.
}
```

`prepareEpoch` and `recomputeEpochFile` take an `AbortSignal` (`signal`):
they stop between two reads once it aborts - the history replay of a
rebuild included - and throw its reason, so a check its caller gave up on
does not go on reading.

**A file is an index and, past 512 accounts, its chunks.** The index is what
the chain's contentHash hashes; past `CHUNK_ACCOUNTS` (512) rows it lists none
and names each chunk file of 512 rows by its range, count, size, sha256, tree
root and sums. `parseEpochFile(bytes)` refuses a chunked index without its
chunks (`ChunksNeeded`); a reader that needs every row takes
`readEpochFile(bytes, fetchChunk)` (or `readWholeEpoch(files, d, bytes)` over
the service's `EpochFiles`), and `verifyEpochFile(bytes, chain, prev, {
chunks })` checks every chunk (`partial: true` checks those given, as the
site does). `recomputeEpochFile` compares the index alone: it names every
chunk by its sha256. One push proves the accounts of one chunk
(`ShareTree.chunkOf`); `multiProofFor` refuses accounts of two.

`prepareEpoch` never writes anything. It throws:

- `ProviderDisagreement` when the providers differ on anything the epoch reads
  (`parts` names what: the transfer count or digest, the block hash at T, the
  timestamps, the launch's contracts, the distributor's state and income, the
  pool answers, the distributor's own exclusions, the keeper receipts, the
  price);
- `EpochNotReady` with `code` `not-safe` (the harvest block is above a
  provider's `safe` head), `pending-root`, `stale-prev` (the given previous
  state is not the active root) or `bad-harvest`;
- `IndexerError` / `InputError` for inconsistent chain data.

`config` (`SharerConfig`) carries the chain id, the Graduator and the block to
scan it from, WETH, the rules (`version`, the append-only exclusion list with a
reason per entry, the keeper keys, the AMM factories) and the Chainlink feeds
per non-WETH quote token. Every address in it may be written in any letter
case - the keys of `feeds` and both feeds of each quote token included - and
gives the file a lowercase config gives (`checkConfig`, run before anything
is read). A value that is not an address, or one quote token named twice in
`feeds`, is refused there.

## What the indexer reads, and how

All reads name the harvest block T; nothing reads `latest`. T must be at or
below the `safe` head of every provider. The providers must serve state at T
(archive state or a recent enough T).

- **Discovery**: `HolderSharingEnabled` from the Graduator. A token switched
  twice, a distributor bound twice, or an event whose `sinceBlock` is not its
  own block is refused. A caller may pass the distributors bound up to T
  (`EpochRequest.distributors`); the keeper, the verifier and the guardian
  pass the list from each provider's own scan, kept in `/data` and advanced
  over new blocks only (`boundDistributors` in `src/ops/keeper.ts`), and
  only when every provider's list is the same, so a recompute does not
  rescan from `graduatorFromBlock` and a provider that leaves one out or
  invents one still stops the epoch.
- **Launch**: the distributor's `launchToken/quoteToken/graduator/factory`,
  cross-checked against `holderDistributorOf`, `sharingSince`,
  `registry.launchOf` (decoded by word, so the record may grow; word 11 is
  `launchedAt`), `curve.feeEscrow`, `lockOf`, `poolManager`, `positionManager`.
- **Transfers**: the token's `Transfer` logs from the opening block on. The
  first epoch opens at the launch block, found by bisecting block timestamps
  for `launchedAt` and confirmed by the registry's `LaunchRegistered` log in
  that block; a later epoch opens at the active epoch's COMPLETE state after
  its T. The file's rows carry only their own accounts' balances, so that
  state is taken from the state store (`src/state-store.ts`) - in memory, per
  launch token, and on disk under `<data>/states` keyed by (chainId, token,
  toBlock), so a restart, the standby and a GitHub run (which restores and
  saves the data directory) start warm - or else rebuilt from the token's
  `Transfer` logs since the launch block, in steps of 250,000 blocks, once
  however many checks ask for it at the same time; either way checked
  against the file's `stateAtEnd` (count, sha256 digest, supply) before it is
  used. A state that is not the one the file commits to is refused. A replay
  of two weeks of a busy token behind a 40 ms provider takes about 8 s and 91
  requests; read from disk the same epoch takes about 1.6 s and 29
  (`test/state-store.test.ts`).
- **Log windows**: `eth_getLogs` in windows that adapt to what the endpoint
  refuses, with the app's rules (`web/browse.js` `logError`): a result-size
  refusal (-32005, "more than N results", "response size", including
  Infura's and Alchemy's wordings that also name a block range) halves the
  window and grows back after 16 windows; a block-range refusal halves it and
  holds; a 429, a timeout or an unknown error is asked again after 0.5, 1, 2,
  4 s. Every answer is checked (inside the window, the address asked for, not
  removed, no log twice).
- **Timestamps**: `blockTimestamp` from the logs when the node provides it,
  otherwise headers; only the blocks the spec needs.
- **Exclusions** (in this order, the first reason wins): the spec's fixed
  ones; the launch's own contracts with fixed reasons (`the launch curve`,
  `the launch hook`, `the launcher FeeEscrow`, `the Graduator`, `the v4
  PoolManager`, `the v4 PositionManager`, `the LaunchRegistry`, `the launch
  PositionLock` once graduated, `a holder distributor` for every other bound
  distributor); the config list; then every address the attempt can weigh for
  which the distributor's own `isExcluded` answers true (reason `excluded by
  the distributor's isExcluded`), so no leaf is ever given to an account the
  distributor would skip; then detected pools.
- **Pool detection**: `token0()`, `token1()` and `factory()` at T, asked only
  of the addresses that weigh (a weight at or above the floor, a millionth of
  the supply held for the window). An address "answers" when the call
  succeeds and returns at least one word whose value is an address; an
  address without code never answers. One whose `token0()` or `token1()` is
  the launch token is a pool and is excluded WHATEVER ITS FACTORY:
  `factory()` only names it in the reason (the rules' label for a listed
  factory, else the address it answered, else `no factory()`).
- **Calls nobody controls - the probe** (spec 4.10, `src/chain/probe.ts`):
  every address that weighs is probed, and anybody can send tokens to any
  address, so a probe may reach code that burns all
  the gas it is given (precompile `0x08`, a contract that is `0xfe`), or code
  that answers differently to different gas. Every probe call, and every feed
  read, goes through SharerProbe (`src/curb/sharing/SharerProbe.sol`): its
  creation code, with the calls appended, is sent as an `eth_call` with no
  `to`, from the zero address, with `PROBE_REQUEST_GAS` (15,000,000). Its
  constructor STATICCALLs each target with exactly `PROBE_CALL_GAS`
  (100,000), stops before a call it could not give that much, and returns the
  answers (at most 160 bytes each); the reader sends the rest from where it
  stopped. One request answers a few hundred calls, a reverting contract costs
  no request of its own, nothing is asked twice, and every call gets the same
  gas on every provider and in every position - so there is no reader setting
  for the keeper, the verifier and the guardian to keep alike. The provider
  must accept an `eth_call` with no `to` and 15,000,000 gas; one that refuses
  fails the epoch loudly. `PROBE_CODE_HASH` pins the code;
  `test/sharing/SharerProbe.t.sol` checks the build against it.
- **Keeper transactions**: every transaction that emitted a log from the
  distributor in `[F, T]`, plus the hashes the caller names (the keeper's own
  journal, which holds reverted transactions that log nothing; a named hash
  that is not in a block in `[F, T]` - a publish replaced at its nonce, one
  still pending, one mined before F or after T - is not counted, and one
  before F is never asked for its receipt). The keeper hands over its whole
  journal (`EpochRequest.keeperJournal`): an entry whose mined send it saw
  before F is left out unasked, so a provider that pruned its transaction
  index cannot stall the epoch. The
  calculator keeps those sent by a keeper key to the distributor, or to the
  factory naming it (`publishMany`'s distinct list, `publish`'s one). The
  verifier passes the file's listed hashes, so a listed transaction that is
  not attributable makes the recomputed bytes differ.
- **Price**: `latestRoundData()` and `decimals()` of the configured ETH/USD
  and QUOTE/USD feeds at T; a feed that reverts or answers zero or less is
  missing (`P = 0`).

## The browser bundle

`browser/curb-share.mjs` exports the calculator (`computeEpoch`, `runVector`),
the encodings (`canonicalJson`, `sha256Hex`, `leafHash`), the file checks
(`parseEpochIndex`, `parseEpochFile`, `readEpochFile`, `verifyEpochFile`,
`stateFromEpochFile`), the chunks (`chunkIndexOf`, `chunkPath`, `chunkCid`,
`epochPart`) and the proof builders (`buildTree`, `treeOf`, `proofOf`,
`multiProofFor`, `verifyProof`, `verifyMultiProof`). It runs every golden
vector byte for byte in a browser and in a sandbox with no `Buffer`,
`process` or `require`. `web/curb-share.mjs` is a byte-for-byte copy.

```js
import * as share from './curb-share.mjs';
const check = share.verifyEpochFile(bytes, { contentHash, merkleRoot, cumHolders0, cumHolders1, cumKeeper0 });
if (!check.ok) show(check.problems);
// one account of a chunked file: the index and the chunk that holds it
const index = share.parseEpochIndex(bytes);
const k = share.chunkIndexOf(index, account);   // its chunk: /<chunkPath(chainId, d, index.chunks[k].sha256)>
const part = share.epochPart(bytes, k, chunkBytes);
const proof = share.proofOf(share.treeOf(part), account);
```

The tree is OpenZeppelin's layout built here (`src/calc/merkle.ts`): the
library takes about 0.35 ms a leaf, which for a quarter of a million accounts
is 85 s a tree; the port takes about 0.03 ms and is held to the library on
every vector and on random sets.
