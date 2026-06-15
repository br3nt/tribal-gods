/**
 * render/effects.ts — the fireworks department.
 *
 * The sim announces what happened (world.events — plain {type, x, z}
 * facts); this module decides what that LOOKS and SOUNDS like. Keeping the
 * mapping here means the sim never knows pixels exist, and we can re-art
 * every spell without touching gameplay.
 *
 * All visuals are deliberately primitive-built, like everything else:
 *
 *   explosion  — an expanding sphere fading from yellow-white to embers
 *   lightning  — a tall thin cylinder flashed for a tenth of a second
 *                (your eye writes the jagged bolt in for free)
 *   plume      — dark spheres rising and swelling from the volcano throat
 *   rings      — expanding flat toruses: converts, splashes, cast flashes
 *   swamp      — flat dark decals laid over swamped tiles
 *
 * Each live effect is {mesh, age, ttl, drive()} — drive() repositions/
 * fades it per frame, and expired effects are disposed. A real engine
 * would pool these; at our effect counts, allocation is nowhere near the
 * profiler's radar (the rule: optimizations must be earned).
 */

import * as THREE from 'three';
import { CURVATURE, TILE, WORLD_SIZE } from '../config';
import { boom, chime, denied, rumble, thud, zap } from '../core/audio';
import { wrapDelta } from '../core/util';
import { CameraRig } from './camera-rig';
import { World } from '../sim/world-state';

const WORLD_UNITS = WORLD_SIZE * TILE;

interface Effect {
  mesh: THREE.Mesh;
  age: number;
  ttl: number;
  /** Per-frame behavior: grow, rise, fade... anything. */
  drive(e: Effect, dt: number): void;
}

export class EffectsRenderer {
  private effects: Effect[] = [];
  private readonly swampDecals = new Map<number, THREE.Mesh>();
  private readonly swampGeo = new THREE.CircleGeometry(1.35, 10);
  private readonly swampMat = new THREE.MeshBasicMaterial({
    color: 0x3a5a28,
    transparent: true,
    opacity: 0.8,
  });

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rig: CameraRig,
  ) {
    this.swampGeo.rotateX(-Math.PI / 2);
  }

  /** Drain new events, animate live effects, maintain swamp decals. */
  sync(world: World, camTarget: THREE.Vector3, dt: number): void {
    for (const ev of world.events.splice(0)) {
      if (ev.type === 'fireball' && ev.x2 !== undefined && ev.z2 !== undefined) {
        this.projectile(ev.x, ev.z, ev.x2, ev.z2, world, camTarget);
        continue;
      }
      this.spawn(ev.type, ev.x, ev.z, ev.magnitude ?? 1, world, camTarget);
    }

    // Animate & expire.
    for (const e of this.effects) {
      e.age += dt;
      e.drive(e, dt);
      if (e.age >= e.ttl) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        (e.mesh.material as THREE.Material).dispose();
      }
    }
    this.effects = this.effects.filter((e) => e.age < e.ttl);

    // Swamp decals mirror the sim's swamp set exactly.
    for (const idx of world.swamp.keys()) {
      if (!this.swampDecals.has(idx)) {
        const m = new THREE.Mesh(this.swampGeo, this.swampMat);
        this.scene.add(m);
        this.swampDecals.set(idx, m);
      }
    }
    for (const [idx, m] of this.swampDecals) {
      if (!world.swamp.has(idx)) {
        this.scene.remove(m);
        this.swampDecals.delete(idx);
        continue;
      }
      const tx = idx % WORLD_SIZE;
      const tz = Math.floor(idx / WORLD_SIZE);
      this.place(m.position, tx, tz, world, camTarget, 0.12);
    }
  }

  // -------------------------------------------------------------------------

  private spawn(
    type: string,
    x: number,
    z: number,
    magnitude: number,
    world: World,
    camTarget: THREE.Vector3,
  ): void {
    switch (type) {
      case 'explosion': {
        boom(1);
        this.rig.shake(0.7);
        this.fireball(x, z, world, camTarget);
        return;
      }
      case 'lightning': {
        zap();
        this.rig.shake(0.3);
        // The bolt: a 40-unit white column, alive for a literal blink.
        const bolt = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.3, 40, 5),
          new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 1 }),
        );
        this.place(bolt.position, x, z, world, camTarget, 20);
        this.add(bolt, 0.14, (e) => {
          (e.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - e.age / e.ttl;
        });
        this.fireball(x, z, world, camTarget, 0.5);
        return;
      }
      case 'convert': {
        chime();
        this.ring(x, z, 0x88eaff, world, camTarget);
        return;
      }
      case 'unlock': {
        // A spell learned at a monument: gold rings, doubled, plus the
        // chime — bigger moment than a convert, and it should feel like it.
        chime();
        this.ring(x, z, 0xffd75e, world, camTarget, 1.4);
        this.ring(x, z, 0xffe9a8, world, camTarget, 0.8);
        return;
      }
      case 'castFlash': {
        this.ring(x, z, 0xcfe8ff, world, camTarget, 0.5);
        return;
      }
      case 'hit': {
        // Melee impact: a brief white spark at the point of contact.
        thud();
        const spark = new THREE.Mesh(
          new THREE.SphereGeometry(0.25, 6, 5),
          new THREE.MeshBasicMaterial({ color: 0xfff2cc, transparent: true, opacity: 0.9 }),
        );
        this.place(spark.position, x, z, world, camTarget, 1);
        this.add(spark, 0.16, (e) => {
          e.mesh.scale.addScalar(0.12);
          (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - e.age / e.ttl);
        });
        return;
      }
      case 'splash': {
        this.ring(x, z, 0x9fd4f5, world, camTarget, 0.6);
        return;
      }
      case 'death': {
        // A small gray soul-puff. A proper ascending spirit is on the
        // wishlist; even this dot of punctuation makes deaths legible.
        const puff = new THREE.Mesh(
          new THREE.SphereGeometry(0.4, 6, 5),
          new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.7 }),
        );
        this.place(puff.position, x, z, world, camTarget, 1);
        this.add(puff, 0.9, (e, d) => {
          e.mesh.position.y += d * 2.2; // rise
          (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - e.age / e.ttl);
        });
        return;
      }
      case 'plume': {
        const smoke = new THREE.Mesh(
          new THREE.SphereGeometry(0.9, 7, 6),
          new THREE.MeshBasicMaterial({ color: 0x3c3733, transparent: true, opacity: 0.85 }),
        );
        this.place(smoke.position, x, z, world, camTarget, 2);
        const drift = (Math.random() - 0.5) * 1.5;
        this.add(smoke, 2.2, (e, d) => {
          e.mesh.position.y += d * 4;
          e.mesh.position.x += d * drift;
          e.mesh.scale.addScalar(d * 1.1); // smoke spreads as it climbs
          (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - e.age / e.ttl);
        });
        return;
      }
      case 'volcanoStart':
        rumble(9);
        this.rig.shake(1.2);
        return;
      case 'quakeStart':
        rumble(4);
        return;
      case 'rumbleSmall':
        rumble(2);
        return;
      case 'shake':
        this.rig.shake(magnitude);
        return;
      case 'swamp':
        // Decals appear via the swamp-set mirror; just squelch... someday.
        return;
      case 'denied':
        denied();
        return;
    }
  }

  /**
   * A firewarrior's shot: a glowing ember that arcs from shooter to target
   * over a quarter second, with a little impact flash on arrival. The sim
   * already applied the damage — this is pure theater, which is why the
   * projectile can never miss.
   */
  private projectile(x: number, z: number, x2: number, z2: number, world: World, camTarget: THREE.Vector3): void {
    const ember = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xffb347 }),
    );
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    this.place(from, x, z, world, camTarget, 1.4);
    this.place(to, x2, z2, world, camTarget, 0.9);
    ember.position.copy(from);
    this.add(ember, 0.26, (e) => {
      const t = e.age / e.ttl;
      e.mesh.position.lerpVectors(from, to, t);
      e.mesh.position.y += Math.sin(t * Math.PI) * 1.2; // a lazy arc
      if (t > 0.96) {
        // Impact flash on the final frame.
        this.fireball(x2, z2, world, camTarget, 0.18);
      }
    });
  }

  /** Expanding fire sphere: yellow-hot → ember-orange → gone. */
  private fireball(x: number, z: number, world: World, camTarget: THREE.Vector3, scale = 1): void {
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.95 }),
    );
    this.place(ball.position, x, z, world, camTarget, 0.8);
    this.add(ball, 0.7, (e, d) => {
      e.mesh.scale.addScalar(d * 7 * scale);
      const m = e.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = 0.95 * (1 - e.age / e.ttl);
      m.color.lerp(new THREE.Color(0xb83a14), d * 3); // cool toward ember
    });
  }

  /** Expanding flat ring — the all-purpose "something magical happened here". */
  private ring(x: number, z: number, color: number, world: World, camTarget: THREE.Vector3, scale = 1): void {
    const geo = new THREE.TorusGeometry(0.7, 0.09, 6, 24);
    geo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }),
    );
    ring.renderOrder = 8;
    this.place(ring.position, x, z, world, camTarget, 0.5);
    this.add(ring, 0.6, (e, d) => {
      e.mesh.scale.addScalar(d * 6 * scale);
      (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - e.age / e.ttl);
    });
  }

  private add(mesh: THREE.Mesh, ttl: number, drive: (e: Effect, dt: number) => void): void {
    this.scene.add(mesh);
    this.effects.push({ mesh, age: 0, ttl, drive });
  }

  /** Standard wrap-anchor + curvature placement (same math as every renderer). */
  private place(
    pos: THREE.Vector3,
    tileX: number,
    tileZ: number,
    world: World,
    camTarget: THREE.Vector3,
    lift: number,
  ): void {
    const relX = wrapDelta(tileX * TILE - camTarget.x, WORLD_UNITS);
    const relZ = wrapDelta(tileZ * TILE - camTarget.z, WORLD_UNITS);
    const y =
      Math.max(0, world.map.sampleHeight(tileX, tileZ)) - CURVATURE * (relX * relX + relZ * relZ);
    pos.set(camTarget.x + relX, y + lift, camTarget.z + relZ);
  }
}
