/**
 * world/surface-fx.ts — what spells leave ON the ground, painted into it.
 *
 * A small RGBA texture laid over the whole planet at FX_RES texels per
 * tile, sampled by the terrain shader (terrain-mesh.ts) and the grass
 * carpet (ground-cover.ts):
 *
 *   R  HEAT    molten rock. Glows (bright and liquid when hot, a crust with
 *              glowing seams as it cools). As heat drains away it leaves
 *   G  BASALT  cooled lava: black, glassy rock that lingers for minutes —
 *              the readable aftermath of a volcano's rivulets.
 *   B  WET     dark, glossy ground fresh out of the sea (Causeway, Undertow
 *              rims); dries in half a minute.
 *   A  CRACK   glowing fissures: a crack network where the ground is
 *              tearing (a swelling volcano, a quake's fault). Fades.
 *
 * The renderer paints with soft round brushes (paint()); the decay runs
 * here at a few Hz and only while something is still fading, so a quiet
 * planet costs nothing. Texel (i, j) sits at tile (i / FX_RES, j / FX_RES)
 * and the texture repeats, so the shader can sample it at any world
 * position with no wrap logic.
 */

import * as THREE from 'three';
import { WORLD_SIZE } from '../config';

/** Texels per tile edge. Two is enough for one-tile-wide lava rivulets. */
export const FX_RES = 2;
export const FX_N = WORLD_SIZE * FX_RES;

/** Channel indices (see the header). */
export const FxChannel = { Heat: 0, Basalt: 1, Wet: 2, Crack: 3 } as const;
export type FxChannel = (typeof FxChannel)[keyof typeof FxChannel];

/** Seconds for a full channel to fade to nothing (heat: while not re-painted). */
const FADE_SECONDS = [55, 900, 28, 14];
/** How often the fade runs and the texture re-uploads (Hz). */
const STEP_HZ = 8;

export class SurfaceFx {
  readonly texture: THREE.DataTexture;
  private readonly data = new Uint8Array(FX_N * FX_N * 4);
  private readonly val = new Float32Array(FX_N * FX_N * 4);
  private live = false;
  private dirty = false;
  private timer = 0;

  constructor() {
    this.texture = new THREE.DataTexture(this.data, FX_N, FX_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  /**
   * Add `amount` (soft round brush, `radius` in tiles) to a channel around
   * fractional tile (x, z). `max` caps the result (paint "up to" a level).
   */
  paint(ch: FxChannel, x: number, z: number, radius: number, amount: number, max = 1): void {
    const R = Math.max(0.5, radius) * FX_RES;
    const cx = x * FX_RES;
    const cz = z * FX_RES;
    const r = Math.ceil(R);
    const ix = Math.round(cx);
    const iz = Math.round(cz);
    const v = this.val;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = ix + dx;
        const pz = iz + dz;
        const d = Math.hypot(px - cx, pz - cz) / R;
        if (d >= 1) continue;
        const k = 1 - d * d;
        const i = ((((pz % FX_N) + FX_N) % FX_N) * FX_N + (((px % FX_N) + FX_N) % FX_N)) * 4 + ch;
        if (v[i] < max) v[i] = Math.min(max, v[i] + amount * k);
      }
    }
    this.live = true;
    this.dirty = true;
  }

  /** Read a channel at the texel nearest fractional tile (x, z). */
  sample(ch: FxChannel, x: number, z: number): number {
    const px = ((Math.round(x * FX_RES) % FX_N) + FX_N) % FX_N;
    const pz = ((Math.round(z * FX_RES) % FX_N) + FX_N) % FX_N;
    return this.val[(pz * FX_N + px) * 4 + ch];
  }

  clear(): void {
    this.val.fill(0);
    this.live = false;
    this.dirty = true;
  }

  /** Fade every channel; cooling heat leaves basalt behind. */
  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    const step = 1 / STEP_HZ;
    this.timer = step;
    if (this.live) {
      const v = this.val;
      const f0 = step / FADE_SECONDS[0];
      const f1 = step / FADE_SECONDS[1];
      const f2 = step / FADE_SECONDS[2];
      const f3 = step / FADE_SECONDS[3];
      let any = false;
      for (let i = 0; i < v.length; i += 4) {
        const h = v[i];
        if (h > 0) {
          // cooling lava hardens: the rock it leaves is as thick as the flow was
          if (v[i + 1] < h * 1.4) v[i + 1] = Math.min(1, h * 1.4);
          v[i] = Math.max(0, h - f0);
          any = true;
        }
        if (v[i + 1] > 0) {
          v[i + 1] = Math.max(0, v[i + 1] - f1);
          any = true;
        }
        if (v[i + 2] > 0) {
          v[i + 2] = Math.max(0, v[i + 2] - f2);
          any = true;
        }
        if (v[i + 3] > 0) {
          v[i + 3] = Math.max(0, v[i + 3] - f3);
          any = true;
        }
      }
      this.live = any;
      this.dirty = true;
    }
    if (this.dirty) {
      const v = this.val;
      const d = this.data;
      for (let i = 0; i < v.length; i++) d[i] = v[i] * 255;
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }
}
