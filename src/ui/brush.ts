/**
 * ui/brush.ts — the sculpting brush: your first god power.
 *
 * Phase 1's stand-in for the spell system. Hold the left mouse button to
 * reshape the planet with the selected tool. The pipeline every terrain
 * spell will share is already all here:
 *
 *   screen-space mouse → ray-marched pick against the curved terrain
 *     → tile coordinates → heightmap edit kernel → version bump → GPU refill
 *
 * (Picking happens in render/ground-picker.ts, against the curved surface
 * the player actually sees — read its header for why triangle raycasting
 * was wrong here.)
 */

import * as THREE from 'three';
import {
  BRUSH_RADIUS,
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  BRUSH_RATE,
  CURVATURE,
  FLATTEN_RATE,
  TILE,
} from '../config';
import { clamp } from '../core/util';
import { pickGroundTile } from '../render/ground-picker';
import { Heightmap } from '../world/heightmap';
import { appState } from './app-state';
import { brushSizeStep } from './hotkeys';
import { toolState } from './tools';

export class SculptBrush {
  radius = BRUSH_RADIUS; // in tiles

  private pointerPx = { x: 0, y: 0 };
  private pointerOnScreen = false;
  private sculpting = false;

  /** Ring of line segments showing where the brush will land. */
  private readonly indicator: THREE.LineLoop;
  private readonly indicatorPositions: THREE.BufferAttribute;
  private static readonly RING_SEGMENTS = 48;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly camTarget: THREE.Vector3,
    private readonly map: Heightmap,
    canvas: HTMLCanvasElement,
    scene: THREE.Scene,
  ) {
    // --- Pointer state ---
    canvas.addEventListener('pointermove', (e) => {
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.pointerOnScreen = true;
    });
    canvas.addEventListener('pointerleave', () => (this.pointerOnScreen = false));
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.sculpting = true;
    });
    addEventListener('pointerup', (e) => {
      if (e.button === 0) this.sculpting = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // --- Size hotkeys (tool switching lives in ui/tools.ts) ---
    addEventListener('keydown', (e) => {
      const step = brushSizeStep(e, appState.mode, appState.debug);
      if (step) this.radius = clamp(this.radius + step, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX);
    });

    // --- Indicator ring ---
    const positions = new Float32Array(SculptBrush.RING_SEGMENTS * 3);
    this.indicatorPositions = new THREE.BufferAttribute(positions, 3);
    this.indicatorPositions.setUsage(THREE.DynamicDrawUsage);
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', this.indicatorPositions);
    this.indicator = new THREE.LineLoop(
      ringGeo,
      // depthTest off: the ring should read through hills, like a UI element
      // projected onto the world rather than an object in it.
      new THREE.LineBasicMaterial({ color: 0xffe9a8, depthTest: false }),
    );
    this.indicator.renderOrder = 10;
    this.indicator.frustumCulled = false;
    this.indicator.visible = false;
    scene.add(this.indicator);
  }

  /**
   * Called once per render frame. `dt` scales the edit so sculpting speed is
   * a units-per-second rate, independent of framerate.
   */
  update(dt: number): void {
    // The brush owns raise/lower (debug keys -/= in game, toolbar in the
    // editor) — plus flatten WHEN EDITING: in play 'flatten' is a spell the
    // caster owns, but the level builder gets it as a plain brush.
    const sculptTool =
      toolState.tool === 'raise' ||
      toolState.tool === 'lower' ||
      (appState.mode === 'editor' && toolState.tool === 'flatten');
    if (!this.pointerOnScreen || !sculptTool) {
      this.indicator.visible = false;
      return;
    }

    // Ray-march against the curved terrain the player actually sees.
    const hit = pickGroundTile(this.pointerPx.x, this.pointerPx.y, this.camera, this.map, this.camTarget);
    if (!hit) {
      this.indicator.visible = false;
      return;
    }

    const tx = hit.x;
    const tz = hit.z;

    this.updateIndicator(tx, tz);

    if (!this.sculpting) return;
    if (toolState.tool === 'raise') this.map.raise(tx, tz, this.radius, BRUSH_RATE * dt);
    else if (toolState.tool === 'lower') this.map.raise(tx, tz, this.radius, -BRUSH_RATE * dt);
    else this.map.flatten(tx, tz, this.radius, FLATTEN_RATE * dt);
  }

  /**
   * Drape the ring over the terrain: each of the 48 points samples the
   * heightmap so the circle follows hillsides instead of slicing through
   * them, and applies the same curvature drop as everything else so the
   * ring sits on the visual surface even out near the horizon.
   */
  private updateIndicator(tx: number, tz: number): void {
    const arr = this.indicatorPositions.array as Float32Array;
    for (let s = 0; s < SculptBrush.RING_SEGMENTS; s++) {
      const a = (s / SculptBrush.RING_SEGMENTS) * Math.PI * 2;
      const px = tx + Math.cos(a) * this.radius;
      const pz = tz + Math.sin(a) * this.radius;
      const dx = px * TILE - this.camTarget.x;
      const dz = pz * TILE - this.camTarget.z;
      arr[s * 3] = px * TILE;
      arr[s * 3 + 1] =
        Math.max(0, this.map.sampleHeight(px, pz)) - CURVATURE * (dx * dx + dz * dz) + 0.3;
      arr[s * 3 + 2] = pz * TILE;
    }
    this.indicatorPositions.needsUpdate = true;
    this.indicator.visible = true;
  }
}
