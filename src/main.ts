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
import { startLoop } from './core/loop';
import { unlockAudio } from './core/audio';
import { LevelData } from './level/level-format';
import { BuildingRenderer } from './render/building-renderer';
import { CameraRig } from './render/camera-rig';
import { EffectsRenderer } from './render/effects';
import { Lighting } from './render/lighting';
import { FOG_FAR_K, FOG_NEAR_K, initialQuality, sunPreset } from './render/look';
import { PostChain } from './render/post';
import { Atmosphere, Sky } from './render/sky';
import { TreeRenderer } from './render/tree-renderer';
import { UnitRenderer } from './render/unit-renderer';
import { World } from './sim/world-state';
import { SculptBrush } from './ui/brush';
import { BuildPlacer } from './ui/build-placer';
import { Hud } from './ui/hud';
import { OrderControl } from './ui/orders';
import { appState } from './ui/app-state';
import { Editor } from './ui/editor';
import { LevelLibrary } from './ui/level-library';
import { Menu } from './ui/menu';
import { Minimap } from './ui/minimap';
import { SpellCaster } from './ui/spell-caster';
import { SpellPanel } from './ui/spell-panel';
import { applyLimbToCpuCurved, curvatureUniforms } from './world/curvature';
import { TerrainMesh } from './world/terrain-mesh';
import { GroundCover } from './world/ground-cover';
import { Water } from './world/water';

// --- The world (simulation state) ---
const world = new World();
// Dev/automation hooks: ?seed=N fixes the planet, ?play=1 skips the menu,
// ?level=<official id> loads a designed level (see tools/shot.mjs).
const query = new URLSearchParams(location.search);
world.reset(query.has('seed') ? Number(query.get('seed')) : Math.floor(Math.random() * 1e9));

// --- Renderer & scene (the look: render/look.ts, sky.ts, lighting.ts, post.ts) ---
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
treeRenderer.rebuild(world);

// --- Camera, input, UI ---
const rig = new CameraRig(world.map, renderer.domElement);
const brush = new SculptBrush(rig.camera, rig.target, world.map, renderer.domElement, scene);
const orders = new OrderControl(rig.camera, rig.target, world, unitRenderer, renderer.domElement);
const placer = new BuildPlacer(rig.camera, rig.target, world, renderer.domElement, scene);
const caster = new SpellCaster(rig.camera, rig.target, world, renderer.domElement, scene);
const effects = new EffectsRenderer(scene, rig, terrain, lighting, quality);
const post = new PostChain(renderer, scene, rig.camera, quality);
post.onQualityChange = (q) => {
  quality = q;
  lighting.applyQuality(q);
};
new SpellPanel(world);
const minimap = new Minimap(rig.target);

// Browsers mute pages until the user interacts — wake the synth on the
// first click so the first Blast actually booms.
addEventListener('pointerdown', unlockAudio, { once: true });

// Open on your tribe, not a random patch of ocean (there are two leaders
// on this planet — make sure we look at OURS).
function centerOnHome(): void {
  const home = world.tribes.player.home;
  rig.target.set(home.x * 2, 0, home.z * 2);
}
centerOnHome();

function newWorld(settings?: Parameters<World['reset']>[1]): void {
  world.reset(Math.floor(Math.random() * 1e9), settings);
  treeRenderer.rebuild(world);
  orders.selected.clear();
  centerOnHome();
}

// --- App modes: menu ⇄ game ⇄ editor ⇄ library ----------------------------
//
// The setup screen offers three doors: Skirmish (random planet), Levels
// (the library: official + yours + imported), and Editor. The library and
// editor feed back into the game via loadLevel; the editor's Test button
// round-trips — play your level, then pop back with the terrain pristine.

const menu = new Menu((settings) => {
  appState.mode = 'game';
  newWorld(settings);
});

/** Launch any level document as a playable skirmish. */
async function startLevel(level: LevelData, asTest = false): Promise<void> {
  await world.loadLevel(level, menu.settings);
  treeRenderer.rebuild(world);
  orders.selected.clear();
  centerOnHome();
  appState.mode = 'game';
  testingLevel = asTest ? level : null;
  backBtn.style.display = asTest ? 'block' : 'none';
}

/** Load a level into the editor as clay (sim frozen, placement tools out). */
async function editLevel(id: string | undefined, level: LevelData): Promise<void> {
  await world.loadLevel(level, menu.settings);
  // Tribes' units don't belong in the editor — keep only the wildmen
  // (which ARE level content). Homes stay marked by the totems.
  world.units = world.units.filter((u) => u.kind === 'wildman');
  treeRenderer.rebuild(world);
  orders.selected.clear();
  centerOnHome();
  lastEdit = { id, level };
  appState.mode = 'editor';
  editor.open({ id, level });
}

/** A fresh editor canvas: roll a random planet, then hand over the chisel. */
function freshEditorCanvas(): void {
  newWorld();
  world.units = world.units.filter((u) => u.kind === 'wildman');
  treeRenderer.rebuild(world);
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
    menu.show();
  },
});

const editor = new Editor(rig.camera, rig.target, world, renderer.domElement, {
  onTest: (level) => {
    lastEdit = { ...lastEdit, level };
    void startLevel(level, true);
  },
  onExit: () => {
    editor.close();
    appState.mode = 'menu';
    menu.show();
  },
});

menu.onLevels = () => {
  appState.mode = 'menu';
  library.show();
};
menu.onEditor = () => freshEditorCanvas();

// The "↩ editor" button, visible only while test-playing a level.
const backBtn = document.createElement('button');
backBtn.textContent = '↩ back to editor';
backBtn.style.cssText = `
  position: fixed; top: 196px; right: 12px; z-index: 15; display: none;
  padding: 8px 12px; cursor: pointer; border-radius: 8px;
  border: 1px solid rgba(255,233,168,0.5); background: rgba(16,22,30,0.85);
  color: #ffe9a8; font: 12px ui-monospace, Menlo, monospace;
`;
backBtn.addEventListener('click', () => {
  if (!lastEdit.level) return;
  backBtn.style.display = 'none';
  testingLevel = null;
  void editLevel(lastEdit.id, lastEdit.level); // pristine copy — test damage discarded
});
document.body.appendChild(backBtn);

addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && appState.mode === 'game' && !testingLevel) newWorld();
  if (e.code === 'KeyM' && appState.mode !== 'editor') {
    appState.mode = 'menu';
    menu.show();
  }
});

addEventListener('resize', () => post.setSize(innerWidth, innerHeight));

// --- The loop ---
let hud: Hud; // created right after the loop starts (it needs the stats object)
const stats = startLoop({
  // Fixed-rate simulation: deterministic, testable, framerate-independent.
  // Frozen outside of play — the editor needs its clay to hold still, and
  // the menu's attract-mode world can idle without an AI scheming in it.
  tick(dt) {
    if (appState.mode === 'game') world.tick(dt);
  },

  // Per-frame rendering: camera + input, then sync visuals to sim state.
  render(dt, alpha) {
    rig.update(dt);
    brush.update(dt);
    placer.update();
    caster.update();

    // One uniform update curves every world-space material around wherever
    // the camera looks (they share these uniform objects — see curvature.ts).
    curvatureUniforms.uCamTarget.value.copy(rig.target);

    terrain.sync(rig.target, world, dt); // slide the grid; re-upload only what changed
    water.update(rig.target, dt);
    groundCover?.update(rig.target, dt);
    sky.update(rig.camera, dt);
    atmosphere.update(rig.target, rig.distance);
    lighting.update(rig.target, rig.distance, dt);
    const fog = scene.fog as THREE.Fog;
    fog.near = rig.distance * FOG_NEAR_K;
    fog.far = rig.distance * FOG_FAR_K + 120;
    unitRenderer.sync(world, rig.target, alpha, dt, orders.selected);
    treeRenderer.sync(world, rig.target);
    buildingRenderer.sync(world, rig.target);
    applyLimbToCpuCurved(scene, rig.target); // until the CPU-curved renderers use curvatureDrop()
    effects.sync(world, rig.target, dt);
    minimap.update(world, rig.target);
    hud.update(world);

    post.render(dt);
  },
});

hud = new Hud(stats, brush, world, orders);

// Automation handle (tools/shot.mjs, tests, the console). Not a game API.
(window as unknown as { __tg: unknown }).__tg = { world, rig, appState, menu, startLevel, terrain, effects, post, scene, lighting };
if (query.get('play') === '1') {
  menu.hide();
  appState.mode = 'game';
  const levelId = query.get('level');
  if (levelId) {
    void import('./level/official-levels').then(async (m) => {
      const hit = m.OFFICIAL_LEVELS.find((l) => l.id === levelId);
      if (hit) await startLevel(await hit.build());
    });
  }
}
