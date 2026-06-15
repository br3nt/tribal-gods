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
 *   CHIME      = two sine tones a musical fifth apart. Sines are "pure"
 *                and read as magic/holy across basically all games.
 *
 * Browsers refuse to make sound before the user interacts with the page
 * (autoplay policy), so the AudioContext is created lazily and main.ts
 * pokes resume() on the first pointer event.
 */

let ctx: AudioContext | null = null;

/** Master volume — all effects route through one gain node. */
const MASTER = 0.22;
let master: GainNode | null = null;

function ensure(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = MASTER;
      master.connect(ctx.destination);
    } catch {
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

/** Noise → low-pass → gain envelope. The shape of every explosion ever. */
export function boom(intensity = 1): void {
  const c = ensure();
  if (!c || !master) return;
  const t = c.currentTime;
  const src = noise(c);
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(400 * intensity, t);
  filter.frequency.exponentialRampToValueAtTime(60, t + 0.7); // boom darkens as it fades
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.9 * intensity, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
  src.stop(t + 0.9);
}

/** Pitch-diving square wave + crackle: lightning, denial buzzes. */
export function zap(): void {
  const c = ensure();
  if (!c || !master) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(900, t);
  osc.frequency.exponentialRampToValueAtTime(70, t + 0.18);
  const og = c.createGain();
  og.gain.setValueAtTime(0.4, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.25);

  const crackle = noise(c);
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.5, t);
  cg.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  crackle.connect(hp).connect(cg).connect(master);
  crackle.start(t);
  crackle.stop(t + 0.15);
  // The thunder arrives a beat later, like it should.
  setTimeout(() => boom(0.7), 120);
}

/** Long sub-bass rumble for earthquakes and volcanoes. */
export function rumble(seconds: number): void {
  const c = ensure();
  if (!c || !master) return;
  const t = c.currentTime;
  const src = noise(c);
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 85;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.8, t + 0.4); // swell in
  gain.gain.setValueAtTime(0.8, t + seconds - 0.8);
  gain.gain.exponentialRampToValueAtTime(0.001, t + seconds);
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
  src.stop(t + seconds + 0.1);
}

/** Two sines a fifth apart: the universal "something good/holy happened". */
export function chime(): void {
  const c = ensure();
  if (!c || !master) return;
  const t = c.currentTime;
  for (const [freq, delay] of [[660, 0], [990, 0.09]] as const) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.35, t + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.5);
    osc.connect(gain).connect(master);
    osc.start(t + delay);
    osc.stop(t + delay + 0.6);
  }
}

/** Short dull knock: a club landing. Quieter than the god-power booms —
 *  battles involve dozens of these a minute. */
export function thud(): void {
  const c = ensure();
  if (!c || !master) return;
  const t = c.currentTime;
  const src = noise(c);
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 300;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.25, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
  src.stop(t + 0.12);
}

/** Flat little thud: "you can't do that" (not enough mana, no shaman). */
export function denied(): void {
  const c = ensure();
  if (!c || !master) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 0.12);
  const gain = c.createGain();
  gain.gain.setValueAtTime(0.25, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + 0.2);
}
