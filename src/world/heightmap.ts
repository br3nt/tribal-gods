/**
 * world/heightmap.ts — the planet itself.
 *
 * The entire world is this: a flat square grid of height values that WRAPS
 * at both edges. Walk off the east edge and you arrive at the west edge.
 * Topologically that's a torus (a donut), but rendered with the curvature
 * trick (world/curvature.ts) it reads convincingly as a small planet — the
 * exact same sleight of hand the 1998 original used.
 *
 * Everything interesting about the god game falls out of this one array:
 *   - Terrain rendering reads it (world/terrain-mesh.ts).
 *   - God powers are just edits to it (raise/flatten below; volcanoes and
 *     earthquakes later are fancier edits applied over several ticks).
 *   - "Can I build here?" = "are these heights flat?"
 *   - "Can I walk here?" = "is this height above sea level?"
 *
 * Convention: sea level is height 0. Below 0 is underwater.
 */

import { MAX_HEIGHT, MIN_HEIGHT, TILE, WORLD_SIZE } from '../config';
import { fbm, hash2 } from '../core/noise';
import { clamp, lerp } from '../core/util';

export class Heightmap {
  /** Flat row-major array: heights[z * WORLD_SIZE + x]. */
  readonly heights = new Float32Array(WORLD_SIZE * WORLD_SIZE);

  /**
   * Bumped on every edit. Cheap change-detection: the terrain mesh
   * remembers the version it last uploaded and refills its vertex buffers
   * only when this number moves. No events, no dirty-rectangle bookkeeping
   * (yet) — compare one integer.
   */
  version = 0;

  /**
   * Wrap any integer tile coordinate onto [0, WORLD_SIZE).
   *
   * This single function is what makes the planet "round". The double
   * modulo handles negative numbers, which JS `%` gets wrong on its own
   * (-1 % 128 === -1, but we need 127).
   */
  wrap(i: number): number {
    return ((i % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
  }

  /** Height at integer tile (x, z), wrapping as needed. */
  heightAt(x: number, z: number): number {
    return this.heights[this.wrap(z) * WORLD_SIZE + this.wrap(x)];
  }

  /**
   * Height at a fractional tile position, bilinearly interpolated — the
   * smooth surface units stand on and the camera glides over. Without this,
   * anything moving across the terrain would stairstep from tile to tile.
   */
  sampleHeight(fx: number, fz: number): number {
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;
    const h00 = this.heightAt(x0, z0);
    const h10 = this.heightAt(x0 + 1, z0);
    const h01 = this.heightAt(x0, z0 + 1);
    const h11 = this.heightAt(x0 + 1, z0 + 1);
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /**
   * Surface normal at a tile, from central differences: compare the heights
   * of the four neighbors. The y component is the horizontal distance the
   * differences span (2 tiles, in world units) — taller neighbors relative
   * to that span = steeper slope = the normal tips further from vertical.
   * Used for lighting AND for gameplay later ("too steep to walk/build").
   */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }): void {
    const hl = this.heightAt(x - 1, z);
    const hr = this.heightAt(x + 1, z);
    const hb = this.heightAt(x, z - 1);
    const hf = this.heightAt(x, z + 1);
    const nx = hl - hr;
    const ny = 2 * TILE;
    const nz = hb - hf;
    const inv = 1 / Math.hypot(nx, ny, nz);
    out.x = nx * inv;
    out.y = ny * inv;
    out.z = nz * inv;
  }

  // -------------------------------------------------------------------------
  // God-power edit kernels.
  //
  // Every terrain spell in the finished game reduces to calls like these.
  // Both take their center in (possibly fractional) tile coordinates and a
  // radius in tiles, and apply a cosine falloff so edits have soft shoulders
  // — a sharp-edged cylinder of raised land instantly looks digital and
  // wrong; a cosine bump looks like geology.
  // -------------------------------------------------------------------------

  /** Raise (or with negative `amount`, lower) a smooth bump of land. */
  raise(cx: number, cz: number, radius: number, amount: number): void {
    this.forEachInRadius(cx, cz, radius, (x, z, falloff) => {
      const i = this.wrap(z) * WORLD_SIZE + this.wrap(x);
      this.heights[i] = clamp(this.heights[i] + amount * falloff, MIN_HEIGHT, MAX_HEIGHT);
    });
    this.version++;
  }

  /**
   * Pull terrain toward the local average height — the spell that makes
   * land buildable. `strength` is a lerp factor (0..1) for this application;
   * callers scale it by frame time so holding the button flattens smoothly
   * rather than snapping.
   *
   * Two passes: measure the falloff-weighted average first, then blend every
   * tile toward it. One pass would let early tiles drag the average around
   * before later tiles read it.
   */
  flatten(cx: number, cz: number, radius: number, strength: number): void {
    let sum = 0;
    let weight = 0;
    this.forEachInRadius(cx, cz, radius, (x, z, falloff) => {
      sum += this.heightAt(x, z) * falloff;
      weight += falloff;
    });
    if (weight === 0) return;
    const avg = sum / weight;

    this.forEachInRadius(cx, cz, radius, (x, z, falloff) => {
      const i = this.wrap(z) * WORLD_SIZE + this.wrap(x);
      this.heights[i] = lerp(this.heights[i], avg, clamp(strength * falloff, 0, 1));
    });
    this.version++;
  }

  /** Visit every tile within `radius` of (cx, cz) with its cosine falloff (1 at center, 0 at rim). */
  private forEachInRadius(
    cx: number,
    cz: number,
    radius: number,
    fn: (x: number, z: number, falloff: number) => void,
  ): void {
    // Iterate an UNWRAPPED bounding box around the center so distances are
    // computed in continuous space; wrapping happens only when the callback
    // touches the array. This is how an edit near the east edge correctly
    // spills onto the west edge.
    const x0 = Math.floor(cx - radius);
    const x1 = Math.ceil(cx + radius);
    const z0 = Math.floor(cz - radius);
    const z1 = Math.ceil(cz + radius);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, z - cz);
        if (d >= radius) continue;
        fn(x, z, 0.5 + 0.5 * Math.cos((d / radius) * Math.PI));
      }
    }
  }

  // -------------------------------------------------------------------------
  // World generation
  // -------------------------------------------------------------------------

  /**
   * Carve a fresh planet from fractal noise.
   *
   * The shaping is one line: take fbm noise in [0,1], subtract a "sea bias",
   * scale up. Everything that lands above 0 is a continent; below is ocean.
   * Nudge SEA_BIAS up for an island-dotted waterworld, down for Pangaea.
   */
  generate(seed: number): void {
    const SEA_BIAS = 0.47;
    const AMPLITUDE = 30;

    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        const v = fbm(x, z, WORLD_SIZE, seed);
        this.heights[z * WORLD_SIZE + x] = clamp((v - SEA_BIAS) * AMPLITUDE, MIN_HEIGHT, MAX_HEIGHT);
      }
    }

    // One gentle 3×3 blur softens the coastlines — raw noise leaves slightly
    // crunchy beaches. (Also a preview of erosion, which is just blur with
    // opinions.)
    this.blur();
    this.version++;
  }

  /** One pass of a wrapped 3×3 box blur. */
  private blur(): void {
    const src = this.heights.slice();
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        let sum = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += src[this.wrap(z + dz) * WORLD_SIZE + this.wrap(x + dx)];
          }
        }
        this.heights[z * WORLD_SIZE + x] = sum / 9;
      }
    }
  }

  /**
   * Stable per-tile random in [0,1) — used to dither terrain colors so flat
   * grass doesn't render as one solid sheet of green. Stable because it
   * hashes the WRAPPED tile coords: the same tile always jitters the same
   * way, so colors don't crawl as the view window scrolls.
   */
  jitterAt(x: number, z: number): number {
    return hash2(this.wrap(x), this.wrap(z), 7777);
  }
}
