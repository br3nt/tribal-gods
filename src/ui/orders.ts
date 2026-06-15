/**
 * ui/orders.ts — selecting your tribe and telling them where to go.
 *
 * The RTS input grammar, unchanged since the 90s because it's perfect:
 *
 *   click          → select the unit under the cursor
 *   drag a box     → select every tribe member inside it
 *   right-click    → everyone selected walks there
 *
 * Two different "where is it?" problems hide in here, solved opposite ways:
 *
 *   - CLICK: cast a ray INTO the world, hit the terrain, then find the
 *     nearest friendly unit to that ground point (in wrapped tile space).
 *     Much more forgiving than ray-vs-figure picking — clicking the ground
 *     NEAR someone selects them, which is what players actually expect.
 *
 *   - BOX: project each unit OUT of the world into screen pixels (the
 *     renderer's anchor math run forward) and test against the rectangle.
 *
 * The drag rectangle itself is a plain DOM div — crisp at any DPI, costs
 * nothing, and lives entirely outside the 3D scene.
 */

import * as THREE from 'three';
import { WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { pickGroundTile } from '../render/ground-picker';
import { UnitRenderer } from '../render/unit-renderer';
import { ATTACK_PICK_RADIUS, World } from '../sim/world-state';
import { appState } from './app-state';
import { toolState } from './tools';

/** Drags shorter than this (px) count as clicks. */
const CLICK_SLOP = 5;
/** Click-select forgiveness, in tiles. */
const PICK_RADIUS = 1.6;

export class OrderControl {
  readonly selected = new Set<number>();

  private dragStart: { x: number; y: number } | null = null;
  private readonly marquee: HTMLDivElement;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly camTarget: THREE.Vector3,
    private readonly world: World,
    private readonly unitRenderer: UnitRenderer,
    canvas: HTMLCanvasElement,
  ) {
    this.marquee = document.createElement('div');
    this.marquee.style.cssText = `
      position: fixed; display: none; pointer-events: none; z-index: 5;
      border: 1px dashed #ffe9a8; background: rgba(255, 233, 168, 0.08);
    `;
    document.body.appendChild(this.marquee);

    canvas.addEventListener('pointerdown', (e) => {
      if (appState.mode !== 'game') return; // selection is a game verb, not an editor one
      if (e.button === 0 && toolState.tool === 'select') {
        this.dragStart = { x: e.clientX, y: e.clientY };
      } else if (e.button === 2) {
        this.issueMoveOrder(e.clientX, e.clientY);
      }
    });

    addEventListener('pointermove', (e) => {
      if (!this.dragStart) return;
      const r = this.dragRect(e.clientX, e.clientY);
      if (Math.max(r.w, r.h) > CLICK_SLOP) {
        this.marquee.style.display = 'block';
        this.marquee.style.left = `${r.x}px`;
        this.marquee.style.top = `${r.y}px`;
        this.marquee.style.width = `${r.w}px`;
        this.marquee.style.height = `${r.h}px`;
      }
    });

    addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.dragStart) return;
      const r = this.dragRect(e.clientX, e.clientY);
      this.marquee.style.display = 'none';
      this.dragStart = null;
      if (Math.max(r.w, r.h) <= CLICK_SLOP) this.clickSelect(e.clientX, e.clientY);
      else this.boxSelect(r);
    });
  }

  // -------------------------------------------------------------------------

  /** Mouse pixels → a point on the (curved, as-seen) terrain → fractional tile coords. */
  private groundTile(px: number, py: number): { x: number; z: number } | null {
    return pickGroundTile(px, py, this.camera, this.world.map, this.camTarget);
  }

  private clickSelect(px: number, py: number): void {
    this.selected.clear();
    const tile = this.groundTile(px, py);
    if (!tile) return;

    // Nearest player unit within reach of the click, wrapped-distance.
    let best: number | null = null;
    let bestDist = PICK_RADIUS;
    for (const u of this.world.units) {
      if (u.tribe !== 'player') continue;
      const d = Math.hypot(wrapDelta(u.x - tile.x, WORLD_SIZE), wrapDelta(u.z - tile.z, WORLD_SIZE));
      if (d < bestDist) {
        bestDist = d;
        best = u.id;
      }
    }
    if (best !== null) this.selected.add(best);
  }

  private boxSelect(r: { x: number; y: number; w: number; h: number }): void {
    this.selected.clear();
    for (const u of this.world.units) {
      if (u.tribe !== 'player') continue;
      const p = this.unitRenderer.screenPosition(u, this.world, this.camTarget, this.camera);
      if (p && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
        this.selected.add(u.id);
      }
    }
  }

  private issueMoveOrder(px: number, py: number): void {
    if (this.selected.size === 0) return;
    const tile = this.groundTile(px, py);
    if (!tile) return;

    // Right-click ON an enemy means "get them", not "stand where they are".
    let enemy: number | null = null;
    let enemyDist = ATTACK_PICK_RADIUS;
    for (const u of this.world.units) {
      if (u.tribe !== 'red' || u.hidden) continue;
      const d = Math.hypot(wrapDelta(u.x - tile.x, WORLD_SIZE), wrapDelta(u.z - tile.z, WORLD_SIZE));
      if (d < enemyDist) {
        enemyDist = d;
        enemy = u.id;
      }
    }
    if (enemy !== null) {
      this.world.orderAttack([...this.selected], enemy);
      return;
    }

    // Right-click ON an unclaimed monument sends the leader to worship
    // (everyone else just escorts — wise, given where monuments tend to be).
    for (let i = 0; i < this.world.monuments.length; i++) {
      const m = this.world.monuments[i];
      if (m.claimedBy) continue;
      if (Math.hypot(wrapDelta(m.x - tile.x, WORLD_SIZE), wrapDelta(m.z - tile.z, WORLD_SIZE)) < 2.5) {
        this.world.orderWorship([...this.selected], i);
        const escorts = [...this.selected].filter(
          (id) => this.world.unitById(id)?.kind !== 'shaman',
        );
        if (escorts.length > 0) this.world.orderMove(escorts, m.x, m.z + 3);
        return;
      }
    }

    this.world.orderMove([...this.selected], tile.x, tile.z);
  }

  private dragRect(px: number, py: number) {
    const s = this.dragStart!;
    return {
      x: Math.min(s.x, px),
      y: Math.min(s.y, py),
      w: Math.abs(px - s.x),
      h: Math.abs(py - s.y),
    };
  }
}
