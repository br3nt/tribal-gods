#!/usr/bin/env node
/**
 * tools/play-chapter.mjs — play a campaign chapter to VICTORY through real
 * input, like a first-time player: read the narrator, look where it points,
 * select the leader with a key, cast with a key and a click, kneel at a
 * stone by clicking it, place buildings with Shift+N and a click.
 *
 *   node tools/play-chapter.mjs <base url> --chapter c01_landfall [--pace fast|slow] [--shots dir] [--speed 1|2|3] [--skip-volcano]
 *
 * The page is driven ONLY by page.mouse / page.keyboard (the title screen,
 * the campaign map, the briefing, the HUD, the canvas). window.__tg is used
 * to READ state (where things are, what the objectives say, where to point
 * the mouse — the game's own projection) and nothing else: no teleports,
 * no sim calls, no spawned units. Time passes at the game's own speed,
 * sped up only with the in-game speed key (]).
 *
 * Pace models how quickly the player responds to each new beat (in game
 * seconds, after the narrator line shows): fast ≈ 6 s, slow ≈ 25 s — the
 * slow player also lets the leader stand about between beats. Every beat
 * is timed; the summary prints a timing budget per beat.
 *
 * Exit 1 if the chapter is not won, a page error is logged, or a beat
 * times out.
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = args[0] ?? 'http://localhost:5241/tribal-gods/';
let chapter = 'c01_landfall';
let pace = 'fast';
let shotDir = null;
let speed = 2;
let size = [1440, 900];
/** Never kneel at the headland: the host must be beaten without the Volcano (c01's recovery path). */
let skipVolcano = false;
/** The dawdler: answers the headland line only after DAWDLE game seconds (and is idle meanwhile). */
let lateVolcano = false;
let DAWDLE = 75;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--dawdle') DAWDLE = Number(args[++i]);
  if (args[i] === '--skip-volcano') skipVolcano = true;
  else if (args[i] === '--late-volcano') lateVolcano = true;
  if (args[i] === '--chapter') chapter = args[++i];
  else if (args[i] === '--pace') pace = args[++i];
  else if (args[i] === '--shots') shotDir = args[++i];
  else if (args[i] === '--speed') speed = Number(args[++i]);
  else if (args[i] === '--size') size = args[++i].split('x').map(Number);
}
if (shotDir) mkdirSync(shotDir, { recursive: true });
/** Game seconds between a beat showing and the player acting on it. */
const REACT = pace === 'slow' ? 25 : 6;

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
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));

const wait = (ms) => page.waitForTimeout(ms);
const tg = (fn, arg) => page.evaluate(fn, arg);
let shotN = 0;
async function shot(name) {
  if (!shotDir) return;
  shotN++;
  await page.screenshot({ path: join(shotDir, `${chapter}-${pace}-${String(shotN).padStart(2, '0')}-${name}.png`) });
}
const log = (...a) => console.log(`[${elapsedNow.toFixed(0).padStart(4)}s]`, ...a);
let elapsedNow = 0;

/** Everything the player could see on screen, as data. */
async function snap() {
  const s = await tg(() => {
    const t = window.__tg;
    const w = t.world;
    const l = w.leaderOf('player');
    const sp = (id) => { const s = w.spellState('player', id); return s.gifted + (s.known ? s.charges : 0); };
    return {
      t: w.elapsed,
      over: w.gameOver,
      reason: w.gameOverReason,
      objectives: w.objectives.map((o) => ({ text: o.text, done: o.done, active: o.active !== false, optional: o.optional, failed: o.failed })),
      seq: w.messageSeq,
      msgs: w.messages.slice(-3).map((m) => ({ text: m.text, focus: m.focus ?? null, at: m.at })),
      leader: l ? { id: l.id, x: l.x, z: l.z, state: l.state, task: l.task, hp: l.hp, cast: l.castSpell } : null,
      spells: Object.fromEntries(['blast', 'convert', 'flatten', 'lightning', 'landbridge', 'volcano', 'bloom', 'ward'].map((id) => [id, sp(id)])),
      monuments: w.monuments.map((m) => ({ x: m.x, z: m.z, spell: m.spell, asleep: !!m.asleep, communing: !!m.communing, progress: m.communeProgress ?? 0, communer: m.communer ?? null, claimer: m.claimer ?? null, available: w.monumentAvailable(m) })),
      foes: w.units.filter((u) => u.tribe !== 'player' && u.tribe !== 'wild' && !u.hidden).map((u) => ({ id: u.id, x: u.x, z: u.z, kind: u.kind, hold: (u.holdUntil ?? 0) > w.elapsed })),
      wild: w.units.filter((u) => u.tribe === 'wild' && u.kind === 'wildman' && !u.hidden).map((u) => ({ x: u.x, z: u.z })),
      stranded: w.units.filter((u) => u.joins === 'player').length,
      guards: w.units.filter((u) => (u.guardOf ?? -1) >= 0 && u.hp > 0).map((u) => ({ id: u.id, x: u.x, z: u.z, of: u.guardOf })),
      fighters: w.units.filter((u) => u.tribe === 'player' && !u.hidden && (u.kind === 'warrior' || u.kind === 'firewarrior')).map((u) => ({ id: u.id, x: u.x, z: u.z })),
      huts: w.buildings.filter((b) => b.tribe === 'player' && b.kind === 'hut').map((b) => ({ x: b.x, z: b.z, done: b.progress >= 1 })),
      home: w.tribes.player.home,
      lost: w.statsOf('player').lostTotal,
      foesLost: w.tribes.violet ? w.statsOf('violet').lostTotal : 0,
      wood: w.tribes.player.wood,
      pop: w.tribePopulation('player'),
      landings: w.landings.length,
      // What the HUD says right now.
      narr: document.querySelector('.narr.on')?.textContent ?? '',
      hint: document.querySelector('.hint-chip')?.textContent?.trim() ?? '',
      speed: t.appState.speed,
      paused: t.appState.paused,
    };
  });
  elapsedNow = s.t;
  return s;
}

const errors = [];
const beats = [];
function beat(name, t0, t1) {
  beats.push({ name, t0, t1 });
  log(`BEAT ${name}: ${t0.toFixed(0)}s → ${t1.toFixed(0)}s`);
}

/** Poll until `cond(snap)` holds; `max` in game seconds. Returns the snap. */
async function until(cond, max, what) {
  const t0 = (await snap()).t;
  for (;;) {
    const s = await snap();
    if (s.over && !cond(s)) throw new Error(`game over (${s.over}: ${s.reason}) while waiting for ${what}`);
    if (cond(s)) return s;
    if (s.t - t0 > max) throw new Error(`timed out after ${max}s waiting for ${what} (t=${s.t.toFixed(0)}; objectives: ${s.objectives.filter((o) => o.active && !o.done).map((o) => o.text).join(' / ')}; hint "${s.hint}")`);
    await wait(150);
  }
}
/** Let game time pass (the player reading, thinking, looking). */
async function think(seconds) {
  const t0 = (await snap()).t;
  await until((s) => s.t >= t0 + seconds || !!s.over, seconds + 60, `${seconds}s to pass`);
}

// --- Camera & pointing (all real input) ----------------------------------------

/** Click the minimap at tile (x, z): the view centres there. */
async function look(x, z) {
  const box = await page.locator('.mm canvas').boundingBox();
  const wx = ((x % 128) + 128) % 128;
  const wz = ((z % 128) + 128) % 128;
  await page.mouse.click(box.x + (box.width * (wx + 0.5)) / 128, box.y + (box.height * (wz + 0.5)) / 128);
  await settle();
}
/** Wait for the camera's easing to finish (it lerps height and zoom). */
async function settle() {
  await wait(150);
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const now = await tg(() => [window.__tg.rig.target.x, window.__tg.rig.target.y, window.__tg.rig.target.z, window.__tg.rig.distance]);
    if (prev && now.every((v, k) => Math.abs(v - prev[k]) < 0.01)) break;
    prev = now;
    await wait(60);
  }
}
const screenOf = (x, z, h = 0) => tg(([x, z, h]) => window.__tg.screenOf(x, z, h), [x, z, h]);
const under = (p) => tg(([x, y]) => window.__tg.ui.orders.whatIsUnder(x, y), [p.x, p.y]);
const ground = (p) => tg(([x, y]) => window.__tg.groundAt(x, y), [p.x, p.y]);
const wrapD = (d) => { let v = d % 128; if (v < -64) v += 128; if (v >= 64) v -= 128; return v; };
const dist = (a, b) => Math.hypot(wrapD(a.x - b.x), wrapD(a.z - b.z));

/** A pixel whose ground is within `tol` tiles of (x, z) (a hill in front may hide the spot: try around it). */
async function pixelFor(x, z, tol = 1.2) {
  for (const [dx, dz] of [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8], [1.5, 1.5], [-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5]]) {
    const p = await screenOf(x + dx, z + dz);
    if (!p || p.x < 30 || p.y < 30 || p.x > size[0] - 30 || p.y > size[1] - 30) continue;
    const g = await ground(p);
    if (g && Math.hypot(wrapD(g.x - x), wrapD(g.z - z)) < tol) return p;
  }
  return null;
}

/** Arm a spell by its key and click the ground at (x, z). Returns true if the leader took the order. */
async function cast(key, spell, x, z, opts = {}) {
  await look(x, z);
  const p = await pixelFor(x, z, opts.tol ?? 1.5);
  if (!p) {
    log(`  cannot see the ground at ${x.toFixed(0)},${z.toFixed(0)} to cast ${spell}`);
    return false;
  }
  await page.keyboard.press(key);
  await wait(120);
  const armed = await tg(() => window.__tg.toolState.tool);
  if (armed !== spell) {
    log(`  ${key} armed ${armed}, not ${spell}`);
    await page.keyboard.press('Escape');
    return false;
  }
  await page.mouse.move(p.x, p.y);
  await wait(250);
  const note = await page.locator('.tg-cursor-note').first().textContent().catch(() => '');
  if (opts.shot) await shot(opts.shot);
  await page.mouse.click(p.x, p.y);
  await wait(200);
  const s = await snap();
  const ok = s.leader && s.leader.cast === spell;
  if (!ok) {
    const toast = await page.locator('.tg-toast').last().textContent({ timeout: 300 }).catch(() => '');
    log(`  ${spell} at ${x.toFixed(0)},${z.toFixed(0)} not taken (aim note "${note}", toast "${toast}")`);
    if ((await tg(() => window.__tg.toolState.tool)) !== 'select') await page.keyboard.press('Escape');
  } else log(`  cast ${spell} → ${x.toFixed(0)},${z.toFixed(0)} (aim note "${note.trim()}")`);
  return ok;
}

/** Press L (select the leader) and check it took. */
async function selectLeader() {
  await page.keyboard.press('KeyL');
  await wait(120);
  const ok = await tg(() => { const l = window.__tg.world.leaderOf('player'); return !!l && window.__tg.ui.selection.units.has(l.id) && window.__tg.ui.selection.units.size === 1; });
  if (!ok) throw new Error('L did not select the leader');
}

/** Leader selected, click stone `i`: she goes to kneel. Hover first (the tag says what it holds). */
async function commune(i, shotName) {
  const s0 = await snap();
  const m = s0.monuments[i];
  await selectLeader();
  await look(m.x, m.z);
  let at = null;
  for (const lift of [2, 3, 1.2, 4, 5]) {
    for (const [dx, dz] of [[0, 0], [0.5, 0.5], [-0.5, 0.5]]) {
      const p = await screenOf(m.x + dx, m.z + dz, lift);
      if (!p) continue;
      const u = await under(p);
      if (u.monument === i) {
        at = p;
        break;
      }
    }
    if (at) break;
  }
  if (!at) throw new Error(`no pixel where stone ${i} is what's under the cursor`);
  await page.mouse.move(at.x, at.y);
  await wait(700);
  const tag = (await page.locator('.wh-tag.show').first().textContent({ timeout: 800 }).catch(() => '')) ?? '';
  if (shotName) await shot(shotName);
  await page.mouse.click(at.x, at.y);
  await wait(200);
  const s = await snap();
  if (!s.leader || s.leader.task !== 'worship') throw new Error(`clicking the stone left the leader ${s.leader?.state}/${s.leader?.task}`);
  log(`  leader sent to the ${m.spell} stone (hover tag: "${tag.replace(/\s+/g, ' ').slice(0, 80)}")`);
  await page.keyboard.press('Escape'); // drop the selection: a player's next click shouldn't order her away
  return tag;
}

/** Shift+N, then click an open site near (x, z) that the game says is placeable. */
async function placeHut(near) {
  const site = await tg(([nx, nz]) => {
    const w = window.__tg.world;
    const out = [];
    for (let r = 0; r < 14; r++) for (let a = 0; a < Math.max(1, r * 6); a++) {
      const x = Math.round(nx + Math.cos((a / Math.max(1, r * 6)) * Math.PI * 2) * r);
      const z = Math.round(nz + Math.sin((a / Math.max(1, r * 6)) * Math.PI * 2) * r);
      if (w.canPlaceBuilding('player', 'hut', x, z)) out.push({ x, z });
      if (out.length >= 6) return out;
    }
    return out;
  }, [near.x, near.z]);
  for (const s of site) {
    await look(s.x, s.z);
    const p = await pixelFor(s.x, s.z, 0.8);
    if (!p) continue;
    await page.keyboard.press('Shift+Digit1');
    await wait(120);
    await page.mouse.move(p.x, p.y);
    await wait(200);
    const before = await tg(() => window.__tg.world.buildings.filter((b) => b.tribe === 'player').length);
    await page.mouse.click(p.x, p.y);
    await wait(200);
    const after = await tg(() => window.__tg.world.buildings.filter((b) => b.tribe === 'player').length);
    if ((await tg(() => window.__tg.toolState.tool)) !== 'select') await page.keyboard.press('Escape');
    if (after > before) {
      log(`  Dwelling placed at ${s.x},${s.z}`);
      return true;
    }
  }
  log('  no Dwelling site took a click');
  return false;
}

/** The newest narrator line since `seq` (waits for it). */
async function nextLine(seq, max, what) {
  const s = await until((q) => q.seq > seq, max, what);
  return s;
}

/** Raiders (not holding on a beach) near `p`, nearest the leader first. */
function loose(s, p, r) {
  return s.foes.filter((f) => !f.hold && dist(f, p) < r).sort((a, b) => dist(a, s.leader ?? p) - dist(b, s.leader ?? p));
}

/** Strike the nearest raider near home: Lightning while the stone's gift lasts, else Blast. */
async function strikeRaiders(s, centre, r = 26) {
  const foe = loose(s, centre, r)[0];
  if (!foe || !s.leader || s.leader.cast) return false;
  if (s.spells.lightning > 0) return cast('KeyF', 'lightning', foe.x, foe.z, { tol: 2.5 });
  if (s.spells.blast > 0) return cast('KeyR', 'blast', foe.x, foe.z, { tol: 2.5 });
  return false;
}

// --- Start: title → Campaign → chapter → briefing → Begin ----------------------

await page.goto(base, { waitUntil: 'load' });
await wait(2500);
await tg(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await wait(2500);
await shot('title');
await page.locator('button', { hasText: 'Campaign' }).first().click();
await wait(700);
const node = page.locator('.tgc-node').nth(Number(chapter.slice(1, 3)) - 1);
if ((await node.count()) && !(await node.evaluate((n) => n.classList.contains('locked')))) await node.click();
else {
  // A locked chapter on a fresh profile: jump straight in (the URL the campaign uses), still played by input.
  await page.goto(`${base}?play=1&scenario=${chapter}`, { waitUntil: 'load' });
}
await wait(900);
if (await page.locator('button', { hasText: 'Begin' }).count()) {
  await shot('briefing');
  await page.locator('button', { hasText: 'Begin' }).first().click();
}
await until((s) => s.t > 0.5, 60, 'the chapter to start');
await wait(400);
for (let i = 1; i < speed; i++) await page.keyboard.press('BracketRight');
let s = await snap();
log(`playing ${chapter} at ${s.speed}x, pace ${pace} (react ${REACT}s)`);

// --- Chapter 1: Landfall ----------------------------------------------------------

async function landfall() {
  const L = { sandbar: { x: 25, z: 64 }, meadow: { x: 50, z: 47 }, meadow2: { x: 73, z: 47 }, slope: { x: 57, z: 70 }, strand: { x: 74, z: 93 } };
  s = await until((q) => q.narr.length > 0, 20, 'the first narrator line');
  await shot('opening');
  const t0 = s.t;
  await think(REACT);
  // 1. Causeway to the kin.
  for (let tries = 0; tries < 4 && !(await cast('KeyJ', 'landbridge', L.sandbar.x, L.sandbar.z, { shot: 'causeway-aim' })); tries++) await think(2);
  await wait(900);
  await shot('causeway');
  s = await until((q) => q.objectives[0].done, 40, 'the kin to come home');
  beat('causeway → kin home', t0, s.t);
  await shot('kin-home');

  // 2. The Levelling chant: twice on the slope; the wanderers in between when the leader is free.
  let t1 = s.t;
  await think(Math.min(REACT, 8));
  const levelAt = [{ x: s.home.x + 6, z: s.home.z + 2 }, { x: s.home.x + 2, z: s.home.z - 6 }];
  for (let k = 0; k < 2; k++) {
    s = await until((q) => q.spells.flatten > 0 && q.leader && !q.leader.cast, 60, 'a Level charge and a free leader');
    if (!(await cast('KeyY', 'flatten', levelAt[k].x, levelAt[k].z, { shot: k === 0 ? 'level-aim' : undefined }))) k--;
    await until((q) => q.leader && !q.leader.cast, 30, 'the Level cast to finish');
    await think(2);
  }
  s = await until((q) => q.objectives[2].done, 30, 'Level objective');
  beat('Level twice', t1, s.t);
  await shot('levelled');

  // Kindle the north meadow while the roofs go up.
  const kindle = async () => {
    const q = await snap();
    if (!q.wild.length || q.spells.convert <= 0 || !q.leader || q.leader.cast || q.leader.task === 'worship') return false;
    // the thickest knot of wanderers within reach of a short walk
    const near = q.wild.filter((w) => dist(w, q.home) < 40);
    if (!near.length) return false;
    const c = near.reduce((b, w) => (near.filter((o) => dist(o, w) < 5).length > near.filter((o) => dist(o, b) < 5).length ? w : b), near[0]);
    return cast('KeyT', 'convert', c.x, c.z, { tol: 2.5 });
  };

  // 3. Four Dwellings on the new ground.
  t1 = s.t;
  for (let n = 0; n < 4; n++) {
    s = await until((q) => q.wood >= 5 || q.huts.length > n, 120, `wood for Dwelling ${n + 1}`);
    if (s.huts.length > n) continue;
    if (!(await placeHut(n % 2 ? levelAt[1] : levelAt[0]))) {
      await think(4);
      n--;
    }
  }
  await shot('dwellings-placed');
  // While the builders work: kindle.
  for (let k = 0; k < 3; k++) {
    if (await kindle()) await until((q) => q.leader && !q.leader.cast, 40, 'the Kindle to land');
    await think(2);
  }
  s = await until((q) => q.objectives[3].done, 300, 'four Dwellings standing');
  beat('four Dwellings', t1, s.t);
  await shot('village');

  // 4. Sails; the strand stone wakes: commune for Lightning.
  t1 = s.t;
  s = await until((q) => !q.monuments[0].asleep, 20, 'the Lightning stone to wake');
  await shot('sails-narrator');
  await think(REACT);
  await commune(0, 'lightning-stone-hover');
  await until((q) => q.monuments[0].communing, 40, 'the ritual to begin');
  await wait(400);
  await shot('lightning-ritual');
  s = await until((q) => q.spells.lightning > 0 || q.objectives[4].done, 90, 'Lightning from the stone');
  beat('commune Lightning', t1, s.t);

  // 5. The raid: strike them as they come.
  t1 = s.t;
  let shotRaid = false;
  for (;;) {
    s = await snap();
    if (s.objectives[4].done) break;
    if (s.over) break;
    const near = loose(s, s.home, 30);
    if (near.length && !shotRaid) {
      await look(near[0].x, near[0].z);
      await shot('raiders');
      shotRaid = true;
    }
    if (near.length && s.leader && !s.leader.cast) {
      // walk out to meet them if they are out of reach
      if (await strikeRaiders(s, s.home, 30)) await until((q) => !q.leader || !q.leader.cast, 30, 'the strike');
      else await think(1);
    } else await think(1);
    if (s.t - t1 > 240) throw new Error('raid not beaten in 240s');
  }
  beat('raid beaten', t1, s.t);
  await shot('raid-beaten');

  if (skipVolcano) return defendWithoutVolcano();
  if (lateVolcano) {
    // The dawdler: reads the headland line, does nothing about it for a long while.
    s = await until((q) => !q.monuments[1].asleep, 30, 'the headland stone to wake');
    await think(DAWDLE);
    await shot('dawdler-sets-out');
  }

  // 6. The headland stone: one Volcano.
  t1 = s.t;
  s = await until((q) => !q.monuments[1].asleep, 30, 'the headland stone to wake');
  await shot('fleet-narrator');
  await think(REACT);
  // finish any straggler first if one is near home
  await commune(1, 'headland-hover');
  s = await until((q) => q.monuments[1].communing || q.spells.volcano > 0, 90, 'the headland ritual to begin');
  const kneelAt = s.t;
  await shot('headland-ritual');
  s = await until((q) => q.spells.volcano > 0 || (!q.monuments[1].communing && q.leader?.task !== 'worship'), 120, 'the headland ritual to end');
  if (s.spells.volcano <= 0) throw new Error(`the headland ritual broke off (progress ${s.monuments[1].progress.toFixed(2)})`);
  beat('headland ritual', t1, s.t);
  log(`  walk ${(kneelAt - t1).toFixed(0)}s incl. reaction; ritual done at ${s.t.toFixed(0)}s`);

  // 7. The host lands and masses; wake the mountain under it (the dawdler: wherever it has got to).
  t1 = s.t;
  s = await until((q) => q.foes.filter((f) => f.hold).length >= 8 || (lateVolcano && q.foes.length >= 6), 200, 'the host to mass on the strand');
  const hostAt = s.t;
  await look(L.strand.x, L.strand.z);
  await shot('host-massing');
  if (!lateVolcano) await think(Math.min(REACT, 10));
  s = await snap();
  const massed = s.foes.filter((f) => f.hold);
  const host = massed.length >= 6 ? massed : s.foes;
  const cx = host.reduce((a, f) => a + f.x, 0) / host.length;
  const cz = host.reduce((a, f) => a + f.z, 0) / host.length;
  if (!(await cast('KeyM', 'volcano', cx, cz, { shot: 'volcano-aim', tol: 2.5 }))) throw new Error('Volcano not taken');
  await wait(1500);
  await shot('volcano-1');
  await think(4);
  await shot('volcano-2');
  await think(6);
  await shot('volcano-3');
  beat('volcano on the host', hostAt, s.t);

  // 8. Mop up: strike whatever walks out of the fire until the host is broken.
  t1 = (await snap()).t;
  for (;;) {
    s = await snap();
    if (s.over) break;
    if (s.leader && !s.leader.cast && (s.spells.lightning > 0 || s.spells.blast > 0)) {
      if (await strikeRaiders(s, s.leader, 18)) await until((q) => !q.leader || !q.leader.cast, 30, 'the strike');
      else await think(2);
    } else await think(2);
    if (s.t - t1 > 300) throw new Error('host not broken in 300s');
  }
  beat('host broken → victory', t1, s.t);
}

/**
 * c01's recovery path: a player who never goes to the headland. The host
 * masses, marches, and has to be broken with what is at hand — Lightning
 * from the strand stone (it lends again after its cooldown), Blast, and the
 * villagers, who fight back.
 */
async function defendWithoutVolcano() {
  const t1 = (await snap()).t;
  let shots = 0;
  for (;;) {
    s = await snap();
    if (s.over) break;
    // Meet the host on the way in (Lightning reaches 16 tiles: strike as they cross the slope).
    const near = loose(s, s.home, 32);
    if (s.leader && !s.leader.cast && s.leader.task !== 'worship') {
      if (near.length && (s.spells.lightning > 0 || s.spells.blast > 0)) {
        if (await strikeRaiders(s, s.home, 32)) await until((q) => !q.leader || !q.leader.cast, 30, 'the strike');
      } else if (!near.length && s.spells.lightning < 3 && s.monuments[0].available) {
        await commune(0);
      } else await think(1);
    } else await think(1);
    if (near.length && shots < 3 && s.t - t1 > 30 * shots) {
      shots++;
      await shot(`host-at-the-village-${shots}`);
    }
    if (s.t - t1 > 600) throw new Error('host not broken in 600s without the Volcano');
  }
  beat('host broken without the Volcano', t1, s.t);
}

// --- Chapter 2: The Speaking Stones ----------------------------------------------

async function speakingStones() {
  const L = { bloom: { x: 24, z: 58 }, level: { x: 88, z: 60 }, ford: { x: 63, z: 64 }, camp: { x: 44, z: 80 } };
  s = await until((q) => q.narr.length > 0, 20, 'the first narrator line');
  await shot('opening');
  let t1 = s.t;
  await think(REACT);
  // Kindle the camp.
  for (let k = 0; k < 2; k++) {
    const q = await snap();
    const near = q.wild.filter((w) => dist(w, L.camp) < 10);
    if (!near.length || q.spells.convert <= 0) break;
    if (await cast('KeyT', 'convert', near[0].x, near[0].z, { tol: 2.5, shot: k === 0 ? 'kindle-aim' : undefined })) await until((x) => x.leader && !x.leader.cast, 40, 'Kindle');
    await think(2);
  }
  beat('kindle the camp', t1, (await snap()).t);

  // The wood stone: bring the spears first — select the army, send them to the stone.
  t1 = (await snap()).t;
  await think(Math.min(REACT, 10));
  await page.keyboard.press('Comma');
  await wait(150);
  await look(L.bloom.x, L.bloom.z + 3);
  const p = await pixelFor(L.bloom.x, L.bloom.z + 3, 2);
  if (p) await page.mouse.click(p.x, p.y, { button: 'right' });
  await wait(200);
  await page.keyboard.press('Escape');
  await think(8);
  await commune(0, 'bloom-hover');
  await until((q) => q.monuments[0].communing || q.guards.some((g) => g.of === 0), 60, 'the Bloom ritual to begin');
  await wait(500);
  await shot('bloom-keepers');
  // Keep the spears on the keepers.
  for (;;) {
    s = await snap();
    if (s.objectives[0].done) break;
    const keepers = s.guards.filter((g) => g.of === 0);
    if (keepers.length && s.leader?.task !== 'worship') {
      // the ritual broke: send the spears at a keeper, then kneel again
      await page.keyboard.press('Comma');
      await wait(100);
      await look(keepers[0].x, keepers[0].z);
      const kp = await screenOf(keepers[0].x, keepers[0].z, 1.2);
      if (kp) await page.mouse.click(kp.x, kp.y, { button: 'right' });
      await page.keyboard.press('Escape');
      await think(4);
      if (s.leader && s.leader.task !== 'worship') await commune(0);
    } else if (!keepers.length && s.leader && s.leader.task !== 'worship' && !s.objectives[0].done) {
      await commune(0);
    }
    await think(2);
    if (s.t - t1 > 200) throw new Error('Bloom stone not taken in 200s');
  }
  beat('Bloom stone', t1, s.t);
  await shot('bloom-learned');

  // The Level stone across the river: the spears go first, then she kneels; a boat comes.
  t1 = s.t;
  await think(REACT);
  await page.keyboard.press('Comma');
  await wait(150);
  await look(L.level.x - 2, L.level.z + 3);
  const p2 = await pixelFor(L.level.x - 2, L.level.z + 3, 2.5);
  if (p2) await page.mouse.click(p2.x, p2.y, { button: 'right' });
  await wait(200);
  await page.keyboard.press('Escape');
  await think(6);
  await commune(1, 'level-hover');
  await until((q) => q.monuments[1].communing, 90, 'the Level ritual to begin');
  await shot('level-ritual');
  for (;;) {
    s = await snap();
    if (s.objectives[1].done) break;
    const threat = loose(s, L.level, 16)[0];
    if (threat && s.leader && !s.leader.cast && s.leader.task === 'worship' && dist(threat, L.level) < 12) {
      // the boat's crew: Blast them off the knoll (the ritual is lost for a moment, the progress keeps)
      await shot('boat-crew');
      if (s.spells.blast > 0) await cast('KeyR', 'blast', threat.x, threat.z, { tol: 2.5 });
      await until((q) => !q.leader || !q.leader.cast, 20, 'the blast');
    } else if (s.leader && s.leader.task !== 'worship' && !s.leader.cast && !s.objectives[1].done) {
      const near = loose(s, L.level, 10);
      if (!near.length) await commune(1);
    }
    await think(2);
    if (s.t - t1 > 300) throw new Error('Level stone not taken in 300s');
  }
  beat('Level stone', t1, s.t);
  await shot('level-learned');

  // Hold the ford: leader home, strike raiders as they come, until the ten minutes run out.
  t1 = s.t;
  let lastShot = 0;
  for (;;) {
    s = await snap();
    if (s.over) break;
    if (s.leader && !s.leader.cast && s.leader.task !== 'worship') {
      if (!(await strikeRaiders(s, L.ford, 22))) {
        if (dist(s.leader, L.ford) > 14 && loose(s, L.ford, 40).length === 0) {
          // walk back toward the ford: select her, click the ground
          await selectLeader();
          await look(L.ford.x - 6, L.ford.z);
          const fp = await pixelFor(L.ford.x - 6, L.ford.z, 2);
          if (fp) await page.mouse.click(fp.x, fp.y);
          await page.keyboard.press('Escape');
        }
        await think(2);
      } else await until((q) => !q.leader || !q.leader.cast, 30, 'the strike');
    } else await think(2);
    if (s.t - lastShot > 120) {
      lastShot = s.t;
      await shot(`ford-${Math.round(s.t)}`);
    }
    if (s.t > 900) throw new Error('chapter 2 not over by 900s');
  }
  beat('hold the ford → victory', t1, s.t);
}

// ---------------------------------------------------------------------------------

let failed = null;
try {
  if (chapter === 'c01_landfall') await landfall();
  else if (chapter === 'c02_speaking_stones') await speakingStones();
  else throw new Error(`no script for ${chapter}`);
  s = await until((q) => q.over, 120, 'the game to end');
} catch (e) {
  failed = String(e.message ?? e);
  await shot('FAILED');
}
s = await snap();
log(`result: ${s.over ?? 'still playing'}${s.reason ? ` (${s.reason})` : ''}; lost ${s.lost}, foes lost ${s.foesLost}; objectives: ${s.objectives.map((o) => `${o.done ? '✓' : o.failed ? '✗' : '·'} ${o.text}`).join(' | ')}`);
if (s.over === 'victory') {
  await wait(1600);
  await shot('victory');
  const deb = page.locator('button', { hasText: 'Campaign debrief' });
  if (await deb.count()) {
    await deb.first().click();
    await wait(900);
    await shot('debrief');
  }
}
console.log('\nTiming budget (game seconds):');
for (const b of beats) console.log(`  ${b.name.padEnd(28)} ${b.t0.toFixed(0).padStart(4)} → ${b.t1.toFixed(0).padStart(4)}  (${(b.t1 - b.t0).toFixed(0)}s)`);
if (failed) console.log(`\nFAILED: ${failed}`);
if (pageErrors.length) console.log(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
await browser.close();
process.exit(!failed && s.over === 'victory' && !pageErrors.length ? 0 : 1);
