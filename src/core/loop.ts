/**
 * core/loop.ts — the fixed-timestep game loop.
 *
 * THE PROBLEM: monitors render whenever they like (60 Hz, 120 Hz, a janky
 * 47 Hz on a hot laptop), but gameplay must be deterministic — a volcano
 * should grow in exactly the same steps on every machine, every run.
 *
 * THE CLASSIC SOLUTION (used by virtually every RTS): split time in two.
 *
 *   - The SIMULATION steps in fixed slices of exactly 1/TICK_HZ seconds.
 *     We accumulate real elapsed time and run as many fixed ticks as fit.
 *   - The RENDERER runs every animation frame and is handed `alpha`, how
 *     far we are *between* two ticks (0..1), so it can interpolate visual
 *     positions and stay buttery while the sim stays chunky and exact.
 *
 * Search "fix your timestep" for the canonical essay on this pattern.
 */

import { TICK_HZ } from '../config';

export interface LoopStats {
  /** Render frames per second (smoothed). */
  fps: number;
  /** Total simulation ticks since start. */
  tickCount: number;
}

export interface LoopCallbacks {
  /** Advance gameplay by exactly `dt` seconds (always 1/TICK_HZ). */
  tick(dt: number): void;
  /** Draw a frame. `dt` = real seconds since last frame, `alpha` = progress between ticks. */
  render(dt: number, alpha: number): void;
}

export function startLoop(cb: LoopCallbacks): LoopStats {
  const stats: LoopStats = { fps: 0, tickCount: 0 };
  const TICK_DT = 1 / TICK_HZ;

  let last = performance.now();
  let accumulator = 0;

  function frame(now: number) {
    // Real time since last frame, in seconds. Capped so that a long pause
    // (tab in background, debugger) doesn't make us "catch up" with a
    // hundred ticks in one frame — the infamous spiral of death.
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;

    // Run however many whole fixed ticks fit into the accumulated time.
    accumulator += dt;
    while (accumulator >= TICK_DT) {
      cb.tick(TICK_DT);
      stats.tickCount++;
      accumulator -= TICK_DT;
    }

    // Whatever time is left over is "partway to the next tick".
    cb.render(dt, accumulator / TICK_DT);

    // Exponential moving average keeps the FPS readout calm.
    if (dt > 0) stats.fps = stats.fps * 0.95 + (1 / dt) * 0.05;

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  return stats;
}
