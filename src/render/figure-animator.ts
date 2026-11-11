/**
 * render/figure-animator.ts — animation as readable maths.
 *
 * Industrial engines store animation as baked curves exported from a DCC
 * tool. We write each clip as a small function from time to a POSE: Euler
 * angles for every bone of the shared skeleton (people/rig.ts) plus a hip
 * offset. A clip reads like a choreographer's note — "pull the spear back,
 * twist the chest, then snap forward with a lunge" — and every number can
 * be tuned with hot reload.
 *
 * What makes it look alive rather than mechanical:
 *
 *   EASING — strikes are fast-in/slow-out with anticipation before and
 *   follow-through after (ease() curves, not linear lerps).
 *
 *   FOOT SYNC — the gait phase advances by distance travelled / stride
 *   length, and stride length comes from the figure's real leg length and
 *   swing amplitude. Feet push the ground instead of skating over it.
 *
 *   CROSSFADES — on a clip change we snapshot the pose we were showing and
 *   blend from that snapshot into the new clip (smoothstep over ~0.25s).
 *   Snapshots make chains of quick changes (walk→attack→walk) seamless.
 *
 *   LAYERS on top of whichever clip plays: breathing, a wandering glance,
 *   lean into turns, a hit flinch, and spring-driven secondary motion for
 *   cloaks, hair and charms (they lag behind the body's acceleration).
 *
 * Bone conventions (see rig.ts): figures face +Z; a limb hanging down
 * swings FORWARD with negative rotation.x; the figure's left is +X.
 */

import * as THREE from 'three';
import { BI, NB } from '../assets/models/people/rig';
import type { FigureModel } from '../assets/models/people/figure';
import type { FigureStyle } from '../assets/models/people/recipes';

export type ClipName =
  | 'idle' | 'walk' | 'run' | 'carry' | 'chop' | 'build' | 'attack' | 'throw' | 'cast'
  | 'chant' | 'pray' | 'cheer' | 'die' | 'drown';

export const CLIP_NAMES: ClipName[] = [
  'idle', 'walk', 'run', 'carry', 'chop', 'build', 'attack', 'throw', 'cast', 'chant', 'pray', 'cheer', 'die', 'drown',
];

/** Pose: 3 Euler angles per bone, then the hip offset (xyz, model units). */
type Pose = Float32Array;
const POSE_LEN = NB * 3 + 3;
const HX = NB * 3;

const TAU = Math.PI * 2;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Ease segment: 0 before a, 1 after b, smooth in between. */
const seg = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
function setR(p: Pose, b: number, x: number, y = 0, z = 0) {
  p[b * 3] = x;
  p[b * 3 + 1] = y;
  p[b * 3 + 2] = z;
}
function addR(p: Pose, b: number, x: number, y = 0, z = 0) {
  p[b * 3] += x;
  p[b * 3 + 1] += y;
  p[b * 3 + 2] += z;
}

export interface ClipCtx {
  style: FigureStyle;
  /** Seconds since the clip started. */
  time: number;
  /** World speed in units/s. */
  speed: number;
  /** Leg length in MODEL units (for crouches). */
  leg: number;
  /** Swing amplitude chosen by the gait solver. */
  amp: number;
}

// ---------------------------------------------------------------------------
// Holds: what the hands do with their gear when the clip doesn't need them.
// ---------------------------------------------------------------------------

/** Orient the right-hand prop: total pitch of the arm chain → hand rotation. */
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _dir = new THREE.Vector3();
const _Z = new THREE.Vector3(0, 0, 1);
/**
 * Point the right-hand prop (its shaft runs along hand-local +Z) in a
 * chest-space direction given as a pitch: dir = Rx(total)·Z, i.e.
 * −π/2 = straight up, 0 = straight ahead, π/2 = straight down. Solves the
 * wrist rotation through the whole clavicle→shoulder→elbow chain, so
 * however the arm is posed (raised, swung out), the staff stays where the
 * clip asked — upright beside the body, not leaning across the face.
 */
function aimR(p: Pose, total: number) {
  _qa.identity();
  for (const b of [BI.clavR, BI.armR, BI.foreR]) {
    _eu.set(p[b * 3], p[b * 3 + 1], p[b * 3 + 2]);
    _qa.multiply(_qb.setFromEuler(_eu));
  }
  _dir.set(0, -Math.sin(total), Math.cos(total)).applyQuaternion(_qa.invert());
  _qb.setFromUnitVectors(_Z, _dir.normalize());
  _eu.setFromQuaternion(_qb, 'XYZ');
  setR(p, BI.handR, _eu.x, _eu.y, _eu.z);
}

function holdRight(p: Pose, s: FigureStyle, swing: number) {
  switch (s.holdR) {
    case 'staff':
      // staff planted beside the body, not across the face
      setR(p, BI.armR, -0.22 + swing * 0.25, 0, -0.62);
      setR(p, BI.foreR, -0.95 + swing * 0.1, 0, 0);
      aimR(p, -Math.PI / 2 + 0.14 + swing * 0.15);
      break;
    case 'spear':
      setR(p, BI.armR, -0.25 + swing * 0.2, 0, -0.34);
      setR(p, BI.foreR, -1.25, 0, 0);
      aimR(p, -Math.PI / 2 + 0.28 + swing * 0.1);
      break;
    case 'maul':
      // resting on the shoulder
      setR(p, BI.armR, -0.45 + swing * 0.1, 0, -0.32);
      setR(p, BI.foreR, -2.05, 0, 0);
      aimR(p, -Math.PI / 2 - 0.85);
      break;
    case 'sling':
      setR(p, BI.armR, swing, 0, -0.12);
      setR(p, BI.foreR, -0.35 - Math.max(0, -swing) * 0.4);
      setR(p, BI.handR, 0.1);
      break;
    default:
      break;
  }
}

function holdLeft(p: Pose, s: FigureStyle, swing: number) {
  switch (s.holdL) {
    case 'shield':
      // shield carried before the left half of the chest, face forward
      setR(p, BI.armL, -0.7 + swing * 0.12, 0, -0.22);
      setR(p, BI.foreL, -1.05, 0, 0);
      setR(p, BI.handL, -Math.PI / 2 + 1.75 - swing * 0.12, 0, 0);
      break;
    case 'tower':
      setR(p, BI.armL, -0.55 + swing * 0.06, 0, -0.3);
      setR(p, BI.foreL, -1.1, 0, 0);
      setR(p, BI.handL, -Math.PI / 2 + 1.65 - swing * 0.06, 0, 0);
      break;
    case 'pot':
      setR(p, BI.armL, -0.12 - swing * 0.6, 0, 0.18);
      setR(p, BI.foreL, -0.25 - Math.max(0, swing) * 0.3);
      setR(p, BI.handL, 0.12 + swing * 0.5);
      break;
    default:
      break;
  }
}

/** Natural free-arm swing (unless a hold overrides it). */
function freeArms(p: Pose, s: FigureStyle, swing: number, bend: number, out = 0.1) {
  setR(p, BI.armL, -swing, 0, out);
  setR(p, BI.foreL, -bend - Math.max(0, swing) * 0.5, 0, 0);
  setR(p, BI.handL, -0.1, 0, 0);
  setR(p, BI.armR, swing, 0, -out);
  setR(p, BI.foreR, -bend - Math.max(0, -swing) * 0.5, 0, 0);
  setR(p, BI.handR, -0.1, 0, 0);
  holdRight(p, s, swing);
  holdLeft(p, s, -swing);
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

/** Gait: shared by walk / run / carry. amp = hip swing; run adds flight + bigger knees. */
function gait(t: number, p: Pose, c: ClipCtx, run: number) {
  const ph = t * TAU;
  const A = c.amp;
  const s = Math.sin(ph);
  const co = Math.cos(ph);
  const heavy = c.style.heavy;
  // legs: hip pitch, knee folds during the swing phase, ankle keeps the sole flat
  const kneeK = lerp(0.9, 1.6, run);
  const thighL = -A * s;
  const thighR = A * s;
  const shinL = kneeK * Math.max(0, co) ** 1.5 + 0.12;
  const shinR = kneeK * Math.max(0, -co) ** 1.5 + 0.12;
  setR(p, BI.thighL, thighL - 0.05 * run, 0, 0.02);
  setR(p, BI.thighR, thighR - 0.05 * run, 0, -0.02);
  setR(p, BI.shinL, shinL);
  setR(p, BI.shinR, shinR);
  setR(p, BI.footL, -(thighL + shinL) * 0.75 + Math.max(0, s) * 0.3 * (1 - run));
  setR(p, BI.footR, -(thighR + shinR) * 0.75 + Math.max(0, -s) * 0.3 * (1 - run));
  // hips: drop at each footfall (twice per cycle), twist with the legs, sway over the planted foot
  const bob = lerp(0.045, 0.09, run) * (1 - heavy * 0.3);
  p[HX + 1] = -bob * (0.5 + 0.5 * Math.cos(2 * ph)) - 0.02 - run * 0.05;
  p[HX] = 0.025 * s * (1 + heavy);
  setR(p, BI.hips, 0, 0.14 * s, -0.04 * s * (1 + heavy));
  // torso counter-twist and lean
  const lean = lerp(0.07, 0.3, run) + c.style.hunch;
  setR(p, BI.spine, lean * 0.5, -0.08 * s, 0.03 * s);
  setR(p, BI.chest, lean * 0.5 + 0.03 * Math.cos(2 * ph), -0.12 * s, 0);
  setR(p, BI.neck, -lean * 0.5, 0.05 * s, 0);
  setR(p, BI.head, -lean * 0.25 - c.style.hunch * 0.3 + 0.03 * Math.cos(2 * ph), 0.04 * s, 0);
  // arms counter-swing the legs
  const aswing = A * lerp(0.9, 1.25, run) * s;
  freeArms(p, c.style, aswing, lerp(0.25, 1.35, run), 0.08 + heavy * 0.12);
  setR(p, BI.clavL, 0, 0, 0.02 * co);
  setR(p, BI.clavR, 0, 0, -0.02 * co);
}

const CLIPS: Record<ClipName, (t: number, p: Pose, c: ClipCtx) => void> = {
  idle(t, p, c) {
    const ph = t * TAU;
    const slow = Math.sin(ph * 0.5);
    const breath = Math.sin(ph * 2);
    const h = c.style.hunch;
    p[HX] = 0.02 * slow;
    p[HX + 1] = -0.012 - 0.008 * Math.abs(slow);
    setR(p, BI.hips, 0, 0.04 * slow, 0.045 * slow);
    // weight on one leg: the other knee relaxes
    setR(p, BI.thighL, -0.04 - 0.06 * Math.max(0, slow), 0.08, 0.06 - 0.045 * slow);
    setR(p, BI.thighR, -0.04 - 0.06 * Math.max(0, -slow), -0.08, -0.06 - 0.045 * slow);
    setR(p, BI.shinL, 0.06 + 0.12 * Math.max(0, slow));
    setR(p, BI.shinR, 0.06 + 0.12 * Math.max(0, -slow));
    setR(p, BI.footL, -0.02 - 0.06 * Math.max(0, slow), -0.08, -0.06 + 0.045 * slow);
    setR(p, BI.footR, -0.02 - 0.06 * Math.max(0, -slow), 0.08, 0.06 + 0.045 * slow);
    setR(p, BI.spine, 0.02 + h * 0.9, 0, -0.035 * slow);
    setR(p, BI.chest, -0.025 * breath + h * 0.3, 0, -0.02 * slow);
    setR(p, BI.neck, -h * 0.6, 0, 0.02 * slow);
    setR(p, BI.head, -h * 0.4 + 0.02 * breath, 0, 0.03 * slow);
    setR(p, BI.clavL, 0, 0, 0.03 * breath);
    setR(p, BI.clavR, 0, 0, -0.03 * breath);
    freeArms(p, c.style, 0.03 * breath, 0.2 + 0.03 * breath, 0.12);
  },

  walk(t, p, c) {
    gait(t, p, c, 0);
  },

  run(t, p, c) {
    gait(t, p, c, 1);
  },

  carry(t, p, c) {
    gait(t, p, c, 0);
    // arms locked under the log, leaning back against the load
    setR(p, BI.armL, -0.62, 0, -0.12);
    setR(p, BI.armR, -0.62, 0, 0.12);
    setR(p, BI.foreL, -1.45, 0, 0);
    setR(p, BI.foreR, -1.45, 0, 0);
    setR(p, BI.handL, -0.2, 0, -0.3);
    setR(p, BI.handR, -0.2, 0, 0.3);
    p[BI.spine * 3] -= 0.06;
    p[BI.chest * 3] -= 0.06;
  },

  chop(t, p, _c) {
    // windup over the right shoulder → chop down and across → recover
    const up = seg(t, 0.0, 0.45) * (1 - seg(t, 0.55, 0.64));
    const hit = seg(t, 0.55, 0.64) * (1 - seg(t, 0.78, 1.0));
    const twist = lerp(0, -0.5, up) + lerp(0, 0.35, hit);
    stance(p, 0.12, 0.08);
    setR(p, BI.spine, 0.05 + hit * 0.35 - up * 0.12, twist * 0.5, 0);
    setR(p, BI.chest, hit * 0.12, twist * 0.6, 0);
    setR(p, BI.head, -hit * 0.2, -twist * 0.6, 0);
    const armX = lerp(lerp(-0.35, -2.75, up), -0.9, hit);
    setR(p, BI.armR, armX, 0, lerp(-0.12, -0.25, up));
    setR(p, BI.foreR, lerp(-0.5, -0.6, up) + hit * 0.35);
    setR(p, BI.armL, armX + 0.2, 0, lerp(0.1, -0.45, Math.max(up, hit)));
    setR(p, BI.foreL, lerp(-0.6, -0.9, up) + hit * 0.3);
    aimR(p, lerp(-1.2, -Math.PI - 0.6, up) + hit * 1.8);
    p[HX + 1] = -0.05 - hit * 0.06;
  },

  build(t, p, c) {
    // kneel on the right knee and hammer: quick down-strokes, slower lifts
    const leg = c.leg;
    p[HX + 1] = -leg * 0.38;
    setR(p, BI.thighL, -1.35, 0.1, 0.1);
    setR(p, BI.shinL, 1.35);
    setR(p, BI.footL, 0.0);
    setR(p, BI.thighR, -0.15, -0.1, -0.1);
    setR(p, BI.shinR, 1.75);
    setR(p, BI.footR, 0.9);
    const ph = (t * 2) % 1;
    const down = ph < 0.3 ? seg(ph, 0.0, 0.3) : 1 - seg(ph, 0.4, 1.0);
    const strikeK = ph < 0.3 ? ph / 0.3 : 1;
    setR(p, BI.spine, 0.35, 0.1, 0);
    setR(p, BI.chest, 0.15 + down * 0.08, 0.15, 0);
    setR(p, BI.neck, -0.15);
    setR(p, BI.head, 0.15);
    setR(p, BI.armR, lerp(-2.0, -0.75, down * strikeK), 0, -0.15);
    setR(p, BI.foreR, lerp(-1.2, -0.35, down));
    aimR(p, lerp(-2.6, -0.1, down));
    setR(p, BI.armL, -0.9, 0, -0.1);
    setR(p, BI.foreL, -0.7);
    setR(p, BI.handL, -0.3);
  },

  attack(t, p, c) {
    switch (c.style.attack) {
      case 'thrust': return thrust(t, p, c);
      case 'smash': return smash(t, p, c);
      case 'throw': return CLIPS.throw(t, p, c);
      default: return CLIPS.chop(t, p, c);
    }
  },

  throw(t, p, _c) {
    // whirl the sling overhead, then step and release
    const wind = seg(t, 0.0, 0.15) * (1 - seg(t, 0.55, 0.62));
    const rel = seg(t, 0.55, 0.65) * (1 - seg(t, 0.8, 1.0));
    const whirl = t * TAU * 3;
    stance(p, 0.16, 0.1);
    setR(p, BI.thighL, -0.35 * rel - 0.1, 0, 0.06);
    setR(p, BI.shinL, 0.2 + 0.2 * rel);
    setR(p, BI.spine, rel * 0.3 - wind * 0.1, -0.35 * wind + 0.35 * rel, 0);
    setR(p, BI.chest, 0, -0.2 * wind + 0.25 * rel, 0);
    setR(p, BI.armR, lerp(lerp(-0.2, -2.7 + Math.sin(whirl) * 0.25, wind), -1.1, rel), 0, -0.3 + Math.cos(whirl) * 0.3 * wind);
    setR(p, BI.foreR, -0.3 + 0.2 * Math.sin(whirl) * wind);
    setR(p, BI.handR, 0.2);
    // pot hand balances out front
    setR(p, BI.armL, -0.6 - 0.3 * rel, 0, 0.3);
    setR(p, BI.foreL, -0.6);
    setR(p, BI.handL, 0.4);
    setR(p, BI.head, -0.1 * wind, 0.2 * wind, 0);
  },

  cast(t, p, c) {
    // crouch (gather) → staff to the sky, arched back (channel) → thrust forward (release)
    const gather = seg(t, 0.0, 0.2) * (1 - seg(t, 0.2, 0.42));
    const raise = seg(t, 0.2, 0.42) * (1 - seg(t, 0.74, 0.86));
    const release = seg(t, 0.74, 0.86) * (1 - seg(t, 0.9, 1.0));
    const tremble = Math.sin(c.time * 40) * 0.03 * raise;
    p[HX + 1] = -0.08 * gather + 0.03 * raise - 0.06 * release;
    stance(p, 0.1 + 0.15 * gather + 0.12 * release, 0.12);
    setR(p, BI.spine, 0.25 * gather - 0.25 * raise + 0.32 * release, 0, 0);
    setR(p, BI.chest, 0.1 * gather - 0.15 * raise + 0.15 * release + tremble, 0, 0);
    setR(p, BI.neck, 0, 0, 0);
    setR(p, BI.head, 0.2 * gather - 0.38 * raise + 0.1 * release, 0, 0);
    setR(p, BI.armR, lerp(lerp(-0.35, 0.15, gather), -2.85, raise) + lerp(0, -1.0, release), 0, -0.15 - 0.15 * raise);
    setR(p, BI.foreR, lerp(-1.1, -0.15, Math.max(raise, release)) + tremble);
    aimR(p, -Math.PI / 2 + 0.2 * gather + 0.95 * release);
    setR(p, BI.armL, lerp(-0.2, -2.2, raise) - 1.1 * release, 0, 0.25 + 0.55 * raise);
    setR(p, BI.foreL, -0.35 - 0.2 * gather);
    setR(p, BI.handL, -0.3 * raise, 0, 0);
  },

  chant(t, p, _c) {
    const ph = t * TAU;
    const beat = Math.sin(ph * 2);
    const pulse = Math.max(0, beat) ** 2;
    p[HX] = 0.03 * Math.sin(ph);
    p[HX + 1] = -0.03 - 0.025 * pulse;
    stance(p, 0.12, 0.12);
    setR(p, BI.hips, 0, 0, 0.06 * Math.sin(ph));
    setR(p, BI.spine, 0.06 + 0.06 * pulse, 0.08 * Math.sin(ph), -0.04 * Math.sin(ph));
    setR(p, BI.chest, -0.04, 0.05 * Math.sin(ph), 0);
    setR(p, BI.head, -0.2 + 0.18 * pulse, 0, 0.06 * Math.sin(ph));
    // staff pumps on the beat (bells ring), free hand open toward the listeners
    setR(p, BI.armR, -0.45 - 0.35 * pulse, 0, -0.2);
    setR(p, BI.foreR, -1.1 + 0.2 * pulse);
    aimR(p, -Math.PI / 2 + 0.1);
    setR(p, BI.armL, -1.5 + 0.15 * Math.sin(ph), 0.2, 0.45);
    setR(p, BI.foreL, -0.55);
    setR(p, BI.handL, 0.6, 0, 0);
  },

  pray(t, p, c) {
    // kneel; arms rise, then the body bows to the ground — slow, rhythmic
    const leg = c.leg;
    const ph = t * TAU;
    const bow = 0.5 - 0.5 * Math.cos(ph);
    p[HX + 1] = -leg * 0.48;
    p[HX + 2] = -0.08;
    for (const [th, sh, ft, sx] of [[BI.thighL, BI.shinL, BI.footL, 1], [BI.thighR, BI.shinR, BI.footR, -1]] as const) {
      setR(p, th, -0.35, 0, sx * 0.08);
      setR(p, sh, 1.95);
      setR(p, ft, 0.9);
    }
    setR(p, BI.spine, 0.15 + bow * 0.75, 0, 0);
    setR(p, BI.chest, bow * 0.25, 0, 0);
    setR(p, BI.head, -0.25 + bow * 0.1, 0, 0);
    const armX = lerp(-2.7, -1.3, bow);
    setR(p, BI.armL, armX, 0, 0.35 - bow * 0.2);
    setR(p, BI.armR, armX, 0, -0.35 + bow * 0.2);
    setR(p, BI.foreL, -0.25);
    setR(p, BI.foreR, -0.25);
    setR(p, BI.handL, 0.4);
    setR(p, BI.handR, 0.4);
  },

  cheer(t, p, c) {
    const ph = t * TAU;
    const hop = Math.max(0, Math.sin(ph * 2));
    p[HX + 1] = hop * 0.22 - 0.05;
    stance(p, 0.15 - hop * 0.12, 0.1);
    setR(p, BI.spine, -0.1, 0, 0.05 * Math.sin(ph));
    setR(p, BI.head, -0.35, 0, 0.1 * Math.sin(ph));
    setR(p, BI.armL, -2.8 + 0.15 * Math.sin(ph * 2), 0, 0.45 + 0.15 * Math.sin(ph * 4));
    setR(p, BI.armR, -2.8 + 0.15 * Math.sin(ph * 2 + 1), 0, -0.45 - 0.15 * Math.sin(ph * 4 + 1));
    setR(p, BI.foreL, -0.3 - 0.4 * Math.max(0, Math.sin(ph * 4)));
    setR(p, BI.foreR, -0.3 - 0.4 * Math.max(0, Math.sin(ph * 4 + 1)));
    setR(p, BI.handL, 0.2);
    if (c.style.holdR !== 'none') aimR(p, -Math.PI / 2 + 0.3);
  },

  die(t, p, _c) {
    // stagger back, knees go, fall flat on the back; arms flung out
    const stag = seg(t, 0, 0.25);
    const fall = seg(t, 0.2, 0.62);
    const settle = seg(t, 0.6, 0.75) - seg(t, 0.75, 0.9) * 0.5;
    stance(p, 0.1 + 0.4 * stag * (1 - fall), 0.1);
    setR(p, BI.root, -1.5 * fall - 0.05 * settle, 0, 0.1 * fall);
    p[HX + 1] = -0.25 * stag * (1 - fall) - fall * 0.35;
    p[HX + 2] = -0.25 * fall;
    setR(p, BI.spine, 0.3 * stag * (1 - fall) - 0.1 * fall, 0, 0);
    setR(p, BI.chest, -0.25 * stag, 0, 0);
    setR(p, BI.head, -0.5 * stag + 0.4 * fall, 0.3 * fall, 0);
    setR(p, BI.armL, lerp(-0.6 * stag, -1.8, fall), 0, 0.3 + 0.9 * fall);
    setR(p, BI.armR, lerp(-0.6 * stag, -1.6, fall), 0, -0.3 - 1.0 * fall);
    setR(p, BI.foreL, -0.5 * (1 - fall) - 0.2);
    setR(p, BI.foreR, -0.5 * (1 - fall) - 0.3);
    setR(p, BI.thighL, -0.3 * fall, 0, 0.1);
    setR(p, BI.thighR, 0.0, 0, -0.15 * fall);
    setR(p, BI.shinL, 0.6 * fall);
    setR(p, BI.shinR, 0.15);
  },

  drown(t, p, _c) {
    const ph = t * TAU;
    p[HX + 1] = -0.05 + 0.05 * Math.sin(ph * 2);
    stance(p, 0.3 + 0.2 * Math.sin(ph * 3), 0.2);
    setR(p, BI.thighL, -0.4 - 0.4 * Math.sin(ph * 3), 0, 0.2);
    setR(p, BI.thighR, -0.4 + 0.4 * Math.sin(ph * 3), 0, -0.2);
    setR(p, BI.spine, -0.15, 0, 0.1 * Math.sin(ph));
    setR(p, BI.head, -0.55, 0.2 * Math.sin(ph * 1.5), 0);
    setR(p, BI.armL, -2.6 + 0.5 * Math.sin(ph * 4), 0, 0.5 + 0.3 * Math.cos(ph * 4));
    setR(p, BI.armR, -2.6 + 0.5 * Math.sin(ph * 4 + 2), 0, -0.5 - 0.3 * Math.cos(ph * 4 + 2));
    setR(p, BI.foreL, -0.5 - 0.4 * Math.sin(ph * 4));
    setR(p, BI.foreR, -0.5 - 0.4 * Math.sin(ph * 4 + 2));
  },
};

/** Planted stance: feet apart, knees soft. */
function stance(p: Pose, knee: number, spread: number) {
  setR(p, BI.thighL, -knee * 0.6, 0.1, spread);
  setR(p, BI.thighR, -knee * 0.4, -0.1, -spread);
  setR(p, BI.shinL, knee);
  setR(p, BI.shinR, knee * 0.8);
  setR(p, BI.footL, -knee * 0.4, -0.1, -spread);
  setR(p, BI.footR, -knee * 0.4, 0.1, spread);
  p[HX + 1] = Math.min(p[HX + 1], -knee * 0.06 - 0.01);
}

function thrust(t: number, p: Pose, c: ClipCtx) {
  // pull back (anticipation) → lunge and stab → recover behind the shield
  const back = seg(t, 0.0, 0.35) * (1 - seg(t, 0.38, 0.48));
  const stab = seg(t, 0.38, 0.48) * (1 - seg(t, 0.62, 1.0));
  stance(p, 0.15, 0.1);
  setR(p, BI.thighL, -0.2 - 0.55 * stab, 0.1, 0.1);
  setR(p, BI.shinL, 0.2 + 0.45 * stab);
  setR(p, BI.thighR, 0.1 + 0.35 * stab, -0.1, -0.1);
  setR(p, BI.shinR, 0.25);
  p[HX + 1] = -0.03 - 0.1 * stab;
  p[HX + 2] = 0.12 * stab - 0.05 * back;
  setR(p, BI.spine, -0.1 * back + 0.3 * stab, -0.25 * back + 0.25 * stab, 0);
  setR(p, BI.chest, 0, -0.3 * back + 0.3 * stab, 0);
  setR(p, BI.head, 0.1 * stab, 0.3 * back - 0.3 * stab, 0);
  setR(p, BI.armR, lerp(lerp(-0.3, 0.35, back), -1.45, stab), 0, -0.25);
  setR(p, BI.foreR, lerp(lerp(-1.2, -1.7, back), -0.15, stab));
  aimR(p, lerp(lerp(-1.25, -0.25, back), 0.0, stab));
  holdLeft(p, c.style, 0);
  addR(p, BI.armL, -0.2 * stab, 0, 0);
}

function smash(t: number, p: Pose, c: ClipCtx) {
  // heave the maul overhead → slam it down with the whole body → recover
  const lift = seg(t, 0.0, 0.42) * (1 - seg(t, 0.48, 0.58));
  const slam = seg(t, 0.48, 0.58) * (1 - seg(t, 0.72, 1.0));
  stance(p, 0.15 + 0.35 * slam, 0.16);
  p[HX + 1] = -0.03 + 0.03 * lift - 0.16 * slam;
  setR(p, BI.spine, -0.2 * lift + 0.55 * slam, -0.15 * lift, 0);
  setR(p, BI.chest, -0.1 * lift + 0.15 * slam, -0.15 * lift + 0.1 * slam, 0);
  setR(p, BI.head, 0.2 * lift - 0.2 * slam, 0, 0);
  setR(p, BI.armR, lerp(lerp(-0.45, -2.9, lift), -1.0, slam), 0, -0.25);
  setR(p, BI.foreR, lerp(lerp(-2.0, -0.5, lift), -0.15, slam));
  aimR(p, lerp(lerp(-Math.PI / 2 - 0.85, -Math.PI - 0.8, lift), 0.45, slam));
  holdLeft(p, c.style, 0);
  addR(p, BI.armL, 0.2 * lift - 0.2 * slam, 0, 0.1 * lift);
}

/** Speeds (world units/s) above which we walk / run. */
const RUN_FROM = 4.6;

// ---------------------------------------------------------------------------
// The animator: one per figure.
// ---------------------------------------------------------------------------

/** One-shot clips: time-normalised, don't loop. */
const ONE_SHOT: Partial<Record<ClipName, number>> = { die: 1.25 };
/** Seconds per cycle for looped, non-locomotion clips. */
const PERIOD: Partial<Record<ClipName, number>> = {
  idle: 4.2, chop: 1.15, build: 1.0, attack: 1.1, throw: 1.6, cast: 1.2, chant: 1.5, pray: 2.8, cheer: 1.3, drown: 1.4,
};

export interface AnimInput {
  clip: ClipName;
  /** World units / second actually travelled (foot sync). */
  speed: number;
  /** Heading angular velocity, rad/s (lean into turns). */
  turnRate: number;
  /** Optional externally-driven phase 0..1 (attack synced to the sim cooldown). */
  phase?: number;
  /** Seconds per cycle override (attack cooldown, cast time). */
  period?: number;
}

export class FigureAnimator {
  private clip: ClipName = 'idle';
  private clipTime = 0;
  private t: number;
  private blend = 1;
  private blendDur = 0.25;
  private readonly from = new Float32Array(POSE_LEN);
  private readonly cur = new Float32Array(POSE_LEN);
  private readonly out = new Float32Array(POSE_LEN);
  // layers
  private hit = 0;
  private lookYaw = 0;
  private lookTarget = 0;
  private lookTimer = 0;
  private lean = 0;
  private swayV = 0;
  private sway = 0;
  private lastSpeed = 0;
  private readonly ctx: ClipCtx;

  constructor(private readonly fig: FigureModel, seed = Math.random() * 1000) {
    this.t = (seed * 0.6180339) % 1;
    this.lookTimer = (seed % 5) + 1;
    this.ctx = { style: fig.style, time: 0, speed: 0, leg: fig.rest[BI.hips * 3 + 1], amp: 0.4 };
  }

  get currentClip(): ClipName {
    return this.clip;
  }

  /** Start a flinch (additive). */
  flinch(): void {
    this.hit = 1;
  }

  update(dt: number, inp: AnimInput): void {
    const fig = this.fig;
    if (inp.clip !== this.clip) {
      this.from.set(this.out);
      this.clip = inp.clip;
      this.clipTime = 0;
      this.blend = 0;
      this.blendDur = inp.clip === 'die' ? 0.12 : inp.clip === 'attack' || inp.clip === 'throw' ? 0.15 : 0.25;
      if (ONE_SHOT[inp.clip]) this.t = 0;
    }
    this.clipTime += dt;
    this.blend = Math.min(1, this.blend + dt / this.blendDur);

    // --- advance the clip clock ---
    const leg = fig.legLen;
    const sp = inp.speed;
    const loco = this.clip === 'walk' || this.clip === 'run' || this.clip === 'carry';
    if (loco) {
      const run = this.clip === 'run' ? 1 : 0;
      // amplitude grows with speed; stride per cycle = 2 steps × 2·L·sin(A)
      const A = run ? 0.72 : Math.min(0.62, Math.max(0.28, 0.22 + (sp / leg) * 0.13));
      this.ctx.amp = A;
      const stride = 4 * leg * Math.sin(A) * (run ? 1.15 : 0.92);
      this.t = (this.t + (dt * Math.max(0.2, sp)) / stride) % 1;
    } else if (ONE_SHOT[this.clip]) {
      this.t = Math.min(1, this.clipTime / ONE_SHOT[this.clip]!);
    } else if (inp.phase !== undefined) {
      this.t = inp.phase;
    } else {
      const per = inp.period ?? PERIOD[this.clip] ?? 1.2;
      this.t = (this.t + dt / per) % 1;
    }

    // --- evaluate ---
    this.cur.fill(0);
    this.ctx.time = this.clipTime;
    this.ctx.speed = sp;
    CLIPS[this.clip](this.t, this.cur, this.ctx);
    const w = smooth(this.blend);
    const out = this.out;
    for (let i = 0; i < POSE_LEN; i++) out[i] = this.from[i] + (this.cur[i] - this.from[i]) * w;

    // --- layers ---
    // glance around when idle-ish
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = 2 + Math.random() * 4;
      this.lookTarget = this.clip === 'idle' ? (Math.random() - 0.5) * 1.3 : 0;
    }
    this.lookYaw += (this.lookTarget - this.lookYaw) * Math.min(1, dt * 2.5);
    out[BI.head * 3 + 1] += this.lookYaw * 0.65;
    out[BI.neck * 3 + 1] += this.lookYaw * 0.35;
    // lean into turns
    const leanT = Math.max(-0.22, Math.min(0.22, -inp.turnRate * sp * 0.035));
    this.lean += (leanT - this.lean) * Math.min(1, dt * 6);
    out[BI.root * 3 + 2] += this.lean;
    // hit flinch
    if (this.hit > 0) {
      const k = Math.sin(this.hit * Math.PI) * this.hit;
      out[BI.chest * 3] -= 0.45 * k;
      out[BI.head * 3] -= 0.35 * k;
      out[BI.spine * 3] -= 0.15 * k;
      this.hit = Math.max(0, this.hit - dt / 0.35);
    }
    // secondary: spring driven by acceleration (cloak, hair, charms)
    const accel = (sp - this.lastSpeed) / Math.max(dt, 1e-3);
    this.lastSpeed = sp;
    const force = -accel * 0.02 - this.sway * 40 - this.swayV * 6;
    this.swayV += force * dt;
    this.sway += this.swayV * dt;
    const flutter = Math.sin(this.clipTime * 7.3) * 0.04 * Math.min(1, sp / 3);
    const chestBack = out[BI.spine * 3] + out[BI.chest * 3];
    out[BI.cloak1 * 3] = Math.max(0.05, 0.08 + Math.min(0.3, sp * 0.05) + this.sway * 1.5 + flutter + Math.max(0, chestBack) * 0.6 - out[BI.thighL * 3] * 0.1);
    out[BI.cloak2 * 3] = 0.05 + Math.min(0.2, sp * 0.03) + this.sway * 2 + flutter * 1.5;
    out[BI.cloak1 * 3 + 2] = this.lean * 0.5;
    out[BI.tail * 3] = 0.1 + Math.min(0.5, sp * 0.06) + this.sway * 2 - out[BI.head * 3] * 0.6;
    out[BI.tail * 3 + 2] = -out[BI.head * 3 + 2] * 0.5;
    const charmSwing = Math.sin(this.clipTime * 3.1) * 0.05 + this.sway * 2.5 + (this.clip === 'chant' ? Math.sin(this.clipTime * 8.4) * 0.12 : 0);
    out[BI.charm * 3 + 1] = charmSwing;

    // --- apply ---
    const bones = fig.bones;
    const rest = fig.rest;
    for (let i = 0; i < NB; i++) {
      const b = bones[i];
      b.rotation.set(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
    }
    const hip = bones[BI.hips];
    hip.position.set(rest[BI.hips * 3] + out[HX], rest[BI.hips * 3 + 1] + out[HX + 1], rest[BI.hips * 3 + 2] + out[HX + 2]);
  }
}

/** Speed threshold above which locomotion becomes a run (world units/s, scaled by figure size). */
export function runThreshold(fig: FigureModel): number {
  return RUN_FROM * (fig.legLen / 1.0);
}

