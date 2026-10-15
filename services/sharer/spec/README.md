# CURB-SHARE v1: the spec, the reference and the golden vectors

This directory pins how a launch's holder sharing income is split for one
epoch. It is normative: the sharer service, the web verifier and any outside
checker must reproduce every vector here **byte for byte**.

| File | What it is |
|---|---|
| `README.md` | The spec (this file). Where the prose and the code disagree, that is a bug to fix in both; the vectors decide until then. |
| `reference.mjs` | The executable reference. Exact BigInt arithmetic, one visible step per rule, every input validated. Importable (`runVector`, `computeEpoch`, `canonicalJson`, `leafHash`, `transfersDigest`, `priceValue`). |
| `vectors/v*.json` | Golden vectors: inputs and the exact expected outputs. |
| `vectors/files/<vector>/<epoch>.json` | The exact canonical bytes of each epoch file `curb.sharing.epoch/1` (its index); its sha256 is the vector's `contentHash`. |
| `vectors/files/<vector>/<epoch>.chunk<k>.json` | Past 512 accounts, the exact bytes of each chunk `curb.sharing.chunk/1` of that file; their sha256 are in the index. |
| `spec.test.mjs` | Checks that do not trust `reference.mjs`: figures derived by hand from the rules below, a naive block-by-block weight sum, an independent rebuild of the OpenZeppelin tree, the on-chain leaf encoding, refused inputs, determinism. |

```
npm ci
npm run check    # recompute every vector and compare outputs and file bytes
npm test         # the independent checks
node reference.mjs --write   # only when a vector's INPUT is added or changed on purpose
```

What the product does, in one paragraph: when a launch's creator switches
holder sharing on (at launch or later, once, one way), the creator's share of
the launch's fees becomes 0% and goes to the launch's distributor instead. Each
epoch, the income the distributor received is split among the token's holders
in proportion to how much they held and for how long. At most 2% of each
epoch's quote income pays the keeper's gas. Every holder who held at least a
millionth of the supply on average over the epoch shares; a share too small
to be worth pushing accumulates (cumulative values never go down) until it is
pushed or claimed. Unclaimed shares never expire.

**Amended before launch.** This text was amended in October 2026, before any
launch used it, after the platform's own audit: the weight floor (1.2), the
probed addresses and pool detection by `token0()`/`token1()` whatever the
factory (1.3), the accounts listed (1.7, 2) and the state commitment that
replaced the full `balancesAtEnd` (1.1, 2); then, after the re-review, the
file in chunks past 512 accounts and the tree in the same chunks (1.7, 2),
which bound every file however many accounts a launch has ever paid, and at
most 512 keeper transactions an epoch (1.5). Nothing had been published under
the earlier text, so it was changed in place rather than as a CURB-SHARE v2:
the schema is still `curb.sharing.epoch/1`, and these rules are the only ones
any epoch file has ever been computed with.

---

## 1. The spec (normative)

Notation. Every value is an unsigned integer and every operation is exact;
`/` is floor division. Addresses are compared and written as lowercase hex.
`D` is the distributor, `token` the launch token, `quote` the quote token.

### 1.1 The epoch and its window

- **Numbering.** The epoch number is `N = lastProposedEpoch + 1`. A vetoed
  epoch's number is burned: the next proposal takes the following number.
- **Active state.** The *active* epoch is the last proposed epoch that was not
  vetoed. Before any, there is none.
- **Range.** `F = sharingSince` (the Graduator's `sharingSince(token)`) when
  there is no active epoch, otherwise `F = active.toBlock + 1`. `T` is the
  block of this epoch's `harvest()` transaction; it must be at or below the
  `safe` head, and `F <= T`.
- **Opening state.** Every account's token balance after block `F - 1`,
  complete: dust included. With no active epoch it is built by replaying
  every `Transfer` log of the token from its first log; a vector may instead
  give the balances after an `opening.block <= F - 1`. With an active epoch
  it is the complete state after `active.toBlock`. The active epoch's file
  does not list it - it commits to it (`stateAtEnd`, section 2) - so a reader
  rebuilds it the same way, by replaying the token from its first log (or
  keeps the state it computed itself), and must refuse to go on when what it
  rebuilt is not exactly what the active file commits to. Dropping any
  balance, however small, would make the replay go below zero when its
  holder later sends it.
- **Replayed logs.** Every `Transfer(from, to, value)` log of the token with
  `openingBlock < block <= T`, in `(block, logIndex)` order. Logs after `T` are
  not read. A mint (`from == 0`) debits nobody and a burn (`to == 0`) credits
  nobody; the zero address has no balance. A balance below zero is an input
  error.

### 1.2 Weights (time-weighted balances)

`bal_a(b)` is account `a`'s balance after all logs of block `b`;
`dt(b) = ts(b) - ts(b - 1)` with `ts` the block timestamp.

```
raw_a  = sum over b = F .. T of  bal_a(b) * dt(b)
supply = sum of every balance after T            (all minted less all burned)
floor  = (supply / 10^6) * (ts(T) - ts(F - 1))   (the weight floor)
w_a    = raw_a  if raw_a >= floor,  else 0
```

Balance-seconds at block resolution. Consequences: a balance bought and sold
inside one block weighs 0; a balance bought in block `T` earns `dt(T)` (one
block); a balance held through a long gap between blocks earns the whole gap.
History before `F` changes balances but earns nothing.

**The weight floor.** An account weighs only if it held at least a millionth
of the supply on average over the window. Below that it is carried in the
state but weighs nothing, takes no share and is not listed (2): spraying
1-wei balances to fresh addresses, or passing one floor-sized amount through
a fresh address every block, adds nothing to the file. Every account that
weighs holds its millionth for the whole window, so at most a million can
weigh in one epoch, and each costs a holder that much token for that long.
With `supply < 10^6` the floor is 0 and every positive weight counts.

Equivalent computation used by the reference: an account's balance as set in
block `b` accrues from `ts(b - 1)`; balances from before `F` accrue from
`ts(F - 1)`; everything accrues up to `ts(T)`. The timestamps needed are
`ts(F - 1)`, `ts(T)` and `ts(b - 1)` for every block `b` in `[F, T]` with a
replayed log.

### 1.3 Exclusions

The excluded set `E` is, in this order (an address keeps the first reason it
gets):

1. fixed: `0x...dead` (burn address), `D`, `token`, `quote`, the distributor
   factory;
2. `rules.exclusions` (versioned, append-only, each with a reason). In
   production this holds the on-chain `isExcluded` set (curve, hook, escrow,
   Graduator, PoolManager, PositionManager, registry, the launch's
   PositionLock, every distributor) and the config list (every admitted
   launcher with its FeeEscrow, FeePolicy and BuybackVault; LaunchRegistry,
   LaunchLens, SharingCatalog; Permit2, the UniversalRouter, SwapRouter02;
   CurbRouter `0xEa20C3266229a01cd0f45D9c7921a45d5b359561`; the Balancer V2
   and V3 Vaults; the platform Safes and treasury);
3. exclusions added for this epoch, if any;
4. **detected pools**: the *probed* addresses are those with `w_a > 0` (1.2)
   that steps 1-2 did not exclude (the probe also reads the distributor's
   `isExcluded` for step 3). A pool is any of them whose `token0()` or
   `token1()` answers `token` at `T`, **whatever its factory**: a pair on
   any AMM, listed or not, holds liquidity, not a holder's balance, and a
   payout pushed to a v2-style pair could be skimmed by anyone. Excluding a contract only hands
   its weight to the holders. The reason names the factory:
   `detected pool (factory <address>: <factory reason>)` when `factory()`
   answers an address in the rules' AMM factory list (a label only),
   `detected pool (factory <address>, not in the rules' list)` when it
   answers another address, `detected pool (no factory())` when it does not
   answer. These calls, and the distributor's `isExcluded` for the same
   addresses, are made exactly as 4.10 pins; a call answers when it succeeds
   with at least 32 bytes whose first word is an address. An address whose
   weight is below the floor is not probed: it can take no share.

   Holders of liquidity that answer neither call - the Uniswap v4
   PoolManager (already excluded), the Balancer V2 and V3 Vaults - belong in
   `rules.exclusions`.

Ordinary contract wallets (Safes) are holders. ERC-6909 claim holders inside
the v4 PoolManager earn nothing (the PoolManager is excluded).

Excluded accounts get `w_a = 0`. `W = sum of w_a over accounts not in E`.

### 1.4 Income

With `prevCum = {h0, h1, k0}` the active root's `cumHolders0`, `cumHolders1`
and `cumKeeper0` (all zero with no active epoch), and `received0`,
`received1` the distributor's `received0()` and `received1()` read with
`eth_call` at block `T`:

```
I0 = received0 - h0 - k0        (quote; ETH + WETH on a WETH launch)
I1 = received1 - h1             (launch token, shared in kind)
```

A negative result is an input error. An epoch is computed only when no root
is pending.

**No epoch** (checked in this order; the attempt consumes nothing, so the
range, the number and the income all wait for the next attempt):

1. `W == 0` - reason `no-weight`;
2. `I0 == 0 and I1 == 0` - reason `no-income`.

### 1.5 Keeper fee

A transaction is attributed to `D` when its sender is one of
`rules.keeperKeys`, its block is in `[F, T]`, and either

- its `to` is `D`: share = its whole cost; or
- its `to` is the distributor factory (`publishMany` and other batched calls)
  and `D` is among the distinct distributors the call names: share =
  `cost / (number of distinct distributors named)`.

Anything else is not attributed. **At most 512 transactions are attributed**
(`MAX_KEEPER_TXS`): when more qualify, the 512 with the lowest hashes. A
verifier looks every transaction a file names up on each of its providers,
so a file naming more than 512 is refused before anything is asked (2,
`keeper.txs`); an honest window holds a harvest, a publish and the pushes of
one root at 200 leaves each, far fewer. Per transaction,
`cost = gasUsed * effectiveGasPrice + l1Fee` (wei, from the receipt), and
`costWei = sum of the attributed shares`.

Price `P`, in asset-0 base units per 10^18 wei:

- WETH quote: `P = 10^18` (source `weth`);
- otherwise, from the Chainlink Base feeds read at `T` (made as 4.10 pins;
  ETH/USD answer `aE`
  with `dE` decimals, QUOTE/USD answer `aQ` with `dQ` decimals, quote token
  with `qDec` decimals): `P = 10^qDec * aE * 10^dQ / (aQ * 10^dE)` (source
  `chainlink`, `feed = "<ethUsd feed>,<quoteUsd feed>"`,
  `round = "<ethUsd round>,<quoteUsd round>"`);
- a missing feed or a zero answer: `P = 0` (source `none`), so `C = 0`.

```
C = costWei * P / 10^18
K = min(C, I0 * 200 / 10000)
H = I0 - K
```

### 1.6 Shares

For every account `a` not in `E` with `w_a > 0`:

```
s0_a = H  * w_a / W
s1_a = I1 * w_a / W
dH0 = sum of s0_a,   dH1 = sum of s1_a
```

**Re-cap.** If `K * 10000 > (dH0 + K) * 200`, set `K = dH0 * 200 / 9800` and
do **not** recompute the shares; the difference stays unallocated. After this
step `K * 10000 <= (dH0 + K) * 200` always holds, which is the distributor's
on-chain check.

**No epoch** (the third check) when `dH0 == 0 and dH1 == 0 and K == 0` -
reason `nothing-allocated`.

An account whose weight rounds to `s0_a = s1_a = 0` keeps its weight in `W`
but takes nothing; it is not listed unless it has an earlier cumulative
value (1.7).

Rounding dust (`I0 - K - dH0` and `I1 - dH1`) is not allocated. It stays in
the distributor and joins a later epoch by itself, because income is always
measured against the cumulative totals.

### 1.7 Cumulative values and the tree

```
cum_a(N) = cum_a(active) + s_a          (per asset; zero when a had none)
cumHolders0 = h0 + dH0,  cumHolders1 = h1 + dH1,  cumKeeper0 = k0 + K
```

These three are the `Root` fields `cumHolders0`, `cumHolders1`, `cumKeeper0`.

The tree holds one leaf for **every account whose `cum0` or `cum1` is
non-zero, for all time** - including accounts that hold nothing now or were
excluded later. Every listed account (2, `accounts`) has one, and nothing
else does. The leaf is

```
[D, account, cum0, cum1]    types ["address","address","uint256","uint256"]
leafHash = keccak256(bytes.concat(keccak256(abi.encode(D, account, cum0, cum1))))
```

**The tree is built in chunks.** The leaves, in account (address) order, are
cut into chunks of `CHUNK_ACCOUNTS = 512` consecutive leaves (the last chunk
may hold fewer). Each chunk is a
`StandardMerkleTree.of(chunkLeaves, ["address","address","uint256","uint256"])`
from `@openzeppelin/merkle-tree` with its default options (leaves sorted by
hash, sorted-pair hashing). With one chunk - at most 512 leaves - the root is
that tree's root, which is the StandardMerkleTree of all the leaves; with
more, the root is `SimpleMerkleTree.of(chunkRoots).root` (default options:
the chunk roots sorted, sorted-pair hashing). Every node is a sorted-pair
keccak256, so a claim proof is the leaf's proof in its chunk followed by its
chunk root's proof in the tree of chunk roots, and the distributor's
`MerkleProof.verify` takes it as it is; a push multiproof proves leaves of
one chunk, its last steps carrying the chunk root up with proof elements
(flag `false`), which `MerkleProof.multiProofVerify` takes as it is. A reader
holding the index (every chunk root, 2) and one chunk proves any leaf of
that chunk without the others. Binding `D` into the leaf makes a proof for
one distributor useless on any other.

The distributor pays `cum - paid` per asset, so a leaf is never paid twice for
the same cumulative value, and a share that is too small to push today is
still in the next leaf, larger.

### 1.8 After a veto

A vetoed epoch burns its number and leaves the active state unchanged. The
next epoch recomputes from `active.toBlock + 1` (so its keeper window also
covers the vetoed epoch's transactions) and lists, in `supersedes`, every
epoch number vetoed since the active epoch, ascending. `prev` points at the
active epoch.

---

## 2. The epoch file `curb.sharing.epoch/1`

Canonical JSON (RFC 8785): object keys sorted by UTF-16 code units, no
whitespace, every integer written as a decimal **string**, no JSON numbers at
all. Served gzipped; `contentHash = sha256(uncompressed bytes)` and is stored
on chain in the `Root`.

**An index and, past 512 accounts, its chunks.** The file the chain hashes is
the *index*. With at most `CHUNK_ACCOUNTS = 512` listed accounts it lists
them itself (`accounts`) and `chunks` is empty. With more, `accounts` is
empty and the rows go in *chunk files*, 512 consecutive rows each in address
order (the last may hold fewer) - the same cut as the tree's (1.7) - and
`chunks` names each one:

| Chunk field (in the index) | Content |
|---|---|
| `first`, `last` | the chunk's first and last account |
| `count` | its rows (512, but the last chunk's 1 to 512) |
| `size`, `sha256` | the byte length and the sha256 of its file: a chunk is trusted only through them, as the index is only through the chain |
| `root` | the root of its tree (1.7) |
| `sum0`, `sum1` | the sums of its rows' `cum0` and `cum1` |

A chunk file `curb.sharing.chunk/1` is the canonical JSON of
`{schema: "curb.sharing.chunk/1", distributor, epoch, accounts}` with its
rows. The site serves it at
`sharing/<chainId>/<distributor>/chunks/<sha256 without 0x>.json`; a chunk of
at most 262,144 bytes (one with the amounts any launch has) is one raw IPFS
block, so its CID - CIDv1, raw, sha2-256 - is its sha256.

| Field | Content |
|---|---|
| `schema` | `"curb.sharing.epoch/1"` |
| `chainId`, `distributor`, `launchToken`, `quoteToken`, `epoch` | identity |
| `supersedes` | vetoed epoch numbers this epoch replaces (1.8) |
| `window` | `fromBlock` F, `toBlock` T, `fromTime` = ts(F - 1) (start of the weighted interval), `toTime` = ts(T), `harvestTx` |
| `rules` | `version`; `exclusions` = the whole set E as `[{address, reason}]` sorted by address; `keeperKeys` sorted |
| `inputs` | `received0`, `received1`, `prevCum {h0, h1, k0}`, `transfers {count, digest}` where `digest = keccak256` of `abi.encode(uint256 block, uint256 logIndex, address from, address to, uint256 value)` concatenated for every replayed log (1.1) in order |
| `keeper` | `cost` = C (asset 0), `txs` = the attributed transactions `[{hash, gasUsed, price, l1Fee, share}]` sorted by hash, at most 512 (1.5) (`price` = effectiveGasPrice, `share` in wei), `price {source, feed, round, value}` (`value` = P), `fee` = K, `capped` = (K != C) |
| `weights` | `W` (1.3) and `floor`, the weight floor (1.2) |
| `accounts` | the rows, `[{a, w, s0, s1, cum0, cum1, b}]` sorted by address: every non-excluded account with `s0 > 0` or `s1 > 0`, plus every account with a previous non-zero cumulative value (excluded ones with `w = 0`); `b` is the account's balance after T (`"0"` when none). An account that weighs but takes no share is in `W` only. Empty when the rows are in chunks |
| `chunks` | `[]` with at most 512 rows; otherwise the chunks, in address order (above) |
| `stateAtEnd` | the commitment to the complete state after T, the next epoch's opening state: `count` = the number of non-zero balances after T (every account, excluded ones and dust included), `supply` = their sum, `digest = sha256` of `abi.encode(address account, uint256 balance)` concatenated for each of them in address order (sha256, as for the file itself: nothing checks it on chain, and it hashes a large state many times faster) |
| `merkle` | `root` (1.7) and `leafEncoding: "address,address,uint256,uint256"`; the leaves are the rows' `[D, a, cum0, cum1]`, and proofs are rebuilt from them |
| `prev` | `null` for the first epoch, else `{epoch, contentHash, uri}` of the active epoch |

**Size.** A file grows with the accounts that take a share or ever took
one, and with nothing else: a weight below the floor costs it no row, no
balance and no exclusion, however many there are. 441,000 addresses given
1 wei each - the spray that took a 300-holder launch's file to 63.6 MiB
under the earlier text, against the 64 MiB the keeper reads files back
under - add only the digits of two counts to it. The rows still grow with
every account that ever took a share - the tree must keep them all, and an
account that earned once is in every later file - so a holder of 2.4% of the
supply can rotate it through 12,000 fresh addresses an epoch, each holding
twice the floor, for 12,000 rows more each epoch. No file grows with them:
a chunk holds 512 rows (about 120 KiB with real amounts, at most 256 KiB),
and the index about 350 bytes for each 512 accounts - 0.7 MiB for a million.
A reader takes what it needs: the site the index and the one chunk that
holds its account; a verifier every chunk.

---

## 3. Vector format

```jsonc
{
  "name": "...", "description": "...", "covers": ["..."],
  "setup": {
    "chainId", "distributor", "factory", "launchToken", "quoteToken",
    "quoteIsWeth": true|false, "quoteDecimals", "sharingSince",
    "rules": { "version", "exclusions": [{address, reason}], "keeperKeys": [...],
               "ammFactories": [{address, reason}] },
    "contracts": { "<address>": { "token0", "token1", "factory" } },   // eth_call answers for pool detection; null for a call that does not answer
    "opening": { "block", "balances": { "<address>": "<balance>" } },  // state before the first epoch
    "timestamps": { "<block>": "<unix seconds>" },
    "transfers": [{ "block", "logIndex", "from", "to", "value" }],      // the token's whole Transfer log
    "keeperTxs": [{ "hash", "from", "to", "block", "gasUsed", "effectiveGasPrice", "l1Fee", "names"? }]
  },
  "epochs": [                                                            // attempts, in order
    { "input": { "toBlock", "harvestTx", "uri", "vetoed"?, "received0", "received1",
                 "price": null | { "ethUsd": {feed, round, answer, decimals}, "quoteUsd": {...} },
                 "exclusionsAdded"? },
      "expected": { ... } }
  ]
}
```

Each attempt runs against the state the earlier attempts left: a no-epoch
attempt changes nothing, a vetoed epoch only burns its number, any other
epoch becomes the active one. `expected` holds `result` (`epoch` or `none`),
`reason` for `none`, and for both: `epoch`, `fromBlock`, `toBlock`, `supply`,
`floor`, `W`, `I0`, `I1`; for an epoch also `supersedes`, `keeperCostWei`, `priceValue`, `C`, `K`,
`recapped`, `H`, `dH0`, `dH1`, `unallocated0`, `unallocated1`,
`cumHolders0`, `cumHolders1`, `cumKeeper0`, `excluded`, `accounts`,
`leaves`, `leafHashes`, `merkleRoot`, `contentHash`, `chunks` (the index's
chunk fields, `[]` with at most 512 accounts), `file` (the path of the epoch
file - its index - under `vectors/`) and `chunkFiles` (the paths of its
chunks, in order).

| Vector | Covers |
|---|---|
| `v01-mid-epoch-transfers` | mid-epoch transfers, a buy in F and in T, an 18 s block gap, a log after T, launch-token income |
| `v02-same-block-zero-weight` | a same-block buy and sell weighs 0, tokens passing through an account in one block |
| `v03-mid-life-enable-first-epoch` | first epoch after a mid-life enable, transfers in F - 1, F and T, rounding dust, a non-WETH price record |
| `v04-exclusions-and-pools` | excluded accounts receiving tokens, pool detection through token0 and token1 (one pool on an unlisted factory), look-alikes that stay holders, de-duplicated reasons, a zero-value log |
| `v05-no-epoch-cases` | `no-weight`, `no-income`, `nothing-allocated`, and a range those attempts did not consume |
| `v06-dust-carry-and-history` | dust carried into the next epoch, a sold-out holder keeps its leaf, launch-token-only income, a resume whose rebuilt state is checked against `stateAtEnd` |
| `v07-keeper-fee-cap` | keeper attribution (direct, split `publishMany`, stranger, other distributor, out of window), K = C, exactly 2%, the re-cap to 0, a large epoch |
| `v08-cbxrp-decimals-and-price` | a 6-decimal quote, feeds with 8 and 18 decimals, a missing feed (C = 0) |
| `v09-veto-recompute` | a vetoed epoch, the recompute of the reopened range with `supersedes`, the epoch after |
| `v10-zero-weight-with-income` | `W = 0` while income exists |
| `v11-recap-nonzero` | a re-cap leaving a non-zero fee, shares not recomputed, an account with weight but no share (in `W`, not listed, no leaf) |
| `v12-weight-floor-and-dust` | the weight floor (at it and below it), one amount passed through fresh addresses block by block, weight without a share, dust only the complete state carries and its holder sending it an epoch later, a burn that moves the floor |
| `v13-pools-on-any-factory` | pools on a listed factory, an unlisted factory and with no `factory()`, look-alikes that stay holders, a pool weighing less than the floor (never probed), a pool listed by hand |
| `v14-chunked-file` | 10 accounts in the index, then 1,100 in three chunks (512, 512, 76) under the root over their roots: new holders between the old ones in address order, a sold-out holder keeping its leaf in a chunk, cumulative values carried from an index into chunks |
| `v15-usdc-stable-quote` | USDC: a 6-decimal quote near $1 with 8-decimal feeds on both sides, at live Base's answers and gas of 2026-10-15; a $0.15 pot the keeper's cost is above 2% of (K capped, then re-capped), and a $25 pot (K = C) |

The vectors' addresses and amounts are synthetic; only their relationships
matter. The leaf hashes and the roots were also checked against
OpenZeppelin's Solidity `MerkleProof.verify` and `multiProofVerify` (the
roots of `v01`-`v13`, each one chunk, are those of the StandardMerkleTree of
all their leaves).

---

## 4. Rules this spec fixes that the design left open

The design (core v2, section D.2.3) gives the rules; these details are pinned
here so that two implementations cannot differ:

1. **Price conversion.** `P` is defined from the ETH/USD and QUOTE/USD answers
   with one floor, and `C` from `P` with a second floor; `feed` and `round`
   record both feeds, comma-joined. A zero answer counts as a missing feed.
2. **Keeper window.** Transactions with block in `[F, T]` (that is
   `(prev.T, T]`), the same for the first epoch. A batched factory call is
   split among the **distinct** distributors it names.
3. **`nothing-allocated`.** No epoch when `dH0 == dH1 == 0` and `K == 0`
   after the re-cap. This also covers the case where the tree would be empty.
4. **Order of the no-epoch checks**: `no-weight`, then `no-income`, then
   `nothing-allocated`.
5. **Fixed exclusions.** `0x...dead`, `D`, `token`, `quote` and the factory
   are always excluded; the first reason given to an address wins; the
   detection rule (by `token0()`/`token1()`, whatever the factory) and which
   addresses are probed (those that weigh) are as in 1.3.
6. **Which accounts are listed** (2, `accounts`: those with a share, and
   those with an earlier cumulative value) and that the tree never drops an
   account with a non-zero cumulative value.
7. **`fromTime` = ts(F - 1)**, the start of the weighted interval, so that
   `toTime - fromTime` is the epoch's length in seconds.
8. **`capped` = (K != C)**; `prev = null` for the first epoch; a row's `b`
   is its account's balance after T, `"0"` when none, and no other balance
   is listed; keeper `txs` sorted by hash, at most 512 (the lowest hashes);
   exclusions sorted by address.
9. **Transfer digest** encoding as in 2 (`inputs.transfers.digest`); for the
   first epoch it covers every log replayed since the opening state, for a
   later one the logs in `[F, T]` (the rebuild of the opening state is checked
   against the active file's `stateAtEnd` instead).
10. **How every probe call is made.** Every address that weighs is probed,
    and anybody can make any address weigh by sending it tokens, including
    one that burns all the gas a call gives it; an answer must not
    depend on the gas a reader happened to give, or on where in a batch a call
    stood. So the calls of 1.3 step 4 (`token0()`, `token1()`, `factory()` of
    each probed address and the distributor's `isExcluded` of it) and the
    feed reads of 1.5 are all made by **SharerProbe**
    (`src/curb/sharing/SharerProbe.sol`, never deployed), whose creation code
    has keccak256
    `0xb6280b759f2832de05a3812c4335bc2ac47927b4ae5c63533efe8b286d8a6ac0`:
    - one request is an `eth_call` at block `T` with no `to`, from the zero
      address, with gas 15,000,000, whose `data` is that creation code, then
      the calls packed one after another as `target (20 bytes) | length
      (2 bytes) | calldata`, then one 32-byte word holding the packed bytes'
      length;
    - the probe makes each call as a STATICCALL with exactly 100,000 gas,
      keeps at most the first 160 bytes of a successful answer and none of a
      failed one, and makes the next call only while, with `out` the bytes it
      has written so far, `out + 192 <= 24,576` (EIP-170) and its gas left is
      at least `103,600 + 200 * (out + 192)` (the call, a cold access,
      bookkeeping, and the code deposit of all it could return); otherwise it
      stops and returns how many calls it answered and their answers;
    - a request carries the calls in order, as many as fit in 49,152 bytes of
      initcode (EIP-3860), and the next request starts at the first call the
      last one did not answer. A request that fails is an error, never a list
      of failed calls.

    The request boundaries are then a function of the calls and the chain
    alone, every call gets the same gas wherever it stands, and nothing is
    asked twice. A reader that probes any other way does not compute
    CURB-SHARE v1, and may disagree with one that does.

11. **The weight floor** (1.2): `floor = (supply / 10^6) * (ts(T) - ts(F - 1))`
    with `supply` the sum of every balance after T; a weight below it is 0
    before exclusions, W and the shares; `weights.floor` records it.
12. **The state commitment** (2, `stateAtEnd`): `count`, `supply` and the
    sha256 `digest` of `abi.encode(address, uint256)` per non-zero balance
    after T in address order. The next epoch's opening state must be exactly
    that state.
13. **Chunks** (1.7, 2): `CHUNK_ACCOUNTS = 512`; the rows and the leaves are
    cut the same way, 512 consecutive in address order, the last chunk
    holding the rest; with one chunk the rows are in the index and `chunks`
    is `[]`, with more the index lists no row; the root over the chunk roots
    is OpenZeppelin's `SimpleMerkleTree` with its default options; a chunk
    file is `{schema, distributor, epoch, accounts}`, and its index entry
    `{first, last, count, size, sha256, root, sum0, sum1}`.
