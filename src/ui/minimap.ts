/**
 * ui/minimap.ts — the whole planet at a glance.
 *
 * A plain 2D <canvas>, drawn in two layers:
 *
 *   TERRAIN — one pixel-ish cell per tile, colored by height (the same
 *   sand/grass/rock bands as the 3D palette, flattened). Repainting 16k
 *   cells is cheap but not free, so it's cached against map.version and
 *   only redrawn when god powers actually move some earth.
 *
 *   OVERLAY — repainted every frame on top: unit dots (blue you, red
 *   them, gray wildmen), building squares, and the camera's view marker.
 *
 * Clicking jumps the camera. The subtlety: the minimap shows WRAPPED tile
 * space but the camera roams unwrapped world units, so the click is
 * resolved to the image of that tile NEAREST the camera (wrapDelta again)
 * — jump west across the seam rather than panning the long way round.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { World } from '../sim/world-state';

const SIZE = 172; // CSS pixels, square
const SCALE = SIZE / WORLD_SIZE;
const WORLD_UNITS = WORLD_SIZE * TILE;

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrain: HTMLCanvasElement; // cached terrain layer
  private terrainVersion = -1;

  constructor(camTarget: THREE.Vector3) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.canvas.style.cssText = `
      position: fixed; top: 12px; right: 12px; z-index: 10; cursor: crosshair;
      border: 1px solid rgba(255,255,255,0.25); border-radius: 8px;
    `;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.terrain = document.createElement('canvas');
    this.terrain.width = this.terrain.height = SIZE;

    this.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const tx = ((e.clientX - rect.left) / SCALE) * TILE;
      const tz = ((e.clientY - rect.top) / SCALE) * TILE;
      // Jump to the image of the clicked spot nearest the current camera.
      camTarget.x += wrapDelta(tx - camTarget.x, WORLD_UNITS);
      camTarget.z += wrapDelta(tz - camTarget.z, WORLD_UNITS);
    });
  }

  update(world: World, camTarget: THREE.Vector3): void {
    if (world.map.version !== this.terrainVersion) {
      this.paintTerrain(world);
      this.terrainVersion = world.map.version;
    }
    const ctx = this.ctx;
    ctx.drawImage(this.terrain, 0, 0);

    // Unclaimed monuments: gold diamonds — the knowledge race, mapped.
    ctx.fillStyle = '#ffd75e';
    for (const m of world.monuments) {
      if (m.claimedBy) continue;
      ctx.fillRect(m.x * SCALE - 2, m.z * SCALE - 2, 4, 4);
    }

    // Buildings: 3px squares.
    for (const b of world.buildings) {
      ctx.fillStyle = b.tribe === 'player' ? '#5e9bff' : '#ff6a52';
      ctx.fillRect(b.x * SCALE - 1.5, b.z * SCALE - 1.5, 3.5, 3.5);
    }
    // Units: 2px dots.
    for (const u of world.units) {
      if (u.hidden) continue;
      ctx.fillStyle = u.tribe === 'player' ? '#aecdff' : u.tribe === 'red' ? '#ffb3a6' : '#b9b4a8';
      ctx.fillRect(u.x * SCALE - 1, u.z * SCALE - 1, 2, 2);
    }

    // The camera's gaze, wrapped back onto the map.
    const cx = (((camTarget.x / TILE) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
    const cz = (((camTarget.z / TILE) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
    ctx.strokeStyle = '#ffe9a8';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx * SCALE - 5, cz * SCALE - 5, 10, 10);
  }

  /** Height → color, one filled rect per tile. Cached until terrain changes. */
  private paintTerrain(world: World): void {
    const ctx = this.terrain.getContext('2d')!;
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        const h = world.map.heightAt(x, z);
        ctx.fillStyle =
          h < -2 ? '#2c5a80'
          : h < 0 ? '#3f86bd'
          : h < 1.5 ? '#d9c389'
          : h < 9 ? '#6fa04b'
          : h < 13 ? '#8a8276'
          : '#e9eded';
        ctx.fillRect(x * SCALE, z * SCALE, SCALE + 0.5, SCALE + 0.5);
      }
    }
  }
}
