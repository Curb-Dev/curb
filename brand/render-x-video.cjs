const { chromium } = require('../web/e2e/node_modules/@playwright/test');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: path.join(__dirname, '.video-tmp'), size: { width: 1280, height: 720 } }
  });
  const page = await context.newPage();
  await page.goto('file:///' + path.join(__dirname, 'x-first-post.html').replace(/\\/g, '/'));
  await page.waitForTimeout(8000);
  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  console.log(videoPath);
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
