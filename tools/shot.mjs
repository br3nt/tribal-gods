#!/usr/bin/env node
/**
 * tools/shot.mjs — headless screenshot of the running game, for checking
 * visual work without a human in the loop.
 *
 *   node tools/shot.mjs <url> <out.png> [--wait ms] [--eval "js"] [--size WxH]
 *
 * Start your own dev server first (pick a unique port so parallel work
 * doesn't collide):   npx vite --port 52xx --strictPort
 * Then e.g.:
 *   node tools/shot.mjs "http://localhost:5201/tribal-gods/?play=1&seed=7" shots/a.png --wait 2500
 *
 * `?play=1` skips the menu (see main.ts); `&seed=N` fixes the planet;
 * `&level=<official level id>` loads a designed level instead.
 * --eval runs in the page before the screenshot; `window.__tg` exposes
 * { world, rig, appState } so you can move the camera, spawn units, cast
 * spells, fast-forward ticks, etc. May be passed more than once; each runs
 * in order, with --wait applied after each.
 * Console errors from the page are printed — treat any as a failure.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const [url, out] = args;
if (!url || !out) {
  console.error('usage: shot.mjs <url> <out.png> [--wait ms] [--eval js]... [--size WxH]');
  process.exit(2);
}
let wait = 2000;
let size = [1440, 900];
const evals = [];
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--wait') wait = Number(args[++i]);
  else if (args[i] === '--eval') evals.push(args[++i]);
  else if (args[i] === '--size') size = args[++i].split('x').map(Number);
}

// Use whichever headless Chromium Playwright has already cached locally.
function findChromium() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of dirs) {
    for (const sub of readdirSync(join(cache, d))) {
      const p = join(cache, d, sub, 'chrome-headless-shell');
      if (existsSync(p)) return p;
    }
  }
  return undefined; // fall back to playwright's default lookup
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
let errors = 0;
page.on('console', (m) => {
  if (m.type() === 'error') {
    errors++;
    console.error('[page error]', m.text());
  }
});
page.on('pageerror', (e) => {
  errors++;
  console.error('[page exception]', e.message);
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(wait);
for (const js of evals) {
  const r = await page.evaluate(js);
  if (r !== undefined) console.log('[eval]', JSON.stringify(r));
  await page.waitForTimeout(wait);
}
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
await browser.close();
console.log(`saved ${out}${errors ? ` (${errors} page errors)` : ''}`);
process.exit(errors ? 1 : 0);
