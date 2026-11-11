/**
 * main.ts — boot: build the world, wire everything together, start the loop.
 *
 * Reading order for the codebase (each file's header comment explains its
 * technique):
 *
 *   1. world/heightmap.ts       — the planet is an array (start here!)
 *   2. world/curvature.ts       — why the flat array looks round
 *   3. world/terrain-mesh.ts    — array → lit, painted geometry
 *   4. sim/world-state.ts       — units as plain data + state machines
 *   5. sim/pathfinding.ts       — A* on the same grid as the terrain
 *   6. assets/models/figures.ts — characters built from primitives
 *   7. render/figure-animator.ts— walk cycles as math
 *   8. render/unit-renderer.ts  — interpolate / anchor / curve
 *   9. core/loop.ts             — fixed-tick sim vs per-frame rendering
 *
 * Architecture rule everything hangs off: SIMULATION state (heightmap,
 * units, trees) is plain data advanced in fixed ticks by World.tick().
 * RENDERING reads that state every frame and never writes it. INPUT
 * (brush, orders) writes to the sim only through its public methods.
 */

import * as THREE from 'three';
import { WORLD_SIZE } from './config';
import { startLoop } from './core/loop';
import { wrapDelta } from './core/util';
import { uiClick, uiHover, unlockAudio } from './core/audio';
import { Soundscape } from './core/sfx';
import { LevelData } from './level/level-format';
import type { ScenarioRules } from './sim/catalog';
import { BuildingRenderer } from './render/building-renderer';
import { CameraRig } from './render/camera-rig';
import { EffectsRenderer } from './render/effects';
import { Lighting } from './render/lighting';
import { CAMERA, initialQuality, QUALITY, sunPreset } from './render/look';
import { PostChain } from './render/post';
import { Atmosphere, Sky } from './render/sky';
import { TreeRenderer } from './render/tree-renderer';
import { UnitRenderer } from './render/unit-renderer';
import { restoreWorld, saveWorld } from './sim/save';
import { World } from './sim/world-state';
import './ui/theme.css';
import { SculptBrush } from './ui/brush';
import { appState } from './ui/app-state';
import { clearSave, clock, readSave, savedTally, writeSave } from './ui/autosave';
import { CampaignController } from './ui/campaign';
import { Editor } from './ui/editor';
import { registerGameOverAction } from './ui/game-over';
import { GameUi } from './ui/game-ui';
import { LevelLibrary } from './ui/level-library';
import { Menu } from './ui/menu';
import { applyUiScale, QualitySetting, settings as uiSettings, writeQualityToUrl } from './ui/settings';
import { toScreen } from './ui/project';
import { toolState } from './ui/tools';
import { curvatureUniforms } from './world/curvature';
import { TerrainMesh } from './world/terrain-mesh';
import { GroundCover } from './world/ground-cover';
import { Water } from './world/water';

// Art review booth (?gallery=1): takes over the page and never returns. See render/gallery.ts.
if (new URLSearchParams(location.search).get('gallery') === '1') await import('./render/gallery').then((m) => m.startGallery());

// --- The world (simulation state) ---
const world = new World();
// Dev/automation hooks: ?seed=N fixes the planet, ?play=1 skips the menu,
// ?level=<official id> loads a designed level (see tools/shot.mjs).
const query = new URLSearchParams(location.search);
const querySeed = query.get('seed')?.trim() && Number.isFinite(Number(query.get('seed'))) ? Number(query.get('seed')) : null;
world.reset(querySeed ?? Math.floor(Math.random() * 1e9));

// --- Renderer & scene (the look: render/look.ts, sky.ts, lighting.ts, post.ts) ---
writeQualityToUrl(true); // the player's saved graphics setting becomes ?q= before the renderer reads it
applyUiScale();
let quality = initialQuality();
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio));
renderer.shadowMap.enabled = quality.shadowMapSize > 0;
renderer.shadowMap.type = THREE.PCFShadowMap; // soft via shadow.radius (r182 PCF = Vogel-disk filtered)
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sunLook = sunPreset();
const sky = new Sky(sunLook);
scene.add(sky.mesh);
sky.mesh.userData.gpuCurved = true;
const atmosphere = new Atmosphere(sky.hazeColor, sky.sunDir);
scene.add(atmosphere.mesh);
atmosphere.mesh.userData.gpuCurved = true;
scene.environment = sky.buildEnvironment(renderer);
scene.environmentIntensity = sunLook.envIntensity;
scene.fog = new THREE.Fog(sky.hazeColor, 100, 500);
const lighting = new Lighting(scene, sky.sunDir, sunLook, quality);

const terrain = new TerrainMesh(world.map, quality);
terrain.setHaze(sky.hazeColor);
scene.add(terrain.mesh);
terrain.mesh.userData.gpuCurved = true;

const groundCover = quality.name === 'low' ? null : new GroundCover(terrain, quality);
if (groundCover) scene.add(groundCover.mesh);

const water = new Water(terrain);
scene.add(water.mesh);
water.mesh.userData.gpuCurved = true;

const unitRenderer = new UnitRenderer(scene);
const treeRenderer = new TreeRenderer(scene);
const buildingRenderer = new BuildingRenderer(scene);
/** A different world was loaded (new game, level, save, editor canvas): drop per-world render state. */
function worldChanged(): void {
  treeRenderer.rebuild(world);
  terrain.clearScorch(); // burnt ground belongs to the old world
}
treeRenderer.rebuild(world);

// --- Camera, input, UI ---
const rig = new CameraRig(world.map, renderer.domElement);
const brush = new SculptBrush(rig.camera, rig.target, world.map, renderer.domElement, scene);
const effects = new EffectsRenderer(scene, rig, terrain, lighting, quality);
const post = new PostChain(renderer, scene, rig.camera, quality);
post.onQualityChange = (q) => {
  quality = q;
  lighting.applyQuality(q);
};
/** Settings → Graphics, applied live. True if the terrain mesh still wants a reload for it. */
const bootTerrain = { subdiv: quality.terrainSubdiv, detail: quality.terrainDetail };
function applyQuality(q: QualitySetting): boolean {
  const tier = QUALITY[q === 'auto' ? 'high' : q];
  quality = tier;
  post.setQuality(tier);
  lighting.applyQuality(tier);
  if (groundCover) groundCover.mesh.visible = tier.name !== 'low';
  return tier.terrainSubdiv !== bootTerrain.subdiv || tier.terrainDetail !== bootTerrain.detail;
}
// Edge panning is a player setting; the rig reads a flag it otherwise takes from ?edgepan=1.
const setEdgePan = (on: boolean) => {
  (rig as unknown as { edgePan: boolean }).edgePan = on || query.get('edgepan') === '1';
};
setEdgePan(uiSettings.edgePan);

// Browsers mute pages until the user interacts — wake the synth on the
// first click so the first Blast actually booms.
addEventListener('pointerdown', unlockAudio, { once: true });
addEventListener('keydown', unlockAudio, { once: true });
const soundscape = new Soundscape();
// A tiny tick on every HUD/menu button press, a softer one on hover (throttled).
let lastHover = 0;
addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest?.('button, .tg-btn, select')) uiClick();
}, true);
addEventListener('pointerover', (e) => {
  const el = (e.target as HTMLElement).closest?.('button:not(:disabled)');
  if (!el || performance.now() - lastHover < 90) return;
  lastHover = performance.now();
  uiHover();
}, true);
/** Share of sea and of trees in the tiles around the camera target (for the ambient bed). */
let ambientSample = { sea: 0, trees: 0, at: -1 };
function ambientAround(tx: number, tz: number): { sea: number; trees: number } {
  const now = performance.now();
  if (now - ambientSample.at < 500) return ambientSample;
  let sea = 0;
  let n = 0;
  for (let dz = -16; dz <= 16; dz += 4) {
    for (let dx = -16; dx <= 16; dx += 4) {
      n++;
      if (world.map.heightAt(Math.round(tx + dx), Math.round(tz + dz)) < 0) sea++;
    }
  }
  // The camera target is unwrapped (you can pan round the planet forever), so
  // distances to trees go the short way round, or the forest falls silent
  // after a lap.
  let trees = 0;
  for (const t of world.trees) {
    if (t.alive && Math.abs(wrapDelta(t.x - tx, WORLD_SIZE)) < 16 && Math.abs(wrapDelta(t.z - tz, WORLD_SIZE)) < 16) trees++;
  }
  ambientSample = { sea: sea / n, trees: Math.min(1, trees / 40), at: now };
  return ambientSample;
}

// Open on your tribe, not a random patch of ocean (there are two leaders
// on this planet — make sure we look at OURS).
function centerOnHome(): void {
  const home = world.tribes.player?.home ?? { x: 0, z: 0 };
  rig.target.set(home.x * 2, 0, home.z * 2);
  rig.zoom = CAMERA.defaultZoom;
}
centerOnHome();

/** What Restart replays: the last skirmish settings, or the last level. */
let lastStart: { settings?: Parameters<World['reset']>[1]; level?: LevelData } = {};

/** Seed of the planet the last skirmish was rolled from (automation reads it to report/replay a run). */
let lastSeed = querySeed ?? 0;

/**
 * Roll a fresh skirmish planet. `?seed=N` in the URL fixes it (so the menu's
 * Begin is reproducible for automation and bug reports); otherwise random.
 */
function newWorld(settings?: Parameters<World['reset']>[1], seed = querySeed ?? Math.floor(Math.random() * 1e9)): void {
  startToken++;
  lastSeed = seed;
  world.reset(seed, settings);
  worldChanged();
  centerOnHome();
  ui?.reset();
  lastStart = { settings };
  testingLevel = null;
  autosaveClock = 0;
}

// --- App modes: menu ⇄ game ⇄ editor ⇄ library ----------------------------
//
// The title screen offers Campaign (ui/campaign.ts), Skirmish (random
// planet), Levels (the library: official + campaign + yours + imported),
// and Editor. The library and
// editor feed back into the game via loadLevel; the editor's Test button
// round-trips — play your level, then pop back with the terrain pristine.

const menu = new Menu((settings) => {
  campaign.leave();
  appState.mode = 'game';
  newWorld(settings);
});
menu.settingsHooks = {
  inGame: () => menu.inGame,
  onEdgePan: setEdgePan,
  onResetHints: () => ui?.resetHints(),
  onQuality: applyQuality,
};
// The in-game menu pauses the sim while it's open and restores the speed after.
let pausedBeforeMenu = false;
function openGameMenu(screen: 'pause' | 'help' = 'pause'): void {
  if (appState.mode !== 'game' || menu.visible) return;
  pausedBeforeMenu = appState.paused;
  appState.paused = true;
  autosave();
  menu.openInGame(screen);
}
menu.onResume = () => {
  menu.hide();
  appState.paused = pausedBeforeMenu;
};
menu.onRestart = () => {
  menu.hide();
  restart();
};
menu.onQuit = () => quitToMenu();
function restart(): void {
  if (campaign.active) {
    appState.mode = 'menu';
    void campaign.play(campaign.active, { force: true }); // same chapter, same boons
  } else if (lastStart.level) {
    appState.mode = 'menu'; // hold the sim until the level has loaded
    void startLevel(lastStart.level, !!testingLevel);
  } else {
    appState.mode = 'game';
    newWorld(lastStart.settings);
  }
}
function quitToMenu(): void {
  autosave();
  testingLevel = null; // a test-play is over; the next game saves again
  autosaveClock = 0;
  startToken++;
  campaign.leave();
  appState.mode = 'menu';
  appState.paused = false;
  backBtn.style.display = 'none';
  showTitle();
}
/** The title screen frames the whole planet, slowly turning. */
function showTitle(): void {
  rig.zoom = 0.78;
  menu.show('title');
}

// --- Save & Continue (ui/autosave.ts, sim/save.ts) -------------------------

/** Save the game in progress (never a test-play, never a finished game). */
function autosave(): void {
  if (appState.mode !== 'game' || testingLevel) return;
  if (world.gameOver) return clearSave();
  if (world.elapsed < 5) return;
  const kind = campaign.active ? 'campaign' : lastStart.level ? 'level' : 'skirmish';
  const what = kind === 'campaign' ? campaign.titleOf(campaign.active!) : kind === 'level' ? lastStart.level!.name : 'Skirmish';
  writeSave({
    v: 1,
    kind,
    ...(kind === 'campaign' ? { campaign: campaign.active! } : {}),
    ...(kind === 'level' ? { level: lastStart.level } : {}),
    label: `${what} · ${clock(world.elapsed)}`,
    world: saveWorld(world),
    ...(ui ? { tally: { ...ui.alerts.tally } } : {}),
  });
}
menu.continueLabel = () => readSave()?.label ?? null;
menu.onContinue = () => {
  const g = readSave();
  if (!g) return showTitle();
  startToken++;
  campaign.leave();
  try {
    restoreWorld(world, g.world);
  } catch (err) {
    console.warn('saved game could not be restored', err);
    clearSave();
    return showTitle();
  }
  worldChanged();
  ui?.reset();
  // Game-over numbers carry on from where the save left them.
  const tally = savedTally(g);
  if (ui && tally) Object.assign(ui.alerts.tally, tally);
  lastStart = g.kind === 'level' && g.level ? { level: g.level } : { settings: world.settings };
  testingLevel = null;
  backBtn.style.display = 'none';
  if (g.kind === 'campaign' && g.campaign) campaign.resume(g.campaign);
  autosaveClock = 0;
  const at = world.leaderOf('player') ?? world.tribes.player?.home;
  if (at) rig.target.set(at.x * 2, 0, at.z * 2);
  rig.zoom = CAMERA.defaultZoom;
  appState.mode = 'game';
};
addEventListener('visibilitychange', () => {
  if (document.hidden) autosave();
});
addEventListener('pagehide', () => autosave());
let autosaveClock = 0;
let savedCleared = false;

/** Bumped by every start/quit: a level load that finishes after the player moved on is dropped. */
let startToken = 0;

/** Launch any level document — under its own rules, or `rules` (a campaign chapter with boons). */
async function startLevel(level: LevelData, asTest = false, rules?: ScenarioRules): Promise<boolean> {
  const token = ++startToken;
  if (!rules) campaign.leave();
  try {
    await world.loadLevel(level, menu.settings, rules);
  } catch (err) {
    // A damaged imported level: say so and go back to the title, never a dead screen.
    console.warn('level failed to load', err);
    alert(`This level could not be loaded: ${(err as Error).message}`);
    quitToMenu();
    return false;
  }
  if (token !== startToken) return false;
  worldChanged();
  centerOnHome();
  ui?.reset();
  appState.mode = 'game';
  lastStart = { level };
  testingLevel = asTest ? level : null;
  autosaveClock = 0;
  backBtn.style.display = asTest ? 'block' : 'none';
  return true;
}

/** Load a level into the editor as clay (sim frozen, placement tools out). */
async function editLevel(id: string | undefined, level: LevelData): Promise<void> {
  const token = ++startToken;
  await world.loadLevel(level, menu.settings);
  if (token !== startToken) return; // the player moved on while it loaded
  // Tribes' units don't belong in the editor — keep only the wildmen
  // (which ARE level content). Homes stay marked by the totems.
  world.units = world.units.filter((u) => u.kind === 'wildman');
  worldChanged();
  ui?.reset();
  centerOnHome();
  lastEdit = { id, level };
  appState.mode = 'editor';
  editor.open({ id, level });
}

/** A fresh editor canvas: roll a random planet, then hand over the chisel. */
function freshEditorCanvas(): void {
  newWorld();
  world.units = world.units.filter((u) => u.kind === 'wildman');
  worldChanged();
  lastEdit = { id: undefined, level: null };
  appState.mode = 'editor';
  editor.open();
}

let testingLevel: LevelData | null = null;
let lastEdit: { id: string | undefined; level: LevelData | null } = { id: undefined, level: null };

const library = new LevelLibrary({
  onPlay: (level) => void startLevel(level),
  onEdit: (id, level) => void editLevel(id, level),
  onClose: () => {
    appState.mode = 'menu';
    showTitle();
  },
  onPlayScenario: (id) => void campaign.brief(id),
  isScenarioUnlocked: (id) => campaign.unlocked(id),
});

// --- Campaign: title → map → briefing → play → debrief (ui/campaign.ts) ---
const campaign = new CampaignController(
  {
    world,
    startScenario: (level, rules) => startLevel(level, false, rules),
    pause: () => {
      ui?.gameOver.hide();
      if (appState.mode === 'game') appState.mode = 'menu';
    },
    showMenu: () => {
      appState.mode = 'menu';
      showTitle();
    },
  },
  { autoDebrief: false }, // the game-over screen offers the debrief (below)
);
menu.onCampaign = () => {
  appState.mode = 'menu';
  campaign.showMap();
};
if (menu.visible) menu.show('title'); // re-render: the Campaign door is open now
registerGameOverAction(() =>
  campaign.active ? { label: 'Campaign debrief', primary: true, icon: 'arrowRight', run: () => campaign.handleGameOver() } : null,
);

const editor = new Editor(rig.camera, rig.target, world, renderer.domElement, {
  onTest: (level) => {
    lastEdit = { ...lastEdit, level };
    void startLevel(level, true);
  },
  onExit: () => {
    editor.close();
    appState.mode = 'menu';
    showTitle();
  },
});

menu.onLevels = () => {
  appState.mode = 'menu';
  library.show();
};
menu.onEditor = () => freshEditorCanvas();

// The "back to editor" button, visible only while test-playing a level.
const backBtn = document.createElement('button');
backBtn.type = 'button';
backBtn.className = 'tg-btn primary';
backBtn.textContent = 'Back to the editor';
backBtn.style.cssText = 'position: fixed; top: calc(var(--edge, 1rem) + 4.2rem); left: var(--edge, 1rem); z-index: 15; display: none;';
backBtn.addEventListener('click', () => {
  if (!lastEdit.level) return;
  backBtn.style.display = 'none';
  testingLevel = null;
  void editLevel(lastEdit.id, lastEdit.level); // pristine copy — test damage discarded
});
document.body.appendChild(backBtn);

addEventListener('resize', () => {
  post.setSize(innerWidth, innerHeight);
  applyUiScale();
});

// --- The loop ---
let ui: GameUi | undefined; // created right after the loop starts (it needs the stats object)
const stats = startLoop({
  // Fixed-rate simulation: deterministic, testable, framerate-independent.
  // Frozen outside of play — the editor needs its clay to hold still, and
  // the menu's attract-mode world can idle without an AI scheming in it.
  // Pause skips ticks; 2×/3× runs that many fixed ticks per loop tick.
  tick(dt) {
    if (appState.mode !== 'game' || appState.paused) return;
    for (let i = 0; i < appState.speed; i++) world.tick(dt);
  },

  // Per-frame rendering: camera + input, then sync visuals to sim state.
  render(dt, alpha) {
    if (appState.mode === 'menu' && menu.visible) rig.yaw += dt * 0.04; // the planet turns behind the menu
    rig.update(menu.visible || ui?.gameOver.visible ? 0 : dt); // no panning behind a menu
    brush.update(dt);
    ui?.update(dt);
    campaign.update();

    // One uniform update curves every world-space material around wherever
    // the camera looks (they share these uniform objects — see curvature.ts).
    curvatureUniforms.uCamTarget.value.copy(rig.target);

    terrain.sync(rig.target, world, dt); // slide the grid; re-upload only what changed
    water.update(rig.target, dt);
    groundCover?.update(rig.target, dt, rig.distance);
    sky.update(rig.camera, dt, scene.fog as THREE.Fog, rig.distance);
    atmosphere.update(rig.target, rig.distance);
    lighting.update(rig.target, rig.distance, dt);
    unitRenderer.sync(world, rig.target, alpha, dt, ui?.selection.units ?? new Set<number>());
    treeRenderer.sync(world, rig.target);
    buildingRenderer.sync(world, rig.target);
    const camTx = rig.target.x / 2;
    const camTz = rig.target.z / 2;
    if (appState.mode === 'game') soundscape.hear(world.events, camTx, camTz, rig.distance); // before effects drain them
    const amb = ambientAround(camTx, camTz);
    soundscape.ambient({ seaFraction: amb.sea, treeFraction: amb.trees, camDistance: rig.distance, paused: appState.mode !== 'game' || appState.paused }, dt);
    effects.sync(world, rig.target, dt); // drains world.events (ui/alerts.ts diffs state instead)
    if (appState.mode === 'game' && !appState.paused) {
      autosaveClock += dt;
      if (autosaveClock > 60) {
        autosaveClock = 0;
        autosave();
      }
    }
    if (world.gameOver && appState.mode === 'game' && !savedCleared) {
      savedCleared = true; // a finished game can't be continued
      clearSave();
    }
    if (!world.gameOver) savedCleared = false;
    ui?.updateOverlay();

    post.render(dt);
  },
});

ui = new GameUi(world, { camera: rig.camera, target: rig.target, map: world.map }, scene, renderer.domElement, stats, {
  openMenu: () => openGameMenu('pause'),
  openHelp: () => openGameMenu('help'),
  restart,
  quitToMenu,
  isBlocked: () => menu.visible,
}, () => brush.radius);

// Automation handle (tools/shot.mjs, tests, the console). Not a game API.
(window as unknown as { __tg: unknown }).__tg = {
  world, rig, appState, menu, startLevel, terrain, effects, post, scene, lighting, ui, toolState, newWorld, campaign,
  autosave, applyQuality, soundscape,
  /** Seed of the last skirmish planet rolled (newWorld). */
  get lastSeed() {
    return lastSeed;
  },
  /** Screen position (CSS px) of tile (x, z) at height h above the ground, or null if off screen. */
  screenOf: (x: number, z: number, h = 0) => toScreen({ camera: rig.camera, target: rig.target, map: world.map }, x, z, h),
};
if (query.get('play') !== '1') rig.zoom = 0.78;
if (query.get('play') === '1') {
  menu.hide();
  appState.mode = 'game';
  ui.reset();
  const levelId = query.get('level');
  const scenarioId = query.get('scenario'); // ?play=1&scenario=<campaign id> jumps into a chapter
  if (scenarioId) {
    void campaign.play(scenarioId, { force: true });
  } else if (levelId) {
    void import('./level/official-levels').then(async (m) => {
      const hit = m.OFFICIAL_LEVELS.find((l) => l.id === levelId);
      if (hit) await startLevel(await hit.build());
    });
  }
}
