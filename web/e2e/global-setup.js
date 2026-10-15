// Drives a real launch into the WAITING state before any test runs, and writes
// the addresses it produced where the spec can read them.
//
// WHY THIS IS NOT OPTIONAL. The page under test only has anything to do when a
// launch is waiting to be moved into its pool, and that state is reached by a
// REAL FAILED ATTEMPT on a real fork - not by a mock. Preparing it by hand was
// the reason the browser checks were never a gate: they needed a human to set
// the stage first.
//
// THE FOUNDRY TOOLCHAIN IS NOT NECESSARILY WHERE NODE IS. On this machine
// base-forge and base-anvil live in WSL while Node lives on Windows, so the
// default command on win32 goes through `wsl`. Override CURB_PREPARE_CMD to
// change that; set CURB_LENS / CURB_TOKEN / CURB_RPC to skip preparation
// entirely and attach to a launch that is already waiting.
const { execSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const STATE = path.join(__dirname, ".state.json");
// NOTHING SHARED CARRIES THE IDENTITY. A file at a fixed path is every run's
// file: two runs overwrite each other's, and a teardown handed somebody else's
// CORRECT id walks straight through the port lock that was supposed to stop it.
// globalSetup returns its teardown instead, so the id is held in that closure
// and reaches nowhere else.

// A NODE OF THIS RUN'S OWN, ON ITS OWN PORT.
//
// Two things went wrong with sharing the default one. A run that reused a node
// an earlier run had spent failed IN SETUP - the NVDAc whale this fork borrows
// from does not hold enough to fund four accounts twice - and that looked like
// flakiness rather than what it was. And a hand-driven wallet session on 8546
// would be walked over by a test run.
//
// So: stop whatever is on THIS port, start a fresh fork pinned to the same
// block, prepare against it, and stop it again at the end. Every run starts
// from the same place, nothing needs cleaning up by hand, and 8546 is left
// alone. Funding the whale more heavily would only postpone the collision.
const E2E_PORT = process.env.CURB_E2E_RPC_PORT || "8549";
const E2E_RPC = `http://127.0.0.1:${E2E_PORT}`;
// AN IDENTITY FOR THIS RUN, not for this port. A record named after the port is
// shared by every run that uses it: two starting together overwrite each
// other's, and the loser goes on to stop a node it does not own. The claim is
// taken atomically by start-node.sh and carries this id; stop-node.sh refuses
// to act on a claim held by anybody else.
const RUN_ID = `e2e-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function inWslPath() {
  return "/mnt/" + REPO[0].toLowerCase() + REPO.slice(2).split(String.fromCharCode(92)).join("/");
}

/// A command run where the foundry toolchain is, with THIS RUN'S port and RPC
/// in its environment, so every script it calls agrees about which node is
/// meant.
function shellCommand(script, env = "") {
  const prefix = `RPC_PORT=${E2E_PORT} RPC=${E2E_RPC} NODE_RUN_ID=${RUN_ID} ${env}`.trim();
  if (process.platform !== "win32") return `${prefix} bash ${script}`;
  const distro = process.env.CURB_WSL_DISTRO || "Ubuntu";
  return `wsl -d ${distro} -e bash -lc "cd '${inWslPath()}' && ${prefix} bash ${script}"`;
}

const prepareCommand = (script) => shellCommand(script);

function run(cmd, what) {
  console.log(what + ":\n  " + cmd);
  try {
    return execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const detail = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      "could not " + what + ".\n\n" + (detail || String(e)) +
      "\n\nThe fork node has to be up and at its pinned block first:\n" +
      "  bash script/b20/start-node.sh"
    );
  }
}

/// A LINE THAT IS ONLY THE NAME AND THE VALUE.
///
/// Without the end anchor this matched "lens status word: 02 (expect 02)" and
/// came away with "status" as the lens address - and the failure landed three
/// suites later, in tests that had nothing to do with it.
const field = (out, name) => {
  const m = out.match(new RegExp("^\\s*" + name + "\\s+(\\S+)\\s*$", "m"));
  return m && m[1];
};

async function answers(url, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if ((await r.json()).result) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

async function startOwnNode() {

  // A PORT THAT ANSWERS IS SOMEBODY ELSE'S. The first version ran stop-node.sh
  // over whatever was there, which would end a second test run or a session
  // being driven by hand - the opposite of what a harness should do with a port
  // it does not own. It says so and stops instead.
  if (await answers(E2E_RPC, 1)) {
    throw new Error(
      `something is already serving ${E2E_RPC}, and this run will not touch it.
` +
      `Stop it yourself, or give this run another port with CURB_E2E_RPC_PORT.`
    );
  }
  console.log("starting this run's own fork node on " + E2E_PORT);
  // ARGV, NOT A SHELL STRING. The command carries a quoted path and an
  // environment prefix, and handing that to `cmd /c` as one string nests quotes
  // inside quotes: it starts nothing and says nothing, which is how this failed
  // the first time. Spawning wsl directly puts the script in ONE argument.
  // The stale pidfile goes in the same breath as the start: one left by a node
  // that has since died would make the teardown think it owns something.
  const inner =
    `cd '${inWslPath()}' && ` +
    `RPC_PORT=${E2E_PORT} RPC=${E2E_RPC} NODE_RUN_ID=${RUN_ID} bash script/b20/start-node.sh`;
  const child = process.platform === "win32"
    ? spawn("wsl", ["-d", process.env.CURB_WSL_DISTRO || "Ubuntu", "-e", "bash", "-lc", inner],
        { detached: true, stdio: "ignore", windowsHide: true })
    : spawn("bash", ["-lc", inner.replace(/^cd '[^']*' && /, "")],
        { cwd: REPO, detached: true, stdio: "ignore" });
  child.unref();

  if (!(await answers(E2E_RPC, 90))) {
    // It may have refused the claim rather than failed to start - either way
    // this asks only about OUR claim, and leaves anybody else's alone.
    stopOwnNode("the node never answered");
    throw new Error(
      `this run's own node never answered on ${E2E_RPC}. If another run holds the port, ` +
      `start-node.sh will have said so.`
    );
  }

  // AND WHAT ANSWERED MUST BE OURS.
  //
  // A port that answers is not a port this run owns. Losing the claim does not
  // stop the winner's node appearing on it moments later, and a run that only
  // waited for an answer would prepare against somebody else's chain - two runs
  // deploying into one node, which is exactly how the first race between two
  // real runs ended: both of them failed, and neither said why.
  //
  // Checked AFTER the wait and for EXACT equality: checked before it, the claim
  // may not be written yet and an empty answer would read as "nobody else has
  // it".
  const holder = run(shellCommand("script/b20/claim-owner.sh"), "read the claim on port " + E2E_PORT).trim();
  if (holder !== RUN_ID) {
    throw new Error(
      `port ${E2E_PORT} answers, but the claim on it belongs to run ${holder || "nobody"}, ` +
      `not to this one.
This run will not use a node it does not own. Give it another port ` +
      `with CURB_E2E_RPC_PORT.`
    );
  }
}

/// Stops what this run started. Throws if it cannot: "the run stopped its node"
/// is part of what a green run means, and a teardown that shrugs leaves the
/// next run to discover it.
function stopOwnNode(why) {
  console.log(execSync(shellCommand("script/b20/stop-node.sh"), {
    cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim() + (why ? `  (${why})` : ""));
}

let attached = false;

module.exports = async () => {
  // ATTACH TO WHAT IS ALREADY THERE. Two deployments take minutes, which is
  // fine once and painful when the point of the run is to check that ONE
  // mutation fails ONE test. Every address the suites need can be supplied.
  // EVERY FIELD THE SPECS READ. A preset that is missing one produces a state
  // file that looks fine and an "undefined is not a function" three tests in -
  // which is how CURB_APP_GRADUATOR went missing.
  const preset = ["CURB_LENS", "CURB_TOKEN", "CURB_RPC", "CURB_APP_FACTORY", "CURB_APP_LENS",
    "CURB_APP_GRADUATOR", "CURB_OTHER_FACTORY", "CURB_OTHER_GRADUATOR"].every((k) => process.env[k]);
  if (!preset) await startOwnNode();
  if (preset) {
    attached = true;
    const state = {
      rpc: process.env.CURB_RPC,
      lens: process.env.CURB_LENS,
      token: process.env.CURB_TOKEN,
      other: {
        factory: process.env.CURB_OTHER_FACTORY,
        lens: process.env.CURB_LENS,
        graduator: process.env.CURB_OTHER_GRADUATOR,
      },
      app: {
        factory: process.env.CURB_APP_FACTORY,
        lens: process.env.CURB_APP_LENS,
        graduator: process.env.CURB_APP_GRADUATOR,
        // HOLDER SHARING'S CONTRACTS, for sharing.spec.js; optional here, as
        // the router is - a spec that needs one says so when it is missing.
        catalog: process.env.CURB_APP_CATALOG,
        sharing: process.env.CURB_APP_SHARING,
      },
      router: process.env.CURB_ROUTER_ADDRESS
        ? { address: process.env.CURB_ROUTER_ADDRESS, codehash: process.env.CURB_ROUTER_CODEHASH } : undefined,
    };
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    console.log("attached to launches that were already prepared:", state.token, state.app.factory);
    return;
  }

  // TWO STAGES, because the two suites need different starting points.
  //
  //   demo-waiting.sh  a launch already in the WAITING state, which is what
  //                    launch.spec.js and the eighteen in-page scenarios read
  //   demo-app.sh      a stack with no launch at all and two funded accounts,
  //                    because app.spec.js creates its own launch from the page
  //
  // Each deploys its own stack. That is deliberate: sharing one would let a
  // step in either suite leave state the other silently depends on.
  // EVERYTHING BELOW CAN FAIL, AND THE NODE IS ALREADY RUNNING. A setup that
  // dies half way used to leave it behind, and the next run then found the port
  // occupied and - correctly, now - refused to start at all.
  try {
    await prepare();
  } catch (e) {
    try { stopOwnNode("the preparation failed"); } catch (stopErr) {
      console.log("and the node could not be stopped: " + (stopErr.message || stopErr));
    }
    throw e;
  }

  // THE TEARDOWN, AS A CLOSURE OVER THIS RUN'S ID. Playwright calls what
  // globalSetup returns once the tests are done. It throws if it cannot stop the
  // node: "the run released what it claimed" is part of what a green run means,
  // and a teardown that shrugs leaves the next run to find out.
  return () => {
    if (attached) return;
    stopOwnNode("the run is over");
  };
};

async function prepare() {
  const waitingOut = run(
    process.env.CURB_PREPARE_CMD || prepareCommand("script/b20/demo-waiting.sh"),
    "preparing a waiting launch"
  );
  // THE COINS OF 2026-10-15 - USDC, VIRTUAL, AERO - for assets.spec.js, come
  // with it: demo-app.sh builds DeployCurb.quoteAssets(), which lists all
  // fourteen. (A bridge script added them while the list did not yet; once the
  // branches met it could only ever skip all three, and it carried a second
  // copy of their terms, so it went.)
  const appOut = run(prepareCommand("script/b20/demo-app.sh"), "preparing a stack for the full flow");
  // THE CURB ROUTER, through the deployment script itself: it lands at the
  // address the page pins only if the code as built is the reviewed code, so a
  // run that gets past this has proved the address and the code hash too.
  // After both stacks, from a sender of its own: its address depends on neither.
  const routerOut = run(prepareCommand("script/b20/deploy-router.sh"), "deploying the CURB router");

  const state = {
    rpc: E2E_RPC,
    lens: field(waitingOut, "lens"),
    token: field(waitingOut, "token"),
    // THE OTHER DEPLOYMENT, kept so tests can tell a cached value from a freshly
    // read one. Two stacks that differ is the only way that difference shows.
    other: {
      factory: field(waitingOut, "factory"),
      lens: field(waitingOut, "lens"),
      graduator: field(waitingOut, "graduator"),
    },
    app: { factory: field(appOut, "factory"), lens: field(appOut, "lens"), graduator: field(appOut, "graduator"),
      // HOLDER SHARING: the catalog and the distributor factory it admitted.
      catalog: field(appOut, "catalog"), sharing: field(appOut, "sharing") },
    router: { address: field(routerOut, "router"), codehash: field(routerOut, "codehash") },
  };
  // READ BACK FROM WHAT THE SCRIPTS REPORTED, never assumed. Deploying twice
  // onto one node moves the sender's nonce and every address with it.
  //
  // EVERY FIELD BY ITS OWN NAME. This used to spread state, state.app and
  // state.other into one object - last wins - so state.other's factory, lens
  // and graduator overwrote the app's, and the three values the tests build
  // every URL from were never looked at. A missing app graduator is exactly
  // the regression this guard was written after.
  const required = {
    rpc: state.rpc, lens: state.lens, token: state.token,
    "other.factory": state.other.factory, "other.lens": state.other.lens, "other.graduator": state.other.graduator,
    "app.factory": state.app.factory, "app.lens": state.app.lens, "app.graduator": state.app.graduator,
    "app.catalog": state.app.catalog, "app.sharing": state.app.sharing,
    "router.address": state.router.address, "router.codehash": state.router.codehash,
  };
  for (const [k, v] of Object.entries(required)) {
    if (typeof v !== "string" || !v) throw new Error(`the preparation did not report ${k}`);
  }

  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log("waiting launch:", state.token, "| full-flow factory:", state.app.factory);
}
