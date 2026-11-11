/**
 * ui/minimap.ts — the whole planet at a glance (bottom left).
 *
 * A 2D <canvas>, drawn in layers:
 *
 *   TERRAIN — one pixel per tile in a 128×128 image, coloured from the same
 *   palette the terrain shader paints with (render/look.ts TERRAIN, WATER)
 *   and hill-shaded from the height differences, then scaled up smoothly.
 *   Repainted only when the heightmap changes (map.version) or every few
 *   seconds for the forests.
 *
 *   OVERLAY — every frame: tribe-coloured dots for people, squares for
 *   buildings, diamonds for standing stones (dim when asleep or claimed),
 *   alert pings, and the camera's view: the ground the screen's edges
 *   actually see, found with the same ray-march picker as clicks, so the
 *   outline turns and stretches as you rotate and zoom.
 *
 * The map shows WRAPPED tile space; the camera roams unwrapped world
 * units. Clicks resolve to the image of the tile nearest the camera, and
 * the view outline is drawn three times over the seams so it never
 * vanishes at an edge.
 *
 * Left click / drag moves the camera; right-click gives the selection the
 * context order at that spot (ui/orders.ts orderAt).
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { pickGroundTile } from '../render/ground-picker';
import { TERRAIN, WATER } from '../render/look';
import { TRIBE_COLORS } from '../sim/catalog';
import { UiContext } from './context';
import { css, escapeHtml, h } from './dom';
import { spellIcon } from './icons';
import { ritualAt, stoneBlocked, stoneName, stoneTerms, tribeLabelOf } from './stones';
import { tip } from './tooltip';
import { lookAtTile, viewCentreTile } from './project';

css('minimap', `
/* The planet painted on hide, stretched in a round wooden hoop; a notch marks north. */
.mm { position: relative; padding: 0.55rem; border: 0; border-image: none; border-radius: 50%;
  background: radial-gradient(circle, transparent 66%, rgba(0,0,0,0.35) 70%), var(--tex-wood-light) 0 0 / 9rem;
  box-shadow: inset 0 0.15rem 0 rgba(255,236,200,0.35), inset 0 -0.2rem 0.3rem rgba(0,0,0,0.5), 0 0 0 1px #140b05, 0 0 0 0.2rem #5a3a1f, 0 0 0 0.26rem #140b05, var(--shadow); }
.mm canvas { display: block; width: 11.5rem; height: 11.5rem; border-radius: 34%; cursor: crosshair; filter: sepia(0.28) saturate(0.85) contrast(1.05);
  box-shadow: 0 0 0 0.16rem #2a170b, 0 0 0 0.3rem #c9a66b; }
.mm .hide { position: absolute; inset: 0.55rem; border-radius: 34%; pointer-events: none; background: var(--tex-hide) 0 0 / 9rem; mix-blend-mode: multiply; opacity: 0.45;
  box-shadow: inset 0 0 0.8rem rgba(80,46,16,0.75); }
.mm .notch { position: absolute; top: -0.05rem; left: 50%; width: 0; height: 0; transform: translateX(-50%); pointer-events: none;
  border-left: 0.45rem solid transparent; border-right: 0.45rem solid transparent; border-top: 0.6rem solid var(--ochre-hi); filter: drop-shadow(0 1px 0 #140b05) drop-shadow(0 0 1px #140b05); }
.mm .notch::after { content: 'N'; position: absolute; top: -0.62rem; left: -0.24rem; font: 800 0.5rem/1 var(--font); color: #2a1606; }
`);

/** How far (world units) the eye reaches over the curved horizon, for the view outline. */
const HORIZON_REACH = 72;
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

export class Minimap {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly terrain: HTMLCanvasElement;
  private terrainKey = '';
  private treeClock = 0;
  private repaintCooldown = 0;
  private frustum: Array<{ x: number; z: number }> = [];
  private frame = 0;
  private dragging = false;
  private pings: Array<{ x: number; z: number; t: number; color: string }> = [];
  private hoverTile: { x: number; z: number } | null = null;
  /** Wired by game-ui: right-click orders. */
  onOrder: ((x: number, z: number) => void) | null = null;

  constructor(private readonly ctx: UiContext) {
    this.el = h('div.mm.tg-panel');
    this.canvas = h('canvas', { 'aria-label': 'Minimap' });
    this.el.append(this.canvas, h('div.hide'), h('div.notch'));
    this.g = this.canvas.getContext('2d')!;
    this.terrain = document.createElement('canvas');
    this.terrain.width = this.terrain.height = WORLD_SIZE;

    const toTile = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * WORLD_SIZE, z: ((e.clientY - r.top) / r.height) * WORLD_SIZE };
    };
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      const t = toTile(e);
      if (e.button === 2 || (e.button === 0 && e.ctrlKey && !e.metaKey)) {
        this.onOrder?.(t.x, t.z);
        this.ping(t.x, t.z, 'info');
        return;
      }
      if (e.button !== 0) return;
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      lookAtTile(ctx.view.target, t.x, t.z);
    });
    // What's under the pointer on the map, for the tooltip: a standing stone says what it holds.
    this.canvas.addEventListener('pointermove', (e) => {
      this.hoverTile = toTile(e);
    });
    tip(this.canvas, () => this.tooltip());
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        const t = toTile(e);
        lookAtTile(ctx.view.target, t.x, t.z);
      }
    });
    this.canvas.addEventListener('pointerup', () => (this.dragging = false));
    this.canvas.addEventListener('pointercancel', () => (this.dragging = false));
  }

  private tooltip(): string {
    const w = this.ctx.world;
    const t = this.hoverTile;
    const idx = t ? w.monuments.findIndex((m) => Math.hypot(wrapDelta(m.x - t.x, WORLD_SIZE), wrapDelta(m.z - t.z, WORLD_SIZE)) < 5) : -1;
    if (idx >= 0) {
      const m = w.monuments[idx];
      const blocked = stoneBlocked(w, m);
      const r = ritualAt(w, idx);
      return `<div class="sub">Standing stone</div><h4>${spellIcon(m.spell, 18)}${escapeHtml(stoneName(m))}</h4><p>${escapeHtml(stoneTerms(m))}.</p>` +
        (r ? `<p>${escapeHtml(tribeLabelOf(w, r.tribe))} communing: ${Math.round(r.progress * 100)}%</p>` : '') +
        (blocked ? `<div class="why">${escapeHtml(blocked)}</div>` : '') + `<div class="hint">Click to look there.</div>`;
    }
    return `<h4>The planet</h4><p>Click or drag to look. Right-click (or Ctrl-click) to send your selection there.</p>`;
  }

  ping(x: number, z: number, tone: 'bad' | 'good' | 'info'): void {
    this.pings.push({ x, z, t: 0, color: tone === 'bad' ? '#ff6a5c' : tone === 'good' ? '#7fdc8c' : '#72d8ff' });
  }

  private resize(): number {
    const css = this.canvas.clientWidth || 200;
    const px = Math.round(css * Math.min(2, devicePixelRatio || 1));
    if (this.canvas.width !== px) this.canvas.width = this.canvas.height = px;
    return px;
  }

  /** Height + slope → the terrain palette, hill-shaded. One pixel per tile. */
  private paintTerrain(): void {
    const w = this.ctx.world;
    const map = w.map;
    const g = this.terrain.getContext('2d')!;
    const img = g.createImageData(WORLD_SIZE, WORLD_SIZE);
    const C = {
      deep: rgb(WATER.deep), mid: rgb(WATER.mid), shallow: rgb(WATER.shallow), sand: rgb(TERRAIN.sand), wet: rgb(TERRAIN.wetSand),
      lush: rgb(TERRAIN.grassLush2), lush2: rgb(TERRAIN.grassLush), dry: rgb(TERRAIN.grassDry), rock: rgb(TERRAIN.rock), snow: rgb(TERRAIN.snow),
      forest: rgb(TERRAIN.forestFloor),
    };
    const forest = new Uint8Array(WORLD_SIZE * WORLD_SIZE);
    for (const t of w.trees) if (t.alive) forest[map.wrap(Math.round(t.z)) * WORLD_SIZE + map.wrap(Math.round(t.x))] = 1;
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        const hgt = map.heightAt(x, z);
        let c: [number, number, number];
        if (hgt < 0) c = hgt < -3 ? mix(C.mid, C.deep, clamp01((-hgt - 3) / 4)) : mix(C.shallow, C.mid, clamp01(-hgt / 3));
        else if (hgt < TERRAIN.wetBand) c = C.wet;
        else if (hgt < TERRAIN.beachTop) c = C.sand;
        else if (hgt < TERRAIN.snowLine - 3) c = mix(C.lush, C.dry, clamp01((hgt - 4) / 6));
        else if (hgt < TERRAIN.snowLine) c = mix(C.dry, C.rock, clamp01((hgt - (TERRAIN.snowLine - 3)) / 3));
        else c = C.snow;
        if (hgt >= TERRAIN.beachTop) {
          const slope = Math.abs(map.heightAt(x + 1, z) - hgt) + Math.abs(map.heightAt(x, z + 1) - hgt);
          if (slope > 2.2) c = mix(c, C.rock, clamp01((slope - 2.2) / 2));
          if (forest[z * WORLD_SIZE + x]) c = mix(c, C.forest, 0.7);
        }
        // Hill-shade: light from the north-west.
        const shade = hgt >= 0 ? clamp01(1 + (map.heightAt(x - 1, z - 1) - hgt) * -0.09) : 1;
        const i = (z * WORLD_SIZE + x) * 4;
        img.data[i] = Math.min(255, c[0] * shade);
        img.data[i + 1] = Math.min(255, c[1] * shade);
        img.data[i + 2] = Math.min(255, c[2] * shade);
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  /** The ground the screen edges see, as wrapped-relative tile offsets from the view centre. */
  private computeFrustum(): void {
    const { camera, target, map } = this.ctx.view;
    const pts: Array<{ x: number; z: number }> = [];
    const W = innerWidth, H = innerHeight, n = 6;
    const edge: Array<[number, number]> = [];
    for (let i = 0; i <= n; i++) edge.push([(W * i) / n, 0]);
    for (let i = 1; i <= n; i++) edge.push([W, (H * i) / n]);
    for (let i = n - 1; i >= 0; i--) edge.push([(W * i) / n, H]);
    for (let i = n - 1; i >= 1; i--) edge.push([0, (H * i) / n]);
    const c = viewCentreTile(target);
    for (const [px, py] of edge) {
      let hit = pickGroundTile(px, py, camera as THREE.Camera, map, target);
      if (!hit) {
        // Looking at sky above the horizon: clamp to the visible ground's reach.
        ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
        ray.setFromCamera(ndc, camera as THREE.Camera);
        const d = ray.ray.direction;
        const len = Math.hypot(d.x, d.z) || 1;
        const reach = HORIZON_REACH / TILE;
        hit = { x: target.x / TILE + (d.x / len) * reach, z: target.z / TILE + (d.z / len) * reach };
      }
      pts.push({ x: c.x + wrapDelta(hit.x - c.x, WORLD_SIZE), z: c.z + wrapDelta(hit.z - c.z, WORLD_SIZE) });
    }
    this.frustum = pts;
  }

  update(dt: number): void {
    const w = this.ctx.world;
    const px = this.resize();
    const s = px / WORLD_SIZE;
    this.treeClock -= dt;
    const key = `${w.map.version}|${w.treesVersion}`;
    this.repaintCooldown -= dt;
    if ((key !== this.terrainKey && this.repaintCooldown <= 0) || this.treeClock <= 0) {
      this.repaintCooldown = 0.25; // terrain spells bump map.version every tick
      this.paintTerrain();
      this.terrainKey = key;
      this.treeClock = 4;
    }
    const g = this.g;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.terrain, 0, 0, px, px);

    // Standing stones: diamonds, bright when available.
    for (const m of w.monuments) {
      const avail = w.monumentAvailable(m);
      const r = 4.5 * (px / 200);
      g.save();
      g.translate(m.x * s, m.z * s);
      g.rotate(Math.PI / 4);
      g.fillStyle = avail ? '#ffe08a' : 'rgba(200,200,200,0.45)';
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.lineWidth = 1.2 * (px / 200);
      g.fillRect(-r / 2, -r / 2, r, r);
      g.strokeRect(-r / 2, -r / 2, r, r);
      g.restore();
    }

    // Buildings: tribe-coloured squares with a dark rim.
    for (const b of w.buildings) {
      const r = (b.size * 0.75 + 1) * s * 0.5;
      g.fillStyle = hex(TRIBE_COLORS[b.tribe]);
      g.globalAlpha = b.progress < 1 ? 0.55 : 1;
      g.fillRect(b.x * s - r, b.z * s - r, r * 2, r * 2);
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 1;
      g.strokeRect(b.x * s - r, b.z * s - r, r * 2, r * 2);
    }

    // People: dots. Selected ones ringed in gold.
    const dot = Math.max(1.6, 1.4 * (px / 200));
    for (const u of w.units) {
      if (u.hidden) continue;
      const leader = u.kind === 'shaman';
      g.fillStyle = hex(TRIBE_COLORS[u.tribe]);
      const r = leader ? dot * 1.9 : dot;
      g.beginPath();
      g.arc(u.x * s, u.z * s, r, 0, Math.PI * 2);
      g.fill();
      if (leader || this.ctx.selection.units.has(u.id)) {
        g.strokeStyle = this.ctx.selection.units.has(u.id) ? '#f4c66a' : 'rgba(255,255,255,0.9)';
        g.lineWidth = 1.2;
        g.stroke();
      }
    }

    // Pings.
    this.pings = this.pings.filter((p) => (p.t += dt) < 2.2);
    for (const p of this.pings) {
      const k = (p.t % 1.1) / 1.1;
      g.strokeStyle = p.color;
      g.globalAlpha = 1 - k;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p.x * s, p.z * s, (4 + k * 18) * (px / 200), 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    }

    // The camera's view.
    if (this.frame++ % 3 === 0) this.computeFrustum();
    if (this.frustum.length > 2) {
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.lineWidth = 1.5 * (px / 200);
      g.lineJoin = 'round';
      for (const ox of [-WORLD_SIZE, 0, WORLD_SIZE]) {
        for (const oz of [-WORLD_SIZE, 0, WORLD_SIZE]) {
          g.beginPath();
          this.frustum.forEach((p, i) => (i ? g.lineTo((p.x + ox) * s, (p.z + oz) * s) : g.moveTo((p.x + ox) * s, (p.z + oz) * s)));
          g.closePath();
          g.fill();
          g.stroke();
        }
      }
    } else {
      const c = viewCentreTile(this.ctx.view.target);
      g.strokeStyle = '#fff';
      g.strokeRect(c.x * s - 6, c.z * s - 6, 12, 12);
    }
  }
}
