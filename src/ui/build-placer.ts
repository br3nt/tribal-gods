/**
 * ui/build-placer.ts — placing building sites: the ghost-footprint tool.
 *
 * Classic RTS building placement: with a building tool active, a
 * translucent ghost of that building rides the cursor, tinted green where
 * the site is valid (flat enough, on land, not overlapping, affordable)
 * and red where it isn't. Click to commit — the sim takes over from there
 * and the braves come running.
 *
 * One ghost model is kept per building kind (built lazily, materials all
 * swapped for a single shared translucent material we tint). Validity is
 * the sim's call (world.canPlaceBuilding) — the UI only ever ASKS, never
 * decides, so the rules live in one place.
 */

import * as THREE from 'three';
import { CURVATURE, TILE } from '../config';
import {
  BuildingModel,
  buildFireHut,
  buildHut,
  buildTower,
  buildWarriorHut,
} from '../assets/models/buildings';
import { pickGroundTile } from '../render/ground-picker';
import { BuildingKind, World } from '../sim/world-state';
import { appState } from './app-state';
import { activeBuilding } from './tools';

const VALID = new THREE.Color(0x4dd06a);
const INVALID = new THREE.Color(0xd9544d);

export class BuildPlacer {
  private readonly ghosts = new Map<BuildingKind, THREE.Group>();
  private readonly ghostMat: THREE.MeshBasicMaterial;
  private pointerPx = { x: 0, y: 0 };
  private pointerOnScreen = false;
  private candidate: { kind: BuildingKind; x: number; z: number; ok: boolean } | null = null;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly camTarget: THREE.Vector3,
    private readonly world: World,
    canvas: HTMLCanvasElement,
    private readonly scene: THREE.Scene,
  ) {
    // One material for every ghost: depthWrite off so the translucency
    // doesn't self-occlude into a mess.
    this.ghostMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });

    canvas.addEventListener('pointermove', (e) => {
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.pointerOnScreen = true;
    });
    canvas.addEventListener('pointerleave', () => (this.pointerOnScreen = false));
    canvas.addEventListener('pointerdown', (e) => {
      if (appState.mode !== 'game') return;
      if (e.button === 0 && this.candidate?.ok && activeBuilding() === this.candidate.kind) {
        this.world.placeBuilding('player', this.candidate.kind, this.candidate.x, this.candidate.z);
      }
    });
  }

  private ghostFor(kind: BuildingKind): THREE.Group {
    let g = this.ghosts.get(kind);
    if (!g) {
      const builders: Record<BuildingKind, (c: number) => BuildingModel> = {
        hut: buildHut,
        warriorHut: buildWarriorHut,
        fireHut: buildFireHut,
        tower: buildTower,
      };
      const model = builders[kind](0xffffff);
      model.setProgress(1); // ghosts show the finished building
      model.root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.material = this.ghostMat;
      });
      g = model.root;
      g.visible = false;
      this.scene.add(g);
      this.ghosts.set(kind, g);
    }
    return g;
  }

  /** Called once per render frame: track the cursor, snap, validate, tint. */
  update(): void {
    const kind = appState.mode === 'game' ? activeBuilding() : null;
    for (const [k, g] of this.ghosts) g.visible = k === kind && this.pointerOnScreen;
    if (!kind || !this.pointerOnScreen) {
      this.candidate = null;
      return;
    }
    const ghost = this.ghostFor(kind);
    const hit = pickGroundTile(this.pointerPx.x, this.pointerPx.y, this.camera, this.world.map, this.camTarget);
    if (!hit) {
      ghost.visible = false;
      this.candidate = null;
      return;
    }

    const cx = Math.round(hit.x);
    const cz = Math.round(hit.z);
    const ok = this.world.canPlaceBuilding('player', kind, cx, cz);
    this.candidate = { kind, x: cx, z: cz, ok };

    this.ghostMat.color.copy(ok ? VALID : INVALID);
    const dx = cx * TILE - this.camTarget.x;
    const dz = cz * TILE - this.camTarget.z;
    ghost.position.set(
      cx * TILE,
      this.world.map.heightAt(cx, cz) - CURVATURE * (dx * dx + dz * dz),
      cz * TILE,
    );
    ghost.visible = true;
  }
}
