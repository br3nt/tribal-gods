/**
 * core/audio.ts — every sound in the game, synthesized from scratch.
 *
 * No audio files. The Web Audio API gives us oscillators (pure tones) and
 * noise buffers (static), plus filters and gain envelopes — which is the
 * entire 1980s synthesizer toolkit, and that's exactly how game sound
 * effects were made before sample playback got cheap.
 *
 * The recipes are worth knowing because they're universal:
 *
 *   EXPLOSION  = white noise through a low-pass filter, volume snapping to
 *                full then decaying. The filter is what makes it "boom"
 *                instead of "hiss" — low frequencies read as big.
 *   ZAP        = a square-wave oscillator pitch-diving fast + a crackle of
 *                high-passed noise. Pitch dive = energy discharge.
 *   RUMBLE     = long, quiet, very-low-passed noise with a slow fade.
 *                Felt more than heard. Sells earthquakes and volcanoes.
 *   CHIME      = sine tones a musical interval apart. Sines are "pure"
 *                and read as magic/holy across basically all games.
 *
 * Routing: every one-shot goes sfx bus -> master; the generative ambient bed
 * goes ambient bus -> master. Master carries the player's volume / mute
 * (persisted in localStorage). core/sfx.ts decides WHEN each sound plays;
 * this file only knows HOW. Each recipe takes an optional `vol` (0..1) used
 * for distance attenuation.
 *
 * Browsers refuse to make sound before the user interacts with the page
 * (autoplay policy), so the AudioContext is created lazily and main.ts
 * pokes resume() on the first pointer event. Without an AudioContext
 * (tests, old browsers) every function here is a silent no-op.
 */

let ctx: AudioContext | null = null;

/** Master volume — all sound routes through one gain node. */
const MASTER = 0.22;
const DEFAULT_VOLUME = 0.7;
const KEY = 'tg.audio.v1';
let master: GainNode | null = null;
/** Sub-busses: one-shot effects, and the generative ambient bed. */
let sfx: GainNode | null = null;
let ambientBus: GainNode | null = null;

let volume = DEFAULT_VOLUME;
let muted = false;
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const p = JSON.parse(raw) as { volume?: number; muted?: boolean };
    if (typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1) volume = p.volume;
    if (typeof p.muted === 'boolean') muted = p.muted;
  }
} catch {
  /* no storage / corrupt — defaults */
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ volume, muted }));
  } catch {
    /* storage blocked: lasts this session only */
  }
}

function masterLevel(): number {
  return muted ? 0 : (MASTER * volume) / DEFAULT_VOLUME;
}

function applyMaster(): void {
  if (ctx && master) master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.04);
}

export function getVolume(): number {
  return volume;
}
export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : DEFAULT_VOLUME));
  persist();
  applyMaster();
}
export function isMuted(): boolean {
  return muted;
}
export function setMuted(b: boolean): void {
  muted = b;
  persist();
  applyMaster();
}

function ensure(): AudioContext | null {
  if (!ctx) {
    if (typeof AudioContext === 'undefined') return null;
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = masterLevel();
      master.connect(ctx.destination);
      sfx = ctx.createGain();
      sfx.gain.value = 1;
      sfx.connect(master);
      ambientBus = ctx.createGain();
      ambientBus.gain.value = 0.6;
      ambientBus.connect(master);
    } catch {
      ctx = null;
      master = null;
      sfx = null;
      ambientBus = null;
      return null; // no audio support — the game plays on, silently
    }
  }
  return ctx;
}

/** Called from main.ts on the first user gesture (autoplay policy). */
export function unlockAudio(): void {
  const c = ensure();
  if (c && c.state === 'suspended') void c.resume();
}

/** True once an AudioContext exists (created on the first gesture). */
export function audioReady(): boolean {
  return ctx !== null && sfx !== null;
}

/** Destination for a one-shot: the sfx bus, or a throwaway gain into it. */
function dest(c: AudioContext, vol: number): AudioNode {
  if (!sfx) return c.destination;
  if (vol >= 0.999) return sfx;
  const g = c.createGain();
  g.gain.value = Math.max(0, vol);
  g.connect(sfx);
  return g;
}

/** A reusable 1-second buffer of white noise (generated once, on demand). */
let noiseBuffer: AudioBuffer | null = null;
function noise(c: AudioContext): AudioBufferSourceNode {
  if (!noiseBuffer) {
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  return src;
}

/** One enveloped oscillator note: fast attack, exponential decay, then stop(). */
function tone(
  c: AudioContext, out: AudioNode, freq: number, t: number, dur: number, peak: number,
  type: OscillatorType = 'sine', glideTo?: number, attack = 0.012,
): void {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + Math.min(attack, dur * 0.9));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/** Enveloped filtered noise burst. `f1` sweeps the filter over the burst. */
function hiss(
  c: AudioContext, out: AudioNode, t: number, dur: number, peak: number,
  type: BiquadFilterType, f0: number, f1 = f0, q = 0.7, attack = 0.005,
): void {
  const src = noise(c);
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + Math.min(attack, dur * 0.9));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

/** Run `fn` with a live context, swallowing every failure. */
function play(vol: number, fn: (c: AudioContext, out: AudioNode, t: number) => void): void {
  const c = ensure();
  if (!c || !sfx) return;
  try {
    fn(c, dest(c, vol), c.currentTime);
  } catch {
    /* a sound must never break the game */
  }
}

/** Frequency of the note n semitones above A4 (440 Hz). */
const hz = (n: number): number => 440 * Math.pow(2, n / 12);

// ---------------------------------------------------------------------------
// Original recipes (`vol` = distance attenuation from the router)
// ---------------------------------------------------------------------------

/** Noise → low-pass → gain envelope. The shape of every explosion ever. */
export function boom(intensity = 1, vol = 1): void {
  play(vol, (c, out, t) => {
    const src = noise(c);
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400 * intensity, t);
    filter.frequency.exponentialRampToValueAtTime(60, t + 0.7); // boom darkens as it fades
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.9 * intensity, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    src.connect(filter).connect(gain).connect(out);
    src.start(t);
    src.stop(t + 0.9);
  });
}

/** Pitch-diving square wave + crackle: lightning. */
export function zap(vol = 1): void {
  play(vol, (c, out, t) => {
    tone(c, out, 900, t, 0.2, 0.4, 'square', 70, 0.004);
    hiss(c, out, t, 0.12, 0.5, 'highpass', 2500);
    // The thunder arrives a beat later, like it should.
    setTimeout(() => boom(0.7, vol), 120);
  });
}

/** Long sub-bass rumble for earthquakes and volcanoes. */
export function rumble(seconds: number, vol = 1): void {
  play(vol, (c, out, t) => {
    const src = noise(c);
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 85;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.8, t + 0.4); // swell in
    gain.gain.setValueAtTime(0.8, t + Math.max(0.4, seconds - 0.8));
    gain.gain.exponentialRampToValueAtTime(0.001, t + seconds);
    src.connect(filter).connect(gain).connect(out);
    src.start(t);
    src.stop(t + seconds + 0.1);
  });
}

/** Two sines a fifth apart: the universal "something good/holy happened". */
export function chime(vol = 1): void {
  play(vol, (c, out, t) => {
    tone(c, out, 660, t, 0.5, 0.35);
    tone(c, out, 990, t + 0.09, 0.5, 0.35);
  });
}

/** Short dull knock: a club landing. */
export function thud(vol = 1): void {
  play(vol, (c, out, t) => hiss(c, out, t, 0.1, 0.25, 'lowpass', 300, 300, 0.7, 0.002));
}

/** Flat little thud: "you can't do that" (not enough mana, no shaman). */
export function denied(vol = 1): void {
  play(vol, (c, out, t) => tone(c, out, 140, t, 0.15, 0.25, 'sawtooth', 90, 0.004));
}

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

/** Ward: soft glassy shimmer — stacked high sines, gentle swell. */
export function wardShimmer(vol = 1): void {
  play(vol, (c, out, t) => {
    [1318, 1976, 2637, 3322].forEach((f, i) => tone(c, out, f, t + i * 0.05, 1.1, 0.1, 'sine', f * 1.01, 0.18));
    tone(c, out, 880, t, 0.9, 0.12, 'triangle', undefined, 0.1);
  });
}

/** Warsong: low drum hit, then a horn-ish swell (detuned saws, low-passed). */
export function warsong(vol = 1): void {
  play(vol, (c, out, t) => {
    tone(c, out, 110, t, 0.35, 0.7, 'sine', 48, 0.004);
    hiss(c, out, t, 0.12, 0.3, 'lowpass', 500, 200, 0.7, 0.002);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(350, t + 0.2);
    lp.frequency.exponentialRampToValueAtTime(1400, t + 0.9);
    lp.connect(out);
    tone(c, lp, 147, t + 0.2, 1.1, 0.16, 'sawtooth', undefined, 0.5);
    tone(c, lp, 147 * 1.007, t + 0.2, 1.1, 0.16, 'sawtooth', undefined, 0.5);
    tone(c, lp, 220, t + 0.2, 1.1, 0.1, 'sawtooth', undefined, 0.5);
  });
}

/** Cyclone: band-passed noise sweeping up and back down — a whoosh. */
export function cyclone(vol = 1): void {
  play(vol, (c, out, t) => {
    const src = noise(c);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(1800, t + 0.45);
    bp.frequency.exponentialRampToValueAtTime(400, t + 1.1);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + 1.15);
  });
}

/** Ember strike: small crackling impact. Cheap — fires ~2/s. */
export function ember(vol = 1): void {
  play(vol, (c, out, t) => {
    hiss(c, out, t, 0.09, 0.3, 'bandpass', 1800 + Math.random() * 1500, 600, 1.5, 0.002);
    tone(c, out, 180, t, 0.08, 0.25, 'sine', 70, 0.003);
  });
}

/** Sink: deep watery rumble with a bubbling gurgle on top. */
export function sink(vol = 1): void {
  play(vol, (c, out, t) => {
    hiss(c, out, t, 2.0, 0.6, 'lowpass', 120, 70, 0.7, 0.5);
    for (let i = 0; i < 5; i++) {
      const f = 220 + Math.random() * 200;
      tone(c, out, f, t + 0.2 + i * 0.28 + Math.random() * 0.1, 0.16, 0.1, 'sine', f * 1.9, 0.02);
    }
  });
}

/** Bloom: rising airy arpeggio of soft plucks. */
export function bloom(vol = 1): void {
  play(vol, (c, out, t) => {
    [0, 4, 7, 12, 16].forEach((n, i) => {
      const f = hz(n + 3);
      tone(c, out, f, t + i * 0.08, 0.7, 0.2, 'triangle', undefined, 0.01);
      tone(c, out, f * 2, t + i * 0.08, 0.5, 0.05, 'sine');
    });
  });
}

// ---------------------------------------------------------------------------
// World events
// ---------------------------------------------------------------------------

/** Training complete: wooden clack, then a rising two-note. */
export function trainedSound(vol = 1): void {
  play(vol, (c, out, t) => {
    hiss(c, out, t, 0.04, 0.4, 'bandpass', 1400, 900, 4, 0.001);
    tone(c, out, 520, t + 0.1, 0.25, 0.2, 'triangle');
    tone(c, out, 780, t + 0.2, 0.35, 0.2, 'triangle');
  });
}

/** Building complete: two wooden knocks and a small chord. */
export function builtSound(vol = 1): void {
  play(vol, (c, out, t) => {
    for (const d of [0, 0.13]) {
      hiss(c, out, t + d, 0.05, 0.4, 'bandpass', 700, 450, 5, 0.001);
      tone(c, out, 200, t + d, 0.07, 0.3, 'sine', 120, 0.002);
    }
    [0, 4, 7].forEach((n) => tone(c, out, hz(n - 2), t + 0.3, 0.6, 0.14, 'triangle'));
  });
}

/** Collapse: crunchy noise crumble, lower and shorter than an explosion. */
export function collapseSound(vol = 1): void {
  play(vol, (c, out, t) => {
    hiss(c, out, t, 0.9, 0.7, 'lowpass', 500, 80, 0.7, 0.01);
    for (let i = 0; i < 4; i++) {
      hiss(c, out, t + 0.08 + i * 0.12 + Math.random() * 0.05, 0.07, 0.3, 'bandpass', 500 + Math.random() * 900, 300, 2, 0.002);
    }
  });
}

/** Fire start: a crackle burst of tiny pops. */
export function fireCrackle(vol = 1): void {
  play(vol, (c, out, t) => {
    for (let i = 0; i < 5; i++) {
      hiss(c, out, t + i * 0.035 + Math.random() * 0.03, 0.03, 0.25, 'highpass', 1500 + Math.random() * 2500, 1500, 1, 0.001);
    }
  });
}

/** Dwelling growth: warm three-note rising pluck. */
export function dwellingGrowSound(vol = 1): void {
  play(vol, (c, out, t) => {
    [0, 4, 7].forEach((n, i) => tone(c, out, hz(n - 9), t + i * 0.1, 0.45, 0.22, 'triangle', undefined, 0.008));
  });
}

/** Defect: soft reversed swell — rises into a tick. */
export function defectSound(vol = 1): void {
  play(vol, (c, out, t) => {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.4);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.38);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.45);
  });
}

/** Gift / learn: brighter chime than convert. */
export function giftChime(vol = 1): void {
  play(vol, (c, out, t) => {
    [1047, 1568, 2093].forEach((f, i) => tone(c, out, f, t + i * 0.07, 0.7, 0.2));
  });
}

/** Objective complete: short four-note fanfare. */
export function fanfare(vol = 1): void {
  play(vol, (c, out, t) => {
    [0, 4, 7, 12].forEach((n, i) => {
      const d = i * 0.12;
      const len = i === 3 ? 0.9 : 0.2;
      tone(c, out, hz(n), t + d, len, 0.22, 'triangle', undefined, 0.01);
      tone(c, out, hz(n) * 2, t + d, len, 0.07, 'sine');
    });
  });
}

/** Leader down: low descending tone. */
export function leaderDownSound(vol = 1): void {
  play(vol, (c, out, t) => {
    tone(c, out, 330, t, 1.2, 0.3, 'triangle', 110, 0.02);
    tone(c, out, 165, t, 1.2, 0.2, 'sine', 55, 0.02);
  });
}

/** Leader return: ascending shimmer. */
export function leaderReturnSound(vol = 1): void {
  play(vol, (c, out, t) => {
    [0, 4, 7, 12, 16, 19].forEach((n, i) => tone(c, out, hz(n), t + i * 0.07, 0.9, 0.14, 'sine', undefined, 0.02));
  });
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export function uiClick(): void {
  play(1, (c, out, t) => tone(c, out, 1400, t, 0.04, 0.12, 'square', 900, 0.001));
}

/** Even tinier and very quiet. */
export function uiHover(): void {
  play(1, (c, out, t) => tone(c, out, 2200, t, 0.025, 0.035, 'sine', undefined, 0.002));
}

export type OrderKind = 'move' | 'attack' | 'garrison' | 'build' | 'cast' | 'train';

/** Small quiet blips, one per order kind. */
export function orderAck(kind: OrderKind): void {
  play(1, (c, out, t) => {
    switch (kind) {
      case 'move':
        tone(c, out, 520, t, 0.07, 0.1, 'triangle', 620, 0.003);
        break;
      case 'attack':
        tone(c, out, 300, t, 0.07, 0.12, 'square', 240, 0.003);
        tone(c, out, 300, t + 0.08, 0.07, 0.12, 'square', 240, 0.003);
        break;
      case 'garrison':
        tone(c, out, 420, t, 0.09, 0.1, 'sine', 300, 0.004);
        break;
      case 'build':
        tone(c, out, 330, t, 0.05, 0.12, 'triangle');
        tone(c, out, 440, t + 0.06, 0.07, 0.12, 'triangle');
        break;
      case 'cast':
        tone(c, out, 880, t, 0.12, 0.09, 'sine', 1320, 0.005);
        break;
      case 'train':
        tone(c, out, 480, t, 0.05, 0.1, 'triangle');
        tone(c, out, 640, t + 0.06, 0.05, 0.1, 'triangle');
        break;
    }
  });
}

/** Alert horn: two-tone for an attack, gentle for info/good. */
export function alertSound(kind: 'attack' | 'info' | 'good'): void {
  play(1, (c, out, t) => {
    if (kind === 'attack') {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      lp.connect(out);
      tone(c, lp, 247, t, 0.22, 0.28, 'sawtooth', undefined, 0.02);
      tone(c, lp, 185, t + 0.24, 0.35, 0.28, 'sawtooth', undefined, 0.02);
    } else if (kind === 'info') {
      tone(c, out, 700, t, 0.25, 0.15, 'sine');
    } else {
      tone(c, out, 660, t, 0.2, 0.15, 'sine');
      tone(c, out, 880, t + 0.1, 0.3, 0.15, 'sine');
    }
  });
}

// ---------------------------------------------------------------------------
// Ambient bed — a few long-lived nodes, owned by the Soundscape
// ---------------------------------------------------------------------------

export interface AmbientBed {
  /** Linear levels, 0..1 each. Smoothed internally. */
  set(wind: number, sea: number): void;
  /** One short bird chirp (sine glissandi), level 0..1. */
  chirp(level: number): void;
  stop(): void;
}

/** Start the wind + surf bed. Returns null with no audio. */
export function startAmbientBed(): AmbientBed | null {
  const c = ensure();
  if (!c || !ambientBus) return null;
  try {
    const bus = ambientBus;
    // A longer, brownish noise loop so the bed doesn't audibly repeat.
    const len = c.sampleRate * 6;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.04;
      d[i] = last * 3.2;
    }
    const mk = (): AudioBufferSourceNode => {
      const s = c.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      return s;
    };
    const lfo = (rate: number, depth: number, target: AudioParam): OscillatorNode => {
      const o = c.createOscillator();
      o.frequency.value = rate;
      const g = c.createGain();
      g.gain.value = depth;
      o.connect(g).connect(target);
      o.start();
      return o;
    };

    // Wind: band-passed brown noise, slow LFO on cutoff and level.
    const wind = mk();
    const wf = c.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 420;
    wf.Q.value = 0.8;
    const wg = c.createGain();
    wg.gain.value = 0;
    const wLevel = c.createGain(); // LFO-modulated multiplier
    wLevel.gain.value = 0.7;
    wind.connect(wf).connect(wg).connect(wLevel).connect(bus);
    const o1 = lfo(0.07, 160, wf.frequency);
    const o2 = lfo(0.11, 0.25, wLevel.gain);
    wind.start();

    // Surf: low-passed noise with a slow swell.
    const surf = mk();
    const sf = c.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 500;
    const sg = c.createGain();
    sg.gain.value = 0;
    const sLevel = c.createGain();
    sLevel.gain.value = 0.55;
    surf.connect(sf).connect(sg).connect(sLevel).connect(bus);
    const o3 = lfo(0.1, 0.45, sLevel.gain);
    const o4 = lfo(0.1, 140, sf.frequency);
    surf.start(0, 2.5);

    return {
      set(w, s) {
        const now = c.currentTime;
        wg.gain.setTargetAtTime(Math.max(0, w) * 0.16, now, 0.8);
        sg.gain.setTargetAtTime(Math.max(0, s) * 0.2, now, 0.8);
      },
      chirp(level) {
        if (level <= 0.01) return;
        try {
          const t = c.currentTime;
          const base = 2400 + Math.random() * 1600;
          const n = 1 + Math.floor(Math.random() * 3);
          for (let i = 0; i < n; i++) {
            const up = Math.random() < 0.6;
            tone(c, bus, base, t + i * 0.11, 0.09, 0.05 * level, 'sine', up ? base * 1.35 : base * 0.75, 0.01);
          }
        } catch {
          /* ignore */
        }
      },
      stop() {
        for (const s of [wind, surf]) {
          try { s.stop(); } catch { /* already stopped */ }
        }
        for (const o of [o1, o2, o3, o4]) {
          try { o.stop(); } catch { /* already stopped */ }
        }
      },
    };
  } catch {
    return null;
  }
}
