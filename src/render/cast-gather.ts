/**
 * render/cast-gather.ts — power gathering in the leader before a spell.
 *
 * While a leader stands casting (sim: kind 'shaman', state 'working',
 * castSpell + castTarget set, workTimer counting down from the spell's
 * castSeconds) a sigil in the spell's colour (look.ts SPELL_LOOK glow)
 * turns on the ground under her feet and a twin opens at the mark. Motes
 * spiral up round her; at the mark they gather. Lightning also draws a dark
 * cloud together over its mark. When the cast lets go, a streak of light
 * runs from her to the mark — so the power visibly comes FROM the leader.
 * (The staff's own glow is the unit renderer's: it reads the same state.)
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { spellDef } from '../sim/catalog';
import type { Unit, World } from '../sim/world-state';
import { EffectsRenderer, fxMaterial, GLOW, MeshFx, SMOKE } from './effects';
import { SPELL_LOOK, SPELL_LOOK_DEFAULT } from './look';

interface Gather {
  spell: string;
  color: number;
  /** The spell's colour as a THREE.Color (cached: motes read it every frame). */
  c: THREE.Color;
  under: MeshFx;
  mark: MeshFx;
  ux: number;
  uz: number;
  tx: number;
  tz: number;
  prog: number;
  seen: boolean;
  acc: number;
  cloudAcc: number;
}

/** Is this unit standing in a cast right now? */
export function isCasting(u: Pick<Unit, 'kind' | 'state' | 'castSpell' | 'castTarget' | 'hidden'>): boolean {
  return u.kind === 'shaman' && u.state === 'working' && !!u.castSpell && !!u.castTarget && !u.hidden;
}

export class CastGather {
  private readonly live = new Map<number, Gather>();
  private readonly disc = new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2);

  constructor(private readonly fx: EffectsRenderer) {
    this.disc.userData.keep = true; // shared by every sigil: never disposed with one
  }

  /** A new world: drop every sigil at once (no release streak into the new map). */
  reset(): void {
    for (const g of this.live.values()) for (const m of [g.under, g.mark]) m.ttl = m.age;
    this.live.clear();
  }

  sync(world: World, dt: number): void {
    for (const g of this.live.values()) g.seen = false;
    for (const u of world.units) {
      if (!isCasting(u)) continue;
      const spell = u.castSpell!;
      let g = this.live.get(u.id);
      if (g && g.spell !== spell) {
        this.release(g, false);
        this.live.delete(u.id);
        g = undefined;
      }
      const color = (SPELL_LOOK[spell] ?? SPELL_LOOK_DEFAULT).glow;
      if (!g) {
        g = {
          spell, color, c: new THREE.Color(color), under: this.sigil(u.x, u.z, color, 2.6), mark: this.sigil(u.castTarget!.x, u.castTarget!.z, color, Math.max(3, spellDef(spell).radius * TILE * 0.55)),
          ux: u.x, uz: u.z, tx: u.castTarget!.x, tz: u.castTarget!.z, prog: 0, seen: true, acc: 0, cloudAcc: 0,
        };
        this.live.set(u.id, g);
      }
      g.seen = true;
      const total = spellDef(spell).castSeconds;
      g.prog = Math.min(1, Math.max(0, 1 - u.workTimer / Math.max(0.05, total)));
      g.ux = u.x;
      g.uz = u.z;
      g.tx = u.castTarget!.x;
      g.tz = u.castTarget!.z;
      g.under.ttl = g.mark.ttl = Infinity;
      g.under.mats[0].uniforms.uProg.value = g.prog;
      g.mark.mats[0].uniforms.uProg.value = g.prog;
      g.under.tx = g.ux;
      g.under.tz = g.uz;
      g.mark.tx = g.tx;
      g.mark.tz = g.tz;
      this.motes(g, dt);
      if (spell === 'lightning') this.cloud(g, dt);
    }
    for (const [id, g] of this.live) {
      if (g.seen) continue;
      this.release(g, g.prog > 0.6);
      this.live.delete(id);
    }
  }

  private motes(g: Gather, dt: number): void {
    const fx = this.fx;
    g.acc += dt * fx.detail * (20 + 50 * g.prog);
    const c = g.c;
    const centre = fx.at(g.ux, g.uz, 0);
    const cx = centre.x, cz = centre.z;
    for (; g.acc >= 1; g.acc--) {
      // rising round the leader, spiralling in
      const a = Math.random() * Math.PI * 2;
      const r = 1.2 + Math.random() * 1.6;
      const p = fx.at(g.ux, g.uz, 0.2 + Math.random() * 0.6);
      fx.glow.emit({
        x: p.x + Math.cos(a) * r, y: p.y, z: p.z + Math.sin(a) * r,
        vx: -Math.cos(a) * 0.8, vy: 2 + 3 * g.prog, vz: -Math.sin(a) * 0.8,
        life: 0.9, size: 0.35, sizeEnd: 0.08, r: c.r * 5, g: c.g * 5, b: c.b * 5,
        drag: 0.4, shape: GLOW, fadeIn: 0.2, swirl: 3, ax: cx, az: cz,
      });
      // gathering at the mark
      if (Math.random() < 0.6) {
        const m = fx.at(g.tx, g.tz, 0);
        const mx = m.x, mz = m.z;
        const b = Math.random() * Math.PI * 2;
        const rr = 3 + Math.random() * 3;
        const q = fx.at(g.tx + (Math.cos(b) * rr) / TILE, g.tz + (Math.sin(b) * rr) / TILE, 0.3 + Math.random());
        fx.glow.emit({
          x: q.x, y: q.y, z: q.z, vx: -Math.cos(b) * rr * 0.9, vy: 1.5, vz: -Math.sin(b) * rr * 0.9,
          life: 0.8, size: 0.4, sizeEnd: 0.1, r: c.r * 4, g: c.g * 4, b: c.b * 4,
          drag: 0.6, shape: GLOW, fadeIn: 0.3, swirl: -2, ax: mx, az: mz,
        });
      }
    }
  }

  /** Lightning: a dark cloud draws together over the mark. */
  private cloud(g: Gather, dt: number): void {
    const fx = this.fx;
    g.cloudAcc += dt * fx.detail * 40;
    const m = fx.at(g.tx, g.tz, 17);
    const mx = m.x, my = m.y, mz = m.z;
    for (; g.cloudAcc >= 1; g.cloudAcc--) {
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 7 * (1 - g.prog * 0.6);
      const v = 0.07 + Math.random() * 0.05;
      fx.matter.emit({
        x: mx + Math.cos(a) * r, y: my + (Math.random() - 0.5) * 3, z: mz + Math.sin(a) * r,
        vx: -Math.cos(a) * r * 0.9, vy: 0, vz: -Math.sin(a) * r * 0.9,
        life: 1.4, size: 4, sizeEnd: 8, r: v, g: v, b: v * 1.25, alpha: 0.85, drag: 1.2, shape: SMOKE, fadeIn: 0.25,
        swirl: 0.8, ax: mx, az: mz,
      });
    }
    if (Math.random() < dt * 3 * g.prog) {
      fx.glow.emit({ x: mx + (Math.random() - 0.5) * 6, y: my, z: mz + (Math.random() - 0.5) * 6, life: 0.15, size: 5, r: 0.8, g: 0.85, b: 1.3, alpha: 0.5, shape: GLOW, fadeIn: 0.01 });
    }
  }

  /** The cast lets go: sigils flare and fade; a streak runs leader → mark. */
  private release(g: Gather, fired: boolean): void {
    for (const m of [g.under, g.mark]) {
      m.ttl = m.age + (fired ? 0.5 : 0.25);
      m.mats[0].uniforms.uProg.value = fired ? 1.4 : g.prog;
    }
    if (!fired) return;
    const fx = this.fx;
    const c = new THREE.Color(g.color);
    const a = fx.at(g.ux, g.uz, 2.4).clone();
    const dx = wrapDelta(g.tx - g.ux, WORLD_SIZE) * TILE;
    const dz = wrapDelta(g.tz - g.uz, WORLD_SIZE) * TILE;
    const by = fx.ground(g.tx, g.tz) + 1;
    const n = fx.n(40, 14);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const arc = Math.sin(t * Math.PI) * Math.min(8, Math.hypot(dx, dz) * 0.25);
      fx.glow.emit({
        x: a.x + dx * t, y: a.y + (by - a.y) * t + arc, z: a.z + dz * t,
        life: 0.12 + t * 0.25, size: 0.9, sizeEnd: 0.3, r: c.r * 7, g: c.g * 7, b: c.b * 7, shape: GLOW, fadeIn: 0.01,
      });
    }
  }

  /** A turning rune sigil draped on the ground; uProg (0..1+) grows and brightens it. */
  private sigil(tx: number, tz: number, color: number, radius: number): MeshFx {
    const c = new THREE.Color(color).multiplyScalar(2.2);
    const mat = fxMaterial(
      this.fx.heightUniform,
      /* glsl */ `
        float r = length(vLocal.xz);
        float ang = atan(vLocal.z, vLocal.x);
        float outer = 1.0 - smoothstep(0.0, 0.03, abs(r - 0.93));
        float inner = 1.0 - smoothstep(0.0, 0.025, abs(r - 0.62));
        float band = step(0.66, r) * step(r, 0.89);
        float glyph = smoothstep(0.45, 0.9, sin(ang * 18.0 + uTime * 1.5) * 0.5 + 0.5)
                    * (1.0 - smoothstep(0.0, 0.09, abs(r - 0.775 - 0.05 * sin(ang * 54.0))));
        float star = (1.0 - smoothstep(0.0, 0.035, abs(sin(ang * 2.5 - uTime * 0.7)) * r)) * step(r, 0.6);
        float fill = (1.0 - r) * 0.18;
        float a = (outer + inner * 0.8 + glyph * band * 1.2 + star * 0.5 + fill) * step(r, 1.0);
        float k = clamp(uProg, 0.0, 1.5);
        gl_FragColor = vec4(uColor * a * (0.35 + 0.9 * k) * uAlpha, 1.0);
      `,
      { uColor: { value: c }, uProg: { value: 0 } },
      { drape: true },
    );
    const mesh = new THREE.Mesh(this.disc, mat);
    mesh.renderOrder = 7;
    return this.fx.addFx(mesh, [mat], tx, tz, 0, Infinity, (f, dt) => {
      f.obj.position.y = 0;
      const p = Math.min(1.4, mat.uniforms.uProg.value as number);
      const s = radius * (0.45 + 0.55 * Math.min(1, f.age * 3)) * (1 + 0.15 * Math.max(0, p - 1));
      f.obj.scale.set(s, 1, s);
      f.obj.rotation.y += dt * (0.6 + 1.6 * p);
      mat.uniforms.uAlpha.value = Math.min(1, f.age * 5) * Math.min(1, (f.ttl - f.age) * 4);
    });
  }
}
