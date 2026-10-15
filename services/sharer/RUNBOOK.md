# curb-sharer runbook

This is the step-by-step guide for running holder sharing: the program that,
every epoch (about hourly), works out each holder's share of a sharing
launch's income, publishes the list, puts its root on chain, and pays the
holders. Read parts 1 to 10 once, in order. Do the rehearsal's 16.1 to 16.4
after parts 2 to 6, 8.1, 8.2 and 8.6 and before the deploy (`DEPLOY.txt`
PREP 3). Part 10, the guardian, is set up at PREP 3 and started at the head
of `DEPLOY.txt` STEP 5, within the hour after the broadcast and before STEP
4A: holder sharing is live from STEP 4, and nothing else watches a root.
Part 7's config is generated at that moment, for the guardian, and committed
in STEP 5; its check on the keeper, and parts 8.3 and 9, come at `DEPLOY.txt`
STEP 9, and 16.5 after them, before the site is announced. Parts 11 to 15
are for later.

Nothing in this guide needs a terminal command you have not seen written out
here. Every command is shown in full; the few steps the developers do for you
(in part 16) are marked as theirs. Commands on the keeper PC are PowerShell;
commands on a Linux server are for its shell. A command broken over several
lines with `\` is written for a Linux shell: in PowerShell, put it on one
line without the `\`.

---

## 1. What runs where

| Piece | Where | What it does | Keys it holds |
|---|---|---|---|
| **keeper** (primary) | the keeper PC, in Docker Desktop (part 8.6); later a rented Linux server (part 8.7) | harvests income, publishes epochs, pushes payouts, pays its own gas fee | publisher, pusher |
| **verifier** | the keeper PC, in Docker, with **other** RPC providers | re-checks every epoch and alerts you if one is wrong | none |
| **standby keeper** | GitHub Actions, every 15 minutes | does the keeper's job only if the keeper PC has been silent for 45 minutes | publisher, standby pusher |
| **verifier** (second) | GitHub Actions, every 15 minutes | the same checks, on GitHub's machines | none |
| **guardian** | a **different** machine, run by a **different person** (part 10), **never** the keeper PC | re-checks every epoch and vetoes a wrong one within minutes | guardian (a vetoer) |

How one epoch goes, when everything is healthy:

1. The keeper sees that a launch has earned enough since the last epoch.
2. It calls `harvest()` on the launch's distributor, which pulls in all the
   income the launch has earned.
3. It waits until that block is "safe" (a few minutes on Base).
4. It computes everyone's share on **two** RPC providers and compares them.
   If they disagree, it stops and writes nothing.
5. It writes the epoch file to the data repo (the site serves it) and pins it
   on IPFS, then downloads it back from the site and from IPFS and checks the
   fingerprint (sha256). Only then does it put the root on chain.
6. For one hour the root is "pending". The guardian and the verifiers check
   it. Anything wrong is vetoed in that hour.
7. After the hour, the keeper activates it and pushes the payouts. At most 2%
   of the epoch's quote income pays the keeper's gas, and that is visible on
   chain.

The service keeps nothing important on its own disk. If a machine is lost,
everything it needs is rebuilt from the chain and the published files.

---

## 2. Before you start: what you need

- The keeper host: a separate Windows 11 Pro PC that stays on, used for
  nothing else (part 8.6). When the keeper moves to a rented server, a small
  Linux VPS (1 CPU, 1 GB RAM, 10 GB disk is plenty) with Docker (part 8.7).
- A GitHub organisation that holds this repository, **public** (part 4.1).
  Keep it public, or budget for Actions minutes: the two workflows of part 9
  run every 15 minutes, about 5,760 jobs a month, each billed as at least one
  minute. A private repository includes only 2,000 minutes a month (Free) or
  3,000 (Pro/Team), so it would need paid minutes or both schedules lowered.
- A second, **public** GitHub repository for the published files:
  `curb-sharing-data` (part 4.2).
- The site (the one on Vercel), so it can serve the files under `/sharing/`
  (part 4.3).
- Accounts with **three** IPFS pinning services, or two and the keeper PC's
  own IPFS node, on plans sized as part 5.1 says.
- RPC accounts with **four** different RPC providers (part 6).
- Somewhere to receive alerts: a Telegram bot and chat, a Discord webhook,
  and/or an email API key (part 13 lists every alert, and how to test them).
- The platform Safe ("Safe A") that owns the CURB contracts, and ideally a
  second Safe ("Safe B") for the vetoer role (part 3, and part 10.3 for its
  signers).
- Someone you trust who is **not** you to run the guardian, **named before
  the first launch with sharing** (part 10.1). If there is nobody, a small
  rented server of your own for a fallback guardian (part 10.2).

---

## 3. The keys and the roles

### 3.1 Create the keys

Create each key on a computer you trust, **offline if you can**, with
Foundry's `cast` (installed with Foundry):

```
cast wallet new
```

It prints an address and a private key. Do this once per key below. Write
the private key into a password manager straight away. Never paste a private
key into a chat, an issue, a commit or an email.

| Key | Holds a role? | Who keeps it | ETH it needs |
|---|---|---|---|
| **publisher** | yes: it is the only key that can put roots on chain | the keeper host and GitHub Actions (the same key in both) | about 0.02 ETH |
| **pusher** (keeper host) | no role; it only pays gas | the keeper host | about 0.05 ETH |
| **standby pusher** | no role; it only pays gas | GitHub Actions | about 0.02 ETH |
| **keeper payee** | receives the keeper's gas fee | a cold wallet (a hardware wallet), or simply the pusher | none |
| **guardian** | a vetoer: it can veto and freeze, nothing else | the independent guardian operator (or your fallback guardian server, part 10.2) | about 0.02 ETH: a veto costs cents at Base's usual gas price, and up to about 0.015 ETH at its 100 gwei cap (`guardian.maxGasPriceWei`) |

Why two pushers: the keeper host and GitHub Actions never send at the same
time (the lease, part 9), but separate gas keys mean one can never wait
behind the other's stuck transaction.

### 3.2 Put the roles on chain

The roles are set when the CURB contracts are deployed. `DeployCurb` reads
them from three settings (see `DEPLOY.txt`, decision 5):

```
CURB_SHARING_PUBLISHER=<publisher address>
CURB_SHARING_KEEPER_PAYEE=<keeper payee address>
CURB_SHARING_VETOERS=<guardian address>,<Safe B address>
```

The owner Safe (Safe A) is always added as a vetoer as well.

What each role can and cannot do (enforced by the contracts):

- **Safe A (owner)** can add a vetoer, revoke the publisher and freeze, all at
  once. It can *announce* a new publisher, a new keeper payee, the removal of
  a vetoer or an unfreeze; each of those takes effect only **48 hours** later.
  It cannot publish, pay, sweep or change any cap.
- **A vetoer** (the guardian, Safe B, Safe A) can veto a pending root during
  its hour (or at any time while frozen) and can freeze. It cannot publish,
  pay or unfreeze.
- **The publisher** can propose one root per launch at a time, within the
  on-chain caps. Nothing else.
- **The keeper payee** receives at most 2% of each epoch's new quote income,
  as gas money.

### 3.3 Fund the keys

Send the ETH from the table above (on Base) to the publisher, the pusher, the
standby pusher and the guardian. The keeper alerts you when one of its keys
falls below 0.005 ETH (part 13, "low ETH"), and the guardian does the same for
its own key.

---

## 4. The repositories and the site

### 4.1 The code repository

The GitHub Actions of part 9 run from this repository, and the site tells
holders to verify an epoch with the code in it, so it must be on GitHub and
public. Do this before part 7, which commits the config to it.

1. Before the first push, have the developers scan the **whole history** for
   secrets (a scanner such as gitleaks). Everything ever committed becomes
   public, not only the files of today.
2. Create an **empty public** repository in your organisation: GitHub →
   New repository → Public, with no README, no licence and no .gitignore, so
   the first push is taken as it is. This guide calls it `<org>/<repo>`.
3. Push the local `master` branch to GitHub as `main`. GitHub runs scheduled
   workflows on the repository's default branch, and both workflows act only
   on the default branch, so `main` must be the default. In the clone
   (PowerShell):

   ```
   git remote add origin https://github.com/<org>/<repo>.git
   git push origin master:main
   ```

   The first branch pushed becomes the default. Check it: Settings → General →
   Default branch must say `main`. Every later push is the same command,
   `git push origin master:main`.

   Then, at once, in the Actions tab, disable both sharing workflows (open
   `sharing-keeper`, then "..." → "Disable workflow"; the same for
   `sharing-verify`). Their schedules start with this push, and every run
   would fail, and email, until they have `deploy/sharer.json` (`DEPLOY.txt`
   STEP 5) and the secrets of part 9.1. Part 9.2 enables them.
4. Settings → Branches → add a protection rule (or a ruleset) for `main` that
   blocks force pushes and deletion. Anyone who can push to `main` can change
   a workflow and so reach the secrets of part 9.1: give write access to as
   few people as you can.
5. Send the developers the repository's address. The site's verify
   instructions name `services/sharer` in it, at the commit that is deployed:
   `DEPLOY.txt` STEP 5 writes
   `https://github.com/<org>/<repo>/tree/<commit>/services/sharer` into
   `CODE_AT` in `web/sharing.js`, and the deploy-day publish check refuses
   the site without it. The commit is the one the keeper's image is built
   from (part 8.1).

### 4.2 The data repository

1. Create the public repository `curb-sharing-data` in your GitHub
   organisation, with a README so it has a `main` branch.
2. Create a **fine-grained personal access token**: GitHub → Settings →
   Developer settings → Fine-grained tokens → Generate new token.
   - Resource owner: your organisation.
   - Repository access: **Only select repositories** → `curb-sharing-data`.
   - Permissions → Repository permissions → **Contents: Read and write**.
     Nothing else.
   - Expiration: 90 days (put a reminder in your calendar, part 12).

   Make a **second** token the same way for the guardian (part 10.1), which
   writes its own heartbeat there, so each can be revoked on its own. The
   verifiers page when that heartbeat goes stale or never appears ("The
   GUARDIAN has never written a heartbeat", every 12 hours). A fine-grained
   token cannot be held to one file, so every token can write the guardian's
   heartbeat: the guardian therefore signs it with its vetoer key, and the
   verifiers trust it only when the signer is a vetoer on chain ("The
   GUARDIAN heartbeat is NOT SIGNED by a vetoer" otherwise). Every token can
   also write `ops/lease.json`: a keeper kept out of it for longer than one
   standby run plus the lease's TTL pages ("Another holder KEEPS THE KEEPER
   LEASE", part 13). A guardian that
   cannot be given a token therefore needs `"verifier": {
   "guardianSilentAfterSec": 0 }` in the config, which turns that watch off;
   the guardian then pages only through its own alert sinks.

### 4.3 The site

Make the site serve the repository's files under `/sharing/<chain>/`.
`web/vercel.json` already has three rewrites: `/` (the Launches page),
`/token/:address` and `/sharing`, which is the page listing every
distributor. **Keep all three, and add this one as the fourth entry of the
same `rewrites` list, after `/sharing`** (replace `your-github-org`):

```json
{ "source": "/sharing/:chain(\\d+)/:path*",
  "destination": "https://raw.githubusercontent.com/your-github-org/curb-sharing-data/main/sharing/:chain/:path*" }
```

The source must start with the chain number. A bare `/sharing/:path*` also
matches `/sharing` itself, so it would send the /sharing page to GitHub.
On Netlify, add the same rule to `web/_redirects`, below the `/sharing` line:
`/sharing/:chain/*  https://raw.githubusercontent.com/your-github-org/curb-sharing-data/main/sharing/:chain/:splat  200`.

After the first epoch, `https://<your site>/sharing/8453/<distributor>/1.json`
must show the file, and `https://<your site>/sharing` must still show the
page. Without this rewrite the keeper publishes nothing. It reads every
file back from the site before its root goes on chain, and stops if the
site does not serve it.

What goes into the data repo:

| Path | What |
|---|---|
| `sharing/8453/<distributor>/<epoch>.json` | each epoch file (its sha256 is on chain) |
| `sharing/8453/<distributor>/latest.json` | a pointer to the newest one (not trusted by anything) |
| `sharing/8453/config.json`, `config-v<N>.json` | the sharing rules, for anyone who wants to verify (written when the keeper publishes) |
| `ops/status.json` | the keeper host's heartbeat: `heartbeatAt` (when it last wrote) and `lastOkAt` (when its last tick finished cleanly) |
| `ops/status-standby.json` | the standby's heartbeat, with the same two times: written when it acts, and on the heartbeat schedule while it stands in |
| `ops/status-guardian.json` | the guardian's heartbeat, written with its own token (part 4.2, part 10) |
| `sharing/8453/probe/` | a probe file `check --probe` writes and deletes again (part 7); nothing stays there |
| `ops/lease.json` | who may write right now |
| `ops/acks.json` | your acknowledgements of vetoes (part 13) |

---

## 5. IPFS pinning

Every epoch file is pinned on at least two services (`ipfs.minPinned`, 2)
before its root goes on chain. Configure **three**, so that one can be down,
or out of its plan, without stopping publishing.

1. **Pinata**: create an API key (JWT) with permission to upload files.
   Create a dedicated gateway (Pinata → Gateways); you get a domain like
   `https://something.mypinata.cloud`.
2. **Filebase**: create an IPFS bucket and an API key for its IPFS RPC API.
   Its public gateway is `https://ipfs.filebase.io`.
3. **A third pinner.** Either a third hosted service with a Kubo-compatible
   IPFS RPC (`"kind": "kubo"`, with its URL and a `token` name), or the keeper
   PC's own IPFS node: `docker compose --profile ipfs up -d` in the keeper's
   folder (part 8.2), added as
   `{ "kind": "kubo", "name": "local", "url": "http://ipfs:5001" }`. Only the
   keeper PC reaches its own node: the GitHub standby then still needs both
   hosted services. A remote-pinning-only service (`"kind": "psa"`) does not
   upload the file, so it does not count toward `minPinned`.

`deploy/sharer.example.json` lists the three: `pinata`, `filebase`, and a
third Kubo-compatible service named `third` (replace its `url` with the
service's IPFS RPC address, or replace the whole entry with the local node
above, which needs no token). `ipfs.minPinned` stays 2.

The tokens go into the `pin_tokens` secret (part 8) as
`{"pinata": "<JWT>", "filebase": "<key>", "third": "<key>"}` (leave `third`
out for the local node). The names on the left must match the `token` names
in the config's `ipfs.pinners`. The pinners are not part of the sharing rules: adding
or replacing one changes no epoch file, so it needs no lockstep change (part
7.1). Change `ipfs` in `deploy/sharer.json`, commit and push it (GitHub
Actions reads it from `main`), copy it to the keeper host, add the token to
the host's `pin_tokens` and to `SHARING_PIN_TOKENS` on GitHub, and restart.

How a pin is trusted: before uploading, the keeper computes the file's IPFS
address (CID) itself, exactly as IPFS's reference software (Kubo) does with
its standard settings for new files (CIDv1, 256 KiB pieces). A pinning
service counts only if it answers that same address. Every copy read back is
also checked against the fingerprint on chain, so a pin that stored the file
some other way can never be used; it only counts as a failed pin. If one
service keeps failing that way (the "pins needed" part of the "could NOT be
published" alert), use a Kubo-compatible service in its place: Filebase's
IPFS RPC, a local IPFS node (the `ipfs` profile) or another hosted Kubo RPC.

One failed pin while two others succeed is only a line in the keeper log
(`a pin failed`, naming the service): publishing goes on, and nothing pages.
That is why part 11 looks at every plan's usage once a month.

### 5.1 How big the plans must be

- An epoch file is about **2 KB, plus about 0.5 KB for every holder** who has
  ever had a share in that launch (the file lists each one). A launch with
  2,000 such holders writes files of about 1 MB.
- A launch gets an epoch when its income since the last one is worth at least
  50 times the epoch's gas cost, or after 7 days with any income, and never
  more than once an hour: a busy launch up to 24 a day, a quiet one about
  once a week.
- Files a month = the epochs of every launch with sharing, added up. Storage
  a month = those files times their size. For example, 20 launches with
  sharing, 2,000 holders each, 6 epochs a day: 3,600 files and about 3.6 GB a
  month.
- Each pinning plan must hold what part 5.2 keeps pinned (30 days of files at
  least), plus half again. Plans limit the **number of files** as well as the
  storage, and free plans usually run out of files first. Read both limits on
  each service's pricing page and pick the plan from your own figures.
- The data repo keeps every file (part 5.2). Git stores consecutive epochs of
  one launch compactly, but look at its size once a month: open
  `https://api.github.com/repos/<org>/curb-sharing-data` in a browser and read
  `size` (in KB). GitHub asks that repositories stay well under 5 GB; when it
  passes 1 GB, plan with the developers what to archive.

### 5.2 What stays pinned

The data repo keeps **every** epoch file for good (the site serves them all
from it), so IPFS is the second copy. On every pinning service keep:

- the epoch in force and the pending epoch of every distributor, however old;
- every epoch file of the last 30 days.

Older files may be unpinned when a plan nears its limit, oldest first. The
keeper never unpins anything: you do it in each service's dashboard, where
each file is named `curb-8453-<distributor>-<epoch>.json`. Before unpinning a
file older than 30 days, check that it is not its distributor's epoch in
force: BaseScan → the distributor → Read Contract → `active` → `epoch`.
Never delete anything from the data repo.

What unpinning costs: the file's `ipfs://` address may stop answering, while
the site copy still verifies it. A verifier or guardian that starts with an
empty `/data` re-checks old epochs and raises one WARN for each unpinned one
("the gateway ... copy does not match the on-chain hash", "could not be
read"). For files older than 30 days that you unpinned, that is expected.

---

## 6. RPC providers

The decision of which providers to use is still yours. Whatever you pick,
each must offer, on Base mainnet:

- archive state (reading old blocks): every epoch is read at its harvest
  block;
- `eth_getLogs` over long ranges (the service adapts to each provider's
  limits by itself);
- the `safe` block tag;
- `eth_call` **with no `to` address and 15,000,000 gas** (the service checks
  odd contracts this way; a provider that refuses makes every epoch fail
  loudly, so test it with `curb-sharer check`, part 7).

Use four **different companies**:

| Who | Providers |
|---|---|
| the keeper (keeper PC) | A and B |
| the verifier (keeper PC) | C and D |
| the GitHub Actions standby and verifier | A and B, or C and D |
| the guardian | its operator's own choice (not A or B) |

The keeper reads every epoch on both of its providers and **refuses to write
anything if they disagree**. That is why they must be two different
companies. The guardian reads every distributor's roots, and each root's
`RootPublished`, on both of its providers too, and pages when they differ.

No provider needs a large `eth_getLogs` range for the guardian or a
verifier: a pass looks a root's event up in its own block and otherwise scans
only the blocks since its last pass (a first start scans from the Graduator's
block once, in whatever windows the provider accepts). A provider limited to
2,000 blocks per request is enough.

---

## 7. The config file

1. **Generate it from the deployment's own record**, never by hand. The
   developers (or you, on any machine with Node 22.18 or later) run, in
   `services/sharer` of a clone at the deployed commit, once
   `deployments/base-mainnet/run.json` is copied into it (`DEPLOY.txt` STEP
   4 makes the copy; STEP 5 commits it together with the `deploy/sharer.json`
   this writes):

   ```
   npm ci --no-audit --no-fund
   npm run config-from-run -- --run ../../deployments/base-mainnet/run.json --keeper-key <the keeper host's pusher address> --keeper-key <the standby pusher address> --out deploy/sharer.json
   ```

   It starts from `deploy/sharer.example.json` (`--from` names another file)
   and fills, from what was actually sent:
   - `sharing.graduator` and `sharing.graduatorFromBlock` (the block of its
     creation);
   - `distributorFactory`, `catalog`, `registry`, `hook`, `lens`, and
     `policyOwner` (Safe A, the factory's owner);
   - `launchers`: every CurbLaunchFactory the run created;
   - `sharing.rules.exclusions`: every CurbLaunchFactory with its FeeEscrow,
     FeePolicy and BuybackVault, the LaunchRegistry, the LaunchLens, Safe A
     and the platform recipient, each with its reason;
   - `sharing.rules.keeperKeys`: the publisher, and each `--keeper-key`.
     The keeper's gas fee only counts transactions from these three.

   It prints a line for everything it set or added, and a `DECIDE:` line for
   what a person must settle: each vetoer other than Safe A - if it is
   **Safe B** (not the guardian's key), add it to
   `sharing.rules.exclusions` yourself, with a reason. A later asset's
   record is passed as a second `--run` (part 7.2).
   The launch's own contracts (its curve, hook, escrow, lock, the Graduator,
   the v4 contracts, the distributors) are excluded automatically.
2. The exclusions only ever grow. Once the service is running, every change
   to the `sharing` block goes the way part 7.1 says, and
   `config-from-run` refuses to change a live config's `sharing` block
   unless `--bump` raises `sharing.rules.version` with it.
3. Check the `sharing.feeds`: the example carries the Chainlink USD feed of
   every quote asset on the list but WETH, which `ethUsdFeed` prices - the
   thirteen of 2026-10-15: USDC, cbBTC, VIRTUAL, AERO, cbXRP, cbZEC, NVDAc,
   GOOGLc, SPCXc, AMZNc, MSFTc, AAPLc and METAc. Each was read back from
   Base that day: `description()` names the pair, `decimals()` is 8 (ZEC /
   USD's is 18), `latestRoundData()` answers, and the asset's own
   `decimals()` is the one the deployment sized it in (USDC and cbXRP 6,
   cbBTC, cbZEC and the stocks 8, VIRTUAL and AERO 18). `config-from-run`
   prints a `DECIDE:` line for every CurbLaunchFactory in the record whose
   quote asset has no feed there; that one is added by hand (part 7.2 step
   3). Without it the asset's launches still run, but the keeper's fee on
   them prices to 0 and their epochs wait for the 7-day rule.
4. `site.base`: your site's address (no trailing slash).
5. `dataRepo.owner`: your GitHub organisation.
6. `ipfs.gateways`: your Pinata gateway and Filebase's. `ipfs.pinners`: the
   three pinners of part 5 (the example's `third` entry is a placeholder).
7. Commit `deploy/sharer.json` and push it to `main`
   (`git push origin master:main`, part 4.1). It holds no secrets, and GitHub
   Actions reads it from there.

Then check it. You need the image and the keeper host's folder first: build
the image as part 8.1 says, and make the folder as part 8.2 says (on the
keeper PC, part 8.6 steps 1 to 4 come first). The folder is **outside** any
clone of the code repository, so no `git add` can ever publish a key. From
that folder:

```
docker compose run --rm keeper check
```

`check` checks: that each provider serves chain 8453; that
`sharing.graduator`, `distributorFactory`, `catalog`, `registry`, `hook` and
`lens` are not zero and have code on every provider (one left out is named
"not set", with what then goes unwatched - `lens: not set` means launches
stuck in Waiting are not watched); that they are wired to each other
(the Graduator's catalog, the catalog approving the factory, the lens and
the hook reading the registry), that the registry's launchers are exactly
`launchers`, that the owners are `policyOwner` (a registry the Safe has
been offered and has not yet accepted passes, and says so), and that the
publisher and guardian keys hold their roles on chain; that every provider
runs an `eth_call` with no `to` address (part 6); that the published
`sharing/8453/config-v<N>.json` of this host's rules version, if there is
one yet, is this host's sharing block; which secrets are present - each key
by its address, the data-repo token and each pin token the config names (a
missing one says "not set": a host only needs the secrets of the roles it
runs); and that there is **an alert sink** (`alert_webhooks`, part 13) -
without one it is NOT OK. It ends with
`config ok; 2 providers on chain 8453, head <block>`. A line starting
`NOT OK:` is the reason it cannot start, and the exit code is then 2.

Two options go further:

- `check --probe` also uses the path every epoch takes, with a small file
  of its own: it writes `sharing/8453/probe/<host>-<time>.json` to the data
  repo and reads it back, pins it on every pinner and compares each
  service's CID with its own (at least `ipfs.minPinned` must hold it), reads
  it back through the site and the IPFS gateways (each copy checked by
  sha256), deletes it from the data repo again, and sends a test alert
  through every sink. Each failure is a named `NOT OK`; the probe pins stay
  (a few hundred bytes, named `curb-probe-...`). Run it on every keeper
  host before its first start, and after any change to the data-repo or pin
  tokens, the pinners, the site or the alert sinks.
- `check --print-public-config` prints, after `config ok`, the sharing block
  exactly as the keeper publishes it to `sharing/8453/config.json` (part 7.3
  uses it).

### 7.1 Changing the sharing block

The guardian and every verifier recompute each payout file with **their own
copy** of the whole `sharing` block and compare the result byte for byte with
the published file. Every part of the block changes what they compute:

- `chainId`, `graduator`, `graduatorFromBlock`, `weth`;
- `rules`: `version`, `exclusions`, `keeperKeys`, `ammFactories`;
- `feeds`: the Chainlink feeds of each quote asset. The keeper's gas fee is
  priced from them, and the file records which feed and round it read;
- and, beside the block, `distributorFactory`, the factory whose
  distributors they check (it is published with the block, part 7.3).

A copy that is out of step with the keeper's makes them call an honest payout
wrong: the guardian vetoes it, and a second veto within 30 days **freezes**
holder sharing for every launch. So every change to any of these (a new
exclusion, a keeper key added in part 12, a feed added or replaced, a new
quote asset in part 7.2) is made everywhere in one step, and **every change
raises `sharing.rules.version` by one**, a feed-only change included: each
verdict names the file's version and the host's, so a host left behind is
found at once.

1. Stop the keeper: on the keeper PC `docker compose stop keeper` (in its
   folder, part 8.2), and in the Actions tab disable the `sharing-keeper`
   workflow.
2. Wait until no root is pending: the site's /sharing page, or each
   distributor's `pending()`, shows none still in its hour. (At most one
   hour after the last publish.)
3. Make the change in `deploy/sharer.json` and raise `sharing.rules.version`
   by one. Commit it and push it to `main` (GitHub Actions and the verify
   workflow read it from there).
4. Copy the same file to the keeper host (`config/sharer.json` in its folder)
   and send it to the guardian operator, who replaces their
   `config/sharer.json` (and to your fallback guardian server, part 10.2, if
   you run one).
5. Run `check` (part 7) with each copy; each must say `config ok`. Then
   compare them as part 7.3 says.
6. Restart: on the keeper PC `docker compose up -d`, the guardian operator
   restarts their container, and enable the `sharing-keeper` workflow again.

Do not delete a verifier's or the guardian's `/data` (its Docker volume)
around a change. A verifier that starts with an empty one re-checks old
epochs with the new block and calls those computed under the old version
mismatches: "does NOT verify and is no longer vetoable" for the old ones, and
"An ACTIVE root does not verify" until the next epoch of that launch
activates. Check such an epoch with the config of its own version (the
version the verdict names for the file):

```
docker run --rm ghcr.io/<org>/curb-sharer:<commit> verify \
  --distributor <distributor> --epoch <n> \
  --rpc <a provider URL> --rpc <another provider URL> \
  --config https://<your site>/sharing/8453/config-v<file's version>.json \
  --site https://<your site> --gateway https://ipfs.filebase.io
```

A verdict line reading `verdict      OK` there means the root is right. More
generally: if a verdict says the file names a different rules version than
the host's config, that host's copy is the one out of step: fix it before
acting on the verdict.

### 7.2 Admitting a new quote asset

A quote asset admitted after launch gets its own CurbLaunchFactory with its
FeeEscrow, FeePolicy and BuybackVault, which must be excluded, and its own
price feed, which the keeper's gas fee needs. Both change the sharing block,
so they go everywhere **before** the first launch on that asset exists.

1. The developers build the asset's contracts with
   `script/DeployAssetStack.s.sol` against the live registry, Graduator and
   hook, as `DEPLOY.txt` describes in ADDING A QUOTE ASSET AFTER LAUNCH, and
   commit its record as `deployments/base-mainnet/asset-<label>.json`. It
   prints the new addresses and the calldata of the Safe's `addLauncher`.
   **The Safe does not sign `addLauncher` yet.**
2. The exclusions and the launcher, from the records, in `services/sharer`:

   ```
   npm run config-from-run -- --from deploy/sharer.json --run ../../deployments/base-mainnet/run.json --run ../../deployments/base-mainnet/asset-<label>.json --bump --out deploy/sharer.json
   ```

   It adds the new CurbLaunchFactory, its FeeEscrow, its FeePolicy and its
   BuybackVault to `sharing.rules.exclusions` with their reasons, adds the
   factory to `launchers`, and raises `sharing.rules.version` by one
   (`--bump`; without it, it refuses to change a live block). It also prints
   `DECIDE: sharing.feeds: no Chainlink feed for the quote asset ...` for
   the new asset, which step 3 settles.
3. The feed, by hand, in the same change (no second version raise): take
   the asset's `<ASSET>/USD` proxy address on Base from Chainlink's own feed
   directory (data.chain.link), and check it on BaseScan: `description()`
   names the pair, `decimals()` and `latestRoundData()` answer. Add the
   asset to `sharing.feeds`:
   `"<asset address>": { "ethUsd": "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70", "quoteUsd": "<feed address>" }`.
   The developers add the same feed to `web/prices.js` and to
   `deploy/sharer.example.json` in the asset's own commit.
4. Make the change everywhere as part 7.1 says (stop, wait, commit, copy to
   the keeper host and the guardian, `check`, compare, restart). Until the
   Safe admits the factory, `check` on every host says exactly one thing is
   NOT OK - `config.launchers lists addresses the registry never admitted`,
   naming the new factory - and nothing else may be.
5. Only when every host prints the same new block (part 7.3) does the Safe
   sign `addLauncher`. The keeper then reports "A listed launcher was
   admitted to the LaunchRegistry" (INFO), and `check` says `config ok` on
   every host. (Admitted before the config lists it, the keeper pages "An
   UNLISTED LAUNCHER was admitted".)
6. After the keeper's next publish, `https://<your site>/sharing/8453/config-v<N>.json`
   exists for the new version and `config.json` equals it.

### 7.3 Every host has the same block

Run `check --print-public-config` on every host (on the keeper PC:
`docker compose run --rm keeper check --print-public-config`). The JSON it
prints last must be the same on every host. Once the keeper has published
under the current version, it must also be the same as
`https://<your site>/sharing/8453/config.json`. The guardian operator can do
this comparison on their own at any time.

---

## 8. Running the keeper host

The keeper and the verifier run together on one machine, from
`docker-compose.yml`: the keeper PC (part 8.6), or later a Linux server
(part 8.7). Parts 8.1 to 8.5 are the same on both.

### 8.1 The image

Build the image from the repository at a reviewed commit - at deploy, the
commit `DEPLOY.txt` STEP 5 names in the site's verify instructions (part
4.1, step 5) - on the keeper host itself, so it never needs a registry
login. **The keeper's own test suite runs first, on that commit**, and no
image is built from a commit whose suite fails. It needs Node 22.18 or
later on the machine (on the keeper PC, installed from your administrator
account):

```
git clone https://github.com/<org>/<repo>.git
cd <repo>
git checkout <commit>
cd services/sharer
npm ci --no-audit --no-fund
npm run check
cd ../..
docker build -t ghcr.io/<org>/curb-sharer:<commit> services/sharer
```

`npm run check` type-checks the code, recomputes every golden vector byte
for byte and runs the suite; its last lines must say `fail 0`. The tag is
only a name on this machine; nothing is pushed. The image runs as an
unprivileged user, with a read-only filesystem, and holds no secrets.

### 8.2 The files

Make a folder with this layout, **outside any clone of the code
repository** (on the keeper PC `C:\Users\curbkeeper\curb-sharer`, part 8.6;
on a server `~/curb-sharer`):

```
curb-sharer/
  docker-compose.yml          (copy of services/sharer/docker-compose.yml)
  .env                        one line: CURB_SHARER_IMAGE=ghcr.io/<org>/curb-sharer:<commit>
  config/sharer.json          (the committed deploy/sharer.json)
  secrets/publisher_key       one line: 0x... the publisher private key
  secrets/pusher_key          one line: 0x... the keeper host's pusher private key
  secrets/rpc_urls            two lines: provider A's URL, provider B's URL
  secrets/verifier_rpc_urls   two lines: provider C's URL, provider D's URL
  secrets/data_repo_token     one line: the fine-grained GitHub token
  secrets/pin_tokens          {"pinata": "<JWT>", "filebase": "<key>", "third": "<key>"}
  secrets/alert_webhooks      see part 13
```

Docker Compose reads `.env` by itself, so the image stays named across
reboots and no command needs a setting in front of it. Then lock the secrets
down: on the keeper PC as part 8.6 step 4 says, on a server as part 8.7 says.

### 8.3 Start it

From the folder (`cd C:\Users\curbkeeper\curb-sharer` on the keeper PC,
`cd ~/curb-sharer` on a server):

```
docker compose run --rm keeper check
docker compose run --rm keeper check --probe
docker compose run --rm keeper alert-test
docker compose up -d
docker compose ps
docker compose logs -f keeper
```

Both `check` runs must end `config ok` (the second says `the write probe
passed` after it), and the test alerts of `check --probe` and `alert-test`
must reach every sink. After a few minutes `docker compose ps` shows both services
"healthy". The log is one JSON object per line.

A healthy keeper writes its heartbeat to `ops/status.json` in the data repo
every 15 minutes: `heartbeatAt` is when it wrote, `lastOkAt` when its last
tick finished cleanly. If `lastOkAt` falls behind while `heartbeatAt` keeps
moving, its ticks are failing (a provider down, a revoked key): the keeper
pages, and the GitHub standby takes over once the last clean tick is older
than 45 minutes.

### 8.4 Update it

Build the new image (part 8.1, `npm run check` first), put its tag in
`.env` (on the keeper PC: `notepad C:\Users\curbkeeper\curb-sharer\.env`),
then, in the folder:

```
docker compose up -d
```

The keeper finishes its current step before it stops. Nothing needs
migrating.

### 8.5 If the keeper host is lost

Nothing is lost. Set up a new one (part 8.6 or 8.7), repeat 8.2 and 8.3 with
the secrets from your password manager. The keeper rebuilds what it needs
from the chain and the published files. Until it is back, the GitHub Actions
standby takes over after 45 minutes.

### 8.6 The keeper on a PC (Windows)

The keeper's home is a separate Windows 11 Pro PC that stays on. It runs the
keeper and the PC verifier. It must come back by itself after a reboot or a
power cut with nobody at the keyboard, and keep the keys from anyone who
uses or takes it. Do these once, in order. "Admin PowerShell" means a
PowerShell window opened with Run as administrator from your own
administrator account.

1. **A Windows user only for the keeper.** From an admin PowerShell (the
   first line waits for you to type its password, unseen: a long one, saved
   in your password manager):

   ```
   $Password = Read-Host -AsSecureString
   New-LocalUser -Name curbkeeper -Password $Password -FullName "CURB keeper" -PasswordNeverExpires
   Add-LocalGroupMember -Group Users -Member curbkeeper
   ```

   It is a standard user, not an administrator. Use it for nothing else: no
   browser, no email, no downloads. Install and update software from your own
   administrator account.

2. **BitLocker on the system drive.** Control Panel → BitLocker Drive
   Encryption → Turn on BitLocker (or Settings → Privacy & security → Device
   encryption). Keep the default unlock by the TPM alone: a PIN at start-up
   would keep the PC from coming back by itself after a power cut. Save the
   recovery key in your password manager, not on this PC. Check it from an
   admin PowerShell; it must say "Protection On":

   ```
   manage-bde -status C:
   ```

   This protects the keys when the PC or its disk is taken while switched
   off. While it runs, step 4 and the locked screen of step 6 protect them.

3. **Docker Desktop.** Install Docker Desktop for Windows (docker.com) from
   your administrator account, with the WSL 2 backend. Then let the keeper
   user run it, from an admin PowerShell:

   ```
   Add-LocalGroupMember -Group docker-users -Member curbkeeper
   ```

   Sign in as `curbkeeper`, start Docker Desktop once, and in its Settings:
   - General → "Start Docker Desktop when you sign in to your computer": on.
   - General → "Use the WSL 2 based engine": on.
   - Software updates → automatic checks and downloads: off. Update it by
     hand once a month (part 11), so an update never restarts the engine
     unannounced.

   `docker-compose.yml` gives both services `restart: unless-stopped`, so they
   come back by themselves whenever the engine starts.

4. **The files, readable only by the keeper user.** Signed in as
   `curbkeeper`, make the folder of part 8.2 at
   `C:\Users\curbkeeper\curb-sharer` (a user's own folder is closed to other
   standard users already). Write each secret into
   `C:\Users\curbkeeper\curb-sharer\secrets` with Notepad, one value per file,
   saved with "Save as type: All files" so the name has no `.txt` ending
   (`publisher_key`, not `publisher_key.txt`). Then cut everyone else out,
   administrators included, in PowerShell as `curbkeeper`:

   ```
   icacls C:\Users\curbkeeper\curb-sharer\secrets /inheritance:r /grant:r "curbkeeper:(OI)(CI)R" "SYSTEM:(OI)(CI)F" /T
   icacls C:\Users\curbkeeper\curb-sharer\secrets
   ```

   The second command must list only `curbkeeper` (R) and
   `NT AUTHORITY\SYSTEM` (F). To change a secret later, give the keeper user
   write access for the time it takes, then run the first command again:

   ```
   icacls C:\Users\curbkeeper\curb-sharer\secrets /grant:r "curbkeeper:(OI)(CI)M" /T
   ```

   Docker Desktop shows files mounted from Windows to the container as
   readable by every user inside it, so the uid 1000 and mode 0400 of part
   8.7 neither apply nor work here: these Windows permissions are the lock.
   Once `config/sharer.json` is in the folder (part 7, at `DEPLOY.txt`
   STEP 9; before the deploy, the rehearsal folder's copies of these files
   are checked the same way, 16.1 step 3), `docker compose run --rm keeper
   check` must list each key by its address; a key it calls "not set" is a
   file the container cannot read.

5. **Never sleep, and come back after a power cut.** From an admin
   PowerShell:

   ```
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   powercfg /hibernate off
   ```

   In the PC's firmware setup (BIOS/UEFI), set the power-loss option
   ("Restore on AC power loss", "AC back") to Power On. A small UPS rides out
   short cuts. Nothing on this PC needs an open port: leave the router's port
   forwarding and Remote Desktop off.

6. **Sign in by itself at start-up, then lock.** Docker Desktop starts only
   when `curbkeeper` signs in, so the PC signs it in by itself and locks the
   screen straight after:
   - From your administrator account, run Microsoft's Sysinternals Autologon
     (learn.microsoft.com/sysinternals/downloads/autologon): user
     `curbkeeper`, its password, Enable. It keeps the password encrypted, not
     in plain text.
   - Signed in as `curbkeeper`, open Task Scheduler → Create Task. Name: "Lock
     after sign-in". Triggers → New → Begin the task: At log on, Specific
     user: `curbkeeper`, Delay task for: 1 minute. Actions → New → Program:
     `rundll32.exe`, Arguments: `user32.dll,LockWorkStation`.

   The locked session keeps running: Docker Desktop and the containers go on
   behind the lock screen. Test it once a keeper runs on this PC - during
   the rehearsal (16.2, with the `curb-rehearsal` project up, before 16.4's
   clean-up) or after part 8.3: restart the PC and do not touch it. Within
   20 minutes `ops/status.json` in the data repo must show a new
   `heartbeatAt`, and the screen must be locked.

7. **Windows Update never restarts it by itself.** From your administrator
   account, run `gpedit.msc` → Computer Configuration → Administrative
   Templates → Windows Components → Windows Update → Manage end user
   experience (on newer builds, its "Legacy Policies" folder):
   - "Configure Automatic Updates": Enabled, "3 - Auto download and notify
     for install";
   - "No auto-restart with logged on users for scheduled automatic updates
     installations": Enabled.

   Then once a month (part 11) install the updates from your administrator
   account (Settings → Windows Update) at a quiet hour and restart. The PC
   comes back by itself (step 6); if it takes longer than 45 minutes, the
   GitHub standby covers.

8. **The clock.** The lease and the 45-minute standby rule compare this PC's
   time with GitHub's. Settings → Time & language → Date & time: "Set time
   automatically" on, then "Sync now". Check from an admin PowerShell:

   ```
   w32tm /query /status
   docker run --rm --entrypoint date ghcr.io/<org>/curb-sharer:<commit> -u
   ```

   The first must show a recent "Last Successful Sync Time". The second is the
   time inside Docker's machine: it must match the real UTC time (time.is/UTC)
   within a few seconds. If it does not, restart Docker Desktop.

9. **The guardian is never on this PC**, nor its key, nor a Safe signer's
   key. This PC holds the publisher key; the guardian is there to catch what a
   stolen publisher key or a bug on this PC would publish.

10. **Health.** `ops/status.json` in the data repo: `heartbeatAt` not older
    than 15 minutes, `lastOkAt` close to it (part 8.3). In the folder,
    `docker compose ps` shows both services "healthy". The keeper pages when
    it goes too long without a clean tick, and a reboot, a power cut or a
    lost internet line on this PC is covered by the GitHub standby after 45
    minutes.

### 8.7 The keeper on a Linux server

When the keeper moves to a rented server: a small Linux VPS (1 CPU, 1 GB RAM,
10 GB disk) with Docker Engine, started at boot (`sudo systemctl enable
docker`). Make the folder of part 8.2 at `~/curb-sharer` and lock the secrets
down so only the container's user (uid 1000) can read them:

```
sudo chown -R 1000:1000 secrets && sudo chmod 0400 secrets/*
```

Then part 8.3. To move from the PC: stop the PC's services first
(`docker compose stop` in its folder), start the server's, check that the
server writes `ops/status.json`, and then delete the PC's secrets folder.

---

## 9. Running on GitHub Actions

Two workflows are in `.github/workflows/`:

- `sharing-keeper.yml`: the standby keeper, every 15 minutes. It acts only
  when the keeper PC's heartbeat, or its last clean tick, is older than 45
  minutes **and** it can take the lease (`ops/lease.json`). Only one keeper
  ever writes at a time.
- `sharing-verify.yml`: a verifier, every 15 minutes. It holds no key.

Both run from the public code repository of part 4.1, and act only on its
default branch (`main`, part 4.1) - the job compares the branch with the
repository's default, so no branch name is written in them. Each saves its
`/data` (the transaction journal, the alert cooldowns, the verifier's record)
even when a run fails, so a failing run does not page afresh every time.
While it stands in, the standby writes its own heartbeat,
`ops/status-standby.json`.

### 9.1 Environments and secrets

In the repository: Settings → Environments.

1. Create the environment **`sharing-mainnet`**.
   - Deployment branches: **Selected branches** → `main` only.
   - Required reviewers: none (a scheduled run cannot wait for approval).
   - Environment secrets:

     | Secret | Value |
     |---|---|
     | `SHARING_PUBLISHER_KEY` | the publisher private key |
     | `SHARING_STANDBY_PUSHER_KEY` | the standby pusher private key |
     | `SHARING_RPC_URLS` | provider A's and B's URLs, one per line |
     | `SHARING_DATA_REPO_TOKEN` | the fine-grained GitHub token |
     | `SHARING_PIN_TOKENS` | `{"pinata": "...", "filebase": "..."}` (and the third service's key, if it has one) |
     | `SHARING_ALERT_WEBHOOKS` | the same JSON as on the keeper host |

2. Create the environment **`sharing-verify`**, also limited to `main`, with
   `SHARING_VERIFY_RPC_URLS` (two providers) and `SHARING_ALERT_WEBHOOKS`.

The workflows never run on pull requests, and every action they use is
pinned to an exact commit.

### 9.2 Turn them on

Enable both workflows in the Actions tab (each was disabled in part 4.1:
open it, then "Enable workflow"). Push to `main` (`git push origin
master:main`) with `services/sharer/deploy/sharer.json` committed. In the
Actions tab, open each workflow, press "Run workflow" (branch `main`) once,
and open the run:

- The job must have **run**: a green tick. A grey "skipped" job means you
  started the run from a branch other than the repository's default: run it
  from `main`, and check that `main` is the default (part 4.1). GitHub sends
  no email for a skipped job. A scheduled run is never skipped by the job's
  condition; if `main` is not the default, scheduled runs start from the
  other branch and fail, red, at the environment's `main`-only rule (9.1).
- `sharing-keeper`: open the "Standby keeper tick" step. With the keeper PC
  healthy, its last line is a JSON line whose notes say
  `the primary (<holder>) beat Ns ago; standby stays idle`.
- `sharing-verify`: the "Verify every published epoch" step's last line is a
  JSON line with `"ok":true`.

Then wait for one **scheduled** run of each (within 15 minutes) and check it
the same way. Do this again after every change to the repository's settings.

### 9.3 Things to know

- GitHub runs scheduled workflows on a best-effort basis: a run can be late.
  That only makes epochs a little longer. This is why the keeper PC is the
  primary.
- GitHub runs scheduled workflows from the default branch only, and these two
  act only on the default branch, `main`.
- GitHub **switches scheduled workflows off after 60 days without a commit**
  to the repository. If that happens, GitHub emails you; press "Enable
  workflow" in the Actions tab.

---

## 10. The guardian

The guardian is the safety net against a stolen publisher key or a keeper
bug: it re-checks every epoch from scratch and vetoes a wrong one inside its
hour. It must be run by someone other than the keeper operator, on another
machine, with another RPC provider.

What the guardian operator does:

1. Creates the guardian key (part 3.1) and sends you its **address** only.
2. You (Safe A) make it a vetoer if it was not named at deploy: the Safe
   calls `addVetoer(<guardian address>)` on the HolderDistributorFactory.
3. On their machine, with Docker, a folder with `config/sharer.json` (your
   committed config - and every later change to its sharing block reaches
   them in the same step, part 7.1) and `secrets/` holding `guardian_key`,
   `rpc_urls` (their own two providers), `alert_webhooks` (their own and
   yours) and `data_repo_token` (the second token of part 4.2: with it the
   guardian writes `ops/status-guardian.json`, which every verifier
   watches). A guardian run without that token writes no heartbeat, and the
   verifiers then page "The GUARDIAN has never written a heartbeat" every
   12 hours unless every copy of the config sets `"verifier": {
   "guardianSilentAfterSec": 0 }` (outside the sharing block, so it needs
   no new rules version). On a Linux machine they lock it down as part 8.7
   does.
4. Checks it, tests the alerts, and starts it:

   ```
   docker run --rm -v "$PWD/config:/config:ro" -v "$PWD/secrets:/run/secrets:ro" \
     -e CURB_SHARER_CONFIG=/config/sharer.json ghcr.io/<org>/curb-sharer:<commit> check
   docker run --rm -v "$PWD/config:/config:ro" -v "$PWD/secrets:/run/secrets:ro" \
     -e CURB_SHARER_CONFIG=/config/sharer.json ghcr.io/<org>/curb-sharer:<commit> alert-test
   docker run -d --name curb-guardian --restart unless-stopped --read-only --tmpfs /tmp \
     -v "$PWD/config:/config:ro" -v "$PWD/secrets:/run/secrets:ro" -v curb-guardian-data:/data \
     -e CURB_SHARER_CONFIG=/config/sharer.json \
     ghcr.io/<org>/curb-sharer:<commit> guardian --loop --interval=60
   ```

What it does by itself:

- a root that does not verify, inside its hour → a `veto` sent the moment
  it is judged, before the next root is checked (with any other veto it
  owes, in one `vetoMany`). A veto that does not land (gas above its cap, a
  provider down, no ETH) pages ("The guardian could NOT veto", again every 5
  minutes) and is sent again at the start of every pass, before any root is
  checked, until the root is no longer pending or its hour is over. Just
  before each send it reads every root it is about to veto again, on both
  providers, and leaves out those no longer pending (a `vetoMany` naming one
  of them would revert whole);
- a second wrong root of the same launch within 30 days (an earlier veto for
  a RECOMPUTE or FILE_INVALID mismatch; an earlier veto of a root nobody
  could check does not count), or a file whose bytes match the on-chain hash
  but not its own root → it also **freezes** publishing, and keeps trying
  for a day if that fails;
- **three or more pending roots to veto at once** (`guardian.freezeAtBadRoots`,
  3; 0 turns it off): roots that do not verify, and roots that could not be
  verified past their grace or late in their hour → it **freezes first**,
  then vetoes them. A publisher holding a stolen key could otherwise queue
  many roots that are slow to check, the theft last, and outrun vetoes sent
  one by one. A freeze holds every pending root (none becomes payable while
  frozen, and each stays vetoable), so after it the vetoes go out together,
  one `vetoMany` per reason, up to 200 roots each. If the cause was an
  outage (the site and every gateway down, a provider failing), unfreeze
  once it is over (part 14);
- a root it cannot check at all (files missing, every served copy hashing to
  something other than the on-chain hash, its providers disagreeing, a check
  that did not finish in time) → vetoed once it has been unverifiable for
  `guardian.vetoUnverifiedAfterSec` (600 s, counted from its first such
  verdict on this guardian: an honest keeper reads its copies back before it
  publishes, so ten minutes is no passing hiccup), or at once in the last 15
  minutes of its hour (`guardian.vetoUnverifiedBeforeSec`, 900 s); on its
  own never frozen: copies that do not match the hash say something about
  whoever serves them (the site, a CDN, a gateway), not about the root.
  Served copies that do not match, a pending root no source serves at all,
  and a check that ran out of time page at once;
- **every pass is bounded in time**. It checks the pending roots first -
  those it has never judged before those it found unverifiable before, and
  among each the one whose hour ends first first; each root's check ends
  after `guardian.checkTimeoutSec` (120 s), every download and every read
  included (a publisher holding a stolen key chooses the URI, and could
  point it at a file that never finishes arriving), and is not started again
  while an abandoned one still runs; the checks of a pass end after
  `guardian.passTimeoutSec` (300 s), counted from the first check, so
  reading the roots and sending what it owed do not use that time up. A
  pending root the pass had no time for is **never vetoed for that**: no
  time is no evidence against a root. It pages ("The guardian had no time to
  check"); when such a root is in the last 15 minutes of its hour, it
  freezes instead, once, which holds every pending root until it has
  checked them. A pass that ran past its deadline counts as failed (it pages
  after 10 minutes of that);
- it reads every distributor's roots, and each root's `RootPublished`, on
  both of its providers, and pages when they differ: one provider cannot
  hide a root from it. The roots of every launch are read in a few
  Multicall3 requests per provider (100 launches each), so a pass does not
  grow with the number of launches; where Multicall3 does not answer it
  reads them one by one and warns;
- a copy that does not match while another does (the root verified) → a
  warning naming that copy and its sha256; the site copy of the epoch in
  force and the pending one is re-hashed on every pass, since the site's
  verify panel and Claim read it;
- it pages with the Safe's veto and freeze transactions **ready to sign**;
- an announced unfreeze → a page with two ready answers: the Safe's
  `cancelPending()`, and a vetoer's `freeze()`, which cancels an announced
  unfreeze (the owner must then announce again and wait another 48 hours).
  It does not freeze again for the announcement alone: whether the unfreeze
  was meant is a person's call. But when it owes a freeze (any of the
  reasons above) while the factory is frozen with an unfreeze announced, it
  freezes again: every root still pending when the unfreeze ripens becomes
  payable, so that is no freeze that holds;
- its key pays up to `guardian.maxGasPriceWei` (100 gwei; a veto is about
  100,000 gas), not the keeper keys' cap;
- it writes its heartbeat to `ops/status-guardian.json`, **signed with its
  vetoer key**, and the verifiers page when that goes stale or is not signed
  by a vetoer; it warns when its own key runs low on ETH.

### 10.1 Who runs it, and when

- **Name the operator before the first launch with sharing.** If $CURB
  launches with sharing on (`CURB_FIRST_SHARE=1` in `DEPLOY.txt`), that is
  deploy day: the guardian's address is then in `CURB_SHARING_VETOERS`, and
  the guardian runs from the head of `DEPLOY.txt` STEP 5, within the hour
  after the broadcast, with `check` saying `config ok` on its machine - long
  before you start the keeper (part 8.3).
- **What they need:** a machine that stays on, with Docker (a small Linux
  server is best), two RPC providers of their own (not A or B), the guardian
  key with about 0.02 ETH (part 3.1), the image, your committed config, alert sinks
  (theirs and yours), and the second data-repo token.
- **How they get the image:** best, they build it themselves from the public
  repository at the commit you name, so they trust nothing of yours but the
  code:

  ```
  git clone https://github.com/<org>/<repo>.git
  cd <repo>
  git checkout <commit>
  docker build -t ghcr.io/<org>/curb-sharer:<commit> services/sharer
  ```

  With Node 22.18 or later on that machine they run the suite first, as part
  8.1 does (`npm ci --no-audit --no-fund` and `npm run check` in
  `services/sharer`).
  If you publish images to GitHub's registry instead, note that a new package
  there starts private: GitHub → your organisation → Packages →
  `curb-sharer` → Package settings → Change visibility → Public.
- **After deploy**, they run `check` and `alert-test` with the real config,
  and you confirm on BaseScan (HolderDistributorFactory → Read Contract →
  `isVetoer`) that the guardian address is a vetoer.

### 10.2 If nobody else can run it: a fallback guardian

Without a guardian, a wrong root published at night is stopped only if a
verifier's page reaches a Safe signer and the Safe signs the veto within the
hour. If no second person is found before the first launch with sharing, run
a fallback guardian yourself, set up exactly as part 10 says, but:

- on a small rented Linux server of its own (1 CPU and 1 GB RAM are plenty;
  the cheapest plan of any host does), never the keeper PC and never a
  machine that holds the publisher or pusher keys or the keeper's RPC URLs;
- with a guardian key created for it alone (part 3.1), named in
  `CURB_SHARING_VETOERS` at deploy or added with `addVetoer` after;
- with its own two RPC providers, not A or B;
- with its alerts going to you, tested with `alert-test`;
- with an image built on that server (part 10.1).

It protects holders against a keeper bug and against a stolen publisher key,
as long as its server and its key stay apart from the keeper PC. It cannot
protect against someone who controls you and both machines: that is what a
second person adds. When one is found, hand over as part 12's guardian row
says.

### 10.3 The hour without the guardian

If the guardian is down, a wrong pending root is stopped only by a Safe
inside its hour. For a root that does not verify, or whose file no source
serves, or whose check runs out of time, the PC verifier pages within about
5 minutes of the publish and the GitHub verifier within about 15, which
leaves 45 minutes or more for a signer. A root a verifier cannot check for
another reason (its own providers disagree, its recompute fails) is only a
WARN ("Epoch N could not be verified") until it has been unverifiable on
that verifier for 10 minutes (`guardian.vetoUnverifiedAfterSec`), or its
hour is in its last 15 minutes, when it pages. While the guardian is down,
treat that WARN as a page. So:

- give Safe B a threshold one signer can meet alone (1 of 2, or 1 of 3). A
  vetoer can only veto and freeze, so the most a single signer can do alone is
  delay payouts, and one person, at night, is what the hour needs;
- make sure Safe B's signers get the PAGE alerts on their phones, with sound
  at night;
- have each signer open the Safe app once → New transaction → Transaction
  Builder with the HolderDistributorFactory's address, so that signing the
  ready-to-sign veto in an alert takes minutes.

Safe A, with its higher threshold, is the backup, not the plan.

---

## 11. Day to day

There is nothing to do while the alerts are quiet. To look anyway:

- `ops/status.json` in the data repo: the keeper's last heartbeat
  (`heartbeatAt`), its last clean tick (`lastOkAt`) and what each launch is
  waiting for;
- `ops/status-guardian.json`: the guardian's last heartbeat;
- `ops/status-standby.json`: the standby's, when it has stood in;
- on the keeper PC, in its folder: `docker compose logs --tail 50 keeper`;
- anyone can check an epoch:

  ```
  docker run --rm ghcr.io/<org>/curb-sharer:<commit> verify \
    --distributor <distributor> --epoch <n> \
    --rpc <a provider URL> --rpc <another provider URL> \
    --config https://<your site>/sharing/8453/config.json \
    --site https://<your site> --gateway https://ipfs.filebase.io
  ```

  Its verdict line reads `verdict      OK`, or `MISMATCH` or `UNVERIFIABLE` with
  exactly what does not match below it. Exit code 0 is OK, 1 is a mismatch,
  2 means it could not check.

- after a lost disk, `rebuild` refills `/data` at once (it is optional; the
  keeper rebuilds lazily):

  ```
  docker compose run --rm keeper rebuild
  ```

Once a month:

- each pinning plan's usage, files and storage, against part 5.1, and the
  keeper log for `a pin failed` (on the keeper PC, in its folder:
  `docker compose logs --since 720h keeper | Select-String "a pin failed"`);
- the data repo's size (part 5.1);
- the expiry dates of the data-repo tokens (part 12);
- the keeper PC: Windows updates and a restart (part 8.6 step 7), Docker
  Desktop's update, and afterwards `ops/status.json` beating again.

---

## 12. Rotating keys

| Key | How | Wait |
|---|---|---|
| **pusher** or **standby pusher** | 1. Create the new key and fund it. 2. Add its address to `sharing.rules.keeperKeys` as part 7.1 says (everywhere at once, `rules.version` raised). 3. Replace the secret (the keeper host's file / GitHub secret) and restart (`docker compose up -d`). 4. Move the old key's leftover ETH. | none |
| **publisher** | 1. Create the new key, fund it, add it to `keeperKeys` (part 7.1). 2. Safe A calls `announcePublisher(<new>)`. 3. After 48 hours (and within 7 days) anyone calls `executePublisher()`. 4. Replace the `publisher_key` secret on the keeper host **and** `SHARING_PUBLISHER_KEY` on GitHub, restart. The old key keeps working until step 3. | 48 h |
| **keeper payee** | Safe A calls `announceKeeperPayee(<new>)`; after 48 hours anyone calls `executeKeeperPayee()`. | 48 h |
| **guardian** (a new key, or a new operator taking over from your fallback guardian) | 1. The operator creates a new key. 2. Safe A calls `addVetoer(<new>)` (immediate). 3. The operator switches the secret and restarts (a new operator starts their guardian as part 10 says). 4. Safe A calls `announceVetoerRemoval(<old>)`; after 48 hours anyone calls `removeVetoer(<old>)`. That call is refused while any root is still in its veto hour, so **stop the keeper for an hour** (`docker compose stop keeper`, and disable the `sharing-keeper` workflow) before it, and start both again after. Then stop the old guardian. | 48 h |
| **data repo tokens** | Generate a new fine-grained token (part 4.2), replace the keeper host's secret file and the GitHub secret (or the guardian's secret file, for its token), restart, delete the old token. | none |
| **pin tokens, RPC URLs, alert webhooks** | Replace the secret file / GitHub secret, restart. After new alert webhooks, run `alert-test` on that host. | none |

A key you think was **stolen** is an emergency: part 14.

---

## 13. Alerts: what each means and what to do

The alert sinks are set in the `alert_webhooks` secret:

```json
{ "telegram": { "token": "<bot token>", "chatId": "<chat id>" },
  "discord": "<webhook url>",
  "email": { "url": "https://api.resend.com/emails", "key": "<api key>", "from": "keeper@your-domain", "to": ["you@your-domain"] } }
```

Any of the three may be left out (a plain `"webhook": "<url>"`, or
`{ "url": ..., "bearer": ... }`, is a fourth kind), but not all: a host with
no sink keeps every alert in its own log, so `check` says NOT OK ("no alert
sink") and a running service logs `no alert sink is configured` when it
starts. After setting or changing them on a host, run `alert-test` there
(on the keeper PC: `docker compose run --rm keeper alert-test`): every sink
must receive "Test alert from <host>" (INFO; `check --probe` sends the same
one). Its exit code is 0 when every sink took it, 1 when one failed and 2
when none is set. GitHub's workflows cannot run it; the standby's first WARN
(part 16.5) proves their secret. `PAGE` alerts need you now; `WARN` within a
day; `INFO` is for the record. The same alert is not repeated within an hour
(reminders for ongoing problems come every 12 hours).

| Alert | Level | What it means | What to do |
|---|---|---|---|
| The RPC providers DISAGREE | PAGE | The keeper's two providers gave different answers. It wrote nothing. | Usually one provider is behind or broken. Check its status page. If it persists, replace that provider's URL. If both look healthy, ask the guardian operator what they see. |
| The `publisher`/`pusher` key is LOW ON ETH | WARN | Below 0.005 ETH. | Send it ETH. |
| The `publisher`/`pusher` key is OUT OF ETH | PAGE | It stopped. Payouts wait (nothing is lost). | Send it ETH. The next run continues by itself. |
| A `publisher`/`pusher` transaction is stuck | PAGE | Not mined after several fee increases, or gas is above the cap. | Usually a gas spike: wait. It is resumed at the same nonce on the next run. |
| A price is missing | WARN | A quote asset's Chainlink feed did not answer. Its keeper fee counts as 0 and its epochs wait for the 7-day rule. | Check the feed on data.chain.link. Nothing else to do; it recovers by itself. A feed that was replaced or retired is a change to the sharing block (part 7.1). |
| An epoch file could NOT be published | PAGE | Writing to the data repo, pinning, or reading back the file or one of its chunk files failed (the text names the chunk: past 512 accounts each chunk goes through all three before the index does), or the file is above the 64 MiB every reader holds it to (then nothing was written or pinned). Nothing went on chain. | Check GitHub status, the token's expiry, each pinning plan (part 5.1) and service. It tries that launch again after `keeper.minEpochGapSec` (an hour), not every run: each try recomputes the epoch and writes and pins the files again (a chunk's path is its hash, so writing it again changes nothing). |
| An epoch file is GROWING large | PAGE (every 12 h) | A launch's epoch file - its index and its chunk files together - reached `keeper.largeFileBytes` (8 MiB) or `keeper.largeFileAccounts` (50,000 accounts or leaves). No file outgrows the read-back limit any more: past 512 accounts the rows go in chunk files of 512 (about 130 KiB each), and the index the chain hashes grows by some 350 bytes a chunk. But its leaves only accumulate, and every epoch writes, pins and reads back each chunk file, and every verifier and the guardian reads them all within `guardian.checkTimeoutSec`: the pinning plans fill and the checks slow down. A spray of tokens to fresh addresses grows it. It is still published. | Tell the developers, with the distributor address and the figures in the alert; look at who is adding accounts, and at each pinning plan's space (part 5.1). |
| A CONTRACT holds a large share of a launch's holder weight | WARN (once per address) | An address with code that no rule excludes carries 5% or more of an epoch's weight. Pools (anything whose `token0()` or `token1()` is the launch token) are excluded whatever their factory; this is something else - a vault, a lending market, a bridge, a pool of another shape, or a Safe or smart wallet. | Look the address up on BaseScan. A Safe or a smart wallet is a holder like any other: nothing to do. A contract that cannot pass its share on to people, or lets anyone take it, goes into `sharing.rules.exclusions` under a new rules version (part 7.1). |
| A distributor is STALLED | PAGE | An epoch has been due for 24 hours and none was published. | Read the other alerts and the keeper log for the reason. |
| Income is waiting in the core | WARN | A harvest could not collect part of a launch's income (an issuer blocking the distributor, for example). | Nothing is lost; it waits. If it lasts, ask the asset's issuer. |
| harvest() would REVERT | PAGE | A launch's harvest cannot run. | Report it to the developers with the distributor address. |
| An epoch was VETOED | PAGE | A vetoer stopped a pending root. | Read why; then the "A VETOED epoch waits for an operator" row. |
| A VETOED epoch waits for an operator | PAGE | An epoch was vetoed. The keeper will not publish that launch again until you say so. | Find out why (the guardian's or verifier's mismatch alert says). Fix the cause. Then run: `docker compose run --rm keeper ack-veto --distributor <address> --epoch <n> --by <your name>`. The next epoch recomputes the vetoed range. |
| Epoch N does NOT verify - veto it | PAGE | A verifier recomputed an epoch and got something else. | If the guardian did not veto within minutes, sign the **ready-to-sign** veto in the alert from Safe A or Safe B (Transaction Builder: to, value 0, data). If a stolen key is possible, also sign the freeze. |
| Epoch N does NOT verify and is no longer vetoable | PAGE | A wrong root became payable, or this host's sharing block is out of step (part 7.1). | Follow part 14, "A wrong root became payable": rule out the second case first, then freeze. |
| An ACTIVE root does not verify | PAGE (hourly) | The epoch in force of a launch did not verify on this host. | As the row above. After a freeze it repeats every hour until the next epoch of that launch activates (part 14). |
| Epoch N could not be verified | WARN / PAGE | A pending root could not be checked. PAGE at once when no source serves its file at all, when its check did not finish within `guardian.checkTimeoutSec` (or an earlier one still runs), or when this host's providers disagree on it (an honest keeper reads its copies back before publishing, so a person looks now); WARN for other reasons (this host's providers disagree on the epoch's data, the recompute failed) until it has been unverifiable for `guardian.vetoUnverifiedAfterSec` (10 minutes) or its hour is in its last 15 minutes, then PAGE ("... for N s" or "... its veto hour is nearly over"), and the guardian vetoes it. | Check the site and IPFS. A veto for this reason only delays payouts. While the guardian is down, treat even the WARN as a page (part 10.3). |
| Epoch N: the served copies do not match the on-chain hash | PAGE | No copy (site, gateways) hashes to the contentHash on chain. Each copy's sha256 is named, and a gateway copy says whether it is the bytes of its CID. After 10 minutes of this, or late in the hour, the guardian vetoes it; on its own it never freezes for this (three or more roots to veto at once do, the row below). | Republish the file from the keeper's `/data` or the data repo (its sha256 must match), and check the site's hosting and the gateways. |
| `<N>` pending roots do NOT verify or cannot be verified - the guardian freezes | PAGE | `guardian.freezeAtBadRoots` (3) or more pending roots are to be vetoed at once: roots that do not verify, and roots that could not be verified for 10 minutes or late in their hour. The guardian freezes first, then vetoes them together (a verifier pages with the freeze ready to sign). | If they do not verify: treat as a stolen publisher key (part 14). If it was an outage (the site and every gateway down, a provider failing): fix it; once the vetoed epochs are acknowledged (`ack-veto`), unfreeze (`announceUnfreeze()` by Safe A, `unfreeze()` 48 hours later). |
| The guardian had no time to check `<N>` pending root(s) | WARN / PAGE (every 5 min) | Its checks ran past `guardian.passTimeoutSec`: too many pending roots at once, or checks too slow. It never vetoes a root it has not checked; it checks them on the next passes. PAGE when one of them is in the last 15 minutes of its hour: then the guardian freezes instead (once), which holds every pending root until it has checked them. | Look at the guardian's log for what is slow (a file that trickles, a recompute, a provider). After a freeze, as the row above. |
| Multicall3 did not answer: every root was read on its own | WARN (every 12 h) | On the provider named, an `aggregate3` call to Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) failed, so the roots were read one call per distributor: correct, but a pass takes longer the more launches there are. | Check that provider; replace its URL if it persists (part 12). |
| Epoch N: the site copy does not match the on-chain hash | WARN | The root verified from another copy, but users reading this one are told the file does NOT check out. | Republish that copy (the data repo file behind the site, or the pin). A gateway copy of an old epoch you unpinned (part 5.2) is expected. |
| The guardian FROZE holder sharing | PAGE | The text says why: a repeated wrong root (a second RECOMPUTE or FILE_INVALID mismatch of the same launch within 30 days; a veto of a root nobody could check does not count), a file whose bytes match the on-chain hash and not its own root, three or more pending roots to veto at once, or pending roots in their last minutes it had no time to check. If the factory was frozen already with an unfreeze announced, it says that this freeze cancelled the unfreeze. Active roots keep paying; every pending root is held; nothing new is published. | Treat as a stolen publisher key (part 14). Unfreezing is `announceUnfreeze()` by Safe A, then `unfreeze()` after 48 hours. |
| Holder sharing is FROZEN (when it happens), then Holder sharing is frozen | PAGE, then PAGE (every 12 h) | The factory is frozen; the first names who froze it. | As above. |
| activate() reverted Frozen | WARN | A root was held by a freeze. | Expected while frozen. |
| This keeper is NOT the factory publisher | PAGE | The publisher on chain is another address. It pushes payouts but publishes nothing. | If you rotated the publisher, update the secret. If you did not, treat it as an emergency (part 14). |
| The `publisher`/`pusher` key is not in rules.keeperKeys | WARN | Its gas would never be counted in the keeper fee. | Add it (part 12, pusher row). |
| A new holder-sharing PUBLISHER was announced | PAGE | Someone with Safe A announced a new publisher (effective in 48 h). | If you did not, cancel it: Safe A signs the ready-to-sign `cancelPending()`, and consider freezing. |
| A new KEEPER PAYEE was announced | PAGE | As above, for the keeper payee. | As above. |
| The REMOVAL OF A VETOER was announced | PAGE | A vetoer will be removable in 48 h. If it says "THIS guardian", it is the guardian's own key. | If you did not plan it, Safe A signs the ready-to-sign `addVetoer(...)`, which cancels it. |
| An UNFREEZE was announced | PAGE | Publishing can resume in 48 h; every pending root not vetoed by then becomes payable. | Make sure the guardian has vetoed every wrong pending root before then. If the Safe did not mean it, cancel it: Safe A with the ready `cancelPending()`, or any vetoer (Safe B, the guardian's key) with the ready `freeze()` - a freeze cancels an announced unfreeze, and the owner must announce again and wait another 48 hours. |
| An announced unfreeze was CANCELLED by a freeze | WARN | A vetoer or the owner froze the factory again while an unfreeze was announced, which cancelled it; the text names who ("THIS guardian" when it was this one). Publishing stays frozen. | If it was planned, nothing. If no vetoer or Safe signer did it, a vetoer key may be in the wrong hands: find out whose, and have Safe A remove it (announceVetoerRemoval, 48 h). Unfreezing again is `announceUnfreeze()` by Safe A, then `unfreeze()` 48 hours later. |
| A vetoer was ADDED / REMOVED | WARN / PAGE | The vetoer list changed. | Check it was planned. |
| Holder sharing was unfrozen / The publisher changed / The keeper payee changed | WARN | An announced change was carried out. | Check it was planned. |
| The publisher was REVOKED | PAGE | Safe A removed the publisher. | Expected only in an emergency. |
| A new DISTRIBUTOR FACTORY was proposed in the SharingCatalog | PAGE | A new distributor version will be admitted in 7 days. | Have its source reviewed before then; the ready-to-sign `cancel(...)` stops it. |
| A distributor factory was admitted / retired, the recommended one changed | WARN / INFO | Catalog changes. | Check they were planned. |
| The standby keeper is acting | WARN | The keeper PC's heartbeat, or its last clean tick, is older than 45 minutes. | Fix the keeper PC (part 8). Nothing is lost meanwhile. |
| The guardian key is NOT a vetoer | PAGE | The guardian cannot veto. | Safe A calls `addVetoer(<guardian address>)`. |
| The guardian could NOT veto / freeze | PAGE (every 5 min) | Its transaction failed: gas above `guardian.maxGasPriceWei`, no ETH, a stuck key, a provider down, or a revert. It is tried again at the start of every pass while the root is pending (a freeze, for a day). | Sign the ready-to-sign transaction in the alert from a Safe now; then find out why (fund the key, check its providers). |
| The guardian's veto of epoch N did NOT land in time | PAGE | The guardian had decided to veto a root and could not before its hour ended; the text says if the root is now active. | Part 14, "A wrong root became payable": freeze first. |
| The guardian GAVE UP freezing | PAGE | A freeze it decided failed for a whole day. | Decide yourself: sign the ready-to-sign freeze from a Safe if it is still needed. |
| This host's providers DISAGREE on a distributor's roots | PAGE | The guardian or a verifier read `active()`/`pending()` of a distributor differently on its two providers. A pending root either one shows is treated as unverifiable (vetoed after 10 minutes of that, or late in its hour). | One provider is behind or wrong: check its status, replace its URL if it persists (part 12). |
| Epoch N is on chain, and its RootPublished cannot be trusted | PAGE | The event that names the root's URI is missing on a provider, or differs between them. The root is treated as unverifiable. | As the row above. If both providers look healthy, sign the veto from a Safe before the hour ends. |
| Another holder KEEPS THE KEEPER LEASE | PAGE (every 12 h) | Somebody else's lease in `ops/lease.json` has kept this keeper from writing for longer than one standby run plus the TTL (`lease.blockedAfterSec`, 30 minutes). Its ticks count as failing from then on. The text names the holder and when its lease ends. | If no keeper of yours runs under that name (a standby run is `gha-<run id>-<attempt>`), a data repo token is in the wrong hands: revoke every data repo token (part 12), make new ones, then delete `ops/lease.json` in the data repo. |
| A published epoch file cannot be found | WARN | `rebuild` could not fetch an old file. | Check the site and IPFS; restore the file from any copy (its sha256 must match). |
| `<The keeper / The STANDBY keeper / The guardian / A verifier>` has had NO CLEAN TICK for `<time>` | PAGE (every 12 h) | Every tick of that service has failed for that long: the keeper and the standby after 30 minutes (`keeper.failingAfterSec`), the guardian after 10 (`guardian.failingAfterSec`), a verifier after 30 (`verifier.failingAfterSec`). The text names the last error. Its heartbeat may still move; its `lastOkAt` does not. A guardian or verifier pass whose checks ran past `guardian.passTimeoutSec` (300 s, counted from its first check) counts as failed ("this pass ran past its deadline"), and so does a keeper tick once another holder has kept the lease from it too long ("Another holder KEEPS THE KEEPER LEASE"). | Read the last error: usually a provider down, out of quota or with a revoked key (replace its URL, part 12), or a refused token (the next row). The standby replaces a keeper whose last clean tick is 45 minutes old; while the guardian is down only a Safe can veto (part 10.3). |
| GitHub REFUSED the data repo token | PAGE (every 12 h) | GitHub answered 401 or 403, not a rate limit: the token expired, was revoked, or lost Contents: Read and write. Nothing is published, and a keeper writes no heartbeat or lease, so the standby cannot see it either. | Generate a new token and put it on every host that holds the old one (part 12, data repo tokens), then restart. |
| NO KEEPER has finished a clean tick for `<time>` | PAGE (every 12 h) | A verifier read both heartbeats (`ops/status.json`, `ops/status-standby.json`): neither the keeper PC nor the standby has finished a clean tick for `verifier.keeperSilentAfterSec` (90 minutes by default, twice the standby's 45). No epoch, activation or payout happens; the income waits. | Fix the keeper PC (part 8), and check that the `sharing-keeper` workflow is enabled and its runs succeed (part 9). |
| The GUARDIAN has not finished a clean tick for `<time>`, or The GUARDIAN has never written a heartbeat, or The GUARDIAN heartbeat is NOT SIGNED by a vetoer | PAGE (every 12 h) | A verifier read `ops/status-guardian.json`: its last clean tick is older than `verifier.guardianSilentAfterSec` (30 minutes), or there is none - the guardian has no data repo token, or has never run - or it is not signed by a vetoer of the factory (anyone with a data repo token can write that file; the text says what is wrong with it). | Ask the guardian operator to check their container (part 10). Until it is back, a wrong root is stopped only by a Safe inside its hour (part 10.3). A guardian that runs without a token on purpose needs `guardianSilentAfterSec` 0 (part 4.2). A heartbeat NOT SIGNED by a vetoer while the guardian runs means somebody else wrote it with a data repo token: revoke those tokens (part 12), and watch the hour yourself until the guardian's own heartbeat is back. |
| The guardian key is LOW ON ETH | WARN | Below `guardian.lowEthWei` (0.005 ETH). A veto it cannot pay for leaves only the Safe signers. | The guardian operator sends it ETH. |
| A launch is STUCK in Waiting: its graduation failed | PAGE (every 12 h) | A launch is ready to graduate and has not (its automatic graduation failed: AutoGraduationFailed). Nobody can buy or sell it until `graduate()` runs. This keeper did not send it: it holds no pusher key, `keeper.completeGraduations` is off, or the send failed (the text says which). The alert carries the ready `graduate(<token>)` call. | Anyone may send it: the launch's page has Complete the move, or send the ready call from any wallet. If it keeps failing, report it to the developers with the token's address. |
| A launch is STUCK in Waiting and graduate() would REVERT | PAGE (every 12 h) | As above, but the call would revert, so `graduate()` was not sent. The keeper sends `Graduator.noteReady(<token>)` instead, once (it reads `readySince` first), so the hour after which anyone may rescue the curve's fees starts without a person; the text says when it opens. The alert carries the ready `graduate` and `rescueCurveFees` calls. | Usually an issuer blocking the launch's escrow: `Graduator.rescueCurveFees(<token>)` first - the curve's creator-fee recipient and the platform recipient (the platform Safe: the quickest way out) may send it at once, anyone else an hour after `noteReady` (`DEPLOY.txt`, A LAUNCH STRANDED BY THE ISSUER) - then `graduate()`. Otherwise report it to the developers. |
| A launch stuck in Waiting was graduated by the keeper | WARN | The keeper found a launch in Waiting and sent `graduate()` itself; the text names the transaction. | Nothing: it trades again. Tell the developers if it recurs. |
| The sharing config changed WITHOUT a new rules version (`<N>`) | PAGE (every 12 h) | The published `sharing/8453/config-v<N>.json` differs from this keeper's sharing block under the same version; the text names each difference. The keeper publishes nothing while it lasts. | A host was changed without part 7.1: raise `sharing.rules.version` everywhere at once (part 7.1), or put this host's copy back as it was. |
| A new PLATFORM RECIPIENT was announced on the FeeHook, or A new PLATFORM FEE was announced on the FeeHook | PAGE | The policy Safe announced a new platform recipient or fee for launches created after it executes it (24 h). | If the Safe did not mean it, sign the ready-to-sign cancel (`cancelPlatformRecipient()` or `cancelPlatformFeeBps()`) from Safe A before the 24 hours end. |
| The platform recipient changed, or The platform fee changed | WARN | An announced change was executed: launches created from now on carry it. A cancelled announcement is INFO. | Check it was planned. |
| An UNLISTED LAUNCHER was admitted to the LaunchRegistry | PAGE | A factory not in `launchers` can register NEW launches from now on, the create form offers it at once, and nothing can remove it. It cannot touch an existing launch: the registry records only a curve whose token, quote asset and Graduator are the new launch's own and that no launch used before. The launches it creates run its code, not Curb's. | If the registry's owner did not mean it, its key is compromised: hide the factory (`web/config.js` hiddenFactories, `INCIDENT.txt`), warn users not to buy launches it creates, and treat the owner's key as stolen (part 14). If it was meant (part 7.2 done out of order), add it to `launchers` on every host. |
| A listed launcher was admitted to the LaunchRegistry | INFO | The Safe's `addLauncher` for a factory the config lists (part 7.2). | Nothing. |
| An OWNERSHIP TRANSFER of `<the contract>` was started | PAGE | The owner of the LaunchRegistry, the FeeHook, the SharingCatalog or the HolderDistributorFactory offered it to an address that is not Safe A. The moment that address accepts, it holds every owner power of it. | If nobody meant it, the current owner signs the ready-to-sign `transferOwnership(0x0000000000000000000000000000000000000000)`, which withdraws the offer, now. |
| The handover of `<the contract>` to the owner Safe was started | WARN | The offer is to Safe A: right after the deploy, the LaunchRegistry's (`DEPLOY.txt` STEP 4B). | Safe A signs the ready-to-sign `acceptOwnership()`. |
| `<the contract>` is now owned by the owner Safe | WARN | Safe A accepted. | Nothing. |
| `<the contract>` has a NEW OWNER | PAGE | Ownership moved to an address that is not Safe A. | If nobody meant it, treat it as a stolen key: part 14, and `INCIDENT.txt`. |
| Pending role changes were cancelled / A catalog proposal was cancelled / An announced platform recipient was cancelled / An announced platform fee was cancelled / A pending ownership transfer of `<the contract>` was cancelled / `<the contract>` was created | INFO | For the record. | Nothing. |

---

## 14. Emergencies

**The publisher key may be stolen.**
1. Safe A: `freeze()` (immediate) and `revokePublisher()` (immediate).
2. Any root a thief got pending is held by the freeze and can be vetoed at
   any time while frozen: the guardian does this, or sign `vetoMany` from a
   Safe.
3. Create a new publisher key (fund it and add it to `keeperKeys`, as
   part 12's publisher row says). Safe A calls `announcePublisher(<new>)`
   and, once the cause is understood, `announceUnfreeze()`; the two can be
   announced together.
4. After 48 hours, and within 7 days, anyone calls `unfreeze()` **first**
   and only then `executePublisher()`. A freeze holds a publisher rotation,
   so `executePublisher()` reverts `PublishingFrozen` while frozen. Replace
   the secrets once `executePublisher()` has run.
Payouts of the last good active root continue the whole time. Nothing paid
is ever taken back, and the contracts never pay more than they received.

**A wrong root became payable** (the alerts "Epoch N does NOT verify and is
no longer vetoable" and "An ACTIVE root does not verify"). A root nobody
vetoed in its hour pays. Nothing paid can be taken back, and every later
epoch of that launch continues from it, so the aim is to stop a second one,
find the cause and tell holders.

1. **Rule out a host out of step** (minutes). If the alert says the file
   names a rules version other than the host's config, check the epoch with
   the config of the file's own version, as part 7.1 shows (`--config
   https://<your site>/sharing/8453/config-v<file's version>.json`).
   A verdict line reading `verdict      OK` means the root is right and that
   host's config is the one to fix. Ask the guardian operator what their
   guardian says. Go on only when a host with the current config says
   mismatch.
2. **Freeze**, unless the guardian already did: sign the ready-to-sign
   `freeze()` in the alert from Safe A or Safe B. From then on:
   - no root is published or activated for **any** launch, for at least 48
     hours (an unfreeze is announced and waits 48 hours);
   - every pending root is held, and can be vetoed at any time while frozen;
   - every active root keeps paying, the wrong one included: the keeper keeps
     pushing and holders can claim. That cannot be stopped, and later epochs
     build on that root anyway;
   - income keeps arriving in every distributor and waits; nothing is lost.
     The first epoch after the unfreeze covers the whole frozen time.

   If the root's publish transaction did not come from your keeper (BaseScan:
   the transaction that emitted its `RootPublished`; the keeper log names
   every transaction it sent), treat it as a stolen publisher key: the
   emergency above, now, `revokePublisher()` included.
3. **Tell holders** the same day, on X and in the site's notice (`banner` in
   `web/config.js`): which launch and epoch, that publishing is stopped for
   every launch until the unfreeze (give the earliest date), that payouts in
   force keep paying, that income keeps accruing and will be shared when
   publishing resumes, and that nothing already paid is affected.
4. **Size it.** The most a wrong root can misdirect is what that distributor
   held unpaid when it activated: a root can never allocate more than the
   distributor received, and what was already paid stays paid. Other launches
   are not touched: each distributor holds only its own launch's income. For
   the exact figure, take the bad file (`sharing/8453/<distributor>/<n>.json`
   in the data repo) to the developers: they recompute the honest file for
   the same harvest, as the verifier did, and compare the two leaf by leaf.
   The accounts given more than their share (the over-allocation) and those
   given less (the shortfall) add up to the same amount. Whether anyone makes
   up the shortfall is your decision; a donation to the distributor is shared
   among all its holders by the normal rules, not given to the accounts that
   were short.
5. **Fix the cause** before unfreezing: a keeper bug → the developers fix it
   and you update the image (part 8.4); a stolen key → the emergency above; a
   wrong config → part 7.1.
6. **Unfreeze** when the cause is fixed: Safe A calls `announceUnfreeze()`.
   After 48 hours, and within 7 days after that (a later call fails and the
   announcement must be made again), anyone calls `unfreeze()`. Before the 48
   hours are up, make sure every pending root is verified or vetoed (part 13,
   "An UNFREEZE was announced").
7. **After the unfreeze** the keeper publishes by itself again, continuing
   from the active root, the wrong one: its next file opens from that root's
   balances and totals, and the verifiers and the guardian check it against
   the same root, so a correct next epoch verifies. "An ACTIVE root does not
   verify" pages every hour until the next epoch of that launch activates (an
   hour after it is published), and "Holder sharing is frozen" every 12 hours
   until the unfreeze; neither needs anything more from you. Tell holders
   when publishing has resumed, with the figure of step 4.

**A pusher key may be stolen.** It has no role. Move its ETH out, rotate it
(part 12). The thief can only waste its gas.

**The guardian key may be stolen.** A vetoer can only delay payouts. Rotate it
(part 12).

**Safe A may be compromised.** It cannot take holders' money directly, and
every change that could let a wrong payout through is announced 48 hours
ahead and alerted. Use those 48 hours: holders can claim what the active root
gives them.

---

## 15. Command reference

| Command | Keys | What |
|---|---|---|
| `keeper --loop --interval=300` | publisher, pusher | the keeper on the keeper host |
| `keeper --once` | publisher, pusher | one keeper run; like every `--once`, it prints what the run did (actions, notes, errors, each launch's epoch line) as one JSON line |
| `keeper --once --standby` | publisher, standby pusher | GitHub Actions: only if the keeper host is silent |
| `verify --loop` / `verify --once` | none | check every epoch, alert |
| `verify --distributor X --epoch N --rpc URL [--rpc URL] --config FILE\|URL [--site URL] [--gateway URL]` | none | the public check of one epoch; `--config` is required (the published `sharing/<chain>/config.json`, or a file) |
| `guardian --loop --interval=60` | guardian | check every epoch, veto and freeze |
| `rebuild` | none | refill `/data` from the chain and the files |
| `ack-veto --distributor X --epoch N --by NAME` | none (the data repo token) | let the keeper recompute after a veto |
| `check` | none | the chain, the contract addresses and their wiring, the launchers and owners, the keys against their roles, `eth_call` with no `to`, the published config of this rules version, which secrets are present, and an alert sink (part 7) |
| `check --probe` | none (the data repo and pin tokens) | also a probe file written to the data repo and read back, pinned on every pinner with its CID compared, read back through the site and the gateways, deleted again, and a test alert (part 7) |
| `check --print-public-config` | none | also prints the sharing block as the keeper publishes it (part 7.3) |
| `alert-test [--note TEXT]` | none | one test alert to every sink in `alert_webhooks`; exit 0 all took it, 1 one failed, 2 none set (part 13). Run it on every host |

Not a mode of the image: `npm run config-from-run -- --run <record> [--run <a later asset's record>] [--from <base config>] [--out <file>] [--keeper-key 0x...]... [--bump]`,
run in `services/sharer` of a clone with Node 22.18 or later, writes the
config from the deployment's records (parts 7 and 7.2).

Settings that are not secrets come from the config file; secrets come only
from Docker secrets (`/run/secrets/<name>`) or, on GitHub Actions, from the
environment (`CURB_SHARER_<NAME>`). The service never logs a secret.

---

## 16. The rehearsal before launch

Do 16.1 to 16.4 once, after parts 2 to 6, 8.1, 8.2 and 8.6 and before the
deploy (`DEPLOY.txt` PREP 3). Part 10, the guardian, starts at the head of
`DEPLOY.txt` STEP 5, within the hour after the broadcast and before STEP 4A;
part 7's config is generated then and committed in STEP 5; its check on the
keeper, and parts 8.3 and 9, come at `DEPLOY.txt` STEP 9, and 16.5 after
them.
It runs one full epoch through the real data repo, the real pinning
services, the real site and the real alert sinks, with a fork of Base as the
chain, so nothing real is paid; then it makes the standby take over. Any step
that fails is fixed and run again before launch.

The fork serves chain id **84531**, not 8453. Everything it produces lands
under `sharing/84531/` in the data repo (the site's rewrite serves any chain
number), never under `sharing/8453/`, and a transaction signed for it is not
valid on Base. The `ops/` files (heartbeat, lease) have no chain in their
path, so parts 16.1 to 16.4 run while the real keeper is **not** running:
before the deploy, and so long before part 8.3 starts it.

### 16.1 Set it up

1. *The developers:* start a Base fork serving chain 84531 where the keeper
   PC can reach it (on the keeper PC itself, or on a machine on the same
   network), deploy the CURB stack on it with **your** publisher, keeper
   payee and guardian addresses as the roles, give your publisher, pusher and
   standby pusher fork ETH, and make one WETH launch with holder sharing on,
   with a few test buyers. They give you the fork's URL and a config made
   from the fork deployment's own record with `npm run config-from-run`
   (part 7), from a copy of the example whose `sharing.chainId` is
   `"84531"`: its contract addresses, launchers and exclusions are the
   fork's.
2. Make a rehearsal folder next to the real one,
   `C:\Users\curbkeeper\curb-rehearsal`, laid out as part 8.2: the same
   `docker-compose.yml` and `.env`; `config/sharer.json` = that config,
   with `dataRepo`, `ipfs` and your keeper keys exactly as the real one will
   have them (part 7), and `site.base` = the hosting project's own address
   (for example `https://<project>.vercel.app`), which serves the same
   `/sharing/<chain>/` rewrite (part 4.3): the real domain is attached only
   at `DEPLOY.txt` STEP 8, so it does not reach the project yet. 16.2's
   site checks read that address. `secrets/` = copies of the real ones,
   locked as part 8.6 step 4 says, except `rpc_urls` and `verifier_rpc_urls`,
   which hold the fork's URL on **both** lines (one fork stands in for both
   providers). On the keeper PC itself the containers reach a fork on the
   PC as `http://host.docker.internal:<port>`.
3. Every rehearsal command names its own project, `-p curb-rehearsal`, so its
   containers and volumes never mix with the real ones. In the rehearsal
   folder:

   ```
   docker compose -p curb-rehearsal run --rm keeper check --probe
   docker compose -p curb-rehearsal run --rm keeper alert-test
   ```

   Every line must be ok, and the test alert must reach every sink.

**Never rehearse as chain 8453 at the data repo's root.** The real keeper
refuses to publish while `sharing/8453/config-v<N>.json` holds another
configuration under its own rules version ("The sharing config changed
WITHOUT a new rules version"). A rehearsal keeper with `sharing.chainId`
`"8453"` writing at the root would leave exactly that behind - its
`config-v1.json`, naming the fork's contracts - and mainnet publishing would
stop until someone deleted it. That is why the fork serves 84531. If the
developers' fork must serve 8453, give the rehearsal config
`"dataRepo": { ..., "root": "rehearsal/" }`: every file it writes, `ops/`
included, then lands under `rehearsal/`, so it touches nothing of the real
keeper's (and could even run beside it). The site's rewrite does not serve
that folder, so `site.base` must then be
`https://raw.githubusercontent.com/<org>/curb-sharing-data/main/rehearsal`,
and the rehearsal no longer proves the site's rewrite (16.2's site checks
read that address instead). Cleaning up (16.4) is then deleting
`rehearsal/`.

### 16.2 One epoch

1. Start it, and follow the keeper:

   ```
   docker compose -p curb-rehearsal up -d
   docker compose -p curb-rehearsal logs -f keeper
   ```

2. *The developers* trade on the fork until an epoch is due. Then check, in
   order:
   - the keeper log: the harvest, `epoch file in the data repo`,
     `epoch file published and read back`, the `publishMany` transaction;
   - the data repo: `sharing/84531/<distributor>/1.json` and `latest.json`,
     `sharing/84531/config.json` and `config-v<N>.json`, and `ops/status.json`
     with `heartbeatAt` and `lastOkAt`;
   - the site (the hosting project's own address, 16.1 step 2):
     `https://<project address>/sharing/84531/<distributor>/1.json` shows
     the file, and `https://<project address>/sharing` still shows the page;
   - every pinning service lists `curb-84531-<distributor>-1.json`, and each
     gateway serves `https://<gateway>/ipfs/<cid>` (the CID is in the `uri`
     of `latest.json`);
   - the rehearsal verifier's log (`docker compose -p curb-rehearsal logs
     verifier`): `epoch checked` with verdict `ok`;
   - an hour later: the activation and the push in the keeper log, and the
     test buyers paid on the fork;
   - the public check, from the keeper PC:

     ```
     docker run --rm ghcr.io/<org>/curb-sharer:<commit> verify --distributor <distributor> --epoch 1 --rpc <the fork's URL> --single-provider --config https://<project address>/sharing/84531/config.json --site https://<project address> --gateway https://ipfs.filebase.io
     ```

     Its verdict line must read `verdict      OK`.

### 16.3 The standby takes over

GitHub's machines cannot reach a fork on your network, so here the
standby's command runs on the keeper PC, in a container of its own, with the
standby pusher's key, exactly as the workflow runs it.

1. Make a folder `C:\Users\curbkeeper\curb-rehearsal\standby-secrets` holding
   `publisher_key`, `pusher_key` (the **standby** pusher's key), `rpc_urls`
   (the fork twice), `data_repo_token`, `pin_tokens` and `alert_webhooks`,
   locked as part 8.6 step 4 says.
2. Stop the keeper and note the time; *the developers* trade until a second
   epoch is due:

   ```
   docker compose -p curb-rehearsal stop keeper
   ```

3. Every 15 minutes, as GitHub would, run the standby once from the
   rehearsal folder:

   ```
   docker run --rm --read-only --tmpfs /tmp -v C:\Users\curbkeeper\curb-rehearsal\config:/config:ro -v C:\Users\curbkeeper\curb-rehearsal\standby-secrets:/run/secrets:ro -v curb-rehearsal-standby:/data -e CURB_SHARER_CONFIG=/config/sharer.json ghcr.io/<org>/curb-sharer:<commit> keeper --once --standby
   ```

   Before 45 minutes its notes say `standby stays idle`. After, they say
   `the primary is silent for Ns; standby acts`, the WARN "The standby keeper
   is acting" reaches every sink, and it publishes epoch 2 and writes
   `ops/status-standby.json`. Keep running it until epoch 2 is active and
   pushed.
4. Start the keeper again. Within 15 minutes `ops/status.json` beats again,
   and the next standby run says `standby stays idle`:

   ```
   docker compose -p curb-rehearsal start keeper
   ```

5. A failing keeper, not only a stopped one: put an address nothing answers
   on (`http://host.docker.internal:1`) as the **second** line of the
   rehearsal's `secrets/rpc_urls` (give yourself write access first, part 8.6
   step 4), and restart the keeper
   (`docker compose -p curb-rehearsal up -d --force-recreate keeper`).
   `ops/status.json` keeps its `heartbeatAt` moving while `lastOkAt` stops;
   the keeper pages that it has had no clean tick; and after 45 minutes the
   standby run of step 3 acts. Put the line back and restart it.

### 16.4 Clean up, before the real keeper starts

1. Remove the rehearsal's containers and volumes, then the rehearsal folder
   with its copied secrets (the `icacls` line gives you back the right to
   delete what step 4 of part 8.6 locked). In the rehearsal folder:

   ```
   docker compose -p curb-rehearsal down -v
   docker volume rm curb-rehearsal-standby
   cd C:\Users\curbkeeper
   icacls C:\Users\curbkeeper\curb-rehearsal /grant:r "curbkeeper:(OI)(CI)F" /T
   Remove-Item -Recurse -Force C:\Users\curbkeeper\curb-rehearsal
   ```

2. In the data repo (its web page → the folder → "..." → Delete directory, or
   delete file), remove `sharing/84531/` and the `ops/` files the rehearsal
   wrote: `status.json`, `status-standby.json`, `lease.json`, and `acks.json`
   if it exists. Do this **before** the real keeper starts: afterwards those
   files are the real keeper's.

### 16.5 The GitHub half, on Base

After the deploy, with the real keeper running (part 8.3) and both workflows
on (part 9.2), and before the site is announced:

1. Stop the keeper PC's keeper: `docker compose stop keeper` in its folder.
2. Within 45 to 60 minutes a scheduled `sharing-keeper` run must say
   `the primary is silent for Ns; standby acts`, and the WARN "The standby
   keeper is acting" must reach every sink. With nothing due, it sends no
   transaction.
3. Start it again (`docker compose start keeper`). The next scheduled run
   must say `standby stays idle`.

This proves GitHub's environment and secrets, the lease and the heartbeat on
the real setup. The guardian operator, meanwhile, runs `check` and
`alert-test` with the real config on their own machine (part 10.1).
