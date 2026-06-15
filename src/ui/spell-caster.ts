/**
 * ui/spell-caster.ts — click-to-smite.
 *
 * With a spell selected, a left-click on the world asks the sim to cast it
 * there (world.orderCast). Note what this module does NOT do: check mana,
 * check range, move the shaman. All of that is the sim's business — the
 * shaman walks into range on her own and the cast resolves in sim ticks.
 * UI modules in this codebase are thin by rule: translate input, ask, done.
 *
 * Also draws the targeting reticle: a ring at the cursor in the spell's
 * signature color, so you always know you're holding live ammunition.
 */

import * as THREE from 'three';
import { CURVATURE, TILE } from '../config';
import { pickGroundTile } from '../render/ground-picker';
import { World } from '../sim/world-state';
import { appState } from './app-state';
import { activeSpell } from './tools';

const SPELL_COLORS: Record<string, number> = {
  blast: 0xffb347,
  convert: 0x88eaff,
  lightning: 0xeaf6ff,
  swamp: 0x6fae4e,
  landbridge: 0xd8c389,
  flatten: 0xcccccc,
  earthquake: 0xb86a3c,
  volcano: 0xff5a2a,
};

export class SpellCaster {
  private readonly reticle: THREE.Mesh;
  private readonly reticleMat: THREE.MeshBasicMaterial;
  private pointerPx = { x: 0, y: 0 };
  private pointerOnScreen = false;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly camTarget: THREE.Vector3,
    private readonly world: World,
    canvas: HTMLCanvasElement,
    scene: THREE.Scene,
  ) {
    const geo = new THREE.TorusGeometry(1.6, 0.12, 6, 28);
    geo.rotateX(-Math.PI / 2);
    this.reticleMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false });
    this.reticle = new THREE.Mesh(geo, this.reticleMat);
    this.reticle.renderOrder = 10;
    this.reticle.visible = false;
    scene.add(this.reticle);

    canvas.addEventListener('pointermove', (e) => {
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.pointerOnScreen = true;
    });
    canvas.addEventListener('pointerleave', () => (this.pointerOnScreen = false));
    canvas.addEventListener('pointerdown', (e) => {
      if (appState.mode !== 'game') return; // no casting from the editor's god-seat
      const spell = activeSpell();
      if (e.button !== 0 || !spell) return;
      const hit = pickGroundTile(e.clientX, e.clientY, this.camera, this.world.map, this.camTarget);
      if (hit) this.world.orderCast('player', spell, hit.x, hit.z);
    });
  }

  /** Track the cursor with the reticle while a spell is armed. */
  update(): void {
    const spell = appState.mode === 'game' ? activeSpell() : null;
    if (!spell || !this.pointerOnScreen) {
      this.reticle.visible = false;
      return;
    }
    const hit = pickGroundTile(this.pointerPx.x, this.pointerPx.y, this.camera, this.world.map, this.camTarget);
    if (!hit) {
      this.reticle.visible = false;
      return;
    }
    this.reticleMat.color.setHex(SPELL_COLORS[spell] ?? 0xffffff);
    const dx = hit.x * TILE - this.camTarget.x;
    const dz = hit.z * TILE - this.camTarget.z;
    this.reticle.position.set(
      hit.x * TILE,
      Math.max(0, this.world.map.sampleHeight(hit.x, hit.z)) - CURVATURE * (dx * dx + dz * dz) + 0.3,
      hit.z * TILE,
    );
    this.reticle.visible = true;
  }
}
