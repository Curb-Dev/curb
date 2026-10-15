# Holder sharing: pinned interfaces

These are the fixed points between the CURB core, the distributor contracts,
the `curb-sharer` service and the web. They change only by an explicit
amendment to the core v2 design (section E.2); every work package builds
against them.

## Solidity interfaces

Declared in [`src/curb/sharing/ICurbSharing.sol`](../../src/curb/sharing/ICurbSharing.sol).

| Interface | Implemented by | Functions (selector) |
|---|---|---|
| `ISharingCatalog` | SharingCatalog | `isApproved(address)` `0x673448dd`, `recommended()` `0xd798b1ac` |
| `IHolderSharingSource` | Graduator | `holderDistributorOf(address)` `0xbaf188c2`, `sharingSince(address)` `0x49d5edb2`, `lockOf(address)` `0x5a46d3b5`, `hasGraduated(address)` `0xfa1653bd`, `registry()` `0x7b103999`, `poolManager()` `0xdc4c90d3`, `positionManager()` `0x791b98bc` |
| `IHolderDistributorFactory` | HolderDistributorFactory | `deploy(address)` `0x4c96a389` (deterministic, idempotent), `predict(address)` `0x901b96e7`, `VERSION()` `0xffa1ad74` |
| `IHolderDistributorIdentity` | HolderFeeDistributor | `launchToken()` `0xa28a4d86`, `quoteToken()` `0x217a4b70`, `graduator()` `0x0245a483` |
| `IFeeHookSharing` | FeeHook | `syncCreator(address)` `0xb3d5bff6` (pool opener only) |
| `IPositionLockSharing` | PositionLock | `claimFees()` `0xd294f093` (anyone; collect-or-hold), `release(address)` `0x19165587` (anyone), `feeRecipient()` `0x46904840`, `held(address,uint256)` `0x2a6baaf7` |

The distributor calls into the core only through existing entry points:
`curve.sweepFees(0)`, `escrow.claimToken(quote)`, `hook.claim(quote)`,
`lock.claimFees()`, `lock.release(address(this))`.

Every distributor version must accept plain ERC20/B20 transfers and ETH from
WETH, the escrow and the hook; never forward funds inside a callback; not be a
core contract; have no owner able to move funds, no upgrade, no delegatecall,
no selfdestruct; and never pay more than it received.

## Event ABI

| Event | Emitted by | topic0 |
|---|---|---|
| `HolderSharingEnabled(address indexed token, address indexed distributor, address indexed factory, address by, bool graduated, uint64 sinceBlock)` | Graduator | `0x01f16e68afabf3d2e246789e4eaf4f9623c490fa2ef3bd574b3c0ad8a5f54e37` |
| `CreatorRedirected(bytes32 indexed poolId, address indexed token, address previous, address distributor)` | FeeHook | `0xc334006e7db04cd423a0f33e4fa205c7a7ad202fcf408bc29f044cda862f870f` |
| `RootPublished(uint32 indexed epoch, bytes32 merkleRoot, uint64 fromBlock, uint64 toBlock, uint128 dH0, uint128 dH1, uint128 dK, bytes32 contentHash, string uri, uint40 payableAt)` | distributor | `0xc69a4a1358f9dc0c4f15bdbfefa0a55ec955f97bfcab9a0d548349620f4395fb` |
| `RootVetoed(uint32 indexed epoch, bytes32 reason)` | distributor | `0xeab66abc974a898350bf3aa2cae99e9d920489e90519d60ead519aa83d23be97` |
| `RootActivated(uint32 indexed epoch, bytes32 root)` | distributor | `0xa2449509363bb583412bf4b731d54215c715106a6a097f14010fbe0fe58a066e` |
| `Paid(address indexed account, address indexed to, uint256 amount0, uint256 amount1, bool pushed)` | distributor | `0x6bdfafaeb95de8a6534f022125c92719569f3e364da25e7001704f3a72c0f821` |
| `PushSkipped(address indexed account, uint8 asset)` | distributor | `0x0e99d4c43ef1b7d28996e50d00929e6ee48920673566c23a11e82c67cfb259fe` |
| `KeeperPaid(address indexed payee, uint256 amount)` | distributor | `0x496b3bf0725d338a836ecf0b614e039f3736dacfd57aa32af1bf55ea601ceaf5` |

The types, their order and which ones are indexed are pinned (topic0 depends
only on the name and the types). Parameter names are descriptive.

## Merkle leaf

```
[distributor, account, cum0, cum1]          types ["address","address","uint256","uint256"]
leaf = keccak256(bytes.concat(keccak256(abi.encode(distributor, account, cum0, cum1))))
```

The leaves, in account order, are cut into chunks of 512 (`CHUNK_ACCOUNTS`;
the last chunk may hold fewer). Each chunk is a `StandardMerkleTree` from
`@openzeppelin/merkle-tree` (default options); the root is the chunk's root
when there is one chunk - so a launch of at most 512 accounts has the
`StandardMerkleTree` of all its leaves - and otherwise the root of
`SimpleMerkleTree.of(chunkRoots)` (default options). Every node is a
sorted-pair keccak256, so it is verified on chain with OpenZeppelin
`MerkleProof` as it is: a claim proof is the leaf's proof in its chunk
followed by the chunk root's, and a push multiproof proves leaves of one
chunk, carried up by proof elements (flag `false`). `cum0` and `cum1` are
cumulative over all epochs (quote and launch token); the distributor pays
`cum - paid`.

## Epoch file `curb.sharing.epoch/1` and its chunks `curb.sharing.chunk/1`

Canonical JSON (RFC 8785, integers as decimal strings), served gzipped, with
`contentHash = sha256(uncompressed bytes)` stored in the on-chain root. That
file is the epoch's *index*. Top level fields: `schema`, `chainId`,
`distributor`, `launchToken`, `quoteToken`, `epoch`, `supersedes`, `window`,
`rules`, `inputs`, `keeper`, `weights`, `accounts`, `chunks`, `stateAtEnd`,
`merkle` (`root`, `leafEncoding`), `prev`. `weights` holds `W` and `floor`,
the weight floor (a millionth of the supply held for the whole window; a
weight below it counts as 0). The rows, `{a, w, s0, s1, cum0, cum1, b}` in
address order (`b` the balance after T), are only the accounts with a share
or an earlier cumulative value; each has a leaf `[distributor, a, cum0,
cum1]`. `keeper.txs` lists at most 512 transactions. `stateAtEnd` commits to
the complete state after T, the next epoch's opening state: `count` and
`supply` of every non-zero balance, and `digest`, the sha256 of
`abi.encode(address, uint256)` per non-zero balance in address order.

**Past 512 rows the file is chunked**, so no file grows past a bound however
many accounts a launch has ever paid: `accounts` is then empty, and `chunks`
names each chunk file of 512 rows (the last may hold fewer) by `first`,
`last`, `count`, `size`, `sha256`, `root` (its tree's) and `sum0`/`sum1`.
A chunk file `curb.sharing.chunk/1` is `{schema, distributor, epoch,
accounts}`, trusted only through the sha256 its index gives, served at
`sharing/<chainId>/<distributor>/chunks/<sha256 without 0x>.json` and, at
most 262,144 bytes, pinned as one raw IPFS block (its CID is its sha256).
With at most 512 rows `chunks` is `[]` and the rows are in `accounts`.
Every field is defined in
[`services/sharer/spec/README.md`](../../services/sharer/spec/README.md)
section 2.

## Share calculation: CURB-SHARE v1

Normative text, reference implementation and golden vectors:
[`services/sharer/spec/`](../../services/sharer/spec/). Any implementation
must reproduce every vector there byte for byte (`npm run check`).

## LaunchLens `LaunchView` (16 words)

`launchState(address)` (`0x3cb24365`) and `launchPage(uint256,uint256)`
(`0xb55ab098`) keep their selectors. Words 0-13 are unchanged; 14 and 15 are
appended. Decoders derive the per-view stride from the returned data
(`(totalWords - viewsAt - 1) / n`, an integer of at least 14) so an older
14-word lens still decodes.

| Word | Field | Type |
|---|---|---|
| 0 | `status` (0 NotFound, 1 Selling, 2 Waiting, 3 Graduated) | `uint8` enum |
| 1 | `curve` | `address` |
| 2 | `quoteToken` | `address` |
| 3 | `beneficiary` | `address` |
| 4 | `quoteReserve` | `uint256` |
| 5 | `tokenReserve` | `uint256` |
| 6 | `realQuoteReserve` | `uint256` |
| 7 | `graduationThreshold` | `uint256` |
| 8 | `totalSupply` | `uint256` |
| 9 | `poolKey.currency0` | `address` |
| 10 | `poolKey.currency1` | `address` |
| 11 | `poolKey.fee` | `uint24` |
| 12 | `poolKey.tickSpacing` | `int24` |
| 13 | `poolKey.hooks` | `address` |
| 14 | `launchedAt` (the registry's clock at `register`) | `uint64` |
| 15 | `holderDistributor` (`graduator.holderDistributorOf(token)`; zero = sharing off) | `address` |
