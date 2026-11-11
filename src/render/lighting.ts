/**
 * render/lighting.ts — the sun, the sky fill, and borrowed flashes.
 *
 * SUN. One DirectionalLight with a soft (PCF, wide-radius) shadow map. A
 * directional light's shadow is an orthographic camera looking along the
 * sun's rays; we park it over the CAMERA TARGET every frame and size its
 * box to what's on screen (tight when zoomed in = crisp shadows on
 * people, wide when zoomed out = the whole view is shadowed). The box
 * centre is snapped to whole shadow-map texels in light space, otherwise
 * every pixel of pan would re-rasterise the shadow edges and they'd crawl.
 *
 * Curvature: the shadow pass uses curved depth materials (curvature.ts),
 * and since the bend is centred on the same camera target, the hill that
 * casts a shadow and the ground it falls on are bent identically.
 *
 * FILL. A HemisphereLight (sky colour from above, warm ground bounce from
 * below) on top of the sky's environment map, so shadowed sides are blue-
 * cool and never black.
 *
 * FLASHES. Lightning and explosions borrow one of a small permanent pool of
 * point lights. Adding/removing lights would recompile every shader in the
 * scene (light counts are compiled in), so the pool always exists and idle
 * lights just sit at intensity 0.
 */

import * as THREE from 'three';
import {
  QualityTier,
  SHADOW_BIAS,
  SHADOW_EXTENT_K,
  SHADOW_EXTENT_MAX,
  SHADOW_EXTENT_MIN,
  SHADOW_NORMAL_BIAS,
  FLASH_SCALE,
  SunPreset,
} from './look';

const FLASH_POOL = 2;

interface Flash {
  light: THREE.PointLight;
  age: number;
  ttl: number;
  peak: number;
}

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly flashes: Flash[] = [];
  private nextFlash = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly lightSpace = new THREE.Matrix4();
  private readonly lightSpaceInv = new THREE.Matrix4();

  constructor(
    scene: THREE.Scene,
    private readonly sunDir: THREE.Vector3,
    preset: SunPreset,
    quality: QualityTier,
  ) {
    this.sun = new THREE.DirectionalLight(preset.color, preset.intensity);
    this.sun.castShadow = quality.shadowMapSize > 0;
    this.applyQuality(quality);
    this.sun.shadow.bias = SHADOW_BIAS;
    this.sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
    this.sun.shadow.intensity = 0.85; // never pitch black — sky light reaches in
    this.sun.target.userData.gpuCurved = true; // not a CPU-curved prop (see applyLimbToCpuCurved)
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(preset.hemiSky, preset.hemiGround, preset.hemiIntensity);
    scene.add(this.hemi);

    for (let i = 0; i < FLASH_POOL; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 40, 1.6);
      scene.add(light);
      this.flashes.push({ light, age: 1, ttl: 1, peak: 0 });
    }
  }

  applyQuality(q: QualityTier): void {
    const s = this.sun.shadow;
    if (q.shadowMapSize <= 0) {
      this.sun.castShadow = false;
      return;
    }
    if (s.mapSize.x !== q.shadowMapSize) {
      s.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      s.map?.dispose();
      s.map = null;
    }
    s.radius = q.shadowRadius;
  }

  /** Follow the camera target; size the shadow box to the view distance. */
  update(target: THREE.Vector3, viewDistance: number, dt: number): void {
    const extent = THREE.MathUtils.clamp(viewDistance * SHADOW_EXTENT_K, SHADOW_EXTENT_MIN, SHADOW_EXTENT_MAX);
    const cam = this.sun.shadow.camera;
    if (cam.right !== extent) {
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.near = 1;
      cam.far = 400;
      cam.updateProjectionMatrix();
    }

    // Snap the box centre to whole shadow texels, measured in light space.
    const texel = (2 * extent) / this.sun.shadow.mapSize.x;
    this.lightSpace.lookAt(new THREE.Vector3(), this.tmp.copy(this.sunDir).negate(), THREE.Object3D.DEFAULT_UP);
    this.lightSpaceInv.copy(this.lightSpace).invert();
    const p = this.tmp.copy(target).applyMatrix4(this.lightSpaceInv);
    p.x = Math.round(p.x / texel) * texel;
    p.y = Math.round(p.y / texel) * texel;
    p.applyMatrix4(this.lightSpace);

    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.sunDir, 200);
    this.sun.target.updateMatrixWorld();

    for (const f of this.flashes) {
      if (f.age >= f.ttl) continue;
      f.age += dt;
      const k = Math.max(0, 1 - f.age / f.ttl);
      f.light.intensity = f.peak * k * k;
    }
  }

  /** Borrow a point light for a flash at an (already curved) world position. */
  flash(pos: THREE.Vector3, color: number, peak: number, ttl: number, range = 40): void {
    const f = this.flashes[this.nextFlash];
    this.nextFlash = (this.nextFlash + 1) % this.flashes.length;
    f.light.position.copy(pos);
    f.light.color.setHex(color);
    f.light.distance = range;
    // Peaks are authored on a 0–3000 'drama' scale; scaled here so even a
    // big flash stays well inside half-float range (an Inf pixel would
    // poison the bloom chain).
    f.peak = Math.min(peak, 3000) * FLASH_SCALE;
    f.age = 0;
    f.ttl = ttl;
    f.light.intensity = f.peak;
  }
}
