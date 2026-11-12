/**
 * core/sfx.ts — the event → sound router and the ambient bed.
 *
 * The sim only emits GameEvents; render/effects.ts draws them. This file is
 * the third listener: it decides which synthesized sound (core/audio.ts) an
 * event gets, how loud it is from where the camera is looking, and how often
 * it may fire — so a 40-unit brawl is a murmur, not a wall of noise.
 *
 * Call `hear()` every frame BEFORE effects.sync drains world.events.
 * Everything is a silent no-op when there is no AudioContext (tests).
 */

import * as audio from './audio';
import { wrapDelta } from './util';

/** The world is a wrapping 128x128-tile torus. */
const WORLD_TILES = 128;
/** Inside this many tiles an event plays at full volume; beyond FAR it is silent. */
const NEAR = 10;
const FAR = 70;

function smooth(e0: number, e1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Shortest wrapped distance between two tile positions. */
export function tileDistance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(wrapDelta(ax - bx, WORLD_TILES), wrapDelta(az - bz, WORLD_TILES));
}

/** Gain 0..1 for an event `d` tiles from the camera target. Silent at >= 70. */
export function attenuation(d: number): number {
  const k = 1 - smooth(NEAR, FAR, d);
  return k * k;
}

/** Allows at most `max` passes per `windowMs`, per key. */
export class RateLimiter {
  private stamps = new Map<string, number[]>();
  allow(key: string, nowMs: number, max: number, windowMs: number): boolean {
    const arr = (this.stamps.get(key) ?? []).filter((t) => nowMs - t < windowMs);
    if (arr.length >= max) {
      this.stamps.set(key, arr);
      return false;
    }
    arr.push(nowMs);
    this.stamps.set(key, arr);
    return true;
  }
}

interface Rule {
  /** Plays the sound at gain `v` (already attenuated). */
  play: (v: number) => void;
  /** Rate limit: max plays per window ms (default: unlimited). */
  max?: number;
  windowMs?: number;
  /** Sounds that matter more are audible further out (extra reach multiplier on gain). */
  boost?: number;
}

const SILENT = null;

/**
 * Every EFFECT_EVENTS entry (plus legacy names), mapped to a sound or to
 * explicit silence (null).
 */
const RULES: Record<string, Rule | null> = {
  explosion: { play: (v) => audio.boom(1, v), max: 2, windowMs: 200, boost: 1.2 },
  lightning: { play: (v) => audio.zap(v), max: 2, windowMs: 300 },
  convert: { play: (v) => audio.chime(v * 0.7), max: 2, windowMs: 200 },
  unlock: { play: (v) => audio.giftChime(v) },
  hit: { play: (v) => audio.thud(v * 0.8), max: 3, windowMs: 100 },
  fireball: { play: (v) => audio.ember(v * 0.7), max: 2, windowMs: 100 },
  death: SILENT,
  castFlash: SILENT,
  splash: SILENT,
  plume: SILENT,
  swamp: SILENT,
  shake: SILENT,
  chantStart: SILENT,
  quakeStart: { play: (v) => audio.rumble(4, v), boost: 1.2 },
  volcanoStart: { play: (v) => audio.rumble(9, v), boost: 1.2 },
  rumbleSmall: { play: (v) => audio.rumble(2, v * 0.6), max: 1, windowMs: 800 },
  denied: { play: (v) => audio.denied(v) },

  wardCast: { play: (v) => audio.wardShimmer(v) },
  warsongCast: { play: (v) => audio.warsong(v), boost: 1.2 },
  cycloneTouch: { play: (v) => audio.cyclone(v * 0.8), max: 1, windowMs: 400 },
  emberStrike: { play: (v) => audio.ember(v), max: 3, windowMs: 100 },
  sinkRumble: { play: (v) => audio.sink(v), max: 1, windowMs: 600 },
  bloomCast: { play: (v) => audio.bloom(v) },
  defect: { play: (v) => audio.defectSound(v * 0.8), max: 2, windowMs: 200 },
  dwellingGrow: { play: (v) => audio.dwellingGrowSound(v * 0.8), max: 2, windowMs: 300 },
  trained: { play: (v) => audio.trainedSound(v * 0.8), max: 2, windowMs: 300 },
  built: { play: (v) => audio.builtSound(v), max: 2, windowMs: 300 },
  collapse: { play: (v) => audio.collapseSound(v), max: 2, windowMs: 300 },
  fireStart: { play: (v) => audio.fireCrackle(v), max: 3, windowMs: 100 },
  giftClaimed: { play: (v) => audio.giftChime(v) },
  objectiveDone: { play: (v) => audio.fanfare(v) },
  leaderDown: { play: (v) => audio.leaderDownSound(v) },
  leaderReturn: { play: (v) => audio.leaderReturnSound(v) },

  // the opening + the ritual (fb-opening)
  landing: { play: (v) => audio.rumble(2, v * 0.5), max: 1, windowMs: 800 },
  rescued: { play: (v) => audio.chime(v * 0.8), max: 1, windowMs: 400 },
  communeStart: { play: (v) => audio.giftChime(v * 0.5), max: 1, windowMs: 600 },
  communeInterrupted: { play: (v) => audio.denied(v) },
  siteLevel: SILENT,
};

/** Is this event mapped (to a sound or to explicit silence)? Tests check every EFFECT_EVENTS entry is. */
export function hasSoundRule(type: string): boolean {
  return type in RULES;
}

/** Events that are always heard at full volume regardless of distance. */
const GLOBAL = new Set(['objectiveDone', 'leaderDown', 'leaderReturn', 'denied', 'unlock', 'giftClaimed']);

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface AmbientContext {
  seaFraction: number;
  treeFraction: number;
  camDistance: number;
  paused: boolean;
}

export class Soundscape {
  private limiter = new RateLimiter();
  private bed: audio.AmbientBed | null = null;
  private bedTried = false;
  private nextChirp = 4;
  private clock = 0;

  /** Play sounds for this frame's events. Call before effects.sync drains them. */
  hear(events: { type: string; x: number; z: number; magnitude?: number; tribe?: string }[], camTileX: number, camTileZ: number, camDistance: number): void {
    if (events.length === 0 || !audio.audioReady()) return;
    void camDistance;
    const t = now();
    for (const ev of events) {
      const rule = RULES[ev.type];
      if (!rule) continue;
      // Global stings are full volume for the player's own (or untagged) events; a rival's are heard by distance.
      const mine = ev.tribe === undefined || ev.tribe === 'player';
      let v = GLOBAL.has(ev.type) && mine ? 1 : attenuation(tileDistance(ev.x, ev.z, camTileX, camTileZ));
      v = Math.min(1, v * (rule.boost ?? 1));
      if (v < 0.03) continue;
      if (rule.max && !this.limiter.allow(ev.type, t, rule.max, rule.windowMs ?? 100)) continue;
      try {
        rule.play(v);
      } catch {
        /* never break the frame over a sound */
      }
    }
  }

  /** Drive the generative bed. Call once per frame; `dt` in seconds. */
  ambient(ctx: AmbientContext, dt: number): void {
    if (!audio.audioReady()) return;
    if (!this.bed) {
      if (this.bedTried) return;
      this.bedTried = true;
      this.bed = audio.startAmbientBed();
      if (!this.bed) return;
    }
    // Zoomed out: wind only, a little lower; zoomed in: all layers.
    const near = 1 - smooth(45, 125, ctx.camDistance);
    const live = ctx.paused ? 0 : 1;
    const wind = live * (0.55 + 0.45 * (1 - near) * 0.5 + 0.1 * near);
    const sea = live * near * Math.min(1, Math.max(0, ctx.seaFraction) * 1.6);
    this.bed.set(wind, sea);

    this.clock += dt;
    if (this.clock >= this.nextChirp) {
      this.clock = 0;
      this.nextChirp = 3 + Math.random() * 9;
      const level = live * near * Math.min(1, Math.max(0, ctx.treeFraction) * 4);
      this.bed.chirp(level);
    }
  }
}
