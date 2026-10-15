// A STUB WALLET, IN ITS OWN FILE BECAUSE TWO RUNNERS NEED THE SAME ONE.
//
// tests.html loads it with a <script> tag; the Playwright runner injects this
// same file into the page before launch.html loads, which is the only way to
// have window.ethereum already present at load time the way a real extension
// is. A second copy would drift, and then the two suites would be testing
// different wallets while claiming to test one page.
//
// It answers eth_chainId / eth_accounts / eth_sendTransaction / receipts from
// `cfg`, and forwards everything else - eth_call above all - to a REAL RPC
// endpoint. So chain reads and chain state are genuine; only the parts a
// wallet owns are simulated.
function makeWallet(rpcUrl, opts) {
  const cfg = Object.assign({
    chainId: "0x2105",
    account: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    // A REAL WALLET DISTINGUISHES "I HAVE AN ACCOUNT" FROM "YOU MAY SEE IT".
    // eth_accounts returns [] until the site has been granted permission;
    // eth_requestAccounts is what grants it. Defaulting to true keeps the
    // behaviour every existing scenario was written against, and setting it to
    // false is the only way to test that the page asks rather than assumes.
    connected: true,
    receipt: null,
    sendError: null,
    sendDelayMs: 0,
    onSend: null,          // called with the tx; may change cfg mid-dialog
    chainIdSequence: null, // consume one per eth_chainId read, then fall back

    // REAL TRANSACTIONS, NOT A FAKE HASH.
    //
    // With this set, eth_sendTransaction and the receipt call go straight to
    // the node instead of being answered from cfg. The node holds the key - an
    // anvil dev account is unlocked - so it signs, mines, and hands back a
    // real hash with a real receipt, and balances actually move.
    //
    // The difference matters more than it looks. Everything the stub answers
    // itself can only test what the PAGE does; a transaction the chain
    // executed is the only thing that tests whether the calldata the page
    // built was right. A demo that proves a hash was displayed has not shown
    // anyone a working product.
    //
    // Off by default: the eighteen in-page scenarios are about the page's
    // behaviour around a send - rejection, a switched network, a lost record -
    // and those need a send they control, not one that really happens.
    forward: false,
  }, opts || {});

  const sent = [];
  const listeners = {};
  let id = 0;
  async function raw(method, params) {
    const r = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const b = await r.json();
    if (b.error) throw new Error(b.error.message);
    return b.result;
  }

  const wallet = {
    cfg, sent, listeners,
    emit(event, arg) { (listeners[event] || []).forEach((f) => f(arg)); },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
    removeListener(event, fn) { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); },
    async request({ method, params }) {
      if (method === "eth_chainId") {
        if (cfg.chainIdSequence && cfg.chainIdSequence.length) return cfg.chainIdSequence.shift();
        return cfg.chainId;
      }
      if (method === "eth_accounts") return cfg.connected ? [cfg.account] : [];
      // NETWORKS, AS A WALLET KEEPS THEM: it switches to one it knows, answers
      // 4902 (EIP-3085) for one it does not, and adds one when asked - then
      // switches to it, as MetaMask offers to. The requests are kept, so a
      // test can read what the page asked for.
      if (method === "wallet_switchEthereumChain") {
        const want = params && params[0] && params[0].chainId;
        wallet.switches.push(want);
        if (!cfg.knownChains.includes(want)) throw Object.assign(new Error("Unrecognized chain ID " + want), { code: 4902 });
        if (cfg.chainId !== want) { cfg.chainId = want; wallet.emit("chainChanged", want); }
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        const net = params && params[0];
        wallet.added.push(net);
        if (!cfg.knownChains.includes(net.chainId)) cfg.knownChains.push(net.chainId);
        if (cfg.chainId !== net.chainId) { cfg.chainId = net.chainId; wallet.emit("chainChanged", net.chainId); }
        return null;
      }
      if (method === "eth_requestAccounts") {
        cfg.connected = true;
        return [cfg.account];
      }
      if (method === "eth_call") return raw("eth_call", params);
      if (method === "eth_getTransactionReceipt") {
        return cfg.forward ? raw(method, params) : cfg.receipt;
      }
      if (method === "eth_sendTransaction") {
        // A SIGNAL AT THE START, not after. A test that wants to interfere while
        // the wallet dialog is open needs to know it is open; waiting a fixed
        // number of milliseconds and hoping is how a test becomes a coin flip.
        wallet.inflight += 1;
        try {
          return await doSend(params);
        } finally {
          wallet.inflight -= 1;
        }
      }
      return raw(method, params);
    },
  };

  async function doSend(params) {
    if (cfg.sendDelayMs) await new Promise((r) => setTimeout(r, cfg.sendDelayMs));
    if (cfg.onSend) cfg.onSend(params[0], wallet);
    if (cfg.sendError) throw cfg.sendError;
    if (cfg.forward) {
      // The node signs with its own unlocked account, so the `from` has to be
      // one it holds. A wrong `from` fails here rather than silently sending as
      // somebody else.
      const hash = await raw("eth_sendTransaction", params);
      sent.push(params[0]);
      return hash;
    }
    sent.push(params[0]);
    return "0x" + (sent.length.toString(16).padStart(2, "0")).repeat(32);
  }

  wallet.inflight = 0;
  wallet.switches = [];
  wallet.added = [];
  if (!Array.isArray(cfg.knownChains)) cfg.knownChains = [cfg.chainId];
  return wallet;
}


window.makeWallet = makeWallet;
// A CREATE TAKES A PERSON STRAIGHT TO THE NEW TOKEN'S PAGE (app.js adoptCreated).
// The suites that go on to trade on the form after creating stay on it; the
// test of the move itself deletes this before the page loads.
window.CURB_STAY_AFTER_CREATE = true;
