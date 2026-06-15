/**
 * render/figure-animator.ts — keyframe animation, the readable way.
 *
 * Industrial engines store animation as binary curve data exported from
 * Blender/Maya. We store it as MATH: each clip is a pure function from
 * cycle time t ∈ [0,1) to a Pose — a handful of joint angles. Sine waves
 * are everywhere because walking IS oscillation: legs swing opposite each
 * other, arms counter-swing the legs (watch yourself walk), and the body
 * bobs twice per stride (once per footfall).
 *
 * Two refinements that separate "moving" from "alive":
 *
 *   FOOT SYNC — the walk cycle's playback rate is tied to actual movement
 *   speed, so feet push the ground instead of skating over it. The single
 *   most noticeable animation bug in amateur games is ignoring this.
 *
 *   CROSSFADING — switching idle→walk instantly looks robotic. We keep a
 *   short blend (BLEND_TIME) where both clips evaluate and the pose is a
 *   lerp between them. Because a Pose is just numbers, blending is just
 *   lerping each field.
 *
 * Each animator starts at a random phase so a crowd doesn't march in
 * eerie unison.
 */

import { lerp } from '../core/util';
import { Figure } from '../assets/models/figures';

/** Everything a clip controls. Angles in radians; bob in world units. */
interface Pose {
  legSwing: number; // legL forward = +, legR gets the negative
  armSwing: number; // armR forward = +, armL gets the negative
  armRaise: number; // both arms lifted forward together (carrying, working)
  bob: number; // vertical body offset
  lean: number; // forward body tilt
}

export type ClipName = 'idle' | 'walk' | 'carry' | 'work' | 'cast';

const TWO_PI = Math.PI * 2;
const BLEND_TIME = 0.18; // seconds for a crossfade

const CLIPS: Record<ClipName, (t: number, out: Pose) => void> = {
  /** Standing: a slow breath and the faintest arm sway. Stillness with a pulse. */
  idle(t, out) {
    out.legSwing = 0;
    out.armSwing = Math.sin(t * TWO_PI) * 0.06;
    out.armRaise = 0;
    out.bob = Math.sin(t * TWO_PI) * 0.015;
    out.lean = 0;
  },
  /** Walking: opposed limb swings, double-frequency bob, eager forward lean. */
  walk(t, out) {
    const phase = t * TWO_PI;
    out.legSwing = Math.sin(phase) * 0.7;
    out.armSwing = Math.sin(phase) * 0.45;
    out.armRaise = 0;
    out.bob = Math.abs(Math.sin(phase)) * 0.05; // two footfalls per cycle
    out.lean = 0.1;
  },
  /** Hauling a log: a walk with the arms locked out front under the load. */
  carry(t, out) {
    const phase = t * TWO_PI;
    out.legSwing = Math.sin(phase) * 0.6;
    out.armSwing = 0;
    out.armRaise = -1.15; // arms forward, cradling
    out.bob = Math.abs(Math.sin(phase)) * 0.05;
    out.lean = 0.16; // leaning back under weight would be -, but stylized forward effort reads better
  },
  /** Chopping/hammering: planted feet, fast alternating arm strikes, bent forward. */
  work(t, out) {
    const phase = t * TWO_PI * 2; // double-speed — industrious!
    out.legSwing = 0;
    out.armSwing = Math.sin(phase) * 0.9;
    out.armRaise = -0.5;
    out.bob = Math.abs(Math.cos(phase)) * 0.03;
    out.lean = 0.3;
  },
  /** Spellcasting: staff thrust skyward, body arched back, trembling with power. */
  cast(t, out) {
    out.legSwing = 0;
    out.armSwing = 0;
    out.armRaise = -2.7 + Math.sin(t * TWO_PI * 6) * 0.06; // arms up, quivering
    out.bob = 0.06;
    out.lean = -0.18; // arched back: channeling, not lifting
  },
};

/** How fast each clip cycles, in cycles/second. Walk/carry get overridden by foot sync. */
const BASE_RATE: Record<ClipName, number> = { idle: 0.35, walk: 1.8, carry: 1.6, work: 0.9, cast: 1 };

/** A unit covers ~0.85 tiles per walk cycle — stride length, for foot sync. */
const STRIDE_TILES = 0.85;

export class FigureAnimator {
  private current: ClipName = 'idle';
  private previous: ClipName = 'idle';
  private blend = 1; // 0 = fully previous clip, 1 = fully current
  private t = Math.random(); // random start phase: crowds shouldn't march in step
  private readonly poseA: Pose = { legSwing: 0, armSwing: 0, armRaise: 0, bob: 0, lean: 0 };
  private readonly poseB: Pose = { legSwing: 0, armSwing: 0, armRaise: 0, bob: 0, lean: 0 };

  /**
   * Advance time and apply the blended pose to a figure.
   * `speedTilesPerSec` drives foot sync when walking (0 when idle).
   */
  update(dt: number, desired: ClipName, speedTilesPerSec: number, fig: Figure): void {
    if (desired !== this.current) {
      this.previous = this.current;
      this.current = desired;
      this.blend = 0;
    }
    this.blend = Math.min(1, this.blend + dt / BLEND_TIME);

    const onTheMove = this.current === 'walk' || this.current === 'carry';
    const rate = onTheMove ? speedTilesPerSec / STRIDE_TILES : BASE_RATE[this.current];
    this.t = (this.t + dt * rate) % 1;

    // Evaluate both clips at the same t and lerp. (Sharing t across clips is
    // a simplification — proper engines keep per-clip clocks — but at a
    // 0.18s blend nobody can tell, and it halves the bookkeeping.)
    CLIPS[this.previous](this.t, this.poseA);
    CLIPS[this.current](this.t, this.poseB);
    const w = this.blend;
    const legSwing = lerp(this.poseA.legSwing, this.poseB.legSwing, w);
    const armSwing = lerp(this.poseA.armSwing, this.poseB.armSwing, w);
    const armRaise = lerp(this.poseA.armRaise, this.poseB.armRaise, w);
    const bob = lerp(this.poseA.bob, this.poseB.bob, w);
    const lean = lerp(this.poseA.lean, this.poseB.lean, w);

    // Pose → joints. Opposite phases for opposite limbs happen right here;
    // armRaise lifts both arms together on top of the swing.
    const { legL, legR, armL, armR } = fig.parts;
    if (legL) legL.rotation.x = legSwing;
    if (legR) legR.rotation.x = -legSwing;
    if (armL) armL.rotation.x = -armSwing + armRaise;
    if (armR) armR.rotation.x = armSwing + armRaise;
    fig.body.position.y = bob;
    fig.body.rotation.x = lean;
  }
}
