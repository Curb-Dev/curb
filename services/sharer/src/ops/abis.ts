// What the ops modes call and watch, beyond the core's reads (chain/abis.ts):
// every write the keeper and the guardian send, the factory's roles, the
// errors they may revert with, and the events that raise alerts. Each line is
// the contract's own declaration (src/curb/sharing/*.sol, SharingCatalog.sol);
// test/ops-abis.test.ts checks them against the sources.

import { parseAbi } from 'viem';
import { ROOT_TUPLE } from '../chain/abis.ts';

export const DIST_ERRORS = [
  'error NotTheFactory(address caller)',
  'error AlreadyInitialized()',
  'error PendingRoot(uint32 epoch)',
  'error NotSharingHere(address launchToken)',
  'error WrongEpoch(uint32 expected, uint32 got)',
  'error BadRange(uint64 expectedFrom, uint64 fromBlock, uint64 toBlock)',
  'error RootShrinks()',
  'error KeeperFeeAboveCap(uint256 fee, uint256 gross)',
  'error AllocatesMoreThanReceived(uint8 asset, uint256 allocated, uint256 received)',
  'error NoSuchPending(uint32 epoch)',
  'error VetoWindowOver(uint40 payableAt)',
  'error NothingPending()',
  'error NotYetPayable(uint40 payableAt)',
  'error Frozen()',
  'error NoActiveRoot()',
  'error BadProof()',
  'error LeavesExceedRoot(uint8 asset)',
  'error Excluded(address account)',
  'error NothingToClaim(address account)',
  'error TransferRefused(address asset, address to)',
  'error InexactTransfer(address asset, uint256 amount, uint256 moved)',
] as const;

export const FACTORY_ERRORS = [
  'error ZeroAddress()',
  'error NotRegistered(address launchToken)',
  'error NotThePublisher(address caller)',
  'error PublishingFrozen()',
  'error NotFrozen()',
  'error NotAVetoer(address caller)',
  'error UnknownDistributor(address distributor)',
  'error LengthMismatch()',
  'error NothingAnnounced()',
  'error ChangeNotReady(uint64 at)',
  'error ChangeExpired(uint64 expiredAt)',
  'error RootsStillVetoable(uint256 until)',
] as const;

/** What the Graduator's graduate(), noteReady() and rescueCurveFees() may
 *  revert with (src/curb/Graduator.sol), so the keeper's Waiting watch names
 *  the reason - RescueNotOpenYet carries when the rescue opens to anyone
 *  (0 while nobody has noted the launch ready). */
export const GRADUATOR_ERRORS = [
  'error AlreadyGraduated(address launchToken)',
  'error CurveIsAnotherLaunchs(address curve, address itsToken)',
  'error RescueNotOpenYet(address caller, uint256 opensAt)',
  'error CurveNotReady(address curve)',
  'error ZeroReserves()',
  'error Reentered()',
  'error PriceOutOfRange(uint256 sqrtPriceX96)',
  'error PoolAlreadyAtADifferentPrice(uint160 wanted, uint160 existing)',
  'error PoolInitializationFailed()',
  'error NoLiquidityFromTheseReserves()',
  'error LockDidNotTakeCustody()',
  'error ReservesDidNotArrive(address token, uint256 expected, uint256 received)',
  'error RemainderNotBurned(address launchToken, uint256 amount, uint256 supplyBefore, uint256 supplyAfter)',
] as const;

export const opsDistributorAbi = parseAbi([
  'struct Leaf { address account; uint256 cum0; uint256 cum1; }',
  'function harvest()',
  'function activate()',
  'function push(Leaf[] leaves, bytes32[] proof, bool[] flags)',
  'function payKeeper()',
  'function paid0(address account) view returns (uint256)',
  'function paid1(address account) view returns (uint256)',
  'function totalPaid0() view returns (uint256)',
  'function totalPaid1() view returns (uint256)',
  'function keeperPaid0() view returns (uint256)',
  'function received0() view returns (uint256)',
  'function received1() view returns (uint256)',
  'function isExcluded(address account) view returns (bool)',
  'function hook() view returns (address)',
  'function escrow() view returns (address)',
  'function curve() view returns (address)',
  'event Harvested(uint256 received0, uint256 received1)',
  'event Paid(address indexed account, address indexed to, uint256 amount0, uint256 amount1, bool pushed)',
  'event PushSkipped(address indexed account, uint8 asset)',
  'event ExcludedLeaf(address indexed account)',
  'event KeeperPaid(address indexed payee, uint256 amount)',
  'event RootActivated(uint32 indexed epoch, bytes32 root)',
  'event RootVetoed(uint32 indexed epoch, bytes32 reason)',
  ...DIST_ERRORS,
]);

export const opsFactoryAbi = parseAbi([
  `struct Root { ${ROOT_TUPLE.split(', ').join('; ')}; }`,
  'function publishMany(address[] distributors, Root[] roots, string[] uris)',
  'function veto(address distributor, uint32 epoch, bytes32 reason)',
  'function vetoMany(address[] distributors, uint32[] epochs, bytes32 reason)',
  'function freeze()',
  'function owner() view returns (address)',
  'function publisher() view returns (address)',
  'function keeperPayee() view returns (address)',
  'function frozen() view returns (bool)',
  'function isVetoer(address account) view returns (bool)',
  'function isDistributor(address distributor) view returns (bool)',
  'function pendingPublisher() view returns (address)',
  'function pendingPublisherAt() view returns (uint64)',
  'function pendingKeeperPayee() view returns (address)',
  'function pendingKeeperPayeeAt() view returns (uint64)',
  'function pendingUnfreezeAt() view returns (uint256)',
  'function vetoableUntil() view returns (uint256)',
  'function vetoerRemovalAt(address account) view returns (uint64)',
  'event PublisherAnnounced(address indexed next, uint64 at)',
  'event PublisherUpdated(address indexed previous, address indexed next)',
  'event PublisherRevoked(address indexed previous)',
  'event KeeperPayeeAnnounced(address indexed next, uint64 at)',
  'event KeeperPayeeUpdated(address indexed previous, address indexed next)',
  'event PendingCancelled()',
  'event VetoerSet(address indexed account, bool isVetoer)',
  'event VetoerRemovalAnnounced(address indexed account, uint64 at)',
  'event Frozen(address indexed by)',
  'event UnfreezeAnnounced(uint64 at)',
  'event UnfreezeCancelled(address indexed by)',
  'event Unfrozen()',
  ...FACTORY_ERRORS,
  ...DIST_ERRORS,
]);

export const catalogAbi = parseAbi([
  'event FactoryAdmitted(address indexed factory, uint64 at)',
  'event FactoryProposed(address indexed factory, uint64 at)',
  'event FactoryCancelled(address indexed factory)',
  'event FactoryRetired(address indexed factory)',
  'event RecommendedSet(address indexed factory)',
  'function isApproved(address factory) view returns (bool)',
]);

/** OpenZeppelin Ownable2Step, as the factory, the catalog, the hook and the
 *  registry inherit it (lib/openzeppelin-contracts/contracts/access). */
export const ownableAbi = parseAbi([
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
]);

/** The FeeHook's platform-terms changes (src/curb/FeeHook.sol): announced,
 *  executable after POLICY_CHANGE_DELAY (24 h), cancellable by the owner. */
export const feeHookAbi = parseAbi([
  'event PlatformRecipientAnnounced(address indexed previous, address indexed next, uint64 readyAt)',
  'event PlatformFeeBpsAnnounced(uint16 previous, uint16 next, uint64 readyAt)',
  'event PlatformRecipientCancelled(address pending)',
  'event PlatformFeeBpsCancelled(uint16 pending)',
  'event PlatformRecipientUpdated(address indexed previous, address indexed next)',
  'event PlatformFeeBpsUpdated(uint16 previous, uint16 next)',
  'function cancelPlatformRecipient()',
  'function cancelPlatformFeeBps()',
  'function registry() view returns (address)',
]);

/** The LaunchRegistry's launchers (src/curb/LaunchRegistry.sol): add-only,
 *  admitted by its owner with no delay. */
export const registryAbi = parseAbi([
  'event LauncherSet(address indexed launcher)',
  'function launcherCount() view returns (uint256)',
  'function launcherAt(uint256 index) view returns (address)',
  'function requiredHook() view returns (address)',
]);

/** What `check` reads to prove the config's addresses are wired together. */
export const wiringAbi = parseAbi([
  'function sharingCatalog() view returns (address)',
  'function registry() view returns (address)',
  'function graduator() view returns (address)',
]);

/** Views telling whether income is stuck in the core after a harvest (an
 *  issuer blocking the distributor, say). */
export const incomeAbi = parseAbi([
  'function balanceOfToken(address recipient, address token) view returns (uint256)',
  'function owed(address recipient, address token) view returns (uint256)',
  'function held(address party, uint256 i) view returns (uint256)',
]);

/** OP-stack GasPriceOracle predeploy: the L1 data fee of a transaction. */
export const GAS_ORACLE = '0x420000000000000000000000000000000000000f';
export const gasOracleAbi = parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)']);

export const lensPriceAbi = parseAbi(['function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)']);

/** Multicall3, at the same address on every EVM chain (on Base, and every
 *  OP-stack chain, a predeploy). Only the guardian's reads of the
 *  distributors' roots go through it (chainview.ts readRootsMany): a root is
 *  288 bytes, more than the probe returns of an answer (PROBE_RETURN_CAP). */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

export const ALL_ERRORS_ABI = parseAbi([...DIST_ERRORS, ...FACTORY_ERRORS, ...GRADUATOR_ERRORS]);
