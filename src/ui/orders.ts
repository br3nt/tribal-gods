/**
 * ui/orders.ts — selecting things and telling your people what to do.
 *
 * The RTS input grammar, because it works:
 *
 *   click            select the person / building / standing stone under it
 *   shift-click      add a person to the selection, or take them out
 *   double-click     everyone of that kind on screen
 *   drag a box       every one of your people inside it (shift adds)
 *   right-click      the CONTEXT ORDER for whatever is under the cursor
 *
 * The context order is decided once, by contextAt(), and used twice: to
 * pick the cursor while hovering (so you know what a right-click will do
 * before you do it) and to issue the order on the click. Orders:
 *
 *   move · attack a person · attack a building · garrison a watchtower or
 *   send villagers to pray at a shrine · commune at a standing stone
 *   (leader) · set a training building's rally point
 *
 * Each issued order leaves a short-lived marker on the ground.
 *
 * Two "where is it?" problems, solved opposite ways: CLICKS cast a ray
 * into the curved ground (render/ground-picker.ts) and search near that
 * tile; BOXES project each unit out to screen pixels (ui/project.ts).
 */

import { WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { pickGroundTile } from '../render/ground-picker';
import { BUILDINGS, TRIBE_COLORS, UNITS } from '../sim/catalog';
import { ATTACK_PICK_RADIUS, Building, Unit } from '../sim/world-state';
import { appState } from './app-state';
import { UiContext } from './context';
import { css, h, uiRoot } from './dom';
import { UI_ICONS } from './icons';
import { tileDist, toScreen } from './project';
import { toolState } from './tools';

/** Drags shorter than this (px) count as clicks. */
const CLICK_SLOP = 5;
/** Click-select forgiveness, in tiles. */
const PICK_RADIUS = 1.6;
const DOUBLE_CLICK_MS = 380;

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
.order-mark { position: fixed; z-index: 4; width: 2.25rem; height: 2.25rem; margin: -1.125rem 0 0 -1.125rem; pointer-events: none;
  border-radius: 50%; border: 2px solid var(--gold); transform: scaleY(0.45); animation: order-mark 700ms var(--ease) forwards; }
.order-mark.attack, .order-mark.attackBuilding { border-color: var(--bad); }
.order-mark.garrison, .order-mark.worship { border-color: var(--mana); }
@keyframes order-mark { 0% { opacity: 1; transform: scaleY(0.45) scale(1.5); } 100% { opacity: 0; transform: scaleY(0.45) scale(0.4); } }
`);

const CURSOR_COLORS: Record<OrderKind, string> = {
  move: '#f4c66a', attack: '#ff6a5c', attackBuilding: '#ff6a5c', garrison: '#72d8ff', worship: '#72d8ff', rally: '#f4c66a', none: '#ffffff',
};
const CURSOR_ICON: Record<Exclude<OrderKind, 'none'>, keyof typeof UI_ICONS> = {
  move: 'move', attack: 'attack', attackBuilding: 'attackBuilding', garrison: 'garrison', worship: 'worship', rally: 'rally',
};

/** A CSS cursor built from an icon: a dark disc with the icon in colour. */
function cursorCss(kind: OrderKind): string {
  if (kind === 'none') return '';
  const inner = UI_ICONS[CURSOR_ICON[kind]];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="16" r="14" fill="rgba(12,16,24,0.82)" stroke="rgba(255,255,255,0.35)"/>` +
    `<g transform="translate(5 5) scale(0.9167)" fill="none" stroke="${CURSOR_COLORS[kind]}" color="${CURSOR_COLORS[kind]}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, pointer`;
}
const CURSORS = Object.fromEntries((Object.keys(CURSOR_COLORS) as OrderKind[]).map((k) => [k, cursorCss(k)])) as Record<OrderKind, string>;

export class OrderControl {
  private dragStart: { x: number; y: number } | null = null;
  private readonly marquee: HTMLDivElement;
  private lastClick: { t: number; kind: string; tribe: string } | null = null;
  private hoverTimer = 0;
  private marks: Array<{ el: HTMLDivElement; x: number; z: number; until: number }> = [];

  constructor(private readonly ctx: UiContext) {
    this.marquee = h('div.tg-marquee');
    this.marquee.hidden = true;
    uiRoot().appendChild(this.marquee);
    const canvas = ctx.canvas;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (appState.mode !== 'game') return;
      if (e.button === 0 && toolState.tool === 'select') {
        this.dragStart = { x: e.clientX, y: e.clientY };
      } else if (e.button === 2) {
        if (toolState.tool !== 'select') ctx.actions.cancelTool();
        else this.orderAtScreen(e.clientX, e.clientY);
      }
    });

    addEventListener('pointermove', (e) => {
      if (!this.dragStart) return;
      const r = this.dragRect(e.clientX, e.clientY);
      if (Math.max(r.w, r.h) > CLICK_SLOP) {
        this.marquee.hidden = false;
        Object.assign(this.marquee.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      }
    });

    addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.dragStart) return;
      const r = this.dragRect(e.clientX, e.clientY);
      this.marquee.hidden = true;
      this.dragStart = null;
      if (Math.max(r.w, r.h) <= CLICK_SLOP) this.clickSelect(e.clientX, e.clientY, e.shiftKey);
      else this.boxSelect(r, e.shiftKey);
    });
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

  private monumentAt(x: number, z: number): number {
    return this.ctx.world.monuments.findIndex((m) => tileDist(m.x, m.z, x, z) < 2.2);
  }

  /** If set and it returns true, a left click on the ground was consumed (e.g. picking a rally point). */
  intercept: ((x: number, z: number) => boolean) | null = null;

  private clickSelect(px: number, py: number, shift: boolean): void {
    const sel = this.ctx.selection;
    const tile = this.groundTile(px, py);
    if (tile && this.intercept?.(tile.x, tile.z)) return;
    if (!tile) {
      if (!shift) sel.clear();
      return;
    }
    const own = this.unitNear(tile.x, tile.z, PICK_RADIUS, (u) => u.tribe === 'player');
    const any = own ?? this.unitNear(tile.x, tile.z, PICK_RADIUS, () => true);
    const now = performance.now();

    if (any) {
      // Double-click: everyone of that kind (yours) on screen.
      const dbl = this.lastClick && now - this.lastClick.t < DOUBLE_CLICK_MS && this.lastClick.kind === any.kind && any.tribe === 'player';
      this.lastClick = { t: now, kind: any.kind, tribe: any.tribe };
      if (dbl) {
        sel.setUnits(this.unitsOnScreen((u) => u.tribe === 'player' && u.kind === any.kind).map((u) => u.id), shift ? 'add' : 'replace');
        return;
      }
      if (any.tribe !== 'player') {
        sel.setUnits([any.id]); // enemies & wanderers: read-only, alone
        return;
      }
      // Shift on a selection that's currently your units: toggle in/out.
      const ownSelection = [...sel.units].every((id) => this.ctx.world.unitById(id)?.tribe === 'player');
      sel.setUnits([any.id], shift && ownSelection ? 'toggle' : 'replace');
      return;
    }
    this.lastClick = null;
    const b = this.buildingAt(tile.x, tile.z);
    if (b) return sel.setBuilding(b.id);
    const m = this.monumentAt(tile.x, tile.z);
    if (m >= 0) return sel.setMonument(m);
    if (!shift) sel.clear();
  }

  private unitsOnScreen(pred: (u: Unit) => boolean, rect?: { x: number; y: number; w: number; h: number }): Unit[] {
    const out: Unit[] = [];
    const r = rect ?? { x: 0, y: 0, w: innerWidth, h: innerHeight };
    for (const u of this.ctx.world.units) {
      if (u.hidden || !pred(u)) continue;
      const p = toScreen(this.ctx.view, u.x, u.z, UNITS[u.kind].height * 0.45);
      if (p && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) out.push(u);
    }
    return out;
  }

  private boxSelect(r: { x: number; y: number; w: number; h: number }, shift: boolean): void {
    const ids = this.unitsOnScreen((u) => u.tribe === 'player', r).map((u) => u.id);
    if (ids.length === 0 && shift) return;
    this.ctx.selection.setUnits(ids, shift ? 'add' : 'replace');
  }

  // -------------------------------------------------------------------------
  // Orders

  /** What a right-click at this tile would do with the current selection. */
  contextAt(x: number, z: number): OrderContext {
    const w = this.ctx.world;
    const sel = this.ctx.selection;
    if (sel.building !== null) {
      const b = w.getBuilding(sel.building);
      if (b && b.tribe === 'player' && BUILDINGS[b.kind].trains) return { kind: 'rally', building: b, x, z };
      return { kind: 'none', x, z };
    }
    const mine = [...sel.units].map((id) => w.unitById(id)).filter((u): u is Unit => !!u && u.tribe === 'player');
    if (mine.length === 0) return { kind: 'none', x, z };

    const enemy = this.unitNear(x, z, ATTACK_PICK_RADIUS, (u) => w.hostile('player', u.tribe));
    if (enemy) return { kind: 'attack', unit: enemy, x, z };
    const b = this.buildingAt(x, z);
    if (b) {
      if (w.hostile('player', b.tribe)) return { kind: 'attackBuilding', building: b, x, z };
      if (b.tribe === 'player' && b.progress >= 1) {
        const fits = b.kind === 'tower'
          ? mine.some((u) => UNITS[u.kind].dmg > 0 && UNITS[u.kind].sight > 0)
          : b.kind === 'shrine'
            ? mine.some((u) => u.kind === 'brave')
            : false;
        if (fits) return { kind: 'garrison', building: b, x, z };
      }
    }
    const m = this.monumentAt(x, z);
    if (m >= 0 && mine.some((u) => u.kind === 'shaman') && w.monumentAvailable(w.monuments[m])) {
      return { kind: 'worship', monument: m, x, z };
    }
    return { kind: 'move', x, z };
  }

  orderAtScreen(px: number, py: number): void {
    const tile = this.groundTile(px, py);
    if (tile) this.orderAt(tile.x, tile.z);
  }

  /** Issue the context order at a tile (also used by the minimap). */
  orderAt(x: number, z: number): void {
    const w = this.ctx.world;
    const c = this.contextAt(x, z);
    const ids = [...this.ctx.selection.units].filter((id) => w.unitById(id)?.tribe === 'player');
    switch (c.kind) {
      case 'none':
        return;
      case 'rally':
        w.setRally(c.building!.id, x, z);
        break;
      case 'attack':
        w.orderAttack(ids, c.unit!.id);
        break;
      case 'attackBuilding':
        w.orderAttackBuilding(ids, c.building!.id);
        break;
      case 'garrison': {
        const b = c.building!;
        const fit = ids.filter((id) => {
          const u = w.unitById(id)!;
          return b.kind === 'tower' ? UNITS[u.kind].dmg > 0 && UNITS[u.kind].sight > 0 : u.kind === 'brave';
        });
        w.orderGarrison(fit, b.id);
        const rest = ids.filter((id) => !fit.includes(id));
        if (rest.length) w.orderMove(rest, b.x, b.z + b.size / 2 + 1.5);
        break;
      }
      case 'worship': {
        const m = w.monuments[c.monument!];
        w.orderWorship(ids, c.monument!);
        const escorts = ids.filter((id) => w.unitById(id)?.kind !== 'shaman');
        if (escorts.length) w.orderMove(escorts, m.x, m.z + 3);
        break;
      }
      case 'move':
        w.orderMove(ids, x, z);
        break;
    }
    this.mark(c.kind, c.unit?.x ?? c.building?.x ?? x, c.unit?.z ?? c.building?.z ?? z);
  }

  private mark(kind: OrderKind, x: number, z: number): void {
    const el = h('div', { class: `order-mark ${kind}` });
    uiRoot().appendChild(el);
    this.marks.push({ el, x, z, until: performance.now() + 700 });
  }

  /** Per frame: hover cursor (throttled) and order markers. */
  update(dt: number): void {
    const now = performance.now();
    this.marks = this.marks.filter((m) => {
      if (now > m.until) {
        m.el.remove();
        return false;
      }
      const p = toScreen(this.ctx.view, m.x, m.z, 0.1);
      if (p) {
        m.el.style.left = `${p.x}px`;
        m.el.style.top = `${p.y}px`;
      }
      return true;
    });

    this.hoverTimer -= dt;
    if (this.hoverTimer > 0) return;
    this.hoverTimer = 0.08;
    const ptr = this.ctx.pointer;
    let cursor = '';
    if (appState.mode === 'game' && ptr.onCanvas && toolState.tool === 'select' && !this.dragStart) {
      const tile = this.groundTile(ptr.x, ptr.y);
      if (tile) {
        const c = this.contextAt(tile.x, tile.z);
        cursor = c.kind === 'move' ? '' : CURSORS[c.kind];
        if (c.kind === 'none' || c.kind === 'move') {
          // Plain pointer over something clickable reads as "select".
          const hoverable = this.unitNear(tile.x, tile.z, PICK_RADIUS, () => true) || this.buildingAt(tile.x, tile.z) || this.monumentAt(tile.x, tile.z) >= 0;
          cursor = hoverable ? 'pointer' : c.kind === 'move' ? CURSORS.move : '';
        }
      }
    } else if (appState.mode === 'game' && toolState.tool !== 'select') cursor = 'crosshair';
    if (this.ctx.canvas.style.cursor !== cursor) this.ctx.canvas.style.cursor = cursor;
  }

  private dragRect(px: number, py: number) {
    const s = this.dragStart!;
    return { x: Math.min(s.x, px), y: Math.min(s.y, py), w: Math.abs(px - s.x), h: Math.abs(py - s.y) };
  }
}

/** Tribe colour as CSS (for portraits, minimap dots, labels). */
export function tribeCss(tribe: string): string {
  const c = TRIBE_COLORS[tribe as keyof typeof TRIBE_COLORS] ?? 0xffffff;
  return `#${c.toString(16).padStart(6, '0')}`;
}
