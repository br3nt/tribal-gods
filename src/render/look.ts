/**
 * render/look.ts — every VISUAL constant in one place.
 *
 * config.ts holds the rules of the world; this file holds how the world
 * LOOKS: the palette the terrain is painted from, the sun, the sky, the
 * sea, the camera's framing and the quality tiers. Change a number here and
 * the game looks different but plays identically.
 *
 * Colours are written as sRGB hex (what a colour picker shows you). three's
 * colour management converts them to linear when they become THREE.Color,
 * and all lighting maths happens in linear space; the post chain (post.ts)
 * tone-maps the result back to sRGB on the way to the screen.
 *
 * Quality tiers: `?q=low|medium|high` forces one. Without it we start at
 * `high` and post.ts steps DOWN a tier if frame time stays poor (it never
 * steps back up mid-game: a look that flickers between tiers is worse than
 * a slightly cheaper steady one).
 */

// ---------------------------------------------------------------------------
// Quality tiers
// ---------------------------------------------------------------------------

export type QualityName = 'low' | 'medium' | 'high';

export interface QualityTier {
  name: QualityName;
  /** Max device-pixel-ratio we render at. */
  pixelRatio: number;
  /** Sun shadow map resolution (0 = no shadows). */
  shadowMapSize: number;
  /** PCF filter radius in shadow texels — softness of shadow edges. */
  shadowRadius: number;
  /** Terrain grid vertices per tile edge (1 = one quad per tile). */
  terrainSubdiv: number;
  /** Fine procedural ground detail (bump + speckle) in the terrain shader. */
  terrainDetail: boolean;
  /** Post chain: bloom, vignette, grade. false = draw straight to the screen. */
  post: boolean;
  /** MSAA samples on the HDR render target (0 = use FXAA instead). */
  msaa: number;
  bloom: boolean;
  /** Particle budget per layer. */
  particles: number;
}

export const QUALITY: Record<QualityName, QualityTier> = {
  low: {
    name: 'low', pixelRatio: 1, shadowMapSize: 1024, shadowRadius: 2, terrainSubdiv: 1,
    terrainDetail: false, post: false, msaa: 0, bloom: false, particles: 1500,
  },
  medium: {
    name: 'medium', pixelRatio: 1.5, shadowMapSize: 2048, shadowRadius: 3, terrainSubdiv: 2,
    terrainDetail: true, post: true, msaa: 0, bloom: true, particles: 3000,
  },
  high: {
    name: 'high', pixelRatio: 2, shadowMapSize: 4096, shadowRadius: 3.5, terrainSubdiv: 2,
    terrainDetail: true, post: true, msaa: 4, bloom: true, particles: 5000,
  },
};

const QUALITY_ORDER: QualityName[] = ['low', 'medium', 'high'];

/** The tier requested by `?q=`, or null when the game should pick (and adapt). */
export function forcedQuality(): QualityName | null {
  const q = new URLSearchParams(location.search).get('q');
  return q === 'low' || q === 'medium' || q === 'high' ? q : null;
}

export function initialQuality(): QualityTier {
  return QUALITY[forcedQuality() ?? 'high'];
}

export function lowerQuality(q: QualityName): QualityName | null {
  const i = QUALITY_ORDER.indexOf(q);
  return i > 0 ? QUALITY_ORDER[i - 1] : null;
}

/** Auto-fallback: average frame time (ms) above this for FALLBACK_WINDOW seconds drops a tier. */
export const FALLBACK_FRAME_MS = 24;
export const FALLBACK_WINDOW = 3;

// ---------------------------------------------------------------------------
// Time of day — the sun's position drives sky, light, fog and water.
// `?tod=golden` gives a low, warm late-afternoon sun (also nice for shots).
// ---------------------------------------------------------------------------

export interface SunPreset {
  /** Degrees above the horizon. */
  elevation: number;
  /** Degrees, compass-ish: 0 = +x, 90 = +z. */
  azimuth: number;
  color: number;
  intensity: number;
  /** Sky: colour straight up, at the horizon, and the glow around the sun. */
  zenith: number;
  horizon: number;
  sunGlow: number;
  /** Haze/fog colour far terrain fades into; the planet's atmosphere rim. */
  haze: number;
  /** Colour of space below the planet's rim (only visible zoomed far out). */
  space: number;
  /** Hemisphere fill: sky side / ground side. */
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  envIntensity: number;
}

export const SUN_PRESETS: Record<'day' | 'golden', SunPreset> = {
  day: {
    elevation: 48, azimuth: -35, color: 0xfff1dc, intensity: 3.1,
    zenith: 0x2a66c8, horizon: 0x9fcdee, sunGlow: 0xfff0c8,
    haze: 0xcfe6f4, space: 0x5d8fd0,
    hemiSky: 0xbcd8ff, hemiGround: 0x5a6a3a, hemiIntensity: 0.55, envIntensity: 0.75,
  },
  golden: {
    elevation: 17, azimuth: -20, color: 0xffc58a, intensity: 3.0,
    zenith: 0x3b5fa8, horizon: 0xf6c99a, sunGlow: 0xffb070,
    haze: 0xe8bfa0, space: 0x2a2a66,
    hemiSky: 0xa9b8e8, hemiGround: 0x5e4a30, hemiIntensity: 0.5, envIntensity: 0.7,
  },
};

export function sunPreset(): SunPreset {
  return new URLSearchParams(location.search).get('tod') === 'golden' ? SUN_PRESETS.golden : SUN_PRESETS.day;
}

/** ACES filmic tone-mapping exposure. */
export const EXPOSURE = 0.9;

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

/** Shadow frustum half-size = clamp(cameraDistance × K, MIN, MAX) world units. */
export const SHADOW_EXTENT_K = 0.95;
export const SHADOW_EXTENT_MIN = 26;
export const SHADOW_EXTENT_MAX = 150;
export const SHADOW_BIAS = -0.0004;
export const SHADOW_NORMAL_BIAS = 0.06;

/** Effect flash point lights: authored peak × this = candela. */
export const FLASH_SCALE = 0.012;

// ---------------------------------------------------------------------------
// Terrain palette (sRGB). The terrain shader splats between these by
// height, slope, moisture and what grows there.
// ---------------------------------------------------------------------------

export const TERRAIN = {
  seabed: 0x5f7a6a,
  seabedDeep: 0x2c4a52,
  wetSand: 0xb39a6c,
  sand: 0xdcc796,
  grassLush: 0x3f8a2e,
  grassLush2: 0x63a336,
  grassDry: 0x8ea446,
  grassDry2: 0xa9a850,
  forestFloor: 0x2f5a26,
  earth: 0x86684a,
  rock: 0x8b8378,
  rockDark: 0x5e5852,
  rockWarm: 0xa08a70,
  snow: 0xf4f7fb,
  swampMud: 0x4a4a28,
  swampWater: 0x34452a,
  scorch: 0x1c1612,
  /** Heights (world units) of the bands. */
  wetBand: 0.35,
  beachTop: 1.25,
  snowLine: 13.0,
  /** Slope (1 − normal.y) where earth / rock take over. */
  earthSlope: 0.16,
  rockSlope: 0.3,
};

/** Atmosphere rim: terrain beyond this distance (world units) from the
 *  camera target fades into the haze colour, so the edge of the drawn
 *  window melts into the planet's glowing limb instead of ending in a line. */
export const RIM_START = 96;
export const RIM_END = 122;

/** Where the planet's limb starts falling away faster than the parabola
 *  (world units from the camera target), and how hard (see curvature.ts). */
export const LIMB_START = 80;
export const LIMB_K = 0.0022;

/** Grass carpet around the camera (world/ground-cover.ts). Off at `low`. */
export const GROUND_COVER = {
  // (Clump spacing is fixed by world/grass-placement.ts: it must divide one
  // lap of the planet exactly so the carpet doesn't reshuffle at the seam.)
  /** Carpet radius around the camera target, by tier. */
  radiusHigh: 44,
  radiusMedium: 28,
  /** Tallest clump height (world units; a villager is ~2.3). */
  height: 0.4,
  tip: 0xd8e07a,
  /** Orbit distances over which the carpet shrinks away. */
  fadeOut: [55, 95] as [number, number],
};

/** The glowing halo around the planet's limb when zoomed out (sky.ts). */
export const ATMOSPHERE = {
  /** Radius (world units) of the sphere the planet's top approximates. */
  radius: 98,
  /** Halo thickness as a fraction of the radius. */
  width: 0.05,
  intensity: 1.4,
  /** Orbit distances over which the halo fades in. */
  fadeIn: [70, 150] as [number, number],
};

/** Distance fog (applies to every lit material, including models). */
export const FOG_NEAR_K = 1.6; // × camera distance
export const FOG_NEAR_MIN = 55;
export const FOG_FAR_K = 5;
export const FOG_FAR_ADD = 260;

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

export const WATER = {
  shallow: 0x3ccfc6,
  mid: 0x1f8fb6,
  deep: 0x0f3f78,
  foam: 0xf4fbff,
  /** Depth (world units) over which colour goes shallow → deep. */
  depthScale: 3.2,
  /** Alpha in the shallows / at depth. */
  alphaShallow: 0.45,
  alphaDeep: 0.94,
  roughness: 0.07,
  waveHeight: 0.12,
};

// ---------------------------------------------------------------------------
// Camera framing. A villager is ~2.3 units tall; a tile is 2.
// ---------------------------------------------------------------------------

export const CAMERA = {
  fov: 38,
  /** Orbit distance at zoom 0 / 1 (world units). */
  distMin: 13,
  distMax: 175,
  /** Pitch (radians above horizontal) at zoom 0 / 1 — hero shot to god view. */
  pitchMin: 0.32,
  pitchMax: 1.12,
  /** Where the game opens: frames a village with readable people. */
  defaultZoom: 0.27,
  defaultYaw: 0.7,
  /** Wheel sensitivity (zoom units per wheel delta pixel). */
  wheelZoom: 0.0011,
  /** Damping rates (1/s) — higher = snappier. */
  zoomDamp: 9,
  yawDamp: 12,
  panDamp: 10,
  panSpeed: 38,
  rotSpeed: 1.9,
  /** Middle-drag rotate sensitivity (radians per pixel). */
  dragRotate: 0.006,
  /** Optional edge-pan (off by default; `?edgepan=1` turns it on). */
  edgePanPx: 14,
  near: 0.5,
  far: 900,
};

// ---------------------------------------------------------------------------
// Figures under spells (unit-renderer.ts). Tints multiply the vertex colours
// of a shared material variant, so they stay cheap for hundreds of people.
// ---------------------------------------------------------------------------

export const UNIT_STATUS = {
  /** Stone Ward: a cool, faintly polished stone sheen. */
  ward: { color: 0xdde4ee, emissive: 0x0c1218, desaturate: 0.7, roughnessShift: -0.4, metalnessShift: 0.15, rim: 0x8aa4c0 },
  /** Warsong: a red-gold flush. */
  warsong: { color: 0xffd2a6, emissive: 0x2a0c02, desaturate: 0, roughnessShift: -0.1, metalnessShift: 0, rim: 0xd2601e },
  /** Both at once: the stone sheen, warmed red-gold. */
  both: { color: 0xf0d2b4, emissive: 0x1c0c04, desaturate: 0.45, roughnessShift: -0.3, metalnessShift: 0.15, rim: 0xc8783a },
  /** Cyclone: how high a caught figure is carried (world units), how fast it spins (rad/s). */
  liftHeight: 3.4,
  liftSpin: 9,
  /** Rates (1/s) at which a figure is snatched up / falls back down. */
  liftRise: 5,
  liftFall: 3.2,
  /** Rate (1/s) at which a fling's teleport is smoothed into a flight. */
  flingGlide: 3.5,
};

// ---------------------------------------------------------------------------
// Standing stones (monuments): how each spell's stone looks (assets/models/
// buildings/landmarks.ts draws the rune; building-renderer.ts the motes and
// the communing ritual). `glow` is the rune's light and the ritual's colour.
// Motes: what drifts round the stone — `pool` 'fire' is additive light,
// 'smoke' alpha-blended matter; vy < 0 falls from the top of the stone.
// ---------------------------------------------------------------------------

export interface SpellLook {
  glow: number;
  mote: { pool: 'fire' | 'smoke'; color: number; vy: number; size: number; life: number; rate: number; spread: number; alpha: number; swirl?: number };
}

export const SPELL_LOOK: Record<string, SpellLook> = {
  blast: { glow: 0xff9a40, mote: { pool: 'fire', color: 0xffb060, vy: 1.2, size: 0.28, life: 0.9, rate: 5, spread: 1.6, alpha: 0.9 } },
  convert: { glow: 0x88eaff, mote: { pool: 'fire', color: 0x9af0ff, vy: 0.7, size: 0.3, life: 2.2, rate: 4, spread: 2.2, alpha: 0.7, swirl: 0.6 } },
  flatten: { glow: 0xe6cf98, mote: { pool: 'smoke', color: 0xc8b48c, vy: 0.15, size: 0.5, life: 3, rate: 3, spread: 3, alpha: 0.3 } },
  bloom: { glow: 0x8cf07a, mote: { pool: 'smoke', color: 0x6fbf3a, vy: -0.5, size: 0.22, life: 4, rate: 4, spread: 2.4, alpha: 0.95 } },
  ward: { glow: 0xb8d4f0, mote: { pool: 'fire', color: 0xd8e8ff, vy: 0.25, size: 0.2, life: 2.6, rate: 4, spread: 2.2, alpha: 0.8 } },
  lightning: { glow: 0xbfe0ff, mote: { pool: 'fire', color: 0xd8ecff, vy: 0.4, size: 0.18, life: 0.35, rate: 9, spread: 2.0, alpha: 1 } },
  warsong: { glow: 0xff6a3a, mote: { pool: 'fire', color: 0xff8050, vy: 1.0, size: 0.25, life: 1.4, rate: 5, spread: 2.0, alpha: 0.85, swirl: 1.2 } },
  swamp: { glow: 0xa8c060, mote: { pool: 'smoke', color: 0x7a8a48, vy: 0.35, size: 0.35, life: 2.4, rate: 3, spread: 2.4, alpha: 0.5 } },
  landbridge: { glow: 0xe0c088, mote: { pool: 'smoke', color: 0xbca27a, vy: 0.2, size: 0.45, life: 2.8, rate: 3, spread: 2.6, alpha: 0.32 } },
  cyclone: { glow: 0xd8f4ff, mote: { pool: 'smoke', color: 0xe6f2f8, vy: 1.4, size: 0.35, life: 1.8, rate: 6, spread: 1.6, alpha: 0.4, swirl: 3.5 } },
  emberfall: { glow: 0xff7a20, mote: { pool: 'fire', color: 0xff8a30, vy: -1.4, size: 0.24, life: 1.6, rate: 7, spread: 2.0, alpha: 0.95 } },
  sink: { glow: 0x4ab0ff, mote: { pool: 'smoke', color: 0xc8e4f4, vy: 0.12, size: 0.9, life: 4, rate: 3, spread: 3.2, alpha: 0.28 } },
  earthquake: { glow: 0xe8955a, mote: { pool: 'smoke', color: 0x8a7258, vy: -0.8, size: 0.2, life: 1.6, rate: 5, spread: 1.8, alpha: 0.85 } },
  volcano: { glow: 0xff5020, mote: { pool: 'fire', color: 0xff6a20, vy: 1.6, size: 0.3, life: 1.3, rate: 8, spread: 1.4, alpha: 0.95 } },
};

/** Fallback for a spell added to the catalog before its stone is designed. */
export const SPELL_LOOK_DEFAULT: SpellLook = SPELL_LOOK.convert;

/** Hover highlight (render/highlight.ts): rim light + lift applied to the model under the cursor. */
export const HIGHLIGHT = {
  color: 0xffffff,
  emissive: 0x141414,
  rim: 0xbfd8ff,
  /** Instanced trees can't swap materials: their instance colour is multiplied instead. */
  treeBoost: 1.45,
};
