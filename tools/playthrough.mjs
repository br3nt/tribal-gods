#!/usr/bin/env node
/**
 * tools/playthrough.mjs — drive the game through REAL input (mouse, keys)
 * like a player, step by step, and print a checklist of what worked.
 *
 *   node tools/playthrough.mjs <base url> [--seed N|random] [--shots dir] [--only name,name]
 *   e.g. node tools/playthrough.mjs "http://localhost:5217/tribal-gods/" --seed 7 --shots shots/play
 *
 * --seed N fixes the skirmish planet (the URL's ?seed= is honoured by the
 * menu's Begin), default 7; --seed random lets the menu roll one, and the
 * run prints the seed it got so a failure can be replayed.
 *
 * Start a dev server first (npx vite --port 52xx --strictPort). Every step
 * uses page.mouse / page.keyboard on the actual canvas and HUD; the
 * automation handle (window.__tg) is only used to SET UP a situation
 * (grant wood or spell charges, fast-forward time) and to CHECK the result
 * — never to perform the action under test. Exit code 1 if any step fails
 * or the page logs an error.
 *
 * Steps: title → skirmish setup; camera keys; click/box/double-click
 * select; right-click move; all 8 buildings placed via Shift+N + click;
 * training at all 4 halls via the selection panel; tower + shrine garrison
 * by right-click; demolish (Del); pause/speed keys; control groups;
 * minimap click/drag and right-click order; all 14 spells aimed + cast via
 * hotkey + click; Esc menu → autosave → reload → Continue; campaign map →
 * briefing → play → win → debrief → boon → next chapter.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = args[0] ?? 'http://localhost:5217/tribal-gods/';
let shotDir = null;
let only = null;
let seed = '7';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--shots') shotDir = args[++i];
  else if (args[i] === '--only') only = args[++i].split(',');
  else if (args[i] === '--seed') seed = args[++i];
}
const seedQuery = seed === 'random' ? '' : `?seed=${Number(seed)}`;
if (shotDir) mkdirSync(shotDir, { recursive: true });

function findChromium() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of dirs) {
    for (const sub of readdirSync(join(cache, d))) {
      const p = join(cache, d, sub, 'chrome-headless-shell');
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));

const results = [];
const wait = (ms) => page.waitForTimeout(ms);
const tg = (fn, arg) => page.evaluate(fn, arg);
async function shot(name) {
  if (shotDir) await page.screenshot({ path: join(shotDir, `${name}.png`) });
}
async function step(name, fn) {
  if (only && !only.some((o) => name.startsWith(o))) return;
  const errsBefore = pageErrors.length;
  try {
    const note = await fn();
    const errs = pageErrors.slice(errsBefore);
    results.push({ name, ok: errs.length === 0, note: errs.length ? `page error: ${errs[0]}` : note ?? '' });
  } catch (e) {
    results.push({ name, ok: false, note: String(e.message ?? e).split('\n')[0] });
  }
  const r = results[results.length - 1];
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}${r.note ? ` — ${r.note}` : ''}`);
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const clickText = async (text, sel = 'button') => {
  const el = page.locator(sel, { hasText: text }).first();
  await el.click();
};
/** Screen position of a tile, via the game's own projection. */
const screenOf = (x, z, h = 0) => tg(([x, z, h]) => window.__tg.screenOf(x, z, h), [x, z, h]);
/** Point the camera at a tile (setup only). */
const lookAt = (x, z) => tg(([x, z]) => window.__tg.rig.target.set(x * 2, 0, z * 2), [x, z]);
/** Centre the view on a tile and give the camera a few frames to settle. */
const focus = async (x, z) => {
  await lookAt(x, z);
  await wait(250);
};
/**
 * Click a person the way a player would: on their body, at a point where
 * THEY are what's drawn (the game's own picking says so — someone may be
 * standing in front), then check the selection really is them.
 */
async function clickUnit(u, opts = {}) {
  await focus(u.x, u.z);
  const now = await tg((id) => window.__tg.world.unitById(id), u.id);
  for (const lift of [1.1, 1.5, 0.7, 1.9]) {
    const p = await screenOf(now.x, now.z, lift);
    if (!p) continue;
    const under = await tg(([x, y]) => window.__tg.ui.orders.whatIsUnder(x, y), [p.x, p.y]);
    if (under.unit !== u.id) continue;
    await page.mouse.click(p.x, p.y, opts);
    await wait(120);
    const sel = await tg(() => [...window.__tg.ui.selection.units]);
    expect(sel.includes(u.id), `clicked ${u.kind} #${u.id} but selection is [${sel.join(',')}]`);
    return p;
  }
  throw new Error(`no point on ${u.kind} #${u.id} where it is the thing under the cursor`);
}

/** Click a building where the building itself is drawn (not someone standing in front of it). */
async function clickBuilding(b) {
  await focus(b.x, b.z);
  const half = b.size / 2 - 0.5;
  const tries = [[0, 0, 3], [0, 0, 2], [0, 0, 4], [-half, 0, 2], [half, 0, 2], [0, -half, 3], [-half, -half, 2], [half, -half, 2], [0, half, 1]];
  let lastUnder = null;
  for (const [dx, dz, lift] of tries) {
    const p = await screenOf(b.x + dx, b.z + dz, lift);
    if (!p) continue;
    const under = await tg(([x, y]) => window.__tg.ui.orders.whatIsUnder(x, y), [p.x, p.y]);
    lastUnder = under;
    if (under.unit !== null || under.building !== b.id) continue;
    await page.mouse.click(p.x, p.y);
    await wait(200);
    return p;
  }
  throw new Error(`no point on the ${b.kind} where it is what's under the cursor (last: ${JSON.stringify(lastUnder)})`);
}
const ticks = (seconds) => tg((s) => { const w = window.__tg.world; for (let i = 0; i < Math.round(s * 15); i++) w.tick(1 / 15); }, seconds);

// ---------------------------------------------------------------------------

await page.goto(`${base}${seedQuery}`, { waitUntil: 'load' });
await wait(2500);

await step('title → skirmish setup → Begin (mouse)', async () => {
  await tg(() => localStorage.clear());
  await clickText('Skirmish');
  await wait(300);
  await clickText('Begin');
  await wait(1500);
  const mode = await tg(() => window.__tg.appState.mode);
  expect(mode === 'game', `mode is ${mode}`);
  await shot('01-skirmish-start');
  return `seed ${await tg(() => window.__tg.lastSeed)}`;
});

// Freeze the AI out of the way for the input tests, and hold real-time play
// still so targets don't walk out from under the cursor: time is advanced
// explicitly with ticks() where a step needs it.
await tg(() => {
  const w = window.__tg.world;
  for (const id of w.activeTribes()) if (id !== 'player') w.tribes[id].ai.awake = false;
  window.__tg.appState.paused = true;
});

await step('camera: Space centres on the leader; WASD pans; wheel zooms', async () => {
  const zoom0 = await tg(() => window.__tg.rig.zoom);
  await page.mouse.move(720, 450);
  await page.keyboard.press('Space');
  await wait(200);
  const a = await tg(() => ({ x: window.__tg.rig.target.x, z: window.__tg.rig.target.z, d: window.__tg.rig.distance }));
  await page.keyboard.down('KeyD');
  await wait(400);
  await page.keyboard.up('KeyD');
  await page.mouse.wheel(0, -400);
  await wait(400);
  const b = await tg(() => ({ x: window.__tg.rig.target.x, z: window.__tg.rig.target.z, d: window.__tg.rig.distance }));
  expect(Math.hypot(b.x - a.x, b.z - a.z) > 2, 'D did not pan');
  expect(b.d < a.d, 'wheel did not zoom in');
  await page.keyboard.press('Space');
  await wait(300);
  // Back to the default framing: later steps must not depend on how far this one zoomed.
  await tg((z) => (window.__tg.rig.zoom = z), zoom0);
  await wait(200);
});

const home = await tg(() => window.__tg.world.tribes.player.home);

await step('select: click a villager, box-select, double-click selects kind on screen', async () => {
  await lookAt(home.x, home.z);
  await wait(300);
  const v = await tg(() => window.__tg.world.units.find((u) => u.tribe === 'player' && u.kind === 'brave' && !u.hidden));
  await clickUnit(v);
  let n = await tg(() => window.__tg.ui.selection.units.size);
  expect(n === 1, `click selected ${n}`);
  // Box: drag across the middle of the screen, over the village.
  await focus(home.x, home.z);
  await page.mouse.move(300, 200);
  await page.mouse.down();
  await page.mouse.move(700, 450, { steps: 6 });
  await page.mouse.move(1150, 700, { steps: 6 });
  await page.mouse.up();
  await wait(150);
  n = await tg(() => window.__tg.ui.selection.units.size);
  expect(n >= 2, `box selected ${n}`);
  const v2 = await tg(() => window.__tg.world.units.find((u) => u.tribe === 'player' && u.kind === 'brave' && !u.hidden));
  const p2 = await clickUnit(v2); // the first click of the double-click, checked
  await page.mouse.dblclick(p2.x, p2.y);
  await wait(150);
  const kinds = await tg(() => [...window.__tg.ui.selection.units].map((id) => window.__tg.world.unitById(id)?.kind));
  expect(kinds.length >= 2 && kinds.every((k) => k === 'brave'), `double-click gave ${kinds.join(',')}`);
  return `box ${n}, double-click ${kinds.length}`;
});

await step('right-click move order: selected people walk there', async () => {
  await focus(home.x + 6, home.z + 6);
  const p = await screenOf(home.x + 6, home.z + 6);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await wait(100);
  const moving = await tg(() => [...window.__tg.ui.selection.units].map((id) => window.__tg.world.unitById(id)).filter((u) => u && u.state === 'moving').length);
  expect(moving >= 1, 'nobody moved');
  await page.keyboard.press('Escape'); // clear selection
  return `${moving} moving`;
});

// --- Buildings -------------------------------------------------------------

const BUILD = ['hut', 'lumberyard', 'tower', 'warriorHut', 'fireHut', 'shrine', 'chantHall', 'wardenHall'];
await step('build: all 8 buildings placed with Shift+1..8 and a click', async () => {
  const placed = [];
  for (let i = 0; i < BUILD.length; i++) {
    const kind = BUILD[i];
    // Setup: wood, and prerequisites standing (a finished lodge/shrine unlocks the next row).
    await tg((k) => {
      const w = window.__tg.world;
      w.tribes.player.wood = 200;
      const need = { fireHut: 'warriorHut', wardenHall: 'warriorHut', chantHall: 'shrine' }[k];
      if (need && !w.buildings.some((b) => b.tribe === 'player' && b.kind === need && b.progress >= 1)) {
        const b = w.buildings.find((b) => b.tribe === 'player' && b.kind === need);
        if (b) b.progress = 1;
      }
      const hut = w.buildings.find((b) => b.tribe === 'player' && b.kind === 'hut');
      if (hut) hut.progress = 1;
    }, kind);
    const site = await tg((k) => {
      const w = window.__tg.world;
      const h = w.tribes.player.home;
      for (let r = 6; r < 30; r += 2) for (let a = 0; a < 24; a++) {
        const x = Math.round(h.x + Math.cos(a / 24 * Math.PI * 2) * r);
        const z = Math.round(h.z + Math.sin(a / 24 * Math.PI * 2) * r);
        let ok = true;
        for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1 && ok; dx++) ok = w.canPlaceBuilding('player', k, x + dx, z + dz);
        if (ok) return { x, z };
      }
      return null;
    }, kind);
    expect(site, `no site for ${kind}`);
    await lookAt(site.x, site.z);
    await wait(250);
    await page.keyboard.press(`Shift+Digit${i + 1}`);
    await wait(150);
    const tool = await tg(() => window.__tg.toolState.tool);
    expect(tool === kind, `Shift+${i + 1} armed ${tool}, wanted ${kind}`);
    const p = await screenOf(site.x, site.z);
    await page.mouse.move(p.x, p.y);
    await wait(200);
    const note = await page.locator('.tg-cursor-note').first().textContent().catch(() => '');
    await page.mouse.click(p.x, p.y);
    await wait(200);
    const ok = await tg((k) => window.__tg.world.buildings.some((b) => b.tribe === 'player' && b.kind === k), kind);
    expect(ok, `${kind} not placed (placer said: ${note})`);
    placed.push(kind);
  }
  await tg(() => { for (const b of window.__tg.world.buildings) if (b.tribe === 'player') { b.progress = 1; b.hp = b.maxHp; } });
  await shot('02-buildings');
  return placed.join(', ');
});

await step('train: all 4 trainable units through the selection panel (+1 button)', async () => {
  const halls = { warriorHut: 'warrior', fireHut: 'firewarrior', wardenHall: 'warden', chantHall: 'chanter' };
  await tg(() => {
    const w = window.__tg.world;
    w.tribes.player.wood = 200;
    const h = w.tribes.player.home;
    for (let i = 0; i < 8; i++) w.spawnNearWalkable('brave', 'player', h.x + (i % 4) - 2, h.z + 3 + (i >> 2));
  });
  const done = [];
  for (const [kind, unit] of Object.entries(halls)) {
    const b = await tg((k) => window.__tg.world.buildings.find((b) => b.tribe === 'player' && b.kind === k), kind);
    await clickBuilding(b);
    const selected = await tg(() => ({ b: window.__tg.ui.selection.building, u: [...window.__tg.ui.selection.units] }));
    expect(selected.b === b.id, `clicking the ${kind} selected ${JSON.stringify(selected)}`);
    await page.locator('[data-a="q"][data-n="1"]').first().click();
    await wait(100);
    const q = await tg((id) => window.__tg.world.getBuilding(id).queue, b.id);
    expect(q >= 1, `${kind} queue ${q}`);
  }
  await ticks(40);
  for (const unit of Object.values(halls)) {
    const n = await tg((k) => window.__tg.world.units.filter((u) => u.tribe === 'player' && u.kind === k).length, unit);
    if (n > 0) done.push(unit);
  }
  expect(done.length === 4, `trained only ${done.join(', ')}`);
  await page.keyboard.press('Escape');
  return done.join(', ');
});

await step('garrison: right-click a tower with a warrior, a shrine with villagers', async () => {
  const tower = await tg(() => window.__tg.world.buildings.find((b) => b.tribe === 'player' && b.kind === 'tower'));
  const warrior = await tg(() => window.__tg.world.units.find((u) => u.tribe === 'player' && u.kind === 'warrior' && !u.hidden));
  expect(warrior, 'no warrior to garrison');
  await clickUnit(warrior);
  await focus(tower.x, tower.z);
  let p = await screenOf(tower.x, tower.z, 4);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  const shrine = await tg(() => window.__tg.world.buildings.find((b) => b.tribe === 'player' && b.kind === 'shrine'));
  const vill = await tg(() => window.__tg.world.units.find((u) => u.tribe === 'player' && u.kind === 'brave' && !u.hidden));
  await clickUnit(vill);
  await focus(shrine.x, shrine.z);
  p = await screenOf(shrine.x, shrine.z, 3);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await ticks(25);
  const g = await tg(([t, s]) => [window.__tg.world.getBuilding(t).garrison.length, window.__tg.world.getBuilding(s).garrison.length], [tower.id, shrine.id]);
  expect(g[0] >= 1, `tower garrison ${g[0]}`);
  expect(g[1] >= 1, `shrine worshippers ${g[1]}`);
  return `tower ${g[0]}, shrine ${g[1]}`;
});

await step('demolish: select the lumberyard, press Delete twice (the first press asks to confirm)', async () => {
  const b = await tg(() => window.__tg.world.buildings.find((b) => b.tribe === 'player' && b.kind === 'lumberyard'));
  await clickBuilding(b);
  const sel = await tg(() => ({ b: window.__tg.ui.selection.building, u: [...window.__tg.ui.selection.units] }));
  expect(sel.b === b.id, `click selected ${JSON.stringify(sel)}`);
  await page.keyboard.press('Delete');
  await wait(250);
  const armed = await page.locator('[data-a="demolish"]').first().textContent({ timeout: 2000 });
  expect(/again/i.test(armed ?? ''), `first Delete showed "${armed}"`);
  await page.keyboard.press('Delete');
  await wait(150);
  const gone = await tg((id) => !window.__tg.world.getBuilding(id), b.id);
  expect(gone, 'lumberyard still standing');
});

await step('pause / speed keys: P, ], [', async () => {
  await tg(() => (window.__tg.appState.paused = false));
  await page.keyboard.press('KeyP');
  let s = await tg(() => ({ ...window.__tg.appState }));
  expect(s.paused, 'P did not pause');
  await page.keyboard.press('KeyP');
  await page.keyboard.press('BracketRight');
  s = await tg(() => ({ ...window.__tg.appState }));
  expect(!s.paused && s.speed === 2, `after ] speed ${s.speed}`);
  await page.keyboard.press('BracketLeft');
  s = await tg(() => ({ ...window.__tg.appState }));
  expect(s.speed === 1, `after [ speed ${s.speed}`);
  await tg(() => (window.__tg.appState.paused = true));
});

await step('control groups: Ctrl+1 then 1 recalls; double-tap jumps', async () => {
  await page.keyboard.press('Comma'); // select army
  const army = await tg(() => window.__tg.ui.selection.units.size);
  expect(army >= 2, `army ${army}`);
  await page.keyboard.press('Control+Digit1');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Digit1');
  const n = await tg(() => window.__tg.ui.selection.units.size);
  expect(n === army, `group 1 recalled ${n}/${army}`);
  return `${n} in group 1`;
});

await step('minimap: click and drag moves the view; right-click orders', async () => {
  const box = await page.locator('.mm canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();
  const after = await tg(() => ({ x: ((window.__tg.rig.target.x / 2) % 128 + 128) % 128, z: ((window.__tg.rig.target.z / 2) % 128 + 128) % 128 }));
  expect(Math.abs(after.x - 0.7 * 128) < 3 && Math.abs(after.z - 0.6 * 128) < 3, `view at tile ${after.x.toFixed(0)},${after.z.toFixed(0)}`);
  // Right-click a reachable spot near home on the minimap (the planet wraps: tile/128 of the map).
  const spot = await tg(() => {
    const w = window.__tg.world;
    const h = w.tribes.player.home;
    for (let r = 8; r < 30; r += 2) for (let a = 0; a < 12; a++) {
      const x = Math.round(h.x + Math.cos(a) * r), z = Math.round(h.z + Math.sin(a) * r);
      if (w.map.heightAt(x, z) > 1) return { x: ((x % 128) + 128) % 128, z: ((z % 128) + 128) % 128 };
    }
    return { x: h.x, z: h.z };
  });
  await page.mouse.click(box.x + (box.width * (spot.x + 0.5)) / 128, box.y + (box.height * (spot.z + 0.5)) / 128, { button: 'right' });
  await wait(100);
  const moving = await tg(() => [...window.__tg.ui.selection.units].map((id) => window.__tg.world.unitById(id)).filter((u) => u && u.state === 'moving').length);
  expect(moving >= 1, 'minimap right-click moved nobody');
  await page.keyboard.press('Escape');
});

// --- Spells ----------------------------------------------------------------

const SPELL_KEYS = { blast: 'KeyR', convert: 'KeyT', flatten: 'KeyY', bloom: 'KeyU', ward: 'KeyI', lightning: 'KeyF', warsong: 'KeyG', swamp: 'KeyH', landbridge: 'KeyJ', cyclone: 'KeyK', emberfall: 'KeyV', sink: 'KeyB', earthquake: 'KeyN', volcano: 'KeyM' };
await step('spells: all 14 aimed by hotkey and cast with a click', async () => {
  const cast = [];
  const failed = [];
  for (const [spell, key] of Object.entries(SPELL_KEYS)) {
    // Setup: the leader knows it, holds a charge, and stands clear of buildings.
    const target = await tg((s) => {
      const w = window.__tg.world;
      const t = w.tribes.player;
      t.known.add(s);
      t.spells[s].charges = Math.max(1, t.spells[s].charges);
      let l = w.leaderOf('player');
      if (!l) l = w.spawnNearWalkable('shaman', 'player', t.home.x, t.home.z);
      w.abandonTask(l);
      // Clear the previous casts' lingering effects: a wandering Cyclone that
      // flings the leader mid-cast cancels the cast (by design), which would
      // test the order of this list rather than the spell under test.
      w.jobs.length = 0;
      w.auras.length = 0;
      // A spot 8 tiles from the leader, on land, where nobody of ours stands.
      for (let a = 0; a < 16; a++) {
        const x = Math.round(l.x + Math.cos(a / 16 * Math.PI * 2) * 8);
        const z = Math.round(l.z + Math.sin(a / 16 * Math.PI * 2) * 8);
        if (w.castCheck('player', s, x, z) === null && w.map.heightAt(x, z) > 0.5) {
          if (s === 'convert') w.spawnNearWalkable('wildman', 'wild', x, z);
          return { x, z, before: t.spells[s].charges + t.spells[s].gifted };
        }
      }
      return null;
    }, spell);
    if (!target) {
      failed.push(`${spell}: no target`);
      continue;
    }
    await lookAt(target.x, target.z);
    await wait(200);
    await page.keyboard.press(key);
    await wait(120);
    const armed = await tg(() => window.__tg.toolState.tool);
    if (armed !== spell) {
      failed.push(`${spell}: key armed ${armed}`);
      continue;
    }
    const p = await screenOf(target.x, target.z);
    await page.mouse.move(p.x, p.y);
    await wait(120);
    const note = await page.locator('.tg-cursor-note').first().textContent().catch(() => '');
    await page.mouse.click(p.x, p.y);
    const toastText = await page.locator('.tg-toast').last().textContent({ timeout: 300 }).catch(() => '');
    await ticks(3);
    const after = await tg((s) => { const sp = window.__tg.world.tribes.player.spells[s]; return sp.charges + sp.gifted; }, spell);
    if (after < target.before) cast.push(spell);
    else failed.push(`${spell}: not cast (aim note "${note}", toast "${toastText}")`);
    await wait(150);
  }
  await shot('03-spells');
  expect(failed.length === 0, failed.join('; '));
  return `${cast.length}/14 cast`;
});

// --- Save & Continue ---------------------------------------------------------

await step('save: Esc opens the menu (autosaves); reload; Continue resumes the same game', async () => {
  await ticks(10);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await wait(300);
  const before = await tg(() => ({ t: window.__tg.world.elapsed, units: window.__tg.world.units.length, b: window.__tg.world.buildings.length }));
  const saved = await tg(() => !!localStorage.getItem('tg.save.v1'));
  expect(saved, 'nothing saved when the menu opened');
  await page.reload({ waitUntil: 'load' });
  await wait(2500);
  await clickText('Continue');
  await wait(800);
  const after = await tg(() => ({ t: window.__tg.world.elapsed, units: window.__tg.world.units.length, b: window.__tg.world.buildings.length, mode: window.__tg.appState.mode }));
  expect(after.mode === 'game', `mode ${after.mode}`);
  expect(Math.abs(after.t - before.t) < 2 && after.b === before.b, `restored t=${after.t.toFixed(1)}/${before.t.toFixed(1)} buildings ${after.b}/${before.b}`);
  await shot('04-continued');
  return `t=${after.t.toFixed(0)}s, ${after.units} units, ${after.b} buildings`;
});

// --- Campaign flow -----------------------------------------------------------

await step('campaign: map → briefing → Begin → win → debrief → boon → next chapter briefing', async () => {
  await page.keyboard.press('Escape');
  await wait(200);
  await clickText('Main menu');
  await wait(400);
  await clickText('Campaign');
  await wait(600);
  await shot('05-campaign-map');
  await page.locator('.tgc-node').first().click();
  await wait(800);
  await shot('06-briefing');
  await clickText('Begin');
  await wait(2500);
  const playing = await tg(() => window.__tg.campaign.active);
  expect(playing === 'c01_landfall', `playing ${playing}`);
  await tg(() => window.__tg.world.endGame('victory', 'Test win'));
  await wait(1500);
  await shot('07-game-over');
  await clickText('Campaign debrief');
  await wait(600);
  await shot('08-debrief');
  const boon = page.locator('.tgc-boon').first();
  if (await boon.count()) await boon.click();
  await wait(200);
  await clickText('Next chapter');
  await wait(800);
  const title = await page.locator('h1, h2').allTextContents();
  await shot('09-next-briefing');
  expect(title.some((t) => /Speaking Stones/i.test(t)), `next briefing shows ${title.join(' | ')}`);
});

// ---------------------------------------------------------------------------

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${pageErrors.length ? `; ${pageErrors.length} page errors` : ''}`);
process.exit(failed.length || pageErrors.length ? 1 : 0);
