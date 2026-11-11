/**
 * render/camera-rig.ts — the god's-eye orbit camera.
 *
 * The entire camera model is three numbers:
 *
 *   target — the point on the ground we're looking at (the "interesting bit")
 *   yaw    — angle we've orbited around that point
 *   zoom   — 0..1, how far out we are
 *
 * Each frame we convert those into a camera position with basic spherical
 * coordinates: stand `dist` away from the target, rotated `yaw` around it,
 * tilted `pitch` above the horizon. Pitch is DERIVED from zoom — zoomed in
 * you skim low across the village like a swooping bird (a hero shot of
 * your people), zoomed out you look down like a god and see the planet
 * curve away. Coupling them is a big part of why the view feels composed.
 *
 * DAMPING. Input never moves the camera directly: wheel, keys and drags
 * move GOALS (zoomGoal, yawGoal, a pan velocity), and the camera eases
 * toward them exponentially every frame (framerate-independent). That one
 * change is most of the difference between "debug camera" and "game".
 *
 * ZOOM TOWARD CURSOR. While zooming in, the target slides toward the ground
 * point under the mouse, so the thing you pointed at stays under the
 * pointer. Middle-drag rotates; optional edge-pan with `?edgepan=1`.
 *
 * The target moves in continuous, UNWRAPPED world units. You can pan east
 * forever; the terrain samples the wrapped heightmap, so the world just
 * keeps coming. That's the planet. The camera target is also what the
 * whole world curves around (see world/curvature.ts).
 *
 * Framing constants live in render/look.ts (CAMERA).
 */

import * as THREE from 'three';
import { TILE } from '../config';
import { clamp, lerp } from '../core/util';
import { Heightmap } from '../world/heightmap';
import { pickGroundTile } from './ground-picker';
import { CAMERA } from './look';

/** Exponential approach factor for rate `k` (1/s) over `dt` seconds. */
const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();

  private yawNow = CAMERA.defaultYaw;
  private yawGoal = CAMERA.defaultYaw;
  private zoomNow = CAMERA.defaultZoom;
  private zoomGoal = CAMERA.defaultZoom;
  private readonly panVel = new THREE.Vector2();
  /** Pending target shift from zoom-toward-cursor, applied with damping. */
  private readonly zoomShift = new THREE.Vector2();

  /** target.y eases toward the terrain height rather than tracking it raw —
   *  panning over a cliff shouldn't slam the whole view up a wall. */
  private smoothedGroundY = 0;

  private readonly keys = new Set<string>();
  private dragging = false;
  private mouseX = innerWidth / 2;
  private mouseY = innerHeight / 2;
  private mouseInside = false;
  private readonly edgePan = new URLSearchParams(location.search).get('edgepan') === '1';
  /** Current trauma level; decays exponentially. See shake(). */
  private shakeAmp = 0;

  /** 0..1 zoom. Setting it jumps (no easing) — for scripts and level loads. */
  get zoom(): number {
    return this.zoomNow;
  }
  set zoom(z: number) {
    this.zoomNow = this.zoomGoal = clamp(z, 0, 1);
  }
  get yaw(): number {
    return this.yawNow;
  }
  set yaw(y: number) {
    this.yawNow = this.yawGoal = y;
  }
  /** Current orbit distance in world units (lighting sizes shadows from it). */
  get distance(): number {
    return lerp(CAMERA.distMin, CAMERA.distMax, this.zoomNow * this.zoomNow);
  }

  constructor(
    private readonly map: Heightmap,
    canvas: HTMLCanvasElement,
  ) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, innerWidth / innerHeight, CAMERA.near, CAMERA.far);

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear()); // alt-tab shouldn't leave keys stuck down

    // Wheel = zoom (toward the cursor). `passive: false` stops browser page-zoom.
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const before = this.zoomGoal;
        this.zoomGoal = clamp(this.zoomGoal + e.deltaY * CAMERA.wheelZoom, 0, 1);
        const zoomingIn = this.zoomGoal < before;
        if (!zoomingIn) return;
        const hit = pickGroundTile(e.clientX, e.clientY, this.camera, this.map, this.target);
        if (!hit) return;
        // Slide toward the pointed-at spot in proportion to how much closer we get.
        const dBefore = lerp(CAMERA.distMin, CAMERA.distMax, before * before);
        const dAfter = lerp(CAMERA.distMin, CAMERA.distMax, this.zoomGoal * this.zoomGoal);
        const frac = clamp(1 - dAfter / dBefore, 0, 0.5);
        this.zoomShift.x += (hit.x * TILE - this.target.x) * frac;
        this.zoomShift.y += (hit.z * TILE - this.target.z) * frac;
      },
      { passive: false },
    );

    // Middle-drag = rotate.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.dragging = true;
      }
    });
    addEventListener('pointerup', (e) => {
      if (e.button === 1) this.dragging = false;
    });
    addEventListener('pointermove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.mouseInside = true;
      if (this.dragging) this.yawGoal -= e.movementX * CAMERA.dragRotate;
    });
    document.addEventListener('pointerleave', () => (this.mouseInside = false));

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  update(dt: number): void {
    // --- Rotation (Q/E) → goal; eased below ---
    if (this.keys.has('KeyQ')) this.yawGoal += CAMERA.rotSpeed * dt;
    if (this.keys.has('KeyE')) this.yawGoal -= CAMERA.rotSpeed * dt;
    this.yawNow += (this.yawGoal - this.yawNow) * damp(CAMERA.yawDamp, dt);
    this.zoomNow += (this.zoomGoal - this.zoomNow) * damp(CAMERA.zoomDamp, dt);

    // --- Panning (WASD / edge), relative to where the camera faces ---
    // At yaw=0 the camera sits south of the target looking north (-z), so
    // "forward" on the ground is (-sin yaw, -cos yaw). Faster zoomed out:
    // you're moving a gaze across a planet, not a person across a field.
    let ix = 0;
    let iz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) iz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) iz -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) ix += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) ix -= 1;
    if (this.edgePan && this.mouseInside && !this.dragging) {
      const m = CAMERA.edgePanPx;
      if (this.mouseX < m) ix -= 1;
      if (this.mouseX > innerWidth - m) ix += 1;
      if (this.mouseY < m) iz += 1;
      if (this.mouseY > innerHeight - m) iz -= 1;
    }
    const speed = CAMERA.panSpeed * lerp(0.45, 2.6, this.zoomNow);
    const fx = -Math.sin(this.yawNow), fz = -Math.cos(this.yawNow);
    const rx = Math.cos(this.yawNow), rz = -Math.sin(this.yawNow);
    const goalVx = (fx * iz + rx * ix) * speed;
    const goalVz = (fz * iz + rz * ix) * speed;
    const a = damp(CAMERA.panDamp, dt);
    this.panVel.x += (goalVx - this.panVel.x) * a;
    this.panVel.y += (goalVz - this.panVel.y) * a;
    this.target.x += this.panVel.x * dt;
    this.target.z += this.panVel.y * dt;

    // Zoom-toward-cursor shift, eased in at the zoom's own pace.
    const zs = damp(CAMERA.zoomDamp, dt);
    this.target.x += this.zoomShift.x * zs;
    this.target.z += this.zoomShift.y * zs;
    this.zoomShift.multiplyScalar(1 - zs);

    // --- Keep the target glued (softly) to the ground ---
    const groundY = Math.max(0, this.map.sampleHeight(this.target.x / TILE, this.target.z / TILE));
    this.smoothedGroundY = lerp(groundY, this.smoothedGroundY, Math.pow(0.001, dt));
    this.target.y = this.smoothedGroundY;

    // --- Spherical coords → camera position ---
    const dist = this.distance; // quadratic in zoom: finer control up close
    // Pitch eases in: stays low longer near the ground (hero shots), then
    // rises toward the god view.
    const pitch = lerp(CAMERA.pitchMin, CAMERA.pitchMax, Math.pow(this.zoomNow, 0.7));
    const horiz = dist * Math.cos(pitch);
    const vert = dist * Math.sin(pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yawNow) * horiz,
      this.target.y + vert,
      this.target.z + Math.cos(this.yawNow) * horiz,
    );
    // Look slightly ABOVE the target when close, so the hero shot shows
    // sky-ward depth instead of staring at feet.
    const lift = lerp(1.2, 0, Math.min(1, this.zoomNow * 2.5));
    this.camera.lookAt(this.target.x, this.target.y + lift, this.target.z);

    // SCREEN SHAKE — random jitter scaled by a decaying "trauma" level;
    // applied AFTER lookAt so the aim point wobbles too.
    if (this.shakeAmp > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmp;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmp * 0.6;
      this.camera.position.z += (Math.random() - 0.5) * this.shakeAmp;
      this.shakeAmp *= Math.pow(0.04, dt); // ~96% gone within a second
    }
  }

  /** Kick the camera. Earthquakes call this a lot. */
  shake(strength: number): void {
    this.shakeAmp = Math.min(2.5, Math.max(this.shakeAmp, strength));
  }
}
