// The constants of CURB-SHARE v1 and of its files (spec README sections 1-2),
// in a module of their own so the calculator (share.ts) and the file format
// (file.ts) both use them without importing each other.

export const SPEC_VERSION = 'CURB-SHARE/1';
/** The index of an epoch file: the file whose sha256 is the on-chain contentHash. */
export const SCHEMA = 'curb.sharing.epoch/1';
/** One chunk of an epoch file's rows (spec 2). */
export const CHUNK_SCHEMA = 'curb.sharing.chunk/1';
export const MAX_KEEPER_FEE_BPS = 200n;
export const BPS = 10000n;
export const WAD = 10n ** 18n;
/** The weight floor (spec 1.2): a weight below what supply /
 *  WEIGHT_FLOOR_DIVISOR held for the whole window would weigh counts as
 *  nothing. Spraying 1-wei balances to fresh addresses then adds no weight,
 *  no share and no row, and passing one floor-sized amount through a fresh
 *  address every block weighs nothing either: each account that earns has
 *  held a millionth of the supply on average over the window, so at most a
 *  million can earn in one epoch. */
export const WEIGHT_FLOOR_DIVISOR = 10n ** 6n;
/** At most this many keeper transactions are attributed to one epoch (spec
 *  1.5): the ones with the lowest hashes when more qualify. A verifier looks
 *  every one a file names up on each of its providers, so a file naming more
 *  is refused before anything is asked; an honest window holds a harvest, a
 *  publish and the pushes of one root (200 leaves each), far fewer. */
export const MAX_KEEPER_TXS = 512;
export const ZERO_ADDRESS = '0x' + '0'.repeat(40);
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
