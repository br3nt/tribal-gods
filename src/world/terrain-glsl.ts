/**
 * world/terrain-glsl.ts — GLSL shared by the terrain, its shadow caster and
 * the sea.
 *
 * THE HEIGHTMAP LIVES ON THE GPU. The 128×128 height array is uploaded as a
 * float texture (64 KB — re-uploading it after a spell is nothing). Every
 * terrain vertex samples it in the vertex shader, so:
 *
 *   - the terrain mesh is a fixed grid that just slides with the camera
 *     (no per-vertex CPU refill when you pan or sculpt);
 *   - we can draw the ground at 2–3 vertices per tile and interpolate
 *     BICUBICALLY (Catmull-Rom) between the tile heights, so hills are
 *     smooth curves instead of faceted triangles — while still passing
 *     exactly through every tile's height (trees, which sit on whole
 *     tiles, stay planted);
 *   - the sea can ask "how deep is it here?" per PIXEL by sampling the same
 *     texture, which is how it gets turquoise shallows and shoreline foam
 *     without reading back a depth buffer.
 *
 * Catmull-Rom with its derivative gives height AND slope in one 16-tap
 * pass, so the normal comes for free. The CPU (picking, unit feet) still
 * samples bilinearly; the two surfaces agree exactly at tile corners and
 * differ by a few centimetres in between.
 *
 * The noise is value noise that tiles every 256 world units (one lap of the
 * planet), so procedural detail doesn't seam where the world wraps.
 */

import { TILE, WORLD_SIZE } from '../config';

const f = (n: number) => n.toFixed(1);

/** Uniform declarations + height sampling. Needs `uHeightTex`. */
export const heightGlsl = /* glsl */ `
  uniform sampler2D uHeightTex;
  #define TG_N ${f(WORLD_SIZE)}
  #define TG_TILE ${f(TILE)}

  float tgTexel(vec2 p) {
    ivec2 q = ivec2(mod(p, TG_N));
    return texelFetch(uHeightTex, q, 0).r;
  }

  // Height (x) and its gradient per TILE (y = d/dx, z = d/dz) at fractional
  // tile coordinate t, Catmull-Rom bicubic.
  vec3 tgHeightGrad(vec2 t) {
    vec2 i = floor(t);
    vec2 f = t - i;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec4 wx = vec4(-0.5*f3.x + f2.x - 0.5*f.x, 1.5*f3.x - 2.5*f2.x + 1.0, -1.5*f3.x + 2.0*f2.x + 0.5*f.x, 0.5*f3.x - 0.5*f2.x);
    vec4 wz = vec4(-0.5*f3.y + f2.y - 0.5*f.y, 1.5*f3.y - 2.5*f2.y + 1.0, -1.5*f3.y + 2.0*f2.y + 0.5*f.y, 0.5*f3.y - 0.5*f2.y);
    vec4 dx = vec4(-1.5*f2.x + 2.0*f.x - 0.5, 4.5*f2.x - 5.0*f.x, -4.5*f2.x + 4.0*f.x + 0.5, 1.5*f2.x - f.x);
    vec4 dz = vec4(-1.5*f2.y + 2.0*f.y - 0.5, 4.5*f2.y - 5.0*f.y, -4.5*f2.y + 4.0*f.y + 0.5, 1.5*f2.y - f.y);
    float h = 0.0, gx = 0.0, gz = 0.0;
    for (int j = 0; j < 4; j++) {
      vec4 row = vec4(
        tgTexel(i + vec2(-1.0, float(j - 1))),
        tgTexel(i + vec2( 0.0, float(j - 1))),
        tgTexel(i + vec2( 1.0, float(j - 1))),
        tgTexel(i + vec2( 2.0, float(j - 1))));
      float rh = dot(wx, row);
      h += wz[j] * rh;
      gz += dz[j] * rh;
      gx += wz[j] * dot(dx, row);
    }
    return vec3(h, gx, gz);
  }

  float tgHeightAtWorld(vec2 worldXZ) {
    return tgHeightGrad(worldXZ / TG_TILE).x;
  }
`;

/** Periodic value noise + fbm. All periods divide one planet lap (256 units). */
export const noiseGlsl = /* glsl */ `
  float tgHash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p.yx + 33.33);
    return fract((p.x + p.y) * p.x);
  }
  // Value noise in [0,1]; lattice wraps every \`period\` cells.
  float tgNoise(vec2 p, float period) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = tgHash(mod(i, period));
    float b = tgHash(mod(i + vec2(1.0, 0.0), period));
    float c = tgHash(mod(i + vec2(0.0, 1.0), period));
    float d = tgHash(mod(i + vec2(1.0, 1.0), period));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float tgFbm(vec2 p, float period) {
    float s = 0.0, a = 0.5;
    for (int o = 0; o < 4; o++) {
      s += a * tgNoise(p, period);
      p *= 2.0; period *= 2.0; a *= 0.5;
    }
    return s / 0.9375;
  }
`;

/**
 * Bump-map a view-space normal by a scalar height field `bh` (world units)
 * using screen-space derivatives (Mikkelsen, "Bump Mapping Unparametrized
 * Surfaces on the GPU"). Unnormalised so the strength is in real units at
 * every distance.
 */
export const bumpGlsl = /* glsl */ `
  vec3 tgPerturb(vec3 surfPos, vec3 n, float bh, float faceDirection) {
    vec3 sx = dFdx(surfPos);
    vec3 sy = dFdy(surfPos);
    vec2 dH = vec2(dFdx(bh), dFdy(bh));
    vec3 r1 = cross(sy, n);
    vec3 r2 = cross(n, sx);
    float det = dot(sx, r1) * faceDirection;
    vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
    return normalize(abs(det) * n - grad);
  }
`;
