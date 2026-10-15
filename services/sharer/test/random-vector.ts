// Seeded random vectors in the spec's vector format, for differential and
// determinism tests: many holders, buys and sells through the curve, pools
// (on listed and unlisted factories, with calls that do not answer),
// same-block round trips, burns, 1-wei dust sprayed to fresh addresses and
// later sent on, history before sharingSince, keeper transactions of every
// kind, a veto, missing and zero price answers.

const hexAddr = (prefix: string, n: number) => '0x' + prefix + n.toString(16).padStart(40 - prefix.length, '0');

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `crowd` holders more, each buying well above the weight floor as sharing
 *  begins: past 512 listed accounts the files go in chunks. */
export function randomVector(seed: number, crowd = 0): any {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: T[]): T => xs[int(xs.length)];
  const weth = seed % 2 === 0;
  const D = hexAddr('d157', 1);
  const factory = hexAddr('fac7', 1);
  const token = hexAddr('70ce', seed);
  const quote = weth ? '0x4200000000000000000000000000000000000006' : hexAddr('cb', 0x1a9);
  const curve = hexAddr('c0be', 1);
  const hook = hexAddr('400c', 1);
  const exclusions = [
    { address: curve, reason: 'the launch curve' },
    { address: hook, reason: 'the launch hook' },
    { address: hexAddr('e5c0', 1), reason: 'the launcher FeeEscrow' },
    { address: hexAddr('96ad', 1), reason: 'the Graduator' },
    { address: hexAddr('0b4a', 1), reason: 'the v4 PoolManager' },
    { address: hexAddr('0b4b', 1), reason: 'the v4 PositionManager' },
    { address: hexAddr('7e91', 1), reason: 'the LaunchRegistry' },
    { address: hexAddr('10c0', 1), reason: 'the launch PositionLock' },
    { address: '0xea20c3266229a01cd0f45d9c7921a45d5b359561', reason: 'CurbRouter' },
  ];
  const v2 = hexAddr('a33f', 2);
  const v3 = hexAddr('a33f', 3);
  const pool = hexAddr('9a12', 1);
  const pool0 = hexAddr('9a12', 2);
  const unlisted = hexAddr('9a12', 3);
  const noFactory = hexAddr('9a12', 4);
  const lookalike = hexAddr('9a12', 5);
  const factoryOnly = hexAddr('9a12', 6);
  const contracts = {
    [pool]: { token0: quote, token1: token, factory: v2 },
    [pool0]: { token0: token, token1: hexAddr('99', 1), factory: v3 },
    [unlisted]: { token0: token, token1: quote, factory: hexAddr('bad', 1) },
    [noFactory]: { token0: null, token1: token, factory: null },
    [lookalike]: { token0: quote, token1: hexAddr('99', 1), factory: v2 },
    [factoryOnly]: { token0: null, token1: null, factory: v3 },
  };
  const holders = Array.from({ length: 30 + int(30) }, (_, i) => hexAddr('a' + (i % 10), 1000 + i));
  const everyone = [...holders, pool, pool0, unlisted, noFactory, lookalike, factoryOnly, hook, '0x000000000000000000000000000000000000dead'];
  let dustN = 0;

  const opening = 999;
  const since = 1000 + int(25);
  const last = since + 120 + int(80);
  const timestamps: Record<string, string> = {};
  let ts = 1_700_000_000 + int(1000);
  for (let b = opening; b <= last + 2; b++) {
    timestamps[String(b)] = String(ts);
    ts += rnd() < 0.05 ? 20 + int(40) : 1 + int(3);
  }

  const bal = new Map<string, bigint>();
  const transfers: any[] = [];
  const push = (block: number, li: number, from: string, to: string, value: bigint) => {
    if (from !== '0x' + '0'.repeat(40)) bal.set(from, (bal.get(from) ?? 0n) - value);
    if (to !== '0x' + '0'.repeat(40)) bal.set(to, (bal.get(to) ?? 0n) + value);
    transfers.push({ block: String(block), logIndex: String(li), from, to, value: value.toString() });
  };
  push(opening + 1, 0, '0x' + '0'.repeat(40), curve, 10n ** 27n);
  for (let b = opening + 2; b <= last + 2; b++) {
    const n = rnd() < 0.3 ? 0 : 1 + int(4);
    let li = 0;
    // 1 wei to a fresh address now and then; a dust holder sometimes sends it on
    if (rnd() < 0.15) push(b, li++, curve, hexAddr('d057', ++dustN), 1n);
    if (dustN > 0 && rnd() < 0.05) {
      const d = hexAddr('d057', 1 + int(dustN));
      if ((bal.get(d) ?? 0n) > 0n) push(b, li++, d, pick(holders), bal.get(d)!);
    }
    for (let k = 0; k < n; k++) {
      const r = rnd();
      const funded = [...bal].filter(([a, v]) => v > 0n && a !== '0x000000000000000000000000000000000000dead' && a !== curve);
      if (r < 0.45 || funded.length < 3) {
        const to = pick(everyone);
        push(b, li++, curve, to, BigInt(1 + int(1e6)) * 10n ** BigInt(12 + int(6)));
      } else {
        const [from, have] = pick(funded);
        const value = rnd() < 0.15 ? have : (have * BigInt(1 + int(100))) / 100n;
        if (value === 0n) continue;
        const to = rnd() < 0.05 ? '0x' + '0'.repeat(40) : rnd() < 0.2 ? curve : pick(everyone);
        push(b, li++, from, to, value);
        if (rnd() < 0.1 && to !== '0x' + '0'.repeat(40) && to !== from) push(b, li++, to, from, value); // a same-block round trip
      }
    }
  }

  // the crowd buys from the curve in the block sharing begins, and a few sell out later
  for (let i = 0; i < crowd; i++) {
    const a = '0x' + Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0') + (seed * 100000 + i).toString(16).padStart(32, '0');
    push(since, 1000 + i, curve, a, 2n * 10n ** 21n + BigInt(int(1e18)));
    if (rnd() < 0.02) push(since + 3 + int(last - since - 3), 2000 + i, a, curve, bal.get(a)!);
  }

  const keys = [hexAddr('cee9', 1), hexAddr('cee9', 2)];
  const others = [hexAddr('d157', 2), hexAddr('d157', 3)];
  const keeperTxs: any[] = [];
  const nTx = 3 + int(10);
  for (let i = 0; i < nTx; i++) {
    const r = rnd();
    const block = since + int(last - since + 1);
    const base = { hash: '0x' + (seed * 1000 + i + 1).toString(16).padStart(64, '0'), block: String(block), gasUsed: String(21000 + int(500000)), effectiveGasPrice: String(1 + int(5_000_000)), l1Fee: String(int(1e9)) };
    if (r < 0.4) keeperTxs.push({ ...base, from: pick(keys), to: D });
    else if (r < 0.65) keeperTxs.push({ ...base, from: pick(keys), to: factory, names: [D, ...others.slice(0, int(3))] });
    else if (r < 0.75) keeperTxs.push({ ...base, from: pick(keys), to: factory, names: [...others] });
    else if (r < 0.85) keeperTxs.push({ ...base, from: hexAddr('5ca1', 1), to: D });
    else keeperTxs.push({ ...base, from: pick(keys), to: pick(others) });
  }

  const nEpochs = 3 + int(3);
  const vetoAt = int(nEpochs + 2); // sometimes none
  let r0 = 0n;
  let r1 = 0n;
  const epochs: any[] = [];
  const cuts = new Set<number>();
  while (cuts.size < nEpochs) cuts.add(since + 5 + int(last - since - 5));
  [...cuts].sort((a, b) => a - b).forEach((toBlock, i) => {
    r0 += rnd() < 0.15 ? 0n : BigInt(int(1e9)) * BigInt(1 + int(1000));
    r1 += rnd() < 0.5 ? 0n : BigInt(int(1e6));
    let price: any = null;
    if (!weth) {
      const pr = rnd();
      price = {
        ethUsd: { feed: hexAddr('ee', 1), round: String(100 + i), answer: String(300000000000 + int(1e10)), decimals: '8' },
        quoteUsd: { feed: hexAddr('ee', 2), round: String(200 + i), answer: pr < 0.15 ? '0' : String(50000000 + int(1e8)), decimals: pr < 0.5 ? '8' : '18' },
      };
      if (price.quoteUsd.decimals === '18') price.quoteUsd.answer = String(BigInt(price.quoteUsd.answer) * 10n ** 10n);
      if (pr > 0.85) delete price.quoteUsd;
    }
    epochs.push({
      input: {
        toBlock: String(toBlock),
        harvestTx: '0x' + (0xabc000 + seed * 100 + i).toString(16).padStart(64, '0'),
        uri: `ipfs://random-${seed}-${i + 1}`,
        ...(i === vetoAt ? { vetoed: true } : {}),
        received0: r0.toString(),
        received1: r1.toString(),
        price,
      },
    });
  });

  return {
    name: `random-${seed}`,
    setup: {
      chainId: '8453',
      distributor: D,
      factory,
      launchToken: token,
      quoteToken: quote,
      quoteIsWeth: weth,
      quoteDecimals: weth ? '18' : '6',
      sharingSince: String(since),
      rules: {
        version: '1',
        exclusions,
        keeperKeys: keys,
        ammFactories: [
          { address: v2, reason: 'listed v2-style factory' },
          { address: v3, reason: 'listed v3-style factory' },
        ],
      },
      contracts,
      opening: { block: String(opening), balances: {} },
      timestamps,
      transfers,
      keeperTxs,
    },
    epochs,
  };
}
