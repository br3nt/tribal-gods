/**
 * world/water.ts — the ocean.
 *
 * Water in this kind of game is gloriously fake: a single translucent plane
 * at sea level (y = 0). The "depth" you perceive is the seafloor's colors
 * darkening underneath it (terrain-mesh.ts paints submerged land murkier),
 * seen through the alpha blend. No simulation, no reflections.
 *
 * Three small touches sell it:
 *   - a gentle traveling sine swell so the surface isn't a dead sheet,
 *   - alpha + a slight brightening where the swell peaks (cheap "sparkle"),
 *   - the same curvature bend as the terrain, so the ocean falls over the
 *     horizon with the land instead of hovering as a flat blue ruler line.
 *
 * The plane is sized to the view window and simply follows the camera
 * target — infinite ocean for the price of one quad grid.
 */

import * as THREE from 'three';
import { COLOR_WATER, TILE, VIEW_TILES } from '../config';
import { curvatureGlsl, curvatureUniforms } from './curvature';

export class Water {
  readonly mesh: THREE.Mesh;
  private readonly uTime = { value: 0 };

  constructor() {
    const size = VIEW_TILES * TILE;
    // Plenty of segments: the curvature bend and the swell are both
    // per-vertex, so a low-poly plane would show faceted artifacts.
    const geometry = new THREE.PlaneGeometry(size, size, 96, 96);
    geometry.rotateX(-Math.PI / 2); // PlaneGeometry is vertical by default

    const material = new THREE.ShaderMaterial({
      transparent: true,
      // Translucent surfaces shouldn't write depth: terrain must stay
      // visible through the water, not get z-fought out of existence.
      depthWrite: false,
      uniforms: {
        ...curvatureUniforms,
        uTime: this.uTime,
        uColor: { value: new THREE.Color(COLOR_WATER) },
      },
      vertexShader: /* glsl */ `
        ${curvatureGlsl}
        uniform float uTime;
        varying float vSwell;
        void main() {
          vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          // Two crossed sine waves make an irregular-looking swell from
          // pure regularity — their sum never quite repeats on screen.
          vSwell = sin(worldPos.x * 0.20 + uTime * 1.1)
                 * sin(worldPos.z * 0.16 + uTime * 0.8);
          worldPos.y += vSwell * 0.18; // amplitude in world units: subtle!
          gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(worldPos), 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vSwell;
        void main() {
          // Swell peaks catch a touch of extra light — poor man's glints.
          vec3 col = uColor * (1.0 + vSwell * 0.08);
          gl_FragColor = vec4(col, 0.55);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false; // same reason as the terrain: the shader bends it
    // Render after terrain so the alpha blend has the seafloor to blend onto.
    this.mesh.renderOrder = 1;
  }

  /** Follow the camera and advance the swell. Called once per frame. */
  update(camTargetWorld: THREE.Vector3, dt: number): void {
    this.mesh.position.set(camTargetWorld.x, 0, camTargetWorld.z);
    this.uTime.value += dt;
  }
}
