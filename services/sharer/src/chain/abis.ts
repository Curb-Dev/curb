// The ABI the sharer reads. The event signatures are the pinned ones
// (docs/sharing/INTERFACES.md); the distributor and factory functions are the
// design's (core v2, D.1), which the distributor contracts implement.

import { parseAbi, parseAbiItem, toEventSelector } from 'viem';

export const ROOT_TUPLE =
  'bytes32 merkleRoot, bytes32 contentHash, uint128 cumHolders0, uint128 cumHolders1, uint128 cumKeeper0, uint64 fromBlock, uint64 toBlock, uint32 epoch, uint40 payableAt';

export const graduatorAbi = parseAbi([
  'event HolderSharingEnabled(address indexed token, address indexed distributor, address indexed factory, address by, bool graduated, uint64 sinceBlock)',
  'function holderDistributorOf(address launchToken) view returns (address)',
  'function sharingSince(address launchToken) view returns (uint64)',
  'function lockOf(address launchToken) view returns (address)',
  'function hasGraduated(address launchToken) view returns (bool)',
  'function registry() view returns (address)',
  'function poolManager() view returns (address)',
  'function positionManager() view returns (address)',
]);

export const registryAbi = parseAbi([
  'event LaunchRegistered(address indexed launchToken, address indexed curve, address indexed beneficiary)',
  'function isRegistered(address launchToken) view returns (bool)',
]);

export const curveAbi = parseAbi(['function feeEscrow() view returns (address)']);

export const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
]);

export const distributorAbi = parseAbi([
  'event RootPublished(uint32 indexed epoch, bytes32 merkleRoot, uint64 fromBlock, uint64 toBlock, uint128 dH0, uint128 dH1, uint128 dK, bytes32 contentHash, string uri, uint40 payableAt)',
  'event RootVetoed(uint32 indexed epoch, bytes32 reason)',
  'event RootActivated(uint32 indexed epoch, bytes32 root)',
  'event Paid(address indexed account, address indexed to, uint256 amount0, uint256 amount1, bool pushed)',
  'event PushSkipped(address indexed account, uint8 asset)',
  'event KeeperPaid(address indexed payee, uint256 amount)',
  'function launchToken() view returns (address)',
  'function quoteToken() view returns (address)',
  'function graduator() view returns (address)',
  'function factory() view returns (address)',
  'function received0() view returns (uint256)',
  'function received1() view returns (uint256)',
  `function active() view returns (${ROOT_TUPLE})`,
  `function pending() view returns (${ROOT_TUPLE})`,
  'function lastProposedEpoch() view returns (uint32)',
  'function isExcluded(address account) view returns (bool)',
  'function harvest()',
]);

export const factoryAbi = parseAbi([
  `struct Root { ${ROOT_TUPLE.split(', ').join('; ')}; }`,
  'function publish(address d, Root r, string uri)',
  'function publishMany(address[] ds, Root[] rs, string[] uris)',
  'function isDistributor(address d) view returns (bool)',
  'function VERSION() view returns (uint256)',
]);

export const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
]);

export const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

export const EVENTS = {
  HolderSharingEnabled: parseAbiItem(
    'event HolderSharingEnabled(address indexed token, address indexed distributor, address indexed factory, address by, bool graduated, uint64 sinceBlock)',
  ),
  LaunchRegistered: parseAbiItem('event LaunchRegistered(address indexed launchToken, address indexed curve, address indexed beneficiary)'),
  Transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  RootPublished: parseAbiItem(
    'event RootPublished(uint32 indexed epoch, bytes32 merkleRoot, uint64 fromBlock, uint64 toBlock, uint128 dH0, uint128 dH1, uint128 dK, bytes32 contentHash, string uri, uint40 payableAt)',
  ),
  RootVetoed: parseAbiItem('event RootVetoed(uint32 indexed epoch, bytes32 reason)'),
};

/** topic0 of the events the sharer reads. */
export const TOPICS = {
  HolderSharingEnabled: toEventSelector(EVENTS.HolderSharingEnabled),
  LaunchRegistered: toEventSelector(EVENTS.LaunchRegistered),
  Transfer: toEventSelector(EVENTS.Transfer),
  RootPublished: toEventSelector(EVENTS.RootPublished),
  RootVetoed: toEventSelector(EVENTS.RootVetoed),
};
