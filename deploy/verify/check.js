#!/usr/bin/env node
// CHECKS THE BASESCAN INPUTS IN THIS FOLDER AGAINST THE CHAIN. Read-only: it
// sends eth_blockNumber, eth_getCode, eth_getTransactionByHash and eth_call,
// and nothing else.
//
//   1. Compile each *.standard-json-input.json here, as it is, with solc
//      0.8.30 (the file carries every setting; nothing else is passed), from
//      an EMPTY directory over stdin, so a source missing from the JSON fails
//      instead of being read off disk (README.txt "TO RUN IT AGAIN"):
//        (cd "$(mktemp -d)" && solc-0.8.30 --standard-json < <checkout>/deploy/verify/FeeHook.standard-json-input.json) > <dir>/FeeHook.out.json
//      and the same for Graduator and PositionLock.
//   2. node deploy/verify/check.js <dir> [--rpc <url>] [--lock <PositionLock address>]
//      --rpc defaults to https://base.gateway.tenderly.co (keyless).
//      --lock also checks one PositionLock and prints its constructor
//      arguments; there is none to give until a launch graduates.
//
// It prints one line per comparison and exits 1 if any fails. What it
// compares, and why, is README.txt's "WHAT WAS CHECKED".
"use strict";
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const argv = process.argv.slice(2);
const OUT = argv[0];
const flag = (name) => {
  const i = argv.indexOf(name);
  return i > 0 ? argv[i + 1] : undefined;
};
const RPC = flag("--rpc") || "https://base.gateway.tenderly.co";
const LOCK = flag("--lock");
if (!OUT || OUT.startsWith("--") || (argv.includes("--lock") && !/^0x[0-9a-fA-F]{40}$/.test(LOCK || ""))) {
  console.error("usage: node deploy/verify/check.js <dir with the solc outputs> [--rpc <url>] [--lock <address>]");
  process.exit(2);
}

// FROM ADDRESSES.txt AND deployments/base-mainnet/run.json (the run's record).
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const DEPLOYED = {
  FeeHook: {
    address: "0xF85Ce05c2Ba8533d79f009fd3A3c8517aaBda0cC",
    tx: "0xedd4296d1f3ffed26a86d2530e3538f3bd602aef4c4ee834c6fde6e444a24e99",
    salt: "0000000000000000000000000000000000000000000000000000000000002bea",
  },
  Graduator: {
    address: "0xA9865e07Ce4EC0cCf7A521B98640031285C92712",
    tx: "0xfee92de7b93b6c11011060a985ad02821ddaef3332d1c60060374d97146049c3",
  },
};
const SOURCE = {
  FeeHook: "src/curb/FeeHook.sol",
  Graduator: "src/curb/Graduator.sol",
  PositionLock: "src/curb/PositionLock.sol",
};
// PositionLock's constructor, in order: (positionManager, beneficiary,
// poolKey, tokenId, sharingSource, launchToken). Every part is static, so the
// encoding is the getters' return data laid end to end - poolKeyView()
// returns the key's five words: words 0, 1, 2-6, 7, 8 and 9.
const LOCK_GETTERS = ["positionManager()", "beneficiary()", "poolKeyView()", "tokenId()", "sharingSource()", "launchToken()"];

let failed = 0;
function report(ok, what) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
}

async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  throw new Error(`${method}: rate limited five times`);
}

const strip = (hex) => hex.toLowerCase().replace(/^0x/, "");

function compiled(name) {
  const out = JSON.parse(fs.readFileSync(path.join(OUT, `${name}.out.json`), "utf8"));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(`${name}: solc reported ${errors.length} error(s): ${errors[0].formattedMessage}`);
  const c = out.contracts[SOURCE[name]][name];
  return {
    creation: c.evm.bytecode.object.toLowerCase(),
    runtime: c.evm.deployedBytecode.object.toLowerCase(),
    immutables: c.evm.deployedBytecode.immutableReferences || {},
    selectors: c.evm.methodIdentifiers,
  };
}

function argsFile(name) {
  return fs.readFileSync(path.join(HERE, `${name}.constructor-args.txt`), "utf8").trim().toLowerCase();
}

// THE RECORD'S ARGUMENTS, ENCODED. Every constructor argument of these two is
// an address, so the encoding is each one left-padded to 32 bytes.
function recordArgs(name) {
  const run = JSON.parse(fs.readFileSync(path.join(HERE, "../../deployments/base-mainnet/run.json"), "utf8"));
  const t = run.transactions.find((x) => x.contractName === name && x.transactionType.startsWith("CREATE"));
  return t.arguments.map((a) => strip(a).padStart(64, "0")).join("");
}

// The code with every immutable's bytes zeroed, and the values found there.
function mask(hex, immutables) {
  const bytes = Buffer.from(hex, "hex");
  const values = {};
  for (const [id, refs] of Object.entries(immutables)) {
    const seen = new Set();
    for (const { start, length } of refs) {
      seen.add(bytes.subarray(start, start + length).toString("hex"));
      bytes.fill(0, start, start + length);
    }
    values[id] = [...seen];
  }
  return { hex: bytes.toString("hex"), values };
}

// The CBOR trailer: its length is the code's last two bytes.
function trailer(hex) {
  const len = parseInt(hex.slice(-4), 16);
  return hex.slice(-(len * 2 + 4));
}

// Runtime against the build: length, immutables masked, trailer, and each
// immutable's value one of the constructor's words.
function compareRuntime(name, code, b, args) {
  report(code.length === b.runtime.length, `runtime length: chain ${code.length / 2} bytes, compiled ${b.runtime.length / 2} bytes`);
  const onChain = mask(code, b.immutables);
  const fromBuild = mask(b.runtime, b.immutables);
  const places = Object.values(b.immutables).reduce((n, refs) => n + refs.length, 0);
  const same = onChain.hex === fromBuild.hex;
  report(same, `runtime == compiled runtime with its ${Object.keys(b.immutables).length} immutables (${places} places) zeroed on both sides`);
  report(trailer(code) === trailer(b.runtime), `metadata trailer (CBOR: ipfs hash, solc version) identical: ${trailer(code)}`);
  if (same) console.log(`      unmasked they differ ${code === b.runtime ? "nowhere" : "only at the immutables"}; the immutables on chain:`);
  const words = args.match(/.{64}/g) || [];
  for (const [id, vals] of Object.entries(onChain.values)) {
    const ok = vals.length === 1 && words.includes(vals[0]);
    report(ok, `  immutable #${id} = 0x${vals.join(" / 0x")}${ok ? `, constructor word ${words.indexOf(vals[0])}` : ", not one value or not a constructor word"}`);
  }
}

async function main() {
  console.log(`rpc ${RPC}, block ${parseInt(await rpc("eth_blockNumber", []), 16)}`);
  const built = {};
  for (const name of Object.keys(SOURCE)) built[name] = compiled(name);
  const chainCode = {};

  for (const [name, d] of Object.entries(DEPLOYED)) {
    const b = built[name];
    const args = argsFile(name);
    console.log(`\n== ${name} ${d.address}`);
    report(args === recordArgs(name), `${name}.constructor-args.txt is the record's arguments, encoded`);

    // CREATION: what the chain's creating transaction carried.
    const tx = await rpc("eth_getTransactionByHash", [d.tx]);
    let initcode = strip(tx.input);
    if (d.salt) {
      report((tx.to || "").toLowerCase() === CREATE2_DEPLOYER, `creation tx was sent to the CREATE2 deployer ${CREATE2_DEPLOYER}`);
      report(initcode.slice(0, 64) === d.salt, `its first 32 bytes are the salt 0x${d.salt.replace(/^0+/, "")}`);
      initcode = initcode.slice(64);
    } else {
      report(tx.to === null, "creation tx is a plain CREATE (no to)");
    }
    report(initcode === b.creation + args, `creation input == compiled creation bytecode (${b.creation.length / 2} bytes) + constructor args (${args.length / 2} bytes), byte for byte`);

    // RUNTIME: eth_getCode, with the immutables masked on both sides.
    const code = strip(await rpc("eth_getCode", [d.address, "latest"]));
    chainCode[name] = code;
    compareRuntime(name, code, b, args);
  }

  // POSITIONLOCK: one per launch, created by the Graduator at graduation, so
  // its creation code is carried inside the Graduator that will create it.
  console.log("\n== PositionLock (created by the Graduator at each graduation)");
  const at = chainCode.Graduator.indexOf(built.PositionLock.creation);
  report(at >= 0 && at % 2 === 0, `compiled PositionLock creation bytecode (${built.PositionLock.creation.length / 2} bytes) is inside the deployed Graduator's runtime code${at >= 0 ? `, at byte ${at / 2}` : ""}`);

  if (LOCK) {
    console.log(`\n== PositionLock ${LOCK}`);
    const b = built.PositionLock;
    const call = (to, sig, arg = "") =>
      rpc("eth_call", [{ to, data: "0x" + b.selectors[sig] + arg }, "latest"]).then(strip);
    let args = "";
    for (const sig of LOCK_GETTERS) {
      if (!b.selectors[sig]) throw new Error(`PositionLock has no ${sig}`);
      args += await call(LOCK, sig);
    }
    report(args.length === 10 * 64, `constructor arguments read from its getters: ${args.length / 64} words (10 expected)`);
    const launchToken = args.slice(9 * 64);
    const lockOf = strip(
      await rpc("eth_call", [{ to: DEPLOYED.Graduator.address, data: "0x" + built.Graduator.selectors["lockOf(address)"] + launchToken }, "latest"]),
    );
    report(lockOf.slice(24) === strip(LOCK), `Graduator.lockOf(its launchToken) is this lock`);
    report(args.slice(8 * 64, 9 * 64) === DEPLOYED.Graduator.address.toLowerCase().slice(2).padStart(64, "0"), "its sharingSource is the Graduator");
    compareRuntime("PositionLock", strip(await rpc("eth_getCode", [LOCK, "latest"])), b, args);
    console.log(`      Constructor Arguments ABI-encoded, for the form:\n      ${args}`);
  }

  console.log(failed ? `\ncheck: ${failed} FAILED` : "\ncheck: ok");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`check: ${e.message}`);
  process.exit(1);
});
