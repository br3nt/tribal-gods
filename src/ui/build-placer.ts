/**
 * ui/build-placer.ts — placing building sites: the footprint ghost.
 *
 * With a building armed, the size×size footprint (catalog BuildingDef.size)
 * rides the cursor, snapped to tiles and draped over the ground. Each tile
 * is painted on its own: green where the ground can take a wall, red where
 * it can't (water, cliff, a tree or building in the way, or the one-tile
 * lane every building keeps around itself). The sim stays the only judge
 * of the whole site — world.canPlaceBuilding — and when it says no while
 * every tile looks fine, the note by the cursor says why (uneven ground,
 * too close to a home circle, not enough wood).
 *
 * Click places (world.placeBuilding). Shift-click keeps the tool for
 * another; Esc or right-click cancels.
 */

import { WORLD_SIZE } from '../config';
import { denied } from '../core/audio';
import { wrapDelta } from '../core/util';
import { pickGroundTile } from '../render/ground-picker';
import { BUILDINGS, BuildingKind } from '../sim/catalog';
import { tileIndex, walkable } from '../sim/pathfinding';
import { appState } from './app-state';
import { UiContext } from './context';
import { h, setClass, setText, uiRoot } from './dom';
import { Drape } from './drape';
import { labelFor } from './hotkeys';
import { activeBuilding, resetTool } from './tools';
import { toast } from './tooltip';

const GOOD = 0x6fe08a;
const BAD = 0xff5a4a;
const LANE = 0xffd36a;

export class BuildPlacer {
  private readonly fill: Drape;
  private readonly rim: Drape;
  private readonly note: HTMLDivElement;
  private candidate: { kind: BuildingKind; x: number; z: number; ok: boolean; why: string | null } | null = null;

  constructor(private readonly ctx: UiContext) {
    this.fill = new Drape(ctx.scene, 0.42, 3000, 20);
    this.rim = new Drape(ctx.scene, 0.95, 3000, 21);
    this.note = h('div.tg-cursor-note');
    this.note.hidden = true;
    uiRoot().appendChild(this.note);

    ctx.canvas.addEventListener('pointerdown', (e) => {
      if (appState.mode !== 'game' || e.button !== 0) return;
      const kind = activeBuilding();
      if (!kind) return;
      this.update();
      const c = this.candidate;
      if (!c || c.kind !== kind) return;
      if (!c.ok || !ctx.world.placeBuilding('player', kind, c.x, c.z)) {
        toast(c.why ?? 'Cannot build here', e.clientX, e.clientY);
        denied();
        return;
      }
      const still = ctx.world.buildState('player', kind);
      if (!e.shiftKey || !still.affordable) resetTool();
    });
  }

  /** Why the whole site is refused, in words (null = it can be placed). */
  private siteReason(kind: BuildingKind, cx: number, cz: number, badTiles: number, laneBlocked: boolean): string | null {
    const w = this.ctx.world;
    const st = w.buildState('player', kind);
    if (st.reason) return st.reason;
    if (w.canPlaceBuilding('player', kind, cx, cz)) return null;
    if (badTiles > 0) return 'Something is in the way';
    if (laneBlocked) return 'Keep a path clear around buildings';
    const r = (BUILDINGS[kind].size - 1) / 2;
    for (const id of w.activeTribes()) {
      const home = w.tribes[id]!.home;
      if (Math.abs(wrapDelta(cx - home.x, WORLD_SIZE)) < r + 3 && Math.abs(wrapDelta(cz - home.z, WORLD_SIZE)) < r + 3) {
        return 'Too close to a home circle';
      }
    }
    return 'The ground is too uneven';
  }

  update(): void {
    const kind = appState.mode === 'game' ? activeBuilding() : null;
    const ptr = this.ctx.pointer;
    const hit = kind && ptr.onCanvas
      ? pickGroundTile(ptr.x, ptr.y, this.ctx.view.camera, this.ctx.world.map, this.ctx.view.target)
      : null;
    if (!kind || !hit) {
      this.candidate = null;
      this.fill.hide();
      this.rim.hide();
      this.note.hidden = true;
      return;
    }
    const { world, view } = this.ctx;
    const def = BUILDINGS[kind];
    const cx = world.map.wrap(Math.round(hit.x));
    const cz = world.map.wrap(Math.round(hit.z));
    const r = (def.size - 1) / 2;
    const obstacles = world.obstacles;

    this.fill.begin(GOOD);
    this.rim.begin(GOOD);
    let bad = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const z = cz + dz;
        const ok = walkable(world.map, x, z) && !obstacles.has(tileIndex(x, z));
        if (!ok) bad++;
        this.fill.color(ok ? GOOD : BAD);
        this.fill.tile(view, x, z, 0.06);
      }
    }
    // The lane ring: tiles just outside that must stay clear.
    let laneBlocked = false;
    for (let dz = -r - 1; dz <= r + 1; dz++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        if (Math.abs(dx) <= r && Math.abs(dz) <= r) continue;
        if (obstacles.has(tileIndex(cx + dx, cz + dz))) {
          laneBlocked = true;
          this.fill.color(LANE);
          this.fill.tile(view, cx + dx, cz + dz, 0.3);
        }
      }
    }
    const why = this.siteReason(kind, cx, cz, bad, laneBlocked);
    const ok = why === null;
    // Outline of the whole footprint, green or red as one.
    this.rim.color(ok ? GOOD : BAD);
    const e = r + 0.5;
    const t = 0.12;
    this.rim.quad(view, cx - e, cz - e, cx + e, cz - e, cx + e, cz - e + t, cx - e, cz - e + t);
    this.rim.quad(view, cx - e, cz + e - t, cx + e, cz + e - t, cx + e, cz + e, cx - e, cz + e);
    this.rim.quad(view, cx - e, cz - e, cx - e + t, cz - e, cx - e + t, cz + e, cx - e, cz + e);
    this.rim.quad(view, cx + e - t, cz - e, cx + e, cz - e, cx + e, cz + e, cx + e - t, cz + e);
    // The door (bottom-centre tile stays open in the sim): a small mark.
    this.rim.ring(view, cx, cz + r + 0.3, 0.06, 0.16);
    this.fill.end();
    this.rim.end();
    this.candidate = { kind, x: cx, z: cz, ok, why };

    this.note.hidden = false;
    this.note.style.left = `${ptr.x}px`;
    this.note.style.top = `${ptr.y}px`;
    setClass(this.note, 'bad', !ok);
    setText(this.note, ok ? `${def.name} · ${def.wood} wood · click to place, shift for more  ${labelFor(`build:${kind}`)}` : why!);
  }
}
