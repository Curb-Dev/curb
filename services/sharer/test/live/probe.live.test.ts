// Against a real node (an anvil fork of Base, which has Multicall3): the probe
// runs SharerProbe's creation code as a deployless eth_call, and on real EVM
// gas rules
//  - a plain Multicall3 aggregate3 of the probes of two gas burners runs out
//    of gas as a whole (precompile 0x08 asked for token0(), and code 0xfe:
//    anybody can send a zero-value transfer of a CurbLaunchToken to either);
//  - the probe answers every call anyway, each with exactly PROBE_CALL_GAS
//    wherever it stands: a contract that reports gasleft() reports the same
//    number after burners as alone;
//  - a contract that looks like a pool only when it is given 2,000,000 gas
//    looks like one on no path, alone or in a crowd;
//  - hundreds of reverting contracts cost a few requests, not three each;
//  - every account probed alone answers as it does among all the others.
//
//   SHARER_LIVE_RPC=http://127.0.0.1:<port> npm run test:live
//
// The node must be one this run started (it sets code and sends transactions
// from anvil's unlocked accounts). Skipped when SHARER_LIVE_RPC is not set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem';
import { httpRpc, type Rpc } from '../../src/chain/rpc.ts';
import { ChainReader } from '../../src/chain/reader.ts';
import { PROBE_CALL_GAS } from '../../src/chain/probe.ts';
import { poolAbi } from '../../src/chain/abis.ts';
import { probeAccounts, replayTransfers } from '../../src/chain/indexer.ts';

const RPC = process.env.SHARER_LIVE_RPC;
const ARTIFACT = join(dirname(fileURLToPath(import.meta.url)), '../../../../out/CurbLaunchToken.sol/CurbLaunchToken.json');
const erc20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
// Multicall3, only to show the failure the probe replaces
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

const at = (tag: number, i = 0) => '0x' + tag.toString(16).padStart(8, '0') + i.toString(16).padStart(32, '0');
const PRECOMPILE_8 = '0x0000000000000000000000000000000000000008';
const INVALID = at(0xc0be0f0e); // 0xfe
const ALWAYS_FALSE = at(0xc0be0d15); // answers 32 zero bytes to anything: isExcluded -> false
const REPORTER = at(0xc0be6a50); // answers gasleft() as it starts
const POOL = at(0xc0be9001); // answers the launch token's address to anything
const GASSY = at(0xc0be9002); // the same, but only when it is given 2,000,000 gas
const reverter = (i: number) => at(0xc0bedead, i); // PUSH0 PUSH0 REVERT

/** Counts the eth_calls a reader sends. */
function counted(rpc: Rpc): { rpc: Rpc; ethCalls: () => number } {
  let n = 0;
  return {
    rpc: { label: rpc.label, request: (a) => (a.method === 'eth_call' && n++, rpc.request(a)) },
    ethCalls: () => n,
  };
}

test('live: the probe answers every call with the same gas, in one request per few hundred, where Multicall3 runs out', { skip: !RPC && 'SHARER_LIVE_RPC is not set' }, async () => {
  assert.ok(existsSync(ARTIFACT), `build the contracts first (${ARTIFACT})`);
  const rpc = httpRpc(RPC!, { label: 'live' });
  const call = (method: string, params: unknown[] = []) => rpc.request({ method, params }) as Promise<any>;
  // a receipt can arrive a moment after eth_sendTransaction answers
  const receipt = async (h: string) => {
    for (let i = 0; i < 100; i++) {
      const rc = await call('eth_getTransactionReceipt', [h]);
      if (rc) return rc;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no receipt for ${h}`);
  };
  const accounts: string[] = await call('eth_accounts');
  const [deployer, nobody] = accounts;
  assert.ok((await call('eth_getCode', [MULTICALL3, 'latest'])).length > 2, 'the node has Multicall3');

  // the real launch token
  const art = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const args = encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint256' }],
    ['Probe', 'PRB', '', deployer as `0x${string}`, 10n ** 27n],
  );
  const deployed = await receipt(await call('eth_sendTransaction', [{ from: deployer, data: art.bytecode.object + args.slice(2), gas: '0x989680' }]));
  const token: string = deployed.contractAddress.toLowerCase();
  const from = BigInt(deployed.blockNumber);
  const tokenWord = token.slice(2);

  // the probes' setting
  await call('anvil_setCode', [INVALID, '0xfe']);
  await call('anvil_setCode', [ALWAYS_FALSE, '0x60205ff3']);
  await call('anvil_setCode', [REPORTER, '0x5a5f5260205ff3']);
  await call('anvil_setCode', [POOL, '0x73' + tokenWord + '5f5260205ff3']);
  // GAS PUSH3 2000000 GT PUSH1 0x24 JUMPI | PUSH20 token PUSH0 MSTORE PUSH1 32 PUSH0 RETURN | 0x24: JUMPDEST PUSH0 PUSH0 REVERT
  await call('anvil_setCode', [GASSY, '0x5a621e848011602457' + '73' + tokenWord + '5f5260205ff3' + '5b5f5ffd']);
  const reverters = Array.from({ length: 300 }, (_, i) => reverter(i));
  for (const r of reverters) await call('anvil_setCode', [r, '0x5f5ffd']);

  // an account holding nothing sends nothing to each burner and to the pool: accepted
  for (const to of [PRECOMPILE_8, INVALID, POOL, GASSY]) {
    const h = await call('eth_sendTransaction', [{ from: nobody, to: token, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [to as `0x${string}`, 0n] }) }]);
    assert.equal((await receipt(h)).status, '0x1', `a zero-value transfer to ${to} is accepted`);
  }
  const head = BigInt(await call('eth_blockNumber'));
  const block = '0x' + head.toString(16);

  // GASSY really does answer, given the gas
  assert.equal(BigInt(await call('eth_call', [{ to: GASSY, data: encodeFunctionData({ abi: poolAbi, functionName: 'token0' }), gas: '0x1c9c380' }, block])), BigInt(token));

  const seen = new Set<string>();
  for (const t of await replayTransfers(new ChainReader(rpc, { tries: 0 }), token, from, head)) {
    seen.add(t.from);
    seen.add(t.to);
  }
  assert.ok(seen.has(PRECOMPILE_8) && seen.has(INVALID) && seen.has(POOL), 'the burners and the pool are counterparties, so they are probed');
  const probe = [...seen, ...reverters].filter((a) => a !== '0x0000000000000000000000000000000000000000').sort();

  // the failure this guards against, on this node: one aggregate3 of the probes
  const calls3 = probe.flatMap((a) => (['token0', 'token1', 'factory'] as const).map((f) => ({ target: a as `0x${string}`, allowFailure: true, callData: encodeFunctionData({ abi: poolAbi, functionName: f }) })));
  await assert.rejects(
    call('eth_call', [{ to: MULTICALL3, data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls3] }) }, block]),
    /gas/i,
    'a plain aggregate3 of these probes runs out of gas on a real node',
  );

  // the probe answers every call, in a few requests
  const c = counted(rpc);
  const all = await probeAccounts(new ChainReader(c.rpc, { tries: 0 }), ALWAYS_FALSE, probe, head);
  assert.deepEqual([...all.contracts.keys()], [POOL], 'the pool, and not the contract that answers only to 2,000,000 gas');
  assert.deepEqual(all.excludedOnChain, []);
  assert.ok(c.ethCalls() <= 4, `${c.ethCalls()} requests for ${4 * probe.length} calls`);

  // each account alone answers as it does among the others
  const r = new ChainReader(rpc, { tries: 0 });
  for (const a of [PRECOMPILE_8, INVALID, POOL, GASSY, reverters[0], nobody.toLowerCase()]) {
    const alone = await probeAccounts(r, ALWAYS_FALSE, [a], head);
    assert.deepEqual([...alone.contracts], [...all.contracts].filter(([k]) => k === a), a);
  }
  // the burners first, as a vanity address would put them
  const first = [PRECOMPILE_8, INVALID, ...probe.filter((a) => a !== PRECOMPILE_8 && a !== INVALID)];
  assert.deepEqual([...(await probeAccounts(r, ALWAYS_FALSE, first, head)).contracts.keys()], [POOL]);

  // the gas each call gets, measured: the same alone and after a crowd of burners
  const t0 = encodeFunctionData({ abi: poolAbi, functionName: 'token0' });
  const alone = await r.callMany([{ to: REPORTER, data: t0 }], head);
  const crowd = await r.callMany([...Array.from({ length: 40 }, (_, i) => ({ to: i % 2 ? PRECOMPILE_8 : INVALID, data: t0 })), { to: REPORTER, data: t0 }], head);
  assert.equal(BigInt(alone[0].returnData), PROBE_CALL_GAS - 2n, 'GAS costs 2: the reporter starts with exactly PROBE_CALL_GAS');
  assert.equal(BigInt(crowd[40].returnData), PROBE_CALL_GAS - 2n, 'and so it does after 40 burners');
  assert.ok(crowd.slice(0, 40).every((x) => !x.success));
});
