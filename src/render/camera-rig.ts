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
 * you skim low across the village like a swooping bird, zoomed out you look
 * down like a god. Coupling them (rather than free-look) is a big part of
 * why these games feel composed from every angle.
 *
 * The camera target is also what the whole world curves around (see
 * world/curvature.ts) — wherever you look is the "top" of the planet.
 *
 * Note the target moves in continuous, UNWRAPPED world units. You can pan
 * east forever; the terrain window (terrain-mesh.ts) samples the wrapped
 * heightmap, so the world just keeps coming. That's the planet.
 */

import * as THREE from 'three';
import {
  CAM_DIST_MAX,
  CAM_DIST_MIN,
  CAM_PAN_SPEED,
  CAM_PITCH_MAX,
  CAM_PITCH_MIN,
  CAM_ROT_SPEED,
  TILE,
} from '../config';
import { clamp, lerp } from '../core/util';
import { Heightmap } from '../world/heightmap';

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();

  private yaw = 0.7;
  private zoom = 0.55;
  /** target.y eases toward the terrain height rather than tracking it raw —
   *  panning over a cliff shouldn't slam the whole view up a wall. */
  private smoothedGroundY = 0;

  private readonly keys = new Set<string>();
  private dragging = false;
  /** Current trauma level; decays exponentially. See shake(). */
  private shakeAmp = 0;

  constructor(
    private readonly map: Heightmap,
    canvas: HTMLCanvasElement,
  ) {
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 600);

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear()); // alt-tab shouldn't leave keys stuck down

    // Wheel = zoom. `passive: false` lets us stop the browser page-zooming.
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = clamp(this.zoom + e.deltaY * 0.0009, 0, 1);
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
      if (this.dragging) this.yaw -= e.movementX * 0.005;
    });

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  update(dt: number): void {
    // --- Rotation (Q/E) ---
    if (this.keys.has('KeyQ')) this.yaw += CAM_ROT_SPEED * dt;
    if (this.keys.has('KeyE')) this.yaw -= CAM_ROT_SPEED * dt;

    // --- Panning (WASD), relative to where the camera faces ---
    // At yaw=0 the camera sits south of the target looking north (-z), so
    // "forward" on the ground is (-sin yaw, -cos yaw) and "right" is
    // perpendicular to it. Panning is faster zoomed out: you're moving a
    // gaze across a planet, not a person across a field.
    const speed = CAM_PAN_SPEED * lerp(0.5, 2.2, this.zoom) * dt;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    if (this.keys.has('KeyW')) { this.target.x += fx * speed; this.target.z += fz * speed; }
    if (this.keys.has('KeyS')) { this.target.x -= fx * speed; this.target.z -= fz * speed; }
    if (this.keys.has('KeyD')) { this.target.x += rx * speed; this.target.z += rz * speed; }
    if (this.keys.has('KeyA')) { this.target.x -= rx * speed; this.target.z -= rz * speed; }

    // --- Keep the target glued (softly) to the ground ---
    const groundY = Math.max(0, this.map.sampleHeight(this.target.x / TILE, this.target.z / TILE));
    // Exponential ease. The pow() makes the smoothing framerate-independent:
    // same convergence per second whether we render 30 or 144 fps.
    this.smoothedGroundY = lerp(groundY, this.smoothedGroundY, Math.pow(0.001, dt));
    this.target.y = this.smoothedGroundY;

    // --- Spherical coords → camera position ---
    const dist = lerp(CAM_DIST_MIN, CAM_DIST_MAX, this.zoom * this.zoom); // quadratic: finer control up close
    const pitch = lerp(CAM_PITCH_MIN, CAM_PITCH_MAX, this.zoom);
    const horiz = dist * Math.cos(pitch); // distance along the ground
    const vert = dist * Math.sin(pitch); // height above the target
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horiz,
      this.target.y + vert,
      this.target.z + Math.cos(this.yaw) * horiz,
    );
    this.camera.lookAt(this.target);

    // SCREEN SHAKE — the cheapest special effect with the biggest payoff.
    // Random jitter scaled by a decaying "trauma" level; applied AFTER
    // lookAt so the aim point wobbles too (rotational shake reads far more
    // violent than positional alone).
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
