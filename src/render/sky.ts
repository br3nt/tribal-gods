/**
 * render/sky.ts — the sky dome, the sun, the clouds, and the atmosphere the
 * little planet floats in.
 *
 * One big sphere around the camera with a shader that colours each
 * direction:
 *
 *   ABOVE THE HORIZON — a zenith→horizon gradient, a warm glow around the
 *     sun plus a hot sun disc (bright enough that bloom haloes it), and
 *     soft drifting clouds: fbm noise projected onto a flat cloud layer,
 *     lit brighter on the sun side.
 *   BELOW THE HORIZON — normally hidden behind the ground, but on a planet
 *     this small, zoom out and you look PAST its curved edge. There we draw
 *     the atmosphere deliberately: a luminous haze band hugging the limb
 *     that deepens into twilight blue — the planet hangs in its own glow.
 *
 * The same shader (minus clouds, with a ground-bounce colour below the
 * horizon) is rendered once into a PMREM environment map: that's the sky
 * light and reflections every PBR material (terrain, sea, models) gets via
 * scene.environment.
 */

import * as THREE from 'three';
import { ATMOSPHERE, SunPreset } from './look';

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uZenith, uHorizon, uSunGlow, uHaze, uSpace, uGround, uSunColor;
  uniform float uTime;
  uniform float uClouds;   // 0 = none (env map), 1 = full
  uniform float uEnvMode;  // 1 = below horizon is ground bounce, not space
  varying vec3 vDir;

  float hash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }

  void main() {
    vec3 d = normalize(vDir);
    float y = d.y;
    float sunDot = max(dot(d, uSunDir), 0.0);
    vec3 col;

    if (y >= 0.0 || uEnvMode > 0.5 && y > -0.02) {
      float t = pow(clamp(y, 0.0, 1.0), 0.45);
      col = mix(uHorizon, uZenith, t);
      // Sun glow — wide warm wash + tighter halo.
      col += uSunGlow * (pow(sunDot, 6.0) * 0.35 + pow(sunDot, 64.0) * 0.6);
      // Clouds on a flat layer: project the view ray onto it.
      if (uClouds > 0.0 && y > 0.01) {
        vec2 uv = d.xz / (y + 0.08) * 1.6 + vec2(uTime * 0.012, uTime * 0.005);
        float n = fbm(uv);
        float cov = smoothstep(0.42, 0.72, n) * smoothstep(0.01, 0.12, y);
        float lit = 0.75 + 0.5 * pow(sunDot, 3.0);
        vec3 cloud = mix(uHorizon * 0.9, vec3(1.0), 0.7) * lit;
        // Darker bellies on thicker cloud.
        cloud *= 1.0 - 0.25 * smoothstep(0.65, 0.95, n);
        col = mix(col, cloud, cov * 0.85 * uClouds);
      }
      // Sun disc (HDR — the bloom pass gives it a halo).
      col += uSunColor * smoothstep(0.9993, 0.9997, sunDot) * 30.0;
    } else if (uEnvMode > 0.5) {
      // Environment light from below: warm-green bounce off the land.
      col = mix(uHaze * 0.6, uGround, smoothstep(-0.02, -0.3, y));
    } else {
      // Past the planet's rim: glowing limb haze into deep atmosphere.
      float k = clamp(-y, 0.0, 1.0);
      col = mix(uHaze * 1.08, uHorizon, smoothstep(0.0, 0.08, k));
      col = mix(col, uSpace, smoothstep(0.05, 0.6, k));
      col += uSunGlow * pow(sunDot, 8.0) * 0.2;
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly sunDir = new THREE.Vector3();
  readonly hazeColor: THREE.Color;
  private readonly material: THREE.ShaderMaterial;
  private envRT: THREE.WebGLRenderTarget | null = null;

  constructor(readonly preset: SunPreset) {
    const el = THREE.MathUtils.degToRad(preset.elevation);
    const az = THREE.MathUtils.degToRad(preset.azimuth);
    this.sunDir.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
    this.hazeColor = new THREE.Color(preset.haze);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uZenith: { value: new THREE.Color(preset.zenith) },
        uHorizon: { value: new THREE.Color(preset.horizon) },
        uSunGlow: { value: new THREE.Color(preset.sunGlow) },
        uHaze: { value: this.hazeColor },
        uSpace: { value: new THREE.Color(preset.space) },
        uGround: { value: new THREE.Color(preset.hemiGround) },
        uSunColor: { value: new THREE.Color(preset.color) },
        uTime: { value: 0 },
        uClouds: { value: 1 },
        uEnvMode: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false, // drawn first, behind everything
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  /**
   * Render the sky (without clouds, ground bounce below) into a prefiltered
   * environment map for image-based lighting. Call once after creation.
   */
  buildEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const scene = new THREE.Scene();
    const envMat = this.material.clone();
    envMat.uniforms.uClouds.value = 0.35;
    envMat.uniforms.uEnvMode.value = 1;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), envMat);
    scene.add(dome);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT?.dispose();
    this.envRT = pmrem.fromScene(scene, 0, 0.1, 100);
    pmrem.dispose();
    envMat.dispose();
    dome.geometry.dispose();
    return this.envRT.texture;
  }

  /** Keep the dome centred on the camera, inside the far plane. */
  update(camera: THREE.PerspectiveCamera, dt: number): void {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.9);
    this.material.uniforms.uTime.value += dt;
  }
}

/**
 * The atmosphere shell: a soft glowing halo hugging the planet's limb,
 * visible when zoomed out. The heightfield isn't a sphere, but near its
 * curved top it behaves like one of radius ATMOSPHERE.radius sitting under
 * the camera target — so we put an invisible sphere there and, per pixel,
 * measure how close the view ray passes to its centre. Rays that just miss
 * the planet glow brightest; the glow fades over a thin band outward. The
 * planet itself (drawn later, opaque) covers the inside.
 */
export class Atmosphere {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(haze: THREE.Color, sunDir: THREE.Vector3) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uR: { value: ATMOSPHERE.radius },
        uColor: { value: haze.clone().multiplyScalar(ATMOSPHERE.intensity) },
        uSunDir: { value: sunDir },
        uStrength: { value: 0 },
        uWidth: { value: ATMOSPHERE.width },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uCenter, uColor, uSunDir;
        uniform float uR, uStrength, uWidth;
        varying vec3 vWorld;
        void main() {
          vec3 rd = normalize(vWorld - cameraPosition);
          vec3 oc = uCenter - cameraPosition;
          float tca = dot(oc, rd);
          float b = sqrt(max(dot(oc, oc) - tca * tca, 0.0)) / uR; // 1 = grazing the limb
          float outer = exp(-max(b - 1.0, 0.0) / uWidth);
          float inner = exp(-max(1.0 - b, 0.0) / (uWidth * 0.35));
          float g = min(outer, inner);
          // Brighter on the sunward side of the limb.
          vec3 toEdge = normalize(cameraPosition + rd * tca - uCenter);
          float sunSide = 0.65 + 0.35 * max(dot(toEdge, uSunDir), 0.0);
          gl_FragColor = vec4(uColor * g * sunSide * uStrength, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -9;
  }

  update(target: THREE.Vector3, viewDistance: number): void {
    const R = ATMOSPHERE.radius;
    const u = this.material.uniforms;
    u.uCenter.value.set(target.x, target.y - R, target.z);
    this.mesh.position.copy(u.uCenter.value);
    this.mesh.scale.setScalar(R * (1 + ATMOSPHERE.width * 6));
    u.uStrength.value = THREE.MathUtils.smoothstep(viewDistance, ATMOSPHERE.fadeIn[0], ATMOSPHERE.fadeIn[1]);
  }
}
