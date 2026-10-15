const { defineConfig } = require("@playwright/test");

// Microsoft Edge rather than Playwright's own Chromium: it is already on this
// machine, so `npm install` does not have to pull a browser build down. Set
// CURB_E2E_BROWSER=chromium (and run `npx playwright install chromium`) to use
// the bundled one instead.
const channel = process.env.CURB_E2E_BROWSER === "chromium" ? undefined : (process.env.CURB_E2E_BROWSER || "msedge");

module.exports = defineConfig({
  testDir: __dirname,
  // One worker. The scenarios share one fork, one launch and one origin's
  // storage; running them at once would make them each other's flakiness.
  workers: 1,
  fullyParallel: false,
  // A stuck receipt poll must fail the run rather than hang CI.
  timeout: 60_000,
  // THE WHOLE RUN, NOT ONE TEST. Ten minutes was set when this file held about
  // half the tests it holds now; the suite outgrew it, and a run cut off
  // part-way kills the worker mid-trace-write, which surfaces as a corrupt
  // artifact rather than as "out of time". Override with CURB_E2E_GLOBAL_MIN.
  globalTimeout: Number(process.env.CURB_E2E_GLOBAL_MIN || 30) * 60_000,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  globalSetup: require.resolve("./global-setup.js"),
  use: {
    baseURL: "http://127.0.0.1:" + (process.env.CURB_E2E_PORT || 8778),
    channel,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node serve.js",
    url: "http://127.0.0.1:" + (process.env.CURB_E2E_PORT || 8778) + "/launch.html",
    cwd: __dirname,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
  },
});
