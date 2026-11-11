/**
 * render/post.ts — the image after the image: HDR → bloom → grade → screen.
 *
 * The scene renders into a half-float (HDR) target — multisampled at high
 * quality so edges stay smooth — then:
 *
 *   1. BLOOM (UnrealBloomPass) with a threshold above 1.0, so only things
 *      brighter than white glow: the sun disc, glints on the sea, magic,
 *      fire. Ordinary lit ground never blooms.
 *   2. GRADE: a gentle colour grade + soft vignette in one tiny shader:
 *      a touch of saturation, warm highlights / cool shadows, and the
 *      corners darkened so the eye settles on the middle of the screen.
 *   3. OUTPUT: ACES filmic tone mapping + sRGB encode (OutputPass).
 *   4. FXAA when the target couldn't be multisampled.
 *
 * At `low` quality there is no composer at all: the renderer tone-maps
 * straight to the canvas with its built-in MSAA.
 *
 * The QUALITY GOVERNOR watches frame time; if it stays poor for a few
 * seconds (and nobody forced a tier with ?q=) it steps down one tier and
 * tells main.ts to re-apply settings.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {
  EXPOSURE,
  FALLBACK_FRAME_MS,
  FALLBACK_WINDOW,
  QUALITY,
  QualityTier,
  forcedQuality,
  lowerQuality,
} from './look';

/** Replaces NaN/Inf pixels before bloom: one bad pixel would otherwise be
 *  blurred across the whole screen by the bloom mip chain. */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      bvec4 bad = bvec4(isnan(c.r) || isinf(c.r), isnan(c.g) || isinf(c.g), isnan(c.b) || isinf(c.b), isnan(c.a) || isinf(c.a));
      gl_FragColor = any(bad) ? vec4(0.0, 0.0, 0.0, 1.0) : min(c, vec4(256.0));
    }
  `,
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.32 },
    uSaturation: { value: 1.08 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette, uSaturation, uAspect;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSaturation);
      // Split tone: cool the shadows, warm the highlights, very slightly.
      float k = smoothstep(0.0, 0.8, l);
      c.rgb *= mix(vec3(0.96, 0.99, 1.05), vec3(1.03, 1.0, 0.96), k);
      // Soft elliptical vignette.
      vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
      float v = smoothstep(0.35, 1.05, length(p) * 1.15);
      c.rgb *= 1.0 - uVignette * v;
      gl_FragColor = c;
    }
  `,
};

export class PostChain {
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  private fxaa: FXAAPass | null = null;
  private frameMsAvg = 16;
  private slowFor = 0;
  private warmup = 4; // seconds before the governor judges anything
  /** Called after the governor drops a tier. */
  onQualityChange: ((q: QualityTier) => void) | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    public quality: QualityTier,
  ) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.build();
  }

  private build(): void {
    this.bloom?.dispose(); // passes own render targets the composer doesn't free
    this.fxaa?.dispose();
    this.bloom = null;
    this.fxaa = null;
    this.composer?.dispose();
    this.composer = null;
    const q = this.quality;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    if (!q.post) return;

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: q.msaa,
    });
    const composer = new EffectComposer(this.renderer, target);
    composer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio));
    composer.setSize(innerWidth, innerHeight);
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (q.bloom) {
      composer.addPass(new ShaderPass(SanitizeShader));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.55, 1.0);
      composer.addPass(this.bloom);
    }
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uAspect.value = innerWidth / innerHeight;
    composer.addPass(this.grade);
    composer.addPass(new OutputPass());
    if (q.msaa === 0) {
      this.fxaa = new FXAAPass();
      composer.addPass(this.fxaa);
    }
    this.composer = composer;
  }

  /** Switch tier now (Settings → Graphics): rebuilds the post chain and pixel ratio in place. */
  setQuality(q: QualityTier): void {
    this.quality = q;
    this.slowFor = 0;
    this.warmup = 4;
    this.grade = null;
    this.build();
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    if (this.grade) this.grade.uniforms.uAspect.value = w / h;
  }

  render(dt: number): void {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.govern(dt);
  }

  /** Step down a tier if frames stay slow. Never steps back up mid-session. */
  private govern(dt: number): void {
    if (forcedQuality() || document.hidden) return;
    const ms = Math.min(dt * 1000, 100);
    this.frameMsAvg += (ms - this.frameMsAvg) * 0.05;
    if (this.warmup > 0) {
      this.warmup -= dt;
      return;
    }
    this.slowFor = this.frameMsAvg > FALLBACK_FRAME_MS ? this.slowFor + dt : 0;
    if (this.slowFor < FALLBACK_WINDOW) return;
    const next = lowerQuality(this.quality.name);
    if (!next) return;
    console.info(`[look] frame time ~${this.frameMsAvg.toFixed(1)} ms — dropping quality to ${next}`);
    this.quality = QUALITY[next];
    this.slowFor = 0;
    this.warmup = 4;
    this.build();
    this.onQualityChange?.(this.quality);
  }
}
