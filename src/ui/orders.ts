/**
 * ui/orders.ts — selecting things and telling your people what to do.
 *
 * The input grammar:
 *
 *   click            select YOUR person / building, or a standing stone;
 *                    a wanderer or a rival only opens a read-only card
 *                    (Selection.inspect) — they are never yours to order
 *   shift-click      add a person to the selection, or take them out
 *   double-click     everyone of that kind (yours) on screen
 *   drag             an area ON THE LAND (ui/marquee.ts): your people
 *                    inside it (shift adds, or removes if all were in)
 *   right-click      the CONTEXT ORDER for whatever is under the cursor
 *   left-click       ALSO the context order, when your people are selected
 *                    and the click isn't on one of your own people or
 *                    buildings (Settings → "Left-click orders", on by
 *                    default: on a trackpad, right-clicking is a chore)
 *
 * On a Mac, Ctrl+click and a two-finger tap arrive as `contextmenu` with or
 * without a button-2 press; both count as right-click, and the browser's
 * own menu never opens over the game.
 *
 * The context order is decided once, by contextAt(), and used three ways:
 * the hover cursor (so you know what a click will do before you do it), the
 * right-click, and the left-click. Orders:
 *
 *   move · attack a person · attack a building · garrison a watchtower or
 *   send villagers to pray at a shrine · commune at a standing stone
 *   (the leader; anyone else selected escorts) · set a rally point
 *
 * Every accepted order paints a marker on the ground where it lands, with a
 * one-word acknowledgement; a refused one paints a red cross and says why.
 *
 * Two "where is it?" problems, solved opposite ways: CLICKS cast a ray into
 * the curved ground (render/ground-picker.ts) and also test silhouettes in
 * screen space (ui/picking.ts) so a click on a roof, a head or a tall stone
 * hits the thing you see; DRAGS are laid on the ground (ui/marquee.ts).
 */

import { denied, orderAck } from '../core/audio';
import { WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { pickGroundTile } from '../render/ground-picker';
import { BUILDINGS, TRIBE_COLORS } from '../sim/catalog';
import { ATTACK_PICK_RADIUS, Building, Unit } from '../sim/world-state';
import { appState } from './app-state';
import { UiContext } from './context';
import { css, h, worldLayer } from './dom';
import { Drape } from './drape';
import { UI_ICONS } from './icons';
import { GroundMarquee, inGroundQuad, quadArea } from './marquee';
import { monumentAtScreen, pickAtScreen } from './picking';
import { tileDist, toScreen } from './project';
import { mergeIds } from './selection';
import { settings } from './settings';
import { toolState } from './tools';
import { toast } from './tooltip';

/** Drags shorter than this (px) count as clicks. */
const CLICK_SLOP = 5;
/** Click-select forgiveness, in tiles. */
const PICK_RADIUS = 1.6;
const DOUBLE_CLICK_MS = 380;
/** A contextmenu this soon after a right-press we already handled is the same click. */
const CONTEXT_DEDUPE_MS = 400;

export type OrderKind = 'move' | 'attack' | 'attackBuilding' | 'garrison' | 'worship' | 'rally' | 'none';

export interface OrderContext {
  kind: OrderKind;
  unit?: Unit;
  building?: Building;
  monument?: number;
  x: number;
  z: number;
}

css('orders', `
.order-word { position: fixed; z-index: 4; pointer-events: none; transform: translate(-50%, -100%); white-space: nowrap;
  padding: 0.14rem 0.45rem 0.18rem; border-radius: 0.2rem 0.35rem 0.25rem 0.4rem; font: 700 var(--t-xs)/1 var(--font-display);
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--bone, #f3e6c8);
  background: var(--bark-face, #3b2618); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.45);
  animation: order-word 900ms var(--ease) forwards; }
.order-word.bad { background: #5a1d14; color: #ffd8cf; }
@keyframes order-word { 0% { opacity: 0; margin-top: 6px; } 15% { opacity: 1; margin-top: 0; } 70% { opacity: 1; } 100% { opacity: 0; margin-top: -10px; } }
`);

/** Paint colours for each order (also the cursor and the ground marker). */
const ORDER_COLORS: Record<OrderKind, number> = {
  move: 0xf2d27a, attack: 0xff6a4d, attackBuilding: 0xff6a4d, garrison: 0x7fe0e8, worship: 0x7fe0e8, rally: 0xf2d27a, none: 0xffffff,
};
const ORDER_WORDS: Record<Exclude<OrderKind, 'none'>, string> = {
  move: 'Go', attack: 'Attack', attackBuilding: 'Attack', garrison: 'In', worship: 'Commune', rally: 'Rally',
};
const CURSOR_ICON: Record<Exclude<OrderKind, 'none'>, keyof typeof UI_ICONS> = {
  move: 'move', attack: 'attack', attackBuilding: 'attackBuilding', garrison: 'garrison', worship: 'worship', rally: 'rally',
};
const hex6 = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** A CSS cursor built from an icon: a carved stone disc with the icon painted on it. */
function cursorCss(kind: OrderKind): string {
  if (kind === 'none') return '';
  const inner = UI_ICONS[CURSOR_ICON[kind]];
  const c = hex6(ORDER_COLORS[kind]);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<path d="M16 2.2l9.6 3.6 4.2 9.4-3.4 10-10.4 4.6-10.2-4.4L2.3 15.6l4.3-9.9z" fill="#3a2a1d" stroke="#140c06" stroke-width="1.6"/>` +
    `<path d="M16 4.4l8 3 3.6 8-2.9 8.4L16 27.6 7.4 23.8 4.6 15.6l3.6-8.2z" fill="none" stroke="rgba(255,226,180,0.28)" stroke-width="1"/>` +
    `<g transform="translate(5 5) scale(0.9167)" fill="none" stroke="${c}" color="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, pointer`;
}
const CURSORS = Object.fromEntries((Object.keys(ORDER_COLORS) as OrderKind[]).map((k) => [k, cursorCss(k)])) as Record<OrderKind, string>;

interface Mark {
  kind: OrderKind | 'refused';
  x: number;
  z: number;
  born: number;
  word: HTMLDivElement | null;
}
const MARK_MS = 900;

export class OrderControl {
  private dragStart: { x: number; y: number } | null = null;
  private dragging = false;
  private readonly marquee: GroundMarquee;
  private readonly markDrape: Drape;
  private lastClick: { t: number; kind: string; tribe: string } | null = null;
  private hoverTimer = 0;
  private marks: Mark[] = [];
  private lastRightPress = 0;
  /** Your people inside the area being dragged (the overlay rings them). */
  readonly preview = new Set<number>();

  constructor(private readonly ctx: UiContext) {
    this.marquee = new GroundMarquee(ctx.scene);
    this.markDrape = new Drape(ctx.scene, 0.95, 3000, 22);
    const canvas = ctx.canvas;

    // The browser's context menu never opens over the game (canvas or HUD).
    addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement;
      if (t === canvas || t.closest?.('#ui, .menu, .tgc-overlay, .lib')) e.preventDefault();
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // A two-finger tap (or Ctrl+click) that never sent a button-2 press.
      if (appState.mode !== 'game' || performance.now() - this.lastRightPress < CONTEXT_DEDUPE_MS) return;
      this.rightClick(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (appState.mode !== 'game') return;
      const secondary = e.button === 2 || (e.button === 0 && e.ctrlKey && !e.metaKey);
      if (secondary) {
        this.lastRightPress = performance.now();
        this.rightClick(e.clientX, e.clientY);
      } else if (e.button === 0 && toolState.tool === 'select') {
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.dragging = false;
      }
    });

    addEventListener('pointermove', (e) => {
      if (!this.dragStart) return;
      if (!this.dragging && Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y) > CLICK_SLOP) this.dragging = true;
      if (this.dragging) this.drawDrag(e.clientX, e.clientY);
    });

    addEventListener('pointercancel', () => this.endDrag());
    addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.dragStart) return;
      const wasDrag = this.dragging;
      const q = wasDrag ? this.marquee.quad : null;
      this.endDrag();
      if (!wasDrag) this.clickSelect(e.clientX, e.clientY, e.shiftKey);
      else if (q && quadArea(q) > 0.5) this.boxSelect(q, e.shiftKey);
      else this.clickSelect(e.clientX, e.clientY, e.shiftKey);
    });
  }

  private endDrag(): void {
    this.dragStart = null;
    this.dragging = false;
    this.marquee.hide();
    this.preview.clear();
  }

  private rightClick(px: number, py: number): void {
    if (toolState.tool !== 'select') this.ctx.actions.cancelTool();
    else this.orderAtScreen(px, py);
  }

  // -------------------------------------------------------------------------
  // Picking

  private groundTile(px: number, py: number): { x: number; z: number } | null {
    return pickGroundTile(px, py, this.ctx.view.camera, this.ctx.world.map, this.ctx.view.target);
  }

  /** Nearest visible unit to a tile within `r`, optionally filtered. */
  private unitNear(x: number, z: number, r: number, pred: (u: Unit) => boolean): Unit | null {
    let best: Unit | null = null;
    let bestD = r;
    for (const u of this.ctx.world.units) {
      if (u.hidden || !pred(u)) continue;
      const d = tileDist(u.x, u.z, x, z);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** The building whose footprint covers this tile. */
  buildingAt(x: number, z: number): Building | null {
    for (const b of this.ctx.world.buildings) {
      const half = b.size / 2;
      if (Math.abs(wrapDelta(x - b.x, WORLD_SIZE)) <= half && Math.abs(wrapDelta(z - b.z, WORLD_SIZE)) <= half) return b;
    }
    return null;
  }

  /**
   * What the player SEES under the cursor: a person or a building, whichever
   * silhouette is in front (ui/picking.ts). Only when no silhouette is under
   * the cursor do we fall back to "someone near the ground tile the ray
   * hit" — over a wall that tile is behind or inside the building, and the
   * fallback would select whoever happens to stand there.
   */
  private pickAt(px: number, py: number, tile: { x: number; z: number } | null, pred: (u: Unit) => boolean): { unit: Unit | null; building: Building | null } {
    const view = this.ctx.view;
    const w = this.ctx.world;
    const preferred = pickAtScreen(view, w.units, w.buildings, px, py, pred);
    if (preferred.unit) return preferred;
    const anyone = pickAtScreen(view, w.units, w.buildings, px, py, () => true);
    if (anyone.unit || anyone.building || !tile) return anyone;
    return { unit: this.unitNear(tile.x, tile.z, PICK_RADIUS, pred) ?? this.unitNear(tile.x, tile.z, PICK_RADIUS, () => true), building: null };
  }

  private monumentAt(x: number, z: number): number {
    return this.ctx.world.monuments.findIndex((m) => tileDist(m.x, m.z, x, z) < 2.2);
  }

  /** The stone drawn under the cursor, or the one at the ground tile. */
  private stoneUnder(px: number, py: number, tile: { x: number; z: number } | null): number {
    const m = monumentAtScreen(this.ctx.view, this.ctx.world.monuments, px, py);
    if (m >= 0) return m;
    return tile ? this.monumentAt(tile.x, tile.z) : -1;
  }

  /** What a left click at (px, py) would pick (automation and debugging read this; same rule as clickSelect). */
  whatIsUnder(px: number, py: number): { unit: number | null; building: number | null; monument: number | null } {
    const tile = this.groundTile(px, py);
    const hit = this.pickAt(px, py, tile, (u) => u.tribe === 'player');
    const building = hit.building?.id ?? (hit.unit || !tile ? null : this.buildingAt(tile.x, tile.z)?.id ?? null);
    const m = hit.unit || building !== null ? -1 : this.stoneUnder(px, py, tile);
    return { unit: hit.unit?.id ?? null, building, monument: m >= 0 ? m : null };
  }

  /** If set and it returns true, a left click on the ground was consumed (e.g. picking a rally point). */
  intercept: ((x: number, z: number) => boolean) | null = null;

  /** Your own people currently selected. */
  private ownSelected(): number[] {
    const w = this.ctx.world;
    return [...this.ctx.selection.units].filter((id) => w.unitById(id)?.tribe === 'player');
  }

  private clickSelect(px: number, py: number, shift: boolean): void {
    const sel = this.ctx.selection;
    const w = this.ctx.world;
    const tile = this.groundTile(px, py);
    if (tile && this.intercept?.(tile.x, tile.z)) return;
    // With your people selected, a plain click on anything that isn't yours
    // is an order (the setting can turn this off).
    const orders = settings.leftClickOrders && !shift && this.ownSelected().length > 0;
    // Screen-space picks first (a roof against the sky has no ground tile behind it).
    // Your own people win over anyone else's under the same pixel.
    const hit = this.pickAt(px, py, tile, (u) => u.tribe === 'player');
    const any = hit.unit;
    const roof = hit.building;
    const now = performance.now();

    if (any) {
      if (any.tribe !== 'player') {
        this.lastClick = null;
        if (orders) return void this.orderAt(any.x, any.z, { px, py });
        sel.inspectUnit(any.id); // wanderers & rivals: a read-only card, never a selection
        return;
      }
      // Double-click: everyone of that kind (yours) on screen.
      const dbl = this.lastClick && now - this.lastClick.t < DOUBLE_CLICK_MS && this.lastClick.kind === any.kind;
      this.lastClick = { t: now, kind: any.kind, tribe: any.tribe };
      if (dbl) {
        sel.setUnits(this.unitsOnScreen((u) => u.tribe === 'player' && u.kind === any.kind).map((u) => u.id), shift ? 'add' : 'replace');
        return;
      }
      sel.setUnits([any.id], shift && sel.units.size > 0 ? 'toggle' : 'replace');
      return;
    }
    this.lastClick = null;
    const b = roof ?? (tile ? this.buildingAt(tile.x, tile.z) : null);
    if (b) {
      if (b.tribe !== 'player' && orders && this.contextAt(b.x, b.z).kind !== 'none') return void this.orderAt(b.x, b.z, { px, py });
      return sel.setBuilding(b.id);
    }
    const m = this.stoneUnder(px, py, tile);
    if (m >= 0) {
      const stone = w.monuments[m];
      // The leader selected + a stone = go and commune (the primary route).
      if (orders && this.contextAt(stone.x, stone.z).kind === 'worship') return void this.orderAt(stone.x, stone.z, { px, py });
      return sel.setMonument(m);
    }
    if (!tile) {
      // Sky: nothing sensible to do there.
      if (!shift) sel.clear();
      return;
    }
    if (orders) return void this.orderAt(tile.x, tile.z, { px, py });
    if (!shift) sel.clear();
  }

  private unitsOnScreen(pred: (u: Unit) => boolean): Unit[] {
    const out: Unit[] = [];
    for (const u of this.ctx.world.units) {
      if (u.hidden || !pred(u)) continue;
      const p = toScreen(this.ctx.view, u.x, u.z, 1);
      if (p && p.x >= 0 && p.x <= innerWidth && p.y >= 0 && p.y <= innerHeight) out.push(u);
    }
    return out;
  }

  /** Your people standing inside a ground quad. */
  private unitsInQuad(q: ReturnType<GroundMarquee['update']>): Unit[] {
    if (!q) return [];
    return this.ctx.world.units.filter((u) => u.tribe === 'player' && !u.hidden && inGroundQuad(u, q));
  }

  private drawDrag(px: number, py: number): void {
    const q = this.marquee.update(this.ctx.view, this.dragStart!, { x: px, y: py }, 0xf2d27a);
    this.preview.clear();
    for (const u of this.unitsInQuad(q)) this.preview.add(u.id);
  }

  private boxSelect(q: NonNullable<GroundMarquee['quad']>, shift: boolean): void {
    const ids = this.unitsInQuad(q).map((u) => u.id);
    const sel = this.ctx.selection;
    if (!shift) return sel.setUnits(ids);
    if (ids.length === 0) return;
    // Shift: add them — or, if every one was already selected, take them out.
    const next = new Set(sel.units);
    mergeIds(next, ids, 'toggle');
    sel.setUnits(next);
  }

  // -------------------------------------------------------------------------
  // Orders

  /** What an order at this tile would do with the current selection. */
  contextAt(x: number, z: number): OrderContext {
    const w = this.ctx.world;
    const sel = this.ctx.selection;
    if (sel.building !== null) {
      const b = w.getBuilding(sel.building);
      if (b && b.tribe === 'player' && BUILDINGS[b.kind].trains) return { kind: 'rally', building: b, x, z };
      return { kind: 'none', x, z };
    }
    const mine = this.ownSelected().map((id) => w.unitById(id)!);
    if (mine.length === 0) return { kind: 'none', x, z };

    const enemy = this.unitNear(x, z, ATTACK_PICK_RADIUS, (u) => w.hostile('player', u.tribe));
    if (enemy) return { kind: 'attack', unit: enemy, x, z };
    const b = this.buildingAt(x, z);
    if (b) {
      if (w.hostile('player', b.tribe)) return { kind: 'attackBuilding', building: b, x, z };
      // The sim decides (room, completion, who fits) — a full tower doesn't promise a garrison.
      if (b.tribe === 'player' && w.canGarrison(mine.map((u) => u.id), b.id)) return { kind: 'garrison', building: b, x, z };
    }
    const m = this.monumentAt(x, z);
    if (m >= 0 && mine.some((u) => u.kind === 'shaman') && w.monumentAvailable(w.monuments[m])) {
      return { kind: 'worship', monument: m, x, z };
    }
    return { kind: 'move', x, z };
  }

  orderAtScreen(px: number, py: number): void {
    const tile = this.groundTile(px, py);
    const w = this.ctx.world;
    // Aim at what is drawn under the cursor: an enemy's body, a roof, a stone.
    const hit = pickAtScreen(this.ctx.view, w.units, w.buildings, px, py, (u) => w.hostile('player', u.tribe));
    if (hit.unit) return void this.orderAt(hit.unit.x, hit.unit.z, { px, py });
    if (hit.building) return void this.orderAt(hit.building.x, hit.building.z, { px, py });
    const m = monumentAtScreen(this.ctx.view, w.monuments, px, py);
    if (m >= 0) return void this.orderAt(w.monuments[m].x, w.monuments[m].z, { px, py });
    if (tile) return void this.orderAt(tile.x, tile.z, { px, py });
    // Sky, or nothing under the cursor at all: say so instead of doing nothing silently.
    if (this.hasCommand()) this.refuse('Can’t go there', px, py, null);
  }

  /** Something is selected that an order would command. */
  private hasCommand(): boolean {
    const sel = this.ctx.selection;
    if (sel.building !== null) return this.ctx.world.getBuilding(sel.building)?.tribe === 'player';
    return this.ownSelected().length > 0;
  }

  /** Issue the context order at a tile (also used by the minimap). Returns whether it was accepted. */
  orderAt(x: number, z: number, at?: { px: number; py: number }): boolean {
    const w = this.ctx.world;
    const c = this.contextAt(x, z);
    const ids = this.ownSelected();
    const before = w.events.length;
    const refusedHere = () => w.events.slice(before).some((e) => e.type === 'denied');
    switch (c.kind) {
      case 'none':
        if (this.hasCommand()) this.refuse('Nothing to do there', at?.px, at?.py, { x, z });
        return false;
      case 'rally':
        w.setRally(c.building!.id, x, z);
        break;
      case 'attack':
        w.orderAttack(ids, c.unit!.id);
        break;
      case 'attackBuilding':
        w.orderAttackBuilding(ids, c.building!.id);
        break;
      case 'garrison':
        // Whoever can't go in (wrong kind, no room) walks to the door; the sim cues 'denied'.
        if (w.orderGarrison(ids, c.building!.id).accepted.length === 0) {
          this.refuse('No room inside', at?.px, at?.py, { x: c.building!.x, z: c.building!.z }, true);
          return false;
        }
        break;
      case 'worship': {
        const m = w.monuments[c.monument!];
        w.orderWorship(ids, c.monument!);
        const escorts = ids.filter((id) => w.unitById(id)?.kind !== 'shaman');
        if (escorts.length) w.orderMove(escorts, m.x, m.z + 3);
        break;
      }
      case 'move':
        w.orderMove(ids, x, z);
        if (refusedHere() && ids.every((id) => w.unitById(id)?.state !== 'moving')) {
          this.refuse('Can’t go there', at?.px, at?.py, { x, z }, true);
          return false;
        }
        break;
    }
    this.mark(c.kind, c.unit?.x ?? c.building?.x ?? x, c.unit?.z ?? c.building?.z ?? z);
    orderAck(c.kind === 'attack' || c.kind === 'attackBuilding' ? 'attack' : c.kind === 'garrison' || c.kind === 'worship' ? 'garrison' : 'move');
    return true;
  }

  /** A refused order: red cross on the ground, the reason by the cursor, the 'no' sound. */
  private refuse(why: string, px: number | undefined, py: number | undefined, tile: { x: number; z: number } | null, simCued = false): void {
    if (!simCued) denied();
    if (tile) this.mark('refused', tile.x, tile.z);
    if (px !== undefined && py !== undefined) toast(why, px, py);
  }

  private mark(kind: Mark['kind'], x: number, z: number): void {
    let word: HTMLDivElement | null = null;
    if (kind !== 'none') {
      word = h('div', { class: `order-word${kind === 'refused' ? ' bad' : ''}`, text: kind === 'refused' ? '✕' : ORDER_WORDS[kind] });
      worldLayer().appendChild(word);
    }
    this.marks.push({ kind, x, z, born: performance.now(), word });
    // Only the newest few: a flurry of clicks shouldn't carpet the ground.
    while (this.marks.length > 4) this.marks.shift()!.word?.remove();
  }

  /** Per frame: ground markers, and (throttled) what's under the cursor. */
  update(dt: number): void {
    const now = performance.now();
    const view = this.ctx.view;
    this.marks = this.marks.filter((m) => {
      if (now - m.born > MARK_MS) {
        m.word?.remove();
        return false;
      }
      return true;
    });
    this.markDrape.begin(0xffffff);
    for (const m of this.marks) {
      const k = (now - m.born) / MARK_MS; // 0 → 1
      if (m.kind === 'refused') {
        this.markDrape.color(0xff4a3a);
        const s = 1.1;
        this.markDrape.band(view, m.x - s, m.z - s, m.x + s, m.z + s, 0.2);
        this.markDrape.band(view, m.x - s, m.z + s, m.x + s, m.z - s, 0.2);
      } else {
        this.markDrape.color(ORDER_COLORS[m.kind]);
        // Two rings closing in on the spot, and a steady centre stake.
        const r = 2.2 * (1 - k) + 0.5;
        this.markDrape.ring(view, m.x, m.z, r - 0.18, r, 0);
        if (k < 0.6) this.markDrape.ring(view, m.x, m.z, r * 0.55 - 0.14, r * 0.55, 0);
        this.markDrape.disc(view, m.x, m.z, 0.28);
      }
      if (m.word) {
        const p = toScreen(view, m.x, m.z, 1.4);
        if (p) {
          m.word.style.left = `${p.x}px`;
          m.word.style.top = `${p.y}px`;
        }
      }
    }
    this.markDrape.end();

    this.hoverTimer -= dt;
    if (this.hoverTimer > 0) return;
    this.hoverTimer = 0.08;
    const ptr = this.ctx.pointer;
    let cursor = '';
    const hover = this.ctx.hover;
    hover.unit = null;
    hover.building = null;
    hover.monument = null;
    let tile: { x: number; z: number } | null = null;
    if (appState.mode === 'game' && ptr.onCanvas && !this.dragging) {
      tile = this.groundTile(ptr.x, ptr.y);
      const hit = this.pickAt(ptr.x, ptr.y, tile, () => true);
      hover.unit = hit.unit?.id ?? null;
      if (hover.unit === null) hover.building = (hit.building ?? (tile ? this.buildingAt(tile.x, tile.z) : null))?.id ?? null;
      if (hover.unit === null && hover.building === null) {
        const m = this.stoneUnder(ptr.x, ptr.y, tile);
        hover.monument = m >= 0 ? m : null;
      }
    }
    if (appState.mode === 'game' && ptr.onCanvas && toolState.tool === 'select' && !this.dragging) {
      const hu = hover.unit !== null ? this.ctx.world.unitById(hover.unit) : null;
      const hb = hover.building !== null ? this.ctx.world.getBuilding(hover.building) : null;
      const hm = hover.monument !== null ? this.ctx.world.monuments[hover.monument] : null;
      // A roof against the sky has no ground tile under the cursor, but is still a target.
      const at = hu ?? hb ?? hm ?? tile;
      if (at) {
        const c = this.contextAt(at.x, at.z);
        const own = (hu && hu.tribe === 'player') || (hb && hb.tribe === 'player');
        // With left-click orders on, a click on your own person or building
        // selects it, so the cursor says "select" (the tooltip names the right-click order).
        if (c.kind === 'none' || c.kind === 'move' || (own && settings.leftClickOrders)) {
          // Plain pointer over something clickable reads as "select".
          cursor = hu || hb || hm ? 'pointer' : c.kind === 'move' ? CURSORS.move : '';
        } else cursor = CURSORS[c.kind];
      }
    } else if (appState.mode === 'game' && toolState.tool !== 'select') cursor = 'crosshair';
    if (this.ctx.canvas.style.cursor !== cursor) this.ctx.canvas.style.cursor = cursor;
  }
}

/** Tribe colour as CSS (for portraits, minimap dots, labels). */
export function tribeCss(tribe: string): string {
  const c = TRIBE_COLORS[tribe as keyof typeof TRIBE_COLORS] ?? 0xffffff;
  return `#${c.toString(16).padStart(6, '0')}`;
}
