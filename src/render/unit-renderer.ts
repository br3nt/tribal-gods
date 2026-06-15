/**
 * render/unit-renderer.ts — sim units → animated figures on the planet.
 *
 * The renderer-side mirror of the unit list: one Figure + FigureAnimator
 * per unit, created/destroyed as units come and go. Each frame, every
 * figure gets placed through the same three-step pipeline:
 *
 * 1. INTERPOLATE — the sim runs at 15 Hz; the screen runs at 60+. We lerp
 *    prevTick→currentTick positions by `alpha` (see core/loop.ts) so motion
 *    is silky despite the chunky sim. The lerp uses wrapDelta so a unit
 *    stepping across the world seam doesn't streak across the planet.
 *
 * 2. ANCHOR — sim positions are wrapped tiles [0,128); the camera roams
 *    UNWRAPPED world units (pan east forever). We place each figure at the
 *    image of its position nearest the camera target. A unit at tile 2
 *    appears just east of a camera near tile 126 — that placement IS the
 *    seamless wrap, the same trick the terrain window does with vertices.
 *
 * 3. CURVE — terrain bends down with distance in its vertex shader; units
 *    must follow or they'd hover at the horizon. Figures are small, so we
 *    drop the whole group by CURVATURE·d² on the CPU instead of giving
 *    every limb a custom shader. (At unit size the error between bending
 *    the object and bending its origin is sub-pixel.)
 *
 * Units use ordinary MeshLambertMaterial, so main.ts adds real THREE
 * lights for them — the terrain ignores those and uses its own shader sun;
 * keep the two roughly matched or people will look pasted on.
 */

import * as THREE from 'three';
import { CIVS, COLOR_SELECTION, COLOR_TEAM_PLAYER, CURVATURE, TILE, TRIBE_COLORS, UNIT_SPEED, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import {
  buildBrave,
  buildFirewarrior,
  buildLeader,
  buildWarrior,
  buildWildman,
  Figure,
} from '../assets/models/figures';
import { FigureAnimator } from './figure-animator';
import { TribeId, Unit, World } from '../sim/world-state';

interface Entry {
  fig: Figure;
  anim: FigureAnimator;
  ring: THREE.Mesh;
  /** What the figure was built as — a convert (wildman → brave) triggers a rebuild. */
  kind: string;
  tribe: string;
}

const WORLD_UNITS = WORLD_SIZE * TILE;

function buildFor(unit: Unit, world: World): Figure {
  const team = TRIBE_COLORS[unit.tribe] ?? COLOR_TEAM_PLAYER;
  switch (unit.kind) {
    case 'shaman': {
      // The leader wears their civilization (regalia, staff, headgear).
      const civ = CIVS[world.tribes[unit.tribe as TribeId].civ];
      return buildLeader(civ, team);
    }
    case 'wildman':
      return buildWildman();
    case 'warrior':
      return buildWarrior(team);
    case 'firewarrior':
      return buildFirewarrior(team);
    case 'brave':
      return buildBrave(team);
  }
}

export class UnitRenderer {
  private readonly entries = new Map<number, Entry>();
  private readonly ringGeo: THREE.RingGeometry;
  private readonly ringMat: THREE.MeshBasicMaterial;

  constructor(private readonly scene: THREE.Scene) {
    // Selection ring: flat, drawn through terrain (depthTest off) like a
    // UI decal. Shared geometry/material across all rings.
    this.ringGeo = new THREE.RingGeometry(0.55, 0.7, 20);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: COLOR_SELECTION,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      side: THREE.DoubleSide,
    });
  }

  /** Called once per render frame. */
  sync(world: World, camTarget: THREE.Vector3, alpha: number, dt: number, selected: Set<number>): void {
    const live = new Set<number>();

    for (const u of world.units) {
      live.add(u.id);
      let e = this.entries.get(u.id);
      // Residents indoors keep their entry (cheap) but render nothing.
      if (u.hidden) {
        if (e) {
          e.fig.root.visible = false;
          e.ring.visible = false;
        }
        continue;
      }
      // Converted units change costume: tear down the old figure, build anew.
      if (e && (e.kind !== u.kind || e.tribe !== u.tribe)) {
        this.dispose(e);
        this.entries.delete(u.id);
        e = undefined;
      }
      if (!e) {
        const fig = buildFor(u, world);
        const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
        ring.renderOrder = 9;
        ring.visible = false;
        this.scene.add(fig.root, ring);
        e = { fig, anim: new FigureAnimator(), ring, kind: u.kind, tribe: u.tribe };
        this.entries.set(u.id, e);
      }

      // 1. INTERPOLATE between sim ticks (wrap-aware).
      const ix = u.prevX + wrapDelta(u.x - u.prevX, WORLD_SIZE) * alpha;
      const iz = u.prevZ + wrapDelta(u.z - u.prevZ, WORLD_SIZE) * alpha;

      // 2. ANCHOR at the wrapped image nearest the camera target.
      const relX = wrapDelta(ix * TILE - camTarget.x, WORLD_UNITS);
      const relZ = wrapDelta(iz * TILE - camTarget.z, WORLD_UNITS);
      const wx = camTarget.x + relX;
      const wz = camTarget.z + relZ;

      // Stand on the terrain surface (or tread water if some god drowned
      // the ground — drowning proper is a Phase 4 feature).
      let y = Math.max(0, world.map.sampleHeight(ix, iz));

      // 3. CURVE down with distance, matching the terrain shader.
      y -= CURVATURE * (relX * relX + relZ * relZ);

      e.fig.root.visible = true;
      e.fig.root.position.set(wx, y, wz);

      // Ease the facing the short way round (wrapDelta on the circle of angles).
      e.fig.root.rotation.y +=
        wrapDelta(u.heading - e.fig.root.rotation.y, Math.PI * 2) * Math.min(1, dt * 10);

      // Animate: clip from sim state, rate from actual speed (foot sync).
      // The task colors the motion — the same "moving" state walks plainly
      // or hauls a log depending on why the unit is moving.
      const clip =
        u.state === 'working' ? (u.castSpell ? 'cast' : 'work')
        : u.state === 'moving' ? (u.carrying ? 'carry' : 'walk')
        : 'idle';
      e.anim.update(dt, clip, UNIT_SPEED[u.kind], e.fig);
      if (e.fig.carryProp) e.fig.carryProp.visible = u.carrying;

      // Selection ring hugs the ground under the figure.
      e.ring.visible = selected.has(u.id);
      if (e.ring.visible) e.ring.position.set(wx, y + 0.15, wz);
    }

    // Units that no longer exist (deaths, world reset) lose their visuals.
    for (const [id, e] of this.entries) {
      if (!live.has(id)) {
        this.dispose(e);
        this.entries.delete(id);
      }
    }
  }

  private dispose(e: Entry): void {
    this.scene.remove(e.fig.root, e.ring);
    e.fig.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }

  /**
   * Where a unit currently sits on screen, in pixels — used by drag-box
   * selection. Mirrors the anchor + curve math from sync(), then projects
   * through the camera. Returns null if behind the camera.
   */
  screenPosition(
    u: Unit,
    world: World,
    camTarget: THREE.Vector3,
    camera: THREE.Camera,
  ): { x: number; y: number } | null {
    const relX = wrapDelta(u.x * TILE - camTarget.x, WORLD_UNITS);
    const relZ = wrapDelta(u.z * TILE - camTarget.z, WORLD_UNITS);
    const y =
      Math.max(0, world.map.sampleHeight(u.x, u.z)) - CURVATURE * (relX * relX + relZ * relZ);
    const v = new THREE.Vector3(camTarget.x + relX, y + 0.8, camTarget.z + relZ); // +0.8: chest height
    v.project(camera); // world space → normalized device coords (-1..1)
    if (v.z > 1) return null; // behind the camera plane
    return { x: (v.x + 1) * 0.5 * innerWidth, y: (1 - v.y) * 0.5 * innerHeight };
  }
}
