/**
 * ui/spell-aim.ts — aiming a spell in the world, and casting it.
 *
 * While a spell is armed (toolState holds a SpellId), every frame draws:
 *
 *   - your leader's RANGE RING (dashed), so you can see what is reachable;
 *   - the effect RETICLE at the cursor, sized to the spell's radius and
 *     draped over the curved ground (ui/drape.ts);
 *   - for `line` spells, the line itself: Causeway's road from where the
 *     leader will stand to the mark, Quake's fault through the mark;
 *   - a note by the cursor: the spell and its hotkey, or — in red — why it
 *     can't land there (world.castCheck is the only judge; the UI asks).
 *
 * Click casts (world.orderCast). Shift-click keeps the spell armed for
 * another cast; otherwise you drop back to selecting. Esc or right-click
 * cancels (handled by ui/orders.ts + the key handler). A refused cast
 * shows its reason by the cursor; the sim fires the 'denied' sound.
 *
 * Out of range but reachable is NOT an error: the leader walks into range
 * and casts, and the note says so.
 */

import * as THREE from 'three';
import { WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { pickGroundTile } from '../render/ground-picker';
import { spellDef } from '../sim/catalog';
import { appState } from './app-state';
import { UiContext } from './context';
import { h, setClass, setText, uiRoot } from './dom';
import { Drape } from './drape';
import { labelFor } from './hotkeys';
import { activeSpell, resetTool } from './tools';
import { toast } from './tooltip';

const OK = 0x72d8ff;
const BAD = 0xff5a4a;
const RANGE = 0xf4f7ff;

export class SpellAim {
  private readonly fill: Drape;
  private readonly rim: Drape;
  private readonly note: HTMLDivElement;
  private readonly noteText: HTMLSpanElement;
  private readonly noteKey: HTMLSpanElement;

  constructor(private readonly ctx: UiContext) {
    this.fill = new Drape(ctx.scene, 0.22, 8000, 20);
    this.rim = new Drape(ctx.scene, 0.9, 6000, 21);
    this.noteText = h('span');
    this.noteKey = h('span.kbd');
    this.note = h('div.tg-cursor-note', {}, this.noteText, this.noteKey);
    this.note.hidden = true;
    uiRoot().appendChild(this.note);

    ctx.canvas.addEventListener('pointerdown', (e) => {
      if (appState.mode !== 'game' || e.button !== 0) return;
      const spell = activeSpell();
      if (!spell) return;
      const hit = pickGroundTile(e.clientX, e.clientY, ctx.view.camera, ctx.world.map, ctx.view.target);
      if (!hit) return;
      const why = ctx.world.orderCast('player', spell, hit.x, hit.z);
      if (why) toast(why, e.clientX, e.clientY);
      else if (!e.shiftKey) resetTool();
    });
  }

  update(): void {
    const spell = appState.mode === 'game' ? activeSpell() : null;
    const ptr = this.ctx.pointer;
    if (!spell || !ptr.onCanvas) {
      this.fill.hide();
      this.rim.hide();
      this.note.hidden = true;
      return;
    }
    const { world, view } = this.ctx;
    const def = spellDef(spell);
    const hit = pickGroundTile(ptr.x, ptr.y, view.camera, world.map, view.target);
    const leader = world.leaderOf('player');
    const why = hit ? this.check(spell, hit.x, hit.z) : 'Aim at the ground';
    const col = why ? BAD : OK;

    this.fill.begin(col);
    this.rim.begin(RANGE);

    // Range ring around the leader.
    if (leader && !leader.hidden) {
      this.rim.ring(view, leader.x, leader.z, def.range - 0.1, def.range + 0.1, 3);
    }

    let walking = false;
    if (hit) {
      this.rim.color(col);
      const tx = hit.x;
      const tz = hit.z;
      if (def.aim === 'line' && leader) {
        // Where will the leader stand? Here, or `range` back along the line.
        const dx = wrapDelta(tx - leader.x, WORLD_SIZE);
        const dz = wrapDelta(tz - leader.z, WORLD_SIZE);
        const dist = Math.hypot(dx, dz) || 1;
        walking = dist > def.range;
        const back = Math.min(dist, def.range);
        const fx = tx - (dx / dist) * back;
        const fz = tz - (dz / dist) * back;
        if (spell === 'earthquake') {
          // The fault runs THROUGH the mark, along the leader→mark direction.
          const half = Math.round(def.radius * 1.45);
          const ux = dx / dist, uz = dz / dist;
          this.fill.band(view, tx - ux * half, tz - uz * half, tx + ux * half, tz + uz * half, 2.5);
          this.rim.bandEdges(view, tx - ux * half, tz - uz * half, tx + ux * half, tz + uz * half, 2.5, 0.22);
        } else {
          const hw = Math.max(1, Math.round(def.radius / 2)) + 0.5;
          this.fill.band(view, fx, fz, tx, tz, hw);
          this.rim.bandEdges(view, fx, fz, tx, tz, hw, 0.22);
        }
        this.rim.ring(view, tx, tz, 0.5, 0.75);
      } else {
        const r = Math.max(def.radius, 0.8);
        this.fill.disc(view, tx, tz, r);
        this.rim.ring(view, tx, tz, r - 0.18, r + 0.06);
        if (def.aim === 'point') this.rim.ring(view, tx, tz, 0.3, 0.5);
        if (leader) walking = Math.hypot(wrapDelta(tx - leader.x, WORLD_SIZE), wrapDelta(tz - leader.z, WORLD_SIZE)) > def.range;
      }
    }
    this.fill.end();
    this.rim.end();

    // Cursor note.
    this.note.hidden = false;
    this.note.style.left = `${ptr.x}px`;
    this.note.style.top = `${ptr.y}px`;
    setClass(this.note, 'bad', !!why);
    setText(this.noteText, why ?? (walking ? `${def.name} · leader walks into range` : `${def.name} · click to cast, shift for more`));
    setText(this.noteKey, why ? '' : labelFor(`spell:${spell}`));
    this.noteKey.hidden = !!why;
  }

  /**
   * castCheck may run an A* search (can the leader walk into range?), so
   * it is re-asked only when the target tile, the leader's tile or the
   * spell's readiness changes — not every frame.
   */
  private check(spell: Parameters<UiContext['world']['castCheck']>[1], x: number, z: number): string | null {
    const w = this.ctx.world;
    const l = w.leaderOf('player');
    const s = w.spellState('player', spell);
    const key = `${spell}|${Math.round(x)}|${Math.round(z)}|${l ? `${Math.round(l.x)},${Math.round(l.z)}` : '-'}|${s.charges + s.gifted > 0}|${w.map.version}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.lastWhy = w.castCheck('player', spell, x, z);
    }
    return this.lastWhy;
  }

  private lastKey = '';
  private lastWhy: string | null = null;

  /** For tests/automation: the world-space centre of the reticle mesh exists. */
  get meshes(): THREE.Mesh[] {
    return [this.fill.mesh, this.rim.mesh];
  }
}
