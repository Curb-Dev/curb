// $CURB'S TOKEN URI, MADE AS THE SITE'S CREATE FORM MAKES ONE (deploy/README.txt).
//
//   node deploy/make-curb-uri.js --check          made again and compared with
//                                                 deploy/curb-first-uri.txt
//   node deploy/make-curb-uri.js --out deploy/curb-first-uri.txt [--no-telegram]
//                                                 written, for a commit of its own
//
// From a Windows PowerShell in the checkout, like the browser suite (DEPLOY.txt
// STEP 1): it drives Microsoft Edge through web/e2e's Playwright, which PREP 2's
// `cd web\e2e; npm ci` installs.
//
// THE SAME STEPS AS THE OWNER WOULD TAKE BY HAND, so the token page reads it as
// it reads any launch's. The form takes png, jpeg, webp or gif - not svg
// (app.html's #nImageFile) - so web/curb-mark.svg is first drawn at its own
// 400x400 in the browser and saved as PNG; that PNG is then given to the form's
// own picker on app.html, whose handler (shrinkToDataUri in web/app.js) crops,
// draws it at 128x128 and keeps the first WebP under its 24 KiB ceiling; the
// image is what the picker's preview then shows, byte for byte. The JSON is
// buildTokenUri's: its key order, empty fields dropped, base64 of the UTF-8.
//
// THE WORDS ARE DECISION 6's (DEPLOY.txt), written here once, so the file can be
// made again and checked rather than trusted. --no-telegram leaves the Telegram
// link out, for a day on which the group is not the project's yet: the URI is
// written into the token for good.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const COMMITTED = path.join(__dirname, "curb-first-uri.txt");
const WORDS = {
  name: "Curb",
  symbol: "CURB",
  description: "Real pairs. Open launches.",
  website: "https://curbfun.xyz",
  twitter: "https://x.com/CurbFun",
  telegram: "https://t.me/CurbCommunity",
};

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : null;
if ((!has("--check") && !out) || (outAt >= 0 && !out) ||
    args.some((a, i) => !["--check", "--out", "--no-telegram"].includes(a) && i !== outAt + 1)) {
  console.error("usage: node deploy/make-curb-uri.js --check | --out <file> [--no-telegram]");
  process.exit(2);
}

/// web/e2e/serve.js on a port of the system's choosing, as the hosts serve web/.
function serve() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "web", "e2e", "serve.js")], {
      env: { ...process.env, CURB_E2E_PORT: "0" }, stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /serving .* on (\d+)/.exec(buf);
      if (m) resolve({ child, base: "http://127.0.0.1:" + m[1] });
    });
    child.on("exit", (c) => reject(new Error("web/e2e/serve.js exited (" + c + ") before serving")));
  });
}

async function make(withTelegram) {
  const { chromium } = require(path.join(ROOT, "web", "e2e", "node_modules", "playwright"));
  const { child, base } = await serve();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "curb-uri-"));
  const channel = process.env.CURB_E2E_BROWSER === "chromium" ? undefined : (process.env.CURB_E2E_BROWSER || "msedge");
  const browser = await chromium.launch({ channel });
  try {
    const page = await browser.newPage();
    await page.goto(base + "/app.html");
    const png = await page.evaluate(async () => {
      const img = new Image();
      img.src = "/curb-mark.svg";
      await img.decode();
      const c = document.createElement("canvas");
      c.width = 400; c.height = 400;
      c.getContext("2d").drawImage(img, 0, 0, 400, 400);
      return c.toDataURL("image/png").split(",")[1];
    });
    const pngFile = path.join(tmp, "curb-mark.png");
    fs.writeFileSync(pngFile, Buffer.from(png, "base64"));
    await page.setInputFiles("#nImageFile", pngFile);
    await page.waitForFunction(
      () => (document.getElementById("nImagePreview").getAttribute("src") || "").startsWith("data:image/"),
      null, { timeout: 15000 });
    const image = await page.getAttribute("#nImagePreview", "src");
    const meta = { name: WORDS.name, symbol: WORDS.symbol, description: WORDS.description, image,
      website: WORDS.website, twitter: WORDS.twitter, telegram: withTelegram ? WORDS.telegram : "" };
    for (const k of Object.keys(meta)) if (!meta[k]) delete meta[k];
    return "data:application/json;base64," + Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
  } finally {
    await browser.close();
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  const uri = await make(!has("--no-telegram"));
  // CURB_FIRST_URI's rules (DEPLOY.txt decision 6): printable ASCII, no space at
  // either end - forge trims those before the script reads the value.
  if (!/^[\x21-\x7e][\x20-\x7e]*[\x21-\x7e]$/.test(uri)) throw new Error("the URI is not printable ASCII without outer spaces");
  if (has("--check")) {
    const committed = fs.readFileSync(COMMITTED, "utf8");
    if (committed !== uri) {
      console.error("DIFFERENT: deploy/curb-first-uri.txt is not what this makes (" + committed.length + " against " + uri.length + " characters)");
      process.exit(1);
    }
    console.log("same: deploy/curb-first-uri.txt is what the create form makes from web/curb-mark.svg and decision 6's words (" + uri.length + " characters)");
  }
  if (out) {
    // ONE LINE AND NOTHING ELSE: CURB_FIRST_URI="$(cat <file>)" takes all of it.
    fs.writeFileSync(out, uri);
    console.log("written: " + out + " (" + uri.length + " characters)" + (has("--no-telegram") ? ", without the Telegram link" : ""));
  }
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
