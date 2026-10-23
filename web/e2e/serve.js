// A static server for web/, with caching switched off.
//
// Playwright starts this itself so the suite is one command. No-store matters:
// a runner that can silently serve a cached copy of the file it is testing is
// worse than no runner, and this repository has already been bitten by exactly
// that in the in-page harness.
//
// IT ANSWERS AS THE HOSTS DO (web/vercel.json, web/_redirects): / is the
// launches page, /token/0x... is app.html, each page has its name without
// .html (CLEAN: /launchpad is app.html, /docs is docs.html...), the name with a
// slash after it is sent on to the name, and an address that is no file gets
// web/404.html with a 404.
//
// CURB_E2E_HEADERS=1 SENDS THE SITE'S RESPONSE HEADERS (web/_headers, the file
// Netlify and Cloudflare Pages read; vercel.json carries the same values) on
// every answer, so a run can show the pages work under the production policy.
// One addition, said where it is made: connect-src also allows
// http://127.0.0.1:*, because the browser tests read a local node over http
// and production reads an https endpoint.
//
// Required as a module (prod.spec.js), it starts nothing and gives the parser.
// THE HEADERS ARE NOT ADDED BY INTERCEPTING RESPONSES IN THE BROWSER: a page
// the test runner fulfils has no address, the browser counts it as public, and
// its reads of the local node are then refused as a public site reaching into
// the loopback network - a failure the real site would never meet.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.CURB_E2E_PORT || 8778);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // THE SHARER'S BROWSER BUILD is an ES module, which a browser runs only when
  // it is served as JavaScript; and an epoch file is JSON.
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

/// THE HEADERS web/_headers GIVES EVERY PATH: the block under "/*", as
/// [name, value] pairs. Only that one block is read, because it is the only one
/// the file has; a second block would be a reason to read this again.
function siteHeaders(text) {
  const out = [];
  let inAll = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    if (!/^\s/.test(raw)) { inAll = raw.trim() === "/*"; continue; }
    if (!inAll) continue;
    const at = raw.indexOf(":");
    if (at < 0) continue;
    out.push([raw.slice(0, at).trim(), raw.slice(at + 1).trim()]);
  }
  return out;
}

/// The same headers, with the local node allowed to answer (see above).
function testHeaders(text) {
  return siteHeaders(text).map(([k, v]) => [k, k.toLowerCase() === "content-security-policy"
    ? v.replace(/connect-src ([^;]*)/, "connect-src $1 http://127.0.0.1:*") : v]);
}

/// WEB/config.js AS THE BROWSER TESTS EXPECT IT: its deployment fields as the
/// placeholders they were before deploy day ("EMPTY STRINGS ARE PLACEHOLDERS",
/// config.js), so what the pages read is the local node and lens a link names.
/// Filled on 16 October 2026, the file as committed refused every send to the
/// tests' own factories and read Base itself. The rest of it - the incident
/// switches, the explorer - is as committed. CURB_E2E_SITE=deployed serves the
/// file as committed instead.
function testConfig() {
  return fs.readFileSync(path.join(ROOT, "config.js"), "utf8") +
    "\nObject.assign(window.CURB_SITE, { rpc: \"\", logsRpc: \"\", logsBlocks: 0, lens: \"\", registry: \"\", factories: [] });\n";
}

/// The file a path names, as the hosts' rewrites make it.
/// THE PAGES BY NAME, as vercel.json and _redirects serve them.
const CLEAN = {
  launchpad: "app.html", launches: "browse.html", curb: "curb.html", docs: "docs.html",
  migrate: "migrate.html", terms: "terms.html", sharing: "sharing.html",
};

function fileFor(pathname) {
  if (pathname === "/" || pathname === "") return "browse.html";
  if (/^\/token\/0x[0-9a-fA-F]{40}\/?$/.test(pathname)) return "app.html";
  const name = /^\/([a-z]+)$/.exec(pathname);
  if (name && Object.hasOwn(CLEAN, name[1])) return CLEAN[name[1]];
  return decodeURIComponent(pathname).replace(/^\/+/, "");
}

/// A NAME WITH A SLASH AFTER IT, sent on to the name without one (the hosts'
/// trailingSlash: false): a page served under /docs/ would look for its own
/// files in /docs/. The query goes with it. null for anything else.
function slashRedirect(pathname, search) {
  const name = /^\/([a-z]+)\/$/.exec(pathname);
  return name && Object.hasOwn(CLEAN, name[1]) ? "/" + name[1] + (search || "") : null;
}

function start() {
  const extra = process.env.CURB_E2E_HEADERS === "1"
    ? testHeaders(fs.readFileSync(path.join(ROOT, "_headers"), "utf8")) : [];
  http
    .createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const onward = slashRedirect(url.pathname, url.search);
      if (onward) {
        res.writeHead(308, Object.fromEntries([["location", onward], ["cache-control", "no-store"], ...extra]));
        res.end();
        return;
      }
      const rel = fileFor(url.pathname);
      const file = path.resolve(ROOT, rel);
      // Nothing outside web/ is servable, whatever the path says.
      if (!file.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end("no");
        return;
      }
      const send = (status, type, body) => {
        res.writeHead(status, Object.fromEntries([["content-type", type], ["cache-control", "no-store"], ...extra]));
        res.end(body);
      };
      if (rel === "config.js" && process.env.CURB_E2E_SITE !== "deployed") {
        send(200, TYPES[".js"], testConfig());
        return;
      }
      fs.readFile(file, (err, body) => {
        if (!err) { send(200, TYPES[path.extname(file)] || "application/octet-stream", body); return; }
        // NOT A FILE: the site's own 404 page, as a host serves it.
        fs.readFile(path.join(ROOT, "404.html"), (err404, page) => {
          if (err404) send(404, "text/plain", "not found: " + rel);
          else send(404, TYPES[".html"], page);
        });
      });
    })
    // PORT 0 IS THE SYSTEM'S CHOICE, and the line says which it chose: a test
    // that starts a second server of its own (prod.spec.js) takes no port
    // another run might hold.
    .listen(PORT, "127.0.0.1", function () {
      console.log("serving " + ROOT + " on " + this.address().port + (extra.length ? " with the site's headers" : ""));
    });
}

/// WHAT EVERY SEND'S CALLDATA ENDS WITH: CURB's Builder Code suffix as
/// web/builder-code.js has it, without 0x. site.spec.js pins the value itself;
/// the suites that read a send's calldata take it from here.
const BUILDER_SUFFIX = fs.readFileSync(path.join(ROOT, "builder-code.js"), "utf8").match(/dataSuffix = "0x([0-9a-f]+)"/)[1];

if (require.main === module) start();
module.exports = { siteHeaders, testHeaders, fileFor, slashRedirect, CLEAN, testConfig, BUILDER_SUFFIX };
