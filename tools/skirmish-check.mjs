#!/usr/bin/env node
/**
 * tools/skirmish-check.mjs — the first five minutes of a default skirmish
 * through real input, checked against the owner's feedback points, plus
 * the visual-consistency screenshots of every screen (title, briefing,
 * debrief come from play-chapter.mjs).
 *
 *   node tools/skirmish-check.mjs <base url> [--seed N] [--shots dir] [--size WxH]
 *
 * Input is page.mouse / page.keyboard only; window.__tg READS state (and,
 * for the one "a rival kneels" check, wakes the rival AI's leader toward a
 * stone the way its own brain would — logged as setup). Prints one line of
 * evidence per point; exit 1 if any check fails or the page logs an error.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = args[0] ?? 'http://localhost:5241/tribal-gods/';
let seed = 7;
let shotDir = null;
let size = [1440, 900];
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--seed') seed = Number(args[++i]);
  else if (args[i] === '--shots') shotDir = args[++i];
  else if (args[i] === '--size') size = args[++i].split('x').map(Number);
}
if (shotDir) mkdirSync(shotDir, { recursive: true });
function findChromium() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of dirs) for (const sub of readdirSync(join(cache, d))) {
    const p = join(cache, d, sub, 'chrome-headless-shell');
    if (existsSync(p)) return p;
  }
  return undefined;
}
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));
const wait = (ms) => page.waitForTimeout(ms);
const tg = (fn, a) => page.evaluate(fn, a);
const tag = `${size[0]}x${size[1]}`;
async function shot(name) {
  if (shotDir) await page.screenshot({ path: join(shotDir, `skirmish-${tag}-${name}.png`) });
  return shotDir ? join(shotDir, `skirmish-${tag}-${name}.png`) : '';
}
const evidence = [];
function check(point, ok, how) {
  evidence.push({ point, ok, how });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${point} — ${how}`);
}
const screenOf = (x, z, h = 0) => tg(([x, z, h]) => window.__tg.screenOf(x, z, h), [x, z, h]);
const under = (p) => tg(([x, y]) => window.__tg.ui.orders.whatIsUnder(x, y), [p.x, p.y]);
async function settle() {
  await wait(150);
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const now = await tg(() => [window.__tg.rig.target.x, window.__tg.rig.target.y, window.__tg.rig.target.z, window.__tg.rig.distance, window.__tg.rig.yaw]);
    if (prev && now.every((v, k) => Math.abs(v - prev[k]) < 0.01)) break;
    prev = now;
    await wait(60);
  }
}
async function look(x, z) {
  const box = await page.locator('.mm canvas').boundingBox();
  const w = (v) => ((v % 128) + 128) % 128;
  await page.mouse.click(box.x + (box.width * (w(x) + 0.5)) / 128, box.y + (box.height * (w(z) + 0.5)) / 128);
  await settle();
}
let lastTag = '';
/** The hover tag's text once it shows something new (a stale tag from the last target doesn't count). */
async function hoverTag() {
  for (let i = 0; i < 12; i++) {
    const t = ((await page.locator('.wh-tag.show').first().textContent({ timeout: 300 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    if (t && t !== lastTag) return (lastTag = t);
    await wait(100);
  }
  return '';
}

// --- Title → skirmish -----------------------------------------------------------
await page.goto(`${base}?seed=${seed}`, { waitUntil: 'load' });
await wait(2500);
await tg(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await wait(2500);
await shot('01-title');
await page.locator('button', { hasText: 'Skirmish' }).first().click();
await wait(500);
await shot('02-skirmish-setup');
await page.locator('button', { hasText: 'Begin' }).first().click();
await wait(2000);
await shot('03-start-default-zoom');

const st = await tg(() => {
  const w = window.__tg.world;
  const h = w.tribes.player.home;
  const l = w.leaderOf('player');
  const d = (a) => Math.hypot(a.x - h.x, a.z - h.z);
  return {
    home: h,
    leader: { id: l.id, x: l.x, z: l.z },
    wild: w.units.filter((u) => u.tribe === 'wild' && u.kind === 'wildman').map((u) => ({ id: u.id, x: u.x, z: u.z, d: d(u) })).sort((a, b) => a.d - b.d),
    stones: w.monuments.map((m, i) => ({ i, x: m.x, z: m.z, spell: m.spell, d: d(m), avail: w.monumentAvailable(m) })).sort((a, b) => a.d - b.d),
    hint: document.querySelector('.hint-chip')?.textContent?.trim() ?? '',
  };
});
const errand = (st.wild[0]?.d ?? 99) < 24 || st.stones.some((s) => s.d < 26 && s.avail);
check('Leader has an errand at once (wanderers, a nearby stone)', errand,
  `nearest wanderer ${st.wild[0]?.d.toFixed(0) ?? '-'} tiles, nearest open stone ${st.stones.find((s) => s.avail)?.d.toFixed(0) ?? '-'} tiles (${st.stones.find((s) => s.avail)?.spell ?? ''}); shot 03`);

// --- Stones show their spell at default zoom ---------------------------------------
const stone = st.stones.find((s) => s.avail) ?? st.stones[0];
await look(stone.x, stone.z);
await wait(300);
const mk = await tg(() => [...document.querySelectorAll('.stone-mk')].filter((e) => !e.hidden).map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, icon: !!e.querySelector('svg') }; }));
const p03 = await shot('04-stone-default-zoom');
check('Stones show the spell they hold at default zoom', mk.length > 0 && mk.every((m) => m.icon && m.w >= 40),
  `${mk.length} stone marker(s) on screen, ${mk[0]?.w.toFixed(0)}px across with the spell's icon (raised from 34px); rune glows on the stone; ${p03.split('/').pop()}`);

// --- Hover feedback everywhere -------------------------------------------------------
const tags = {};
// a stone
for (const lift of [2, 3, 1.2, 4]) {
  const p = await screenOf(stone.x, stone.z, lift);
  if (p && (await under(p)).monument === stone.i) {
    await page.mouse.move(p.x, p.y);
    await wait(700);
    tags.stone = await hoverTag();
    break;
  }
}
await shot('05-hover-stone');
// a villager
await look(st.home.x, st.home.z);
const vill = await tg(() => window.__tg.world.units.filter((u) => u.tribe === 'player' && u.kind === 'brave' && !u.hidden).map((u) => ({ id: u.id, x: u.x, z: u.z })));
for (const v of vill) {
  const p = await screenOf(v.x, v.z, 1.1);
  if (p && (await under(p)).unit === v.id) {
    await page.mouse.move(p.x, p.y);
    await wait(700);
    tags.villager = await hoverTag();
    break;
  }
}
await shot('06-hover-villager');
// a wanderer
if (st.wild[0]) {
  await look(st.wild[0].x, st.wild[0].z);
  await tg(() => (window.__tg.appState.paused = true)); // people stop walking under the cursor while it hovers
  for (const lift of [1.1, 1.5, 0.7, 1.8]) {
    const wl = await tg((id) => window.__tg.world.unitById(id), st.wild[0].id);
    const p = wl && (await screenOf(wl.x, wl.z, lift));
    if (p && (await under(p)).unit === wl.id) {
      await page.mouse.move(p.x, p.y);
      await wait(700);
      tags.wanderer = await hoverTag();
      if (/wanderer/i.test(tags.wanderer)) break;
    }
  }
  await tg(() => (window.__tg.appState.paused = false));
  await shot('07-hover-wanderer');
}
// the HUD: a spell slot
const slot = page.locator('.sb-slot').first();
if (await slot.count()) {
  await slot.hover();
  await wait(700);
  tags.spellSlot = ((await page.locator('.tg-tip:not(.wh-tag)').first().textContent({ timeout: 700 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  await shot('08-hover-spell-slot');
}
check('Hover feedback everywhere', !!tags.stone && !!tags.villager && (!st.wild[0] || !!tags.wanderer),
  Object.entries(tags).map(([k, v]) => `${k}: "${v.slice(0, 50)}"`).join('; '));
check('Wanderers not selectable (hover says look, not select)', !tags.wanderer || !/to select/i.test(tags.wanderer), `wanderer tag "${tags.wanderer?.slice(0, 60)}"`);

// --- Left-click orders ---------------------------------------------------------------
await page.mouse.move(10, 400);
await look(st.home.x, st.home.z);
let ordered = 'no villager clickable';
for (const v of vill.slice(0, 6)) {
  const now = await tg((id) => window.__tg.world.unitById(id), v.id);
  const p = await screenOf(now.x, now.z, 1.1);
  if (!p || (await under(p)).unit !== v.id) continue;
  await page.mouse.click(p.x, p.y);
  await wait(150);
  const spot = await tg(([x, z]) => {
    const w = window.__tg.world;
    for (let r = 5; r < 12; r++) for (let a = 0; a < 12; a++) {
      const tx = Math.round(x + Math.cos(a) * r), tz = Math.round(z + Math.sin(a) * r);
      if (w.map.heightAt(tx, tz) > 1 && !w.buildings.some((b) => Math.abs(b.x - tx) < 4 && Math.abs(b.z - tz) < 4) && !w.monuments.some((m) => Math.hypot(m.x - tx, m.z - tz) < 4) && !w.units.some((q) => Math.hypot(q.x - tx, q.z - tz) < 2)) return { x: tx, z: tz };
    }
    return null;
  }, [now.x, now.z]);
  const q = spot && (await screenOf(spot.x, spot.z));
  if (!q) continue;
  const u = await under(q);
  if (u.unit !== null || u.building !== null) continue;
  await page.mouse.move(q.x, q.y);
  await wait(250);
  const cursor = await tg(() => window.__tg.ui.ctx.canvas.style.cursor);
  await page.mouse.click(q.x, q.y);
  await wait(150);
  const s2 = await tg((id) => window.__tg.world.unitById(id).state, v.id);
  await shot('09-left-click-order');
  ordered = `villager #${v.id} ${s2} after a plain left click on the ground (cursor ${/url\(/.test(cursor) ? 'is the move cursor' : cursor})`;
  check('Left-click moves selected units', s2 === 'moving', ordered);
  break;
}
if (ordered === 'no villager clickable') check('Left-click moves selected units', false, ordered);
await page.keyboard.press('Escape');

// --- Drag-select drawn on the land ---------------------------------------------------
await look(st.home.x, st.home.z);
await page.mouse.move(size[0] * 0.35, size[1] * 0.4);
await page.mouse.down();
await page.mouse.move(size[0] * 0.55, size[1] * 0.55, { steps: 5 });
await page.mouse.move(size[0] * 0.65, size[1] * 0.68, { steps: 5 });
await wait(120);
const drawn = await tg(() => window.__tg.scene.children.some((o) => o.isMesh && o.visible && o.renderOrder === 18));
await shot('10-drag-on-land');
await page.mouse.up();
await wait(150);
const nsel = await tg(() => window.__tg.ui.selection.units.size);
check('Drag-select drawn on the land', drawn, `ground decal (draped quad, renderOrder 18) visible during the drag; ${nsel} selected; shot 10`);
await page.keyboard.press('Escape');

// --- Commune: select leader, click stone; takes time; shows progress -----------------
await page.keyboard.press('KeyL');
await wait(150);
await look(stone.x, stone.z);
let at = null;
for (const lift of [2, 3, 1.2, 4]) {
  const p = await screenOf(stone.x, stone.z, lift);
  if (p && (await under(p)).monument === stone.i) { at = p; break; }
}
let communeNote = 'stone not clickable';
if (at) {
  await page.mouse.move(at.x, at.y);
  await wait(600);
  const cursor = await tg(() => window.__tg.ui.ctx.canvas.style.cursor);
  await page.mouse.click(at.x, at.y);
  await wait(200);
  await page.keyboard.press('Escape');
  await page.keyboard.press('BracketRight');
  await page.keyboard.press('BracketRight');
  const t0 = await tg(() => window.__tg.world.elapsed);
  let begun = null, seenRing = false, prog = [];
  for (let i = 0; i < 300; i++) {
    const r = await tg((i) => { const m = window.__tg.world.monuments[i]; return { c: !!m.communing, p: m.communeProgress ?? 0, t: window.__tg.world.elapsed, got: !window.__tg.world.monumentAvailable(m) || window.__tg.world.tribes.player.known.has(m.spell) }; }, stone.i);
    if (r.c && begun === null) begun = r.t;
    if (r.c) prog.push(r.p);
    if (r.c && !seenRing && (await page.locator('.stone-mk .ritual:not([hidden])').count())) {
      seenRing = true;
      await wait(100);
      await shot('11-commune-progress');
    }
    if (begun !== null && !r.c && r.got) {
      communeNote = `cursor over stone ${/url\(/.test(cursor) ? 'is the commune cursor' : cursor}; leader walked ${(begun - t0).toFixed(0)}s, knelt ${(r.t - begun).toFixed(0)}s (ritual ${await tg((i) => window.__tg.ui ? 0 : 0, 0) || ''}), progress ring shown: ${seenRing}`;
      break;
    }
    await wait(150);
  }
  check('Commune takes time and shows progress', begun !== null && seenRing && prog.length > 3, communeNote);
} else check('Commune takes time and shows progress', false, communeNote);
await page.keyboard.press('BracketLeft');
await page.keyboard.press('BracketLeft');

// --- A rival's ritual raises an alert -----------------------------------------------
const rival = await tg(() => {
  const w = window.__tg.world;
  const id = w.activeTribes().find((t) => t !== 'player');
  const l = w.leaderOf(id);
  const i = w.monuments.findIndex((m) => w.monumentAvailable(m));
  if (!l || i < 0) return null;
  // setup: the rival god sends its leader to the nearest open stone (what its own brain does when awake)
  w.orderWorship([l.id], i);
  return { id, i, m: w.monuments[i] };
});
let alertText = '';
if (rival) {
  for (let i = 0; i < 200 && !alertText; i++) {
    await wait(250);
    alertText = await tg(() => [...document.querySelectorAll('.alert, .al, [class*=alert]')].map((e) => e.textContent ?? '').find((t) => /commun|ritual|kneel/i.test(t)) ?? '');
  }
  await shot('12-rival-ritual-alert');
}
check("A rival's ritual raises an alert", !!alertText, rival ? `alert: "${alertText.replace(/\s+/g, ' ').slice(0, 80)}"` : 'no rival leader / open stone');

// --- Camera-independence checks (grass, foundations, bars) -----------------------------
// A Dwelling site near home (Shift+1, click): its build bar is the bar under test.
await look(st.home.x, st.home.z);
const site = await tg(() => {
  const w = window.__tg.world; const h = w.tribes.player.home;
  for (let r = 6; r < 20; r++) for (let a = 0; a < 16; a++) { const x = Math.round(h.x + Math.cos(a / 16 * 6.283) * r), z = Math.round(h.z + Math.sin(a / 16 * 6.283) * r); if (w.canPlaceBuilding('player', 'hut', x, z)) return { x, z }; }
  return null;
});
if (site) {
  await look(site.x, site.z);
  const sp = await screenOf(site.x, site.z);
  await page.keyboard.press('Shift+Digit1');
  await page.mouse.click(sp.x, sp.y);
  await wait(300);
  if ((await tg(() => window.__tg.toolState.tool)) !== 'select') await page.keyboard.press('Escape');
  for (let i = 0; i < 40; i++) { await wait(150); if (await tg(() => window.__tg.world.buildings.some((b) => b.tribe === 'player' && b.progress > 0.15 && b.progress < 1))) break; }
}
await tg(() => (window.__tg.appState.paused = true));
if (site) await look(site.x, site.z);
await shot('13-yaw-0');
for (let i = 0; i < 6; i++) { await page.keyboard.down('KeyQ'); await wait(120); await page.keyboard.up('KeyQ'); }
await settle();
await shot('14-yaw-rotated');
await page.mouse.wheel(0, -500);
await settle();
await shot('15-zoomed-in');
const bars = () => tg(() => [...document.querySelectorAll('.wo .hp, .wo .tr')].filter((e) => e.offsetParent).slice(0, 3).map((e) => e.getBoundingClientRect().width.toFixed(0)));
const barW = await bars();
await page.mouse.wheel(0, 900);
await settle();
const barW2 = await bars();
await shot('16-zoomed-out');
check('Progress bars do not change with the camera', barW.length > 0 && barW2.length > 0 && barW[0] === barW2[0], `bar widths zoomed in ${barW.join('/')}px, zoomed out ${barW2.join('/')}px (shots 15/16)`);
await tg(() => (window.__tg.appState.paused = false));

// --- Pause, settings, how-to-play -----------------------------------------------------
// Esc drops a selection first, then opens the menu.
for (let i = 0; i < 2 && !(await tg(() => window.__tg.menu.visible)); i++) { await page.keyboard.press('Escape'); await wait(400); }
await shot('17-pause-menu');
const settingsBtn = page.locator('button', { hasText: 'Settings' }).first();
if (await settingsBtn.count()) { await settingsBtn.click(); await wait(500); await shot('18-settings'); await page.keyboard.press('Escape'); await wait(300); }
const helpBtn = page.locator('button', { hasText: /How to play/i }).first();
if (await helpBtn.count()) { await helpBtn.click(); await wait(500); await shot('19-how-to-play'); }

await browser.close();
const bad = evidence.filter((e) => !e.ok);
console.log(`\n${evidence.length - bad.length}/${evidence.length} checks passed${pageErrors.length ? `; page errors: ${pageErrors.slice(0, 2).join(' | ')}` : ''}`);
process.exit(bad.length || pageErrors.length ? 1 : 0);
