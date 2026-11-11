/**
 * render/gallery.ts — the art review booth (`?gallery=1`).
 *
 * A neutral stage, independent of the game: soft key + fill light with
 * shadows, a plain ground, and a turntable line-up of every model in the
 * kit. This is how the artist (and the reviewer) inspects the work.
 *
 * URL parameters:
 *   view=units|buildings|tiers|flora|all   what to line up (default units)
 *   clip=idle|walk|run|carry|chop|build|attack|throw|cast|chant|pray|cheer|die|drown
 *   focus=<unit kind>     one figure, close up (with civ= for leaders)
 *   civ=forest|dynasty|north
 *   spin=0                stop the turntable (models face the camera)
 *   yaw=<deg>             fixed model yaw when spin=0
 *   progress=0..1         building construction progress (default 1)
 *   hp=0..1               building health fraction
 *   burning=1             set buildings alight
 *   kinds=a,b             only these building kinds
 *   zoom=<k>              camera distance multiplier
 *   speed=<u/s>           locomotion speed for walk/run/carry (default 3.6)
 *   view=death&dieAt=<s>  the in-game death: fall, lie, fade with a tribe wisp
 */

import * as THREE from 'three';
import { CIVS, CivId } from '../config';
import { BUILDINGS, BuildingKind, BUILD_ORDER, TRIBE_IDS, Tribe, UnitKind } from '../sim/catalog';
import { buildBuildingModel, buildUnitModel, FigureModel, BuildingModel } from '../assets/models/registry';
import { tickModelMaterials } from '../assets/models/materials';
import { AnimInput, ClipName, FigureAnimator, CLIP_NAMES } from './figure-animator';
import { buildFloraPreview } from '../assets/models/flora';
import { ModelFx } from './model-particles';
import { UnitRenderer } from './unit-renderer';
import { World } from '../sim/world-state';

interface Actor {
  fig: FigureModel;
  anim: FigureAnimator;
  baseYaw: number;
}

export function startGallery(): Promise<never> {
  const q = new URLSearchParams(location.search);
  const view = q.get('view') ?? 'units';
  const clipQ = (q.get('clip') ?? 'idle') as ClipName;
  const clip: ClipName = CLIP_NAMES.includes(clipQ) ? clipQ : 'idle';
  const spin = q.get('spin') !== '0';
  const fixedYaw = (Number(q.get('yaw') ?? 0) * Math.PI) / 180;
  const zoom = Number(q.get('zoom') ?? 1);
  const speed = Number(q.get('speed') ?? 3.6);
  const progress = Number(q.get('progress') ?? 1);
  const hp = Number(q.get('hp') ?? 1);
  const burning = q.get('burning') === '1';
  const focus = q.get('focus') as UnitKind | null;
  const civQ = (q.get('civ') ?? '') as CivId;

  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.style.background = '#cfd6dc';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc9d3dc);
  scene.fog = new THREE.Fog(0xc9d3dc, 120, 260);
  const hemi = new THREE.HemisphereLight(0xdfe8f5, 0x6b6250, 1.1);
  const key = new THREE.DirectionalLight(0xfff1dc, 2.6);
  key.position.set(30, 50, 35);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.06;
  key.shadow.radius = 3;
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.6);
  fill.position.set(-30, 20, -10);
  scene.add(hemi, key, key.target, fill);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(220, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x9a9a88, roughness: 0.95 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const fx = new ModelFx(scene);
  const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 600);
  const actors: Actor[] = [];
  const buildings: BuildingModel[] = [];
  const spinners: THREE.Object3D[] = [];

  const addFigure = (kind: UnitKind, tribe: Tribe, civ: CivId, seed: number, x: number, z: number) => {
    const fig = buildUnitModel(kind, tribe, CIVS[civ], seed);
    fig.root.position.set(x, 0, z);
    scene.add(fig.root);
    const anim = new FigureAnimator(fig, seed * 13.7);
    actors.push({ fig, anim, baseYaw: fixedYaw });
    spinners.push(fig.root);
    return fig;
  };

  let frameW = 30;
  let frameH = 4;
  let frameCenter = new THREE.Vector3();

  if (focus) {
    const civ = civQ || 'forest';
    const fig = addFigure(focus, 'player', civ, Number(q.get('seed') ?? 1), 0, 0);
    // frame the whole figure, crest and staff included
    const h = Math.max(2.4, fig.height * (fig.style.leader ? 1.22 : 1.05));
    frameW = h * 1.1;
    frameH = h * 1.12;
    frameCenter.set(0, h * 0.5, 0);
  } else if (view === 'units' || view === 'all') {
    const row1: UnitKind[] = ['brave', 'brave', 'brave', 'brave', 'warrior', 'firewarrior', 'warden', 'chanter', 'wildman'];
    const seeds = [0, 1, 5, 6, 1, 1, 1, 1, 1];
    row1.forEach((k, i) => addFigure(k, k === 'wildman' ? 'wild' : 'player', 'forest', seeds[i], (i - (row1.length - 1) / 2) * 2.3, 2.5));
    const leaders: Array<[CivId, Tribe]> = [['forest', 'player'], ['dynasty', 'red'], ['north', 'gold']];
    leaders.forEach(([civ, tribe], i) => addFigure('shaman', tribe, civ, 1, (i - 1) * 3.2 - 6, -2.5));
    const tribes: Tribe[] = [...TRIBE_IDS, 'wild'];
    tribes.forEach((t, i) => addFigure('warrior', t, 'forest', i + 3, 3 + i * 2.2 - 2, -2.5));
    frameW = 22;
    frameH = 5;
    frameCenter.set(0, 1.3, 0);
  }

  if (view === 'buildings' || view === 'tiers' || view === 'all') {
    const civs: CivId[] = civQ ? [civQ] : ['forest', 'dynasty', 'north'];
    const tribes: Tribe[] = ['player', 'red', 'gold'];
    const only = q.get('kinds')?.split(',') ?? null;
    const list: Array<[BuildingKind, number]> = ([
      ...(view === 'tiers' ? [['hut', 0], ['hut', 1], ['hut', 2]] : BUILD_ORDER.map((k) => [k, 0]))
    ] as Array<[BuildingKind, number]>).filter(([k]) => !only || only.includes(k as string)) as Array<[BuildingKind, number]>;
    const zBase = view === 'all' ? -14 : 0;
    civs.forEach((civ, row) => {
      let x = 0;
      const widths = list.map(([k]) => BUILDINGS[k].size * 2 + 2.5);
      const total = widths.reduce((a, b) => a + b, 0);
      x = -total / 2;
      list.forEach(([k, tier], i) => {
        const m = buildBuildingModel(k, tribes[row % tribes.length], CIVS[civ], tier);
        x += widths[i] / 2;
        m.root.position.set(x, 0, zBase - row * 13);
        x += widths[i] / 2;
        m.update({ progress, hpFrac: hp, burning, dt: 0 });
        scene.add(m.root);
        buildings.push(m);
      });
      frameW = Math.max(frameW, total);
    });
    frameH = 6 + civs.length * 6;
    frameCenter.set(0, 2, zBase - ((civs.length - 1) * 13) / 2);
    if (view === 'all') frameCenter.z = -10;
  }

  // view=death: the game's own UnitRenderer on a flat stand-in world; the
  // figures die `dieAt` seconds in (default 1) — fall, lie, fade, wisp.
  let deathStage: { r: UnitRenderer; world: World; dieAt: number } | null = null;
  if (view === 'death') {
    const kinds: UnitKind[] = ['brave', 'warrior', 'firewarrior', 'warden'];
    // A real (empty, flat) World: the renderer reads it exactly as in game.
    const world = new World();
    kinds.forEach((kind, i) => {
      world.spawn(kind, i % 2 ? 'red' : 'player', (i - 1.5) * 1.6, 0).heading = 0.5;
    });
    const r = new UnitRenderer(scene);
    r.setCamera(camera);
    deathStage = { r, world, dieAt: Number(q.get('dieAt') ?? 1) };
    ground.position.y = -0.001;
    frameW = 9;
    frameH = 3.5;
    frameCenter.set(0, 0.9, 0);
  }

  if (view === 'flora') {
    const g = buildFloraPreview();
    scene.add(g);
    frameW = 34;
    frameH = 8;
    frameCenter.set(0, 3, 0);
  }

  // Frame the camera on the line-up.
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (Math.max(frameH, frameW / camera.aspect) / 2 / Math.tan(fov / 2)) * 1.15 * zoom;
  const pitch = focus ? 0.12 : view === 'units' ? 0.32 : 0.55;
  camera.position.set(frameCenter.x, frameCenter.y + Math.sin(pitch) * dist, frameCenter.z + Math.cos(pitch) * dist);
  camera.lookAt(frameCenter);
  key.target.position.copy(frameCenter);
  const sc = key.shadow.camera;
  const ext = Math.max(frameW, frameH * 2) * 0.75 + 4;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 200;
  key.position.copy(frameCenter).add(new THREE.Vector3(30, 50, 35));
  sc.updateProjectionMatrix();

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  // Status line for the screenshot.
  const label = document.createElement('div');
  label.style.cssText = 'position:fixed;left:12px;top:10px;font:12px ui-monospace,Menlo,monospace;color:#223;opacity:.75';
  label.textContent = `gallery · view=${view} · clip=${clip}${focus ? ` · focus=${focus}` : ''}`;
  document.body.appendChild(label);

  let last = performance.now();
  let time = 0;
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    tickModelMaterials(dt);
    for (const a of actors) {
      const loco = clip === 'walk' || clip === 'run' || clip === 'carry';
      const inp: AnimInput = { clip, speed: loco ? speed : 0, turnRate: 0 };
      if (a.fig.style.tools) {
        a.fig.setProp('axe', clip === 'chop' || (clip === 'attack' && a.fig.kind === 'brave'));
        a.fig.setProp('hammer', clip === 'build');
        a.fig.setProp('log', clip === 'carry');
      }
      a.anim.update(dt, inp);
      if (a.fig.aura) {
        const k = 0.85 + 0.15 * Math.sin(time * 2.2);
        a.fig.aura.scale.setScalar(k);
      }
    }
    for (const s of spinners) s.rotation.y = spin ? time * 0.6 : fixedYaw;
    for (const b of buildings) {
      b.update({ progress, hpFrac: hp, burning, dt });
      fx.building(b.root, b, dt);
    }
    if (deathStage) {
      if (time > deathStage.dieAt) deathStage.world.units.length = 0;
      deathStage.r.sync(deathStage.world, ZERO3, 1, dt, EMPTY);
    }
    scene.updateMatrixWorld();
    fx.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();
  (window as unknown as { __gallery: unknown }).__gallery = { scene, camera, actors, buildings };
  return new Promise<never>(() => {});
}

const ZERO3 = new THREE.Vector3();
const EMPTY = new Set<number>();
