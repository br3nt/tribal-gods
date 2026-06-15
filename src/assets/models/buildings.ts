/**
 * assets/models/buildings.ts — huts and the village totem, as recipes.
 *
 * Same philosophy as figures.ts: primitives, hand-placed, readable. The
 * interesting addition is CONSTRUCTION STAGES. A building's model exposes
 * setProgress(0..1) and shows the right moment of its own assembly:
 *
 *   0.0–0.4   staked-out site (corner posts) while builders level the ground
 *   0.4–0.8   walls rising — literally scaled up out of the earth
 *   0.8–1.0   roof on, stakes gone, done
 *
 * Scaling the wall box vertically as progress climbs is a 20-cent trick
 * that reads, at game zoom, exactly like "being built". The original played
 * a similar game with staged models.
 */

import * as THREE from 'three';
import { Civ, CIVS, COLOR_HUT_ROOF } from '../../config';

const mat = (color: number) => new THREE.MeshLambertMaterial({ color });

export interface BuildingModel {
  root: THREE.Group;
  setProgress(p: number): void;
}

/**
 * The civ's roof, the single strongest architectural signature:
 *   thatch  — the 4-sided cone pyramid of the Forest Tribe
 *   stepped — stacked shrinking sandstone slabs (River Dynasty ziggurat)
 *   gabled  — a steep stretched prism, the Northmen's snow-shedding hall
 */
function buildRoof(civ: Civ): THREE.Group {
  const g = new THREE.Group();
  switch (civ.roof) {
    case 'thatch': {
      const roof = new THREE.Mesh(new THREE.ConeGeometry(2.45, 1.5, 4), mat(civ.roofColor));
      roof.rotation.y = Math.PI / 4;
      roof.position.y = 2.05;
      g.add(roof);
      break;
    }
    case 'stepped': {
      for (let i = 0; i < 3; i++) {
        const w = 2.9 - i * 0.85;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, w), mat(civ.roofColor));
        slab.position.y = 1.5 + i * 0.42;
        g.add(slab);
      }
      break;
    }
    case 'gabled': {
      // A 4-sided cone squashed on one axis = a steep ridge roof.
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 2.1, 4), mat(civ.roofColor));
      roof.rotation.y = Math.PI / 4;
      roof.scale.z = 1.5;
      roof.position.y = 2.35;
      g.add(roof);
      break;
    }
  }
  return g;
}

export function buildHut(teamColor: number, civ: Civ = CIVS.forest): BuildingModel {
  const root = new THREE.Group();

  // Corner stakes — the "under construction" sign.
  const stakes = new THREE.Group();
  const stakeGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.0, 5);
  const stakeMat = mat(0x8a6a40);
  for (const [sx, sz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
    const s = new THREE.Mesh(stakeGeo, stakeMat);
    s.position.set(sx, 0.5, sz);
    stakes.add(s);
  }
  root.add(stakes);

  // Walls: one box, scaled up from the ground during construction.
  // Geometry is shifted so its base sits at y=0 — then scaling y GROWS it
  // upward from the dirt instead of inflating it around its middle.
  const wallGeo = new THREE.BoxGeometry(2.8, 1.3, 2.8);
  wallGeo.translate(0, 0.65, 0);
  const walls = new THREE.Mesh(wallGeo, mat(civ.wallColor));
  root.add(walls);

  // Door: a dark inset on the south face (+z) — where residents come and go.
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.1), mat(0x2e2218));
  door.position.set(0, 0.45, 1.41);
  root.add(door);

  // Civ roof, topped with a team-color finial so tribe ownership reads
  // from across the map.
  const roof = buildRoof(civ);
  const finial = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 0.22), mat(teamColor));
  finial.position.y = civ.roof === 'gabled' ? 3.6 : 3.0;
  root.add(roof, finial);

  function setProgress(p: number): void {
    stakes.visible = p < 1;
    const wallRise = Math.min(1, Math.max(0.04, (p - 0.35) / 0.45));
    walls.scale.y = wallRise;
    door.visible = p > 0.6;
    roof.visible = finial.visible = p >= 0.8;
  }
  setProgress(0);

  return { root, setProgress };
}

/**
 * A monument: an ancient stone head holding one spell for whichever god's
 * leader worships at it first. Glowing eyes = unclaimed and waiting. The
 * face is four boxes — brow, nose, lip, chin — which is genuinely all a
 * face needs at this scale.
 */
export function buildMonument(): { root: THREE.Group; setClaimed(c: boolean): void } {
  const root = new THREE.Group();
  const stone = mat(0x7e8388);
  const dark = mat(0x5d6166);

  const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.6, 1.3), stone);
  head.position.y = 1.3;
  const brow = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 0.4), dark);
  brow.position.set(0, 2.2, 0.55);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.9, 0.34), dark);
  nose.position.set(0, 1.55, 0.62);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.26, 0.28), dark);
  lip.position.set(0, 0.85, 0.6);
  root.add(head, brow, nose, lip);

  const eyeMat = new THREE.MeshLambertMaterial({ color: 0x88eaff, emissive: 0x3fb8d8 });
  const eyes: THREE.Mesh[] = [];
  for (const ex of [-0.4, 0.4]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.1), eyeMat);
    eye.position.set(ex, 1.95, 0.68);
    root.add(eye);
    eyes.push(eye);
  }

  return {
    root,
    setClaimed(claimed: boolean): void {
      // The light goes out of its eyes; the knowledge has moved on.
      for (const e of eyes) e.visible = !claimed;
    },
  };
}

/**
 * A warrior training hut: the basic hut silhouette, but with a darker
 * hide roof and two crossed club shapes over the door. Distinguishing
 * buildings by roof + one prop is the cheapest legible vocabulary.
 */
export function buildWarriorHut(teamColor: number, civ: Civ = CIVS.forest): BuildingModel {
  const base = buildHut(teamColor, civ);
  base.root.traverse((o) => {
    // Re-tint the roof to dark hide — "this building means business".
    if (o instanceof THREE.Mesh && (o.material as THREE.MeshLambertMaterial).color?.getHex() === civ.roofColor) {
      (o.material as THREE.MeshLambertMaterial).color.setHex(0x6b4a30);
    }
  });
  const clubs = new THREE.Group();
  for (const tilt of [0.5, -0.5]) {
    const club = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.04, 0.9, 5), mat(0x5a3e24));
    club.rotation.z = tilt;
    clubs.add(club);
  }
  clubs.position.set(0, 1.55, 1.45);
  base.root.add(clubs);
  const inner = base.setProgress;
  return { root: base.root, setProgress: (p) => { inner(p); clubs.visible = p >= 0.8; } };
}

/** A firewarrior hut: ember-orange roof and a glowing brazier at the door. */
export function buildFireHut(teamColor: number, civ: Civ = CIVS.forest): BuildingModel {
  const base = buildHut(teamColor, civ);
  base.root.traverse((o) => {
    if (o instanceof THREE.Mesh && (o.material as THREE.MeshLambertMaterial).color?.getHex() === civ.roofColor) {
      (o.material as THREE.MeshLambertMaterial).color.setHex(0xb8622e);
    }
  });
  const brazier = new THREE.Group();
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.12, 0.3, 7), mat(0x4a3a28));
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.4, 6),
    new THREE.MeshLambertMaterial({ color: 0xffb347, emissive: 0xd86018 }),
  );
  flame.position.y = 0.35;
  brazier.add(bowl, flame);
  brazier.position.set(0.9, 0.15, 1.7);
  base.root.add(brazier);
  const inner = base.setProgress;
  return { root: base.root, setProgress: (p) => { inner(p); brazier.visible = p >= 0.8; } };
}

/**
 * A guard tower: a tapering stone column with a thatched lookout. Tall and
 * thin so it reads instantly against the squat huts — and tall enough to
 * justify its range advantage diegetically.
 */
export function buildTower(teamColor: number): BuildingModel {
  const root = new THREE.Group();

  const stakes = new THREE.Group();
  const stakeGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.0, 5);
  for (const [sx, sz] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
    const s = new THREE.Mesh(stakeGeo, mat(0x8a6a40));
    s.position.set(sx, 0.5, sz);
    stakes.add(s);
  }
  root.add(stakes);

  const shaftGeo = new THREE.CylinderGeometry(0.55, 0.8, 3.4, 8);
  shaftGeo.translate(0, 1.7, 0); // grow from the ground (see hut walls)
  const shaft = new THREE.Mesh(shaftGeo, mat(0x8d8577));
  root.add(shaft);

  const platform = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.18, 8), mat(0x7a5634));
  platform.position.y = 3.5;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.0, 0.8, 8), mat(COLOR_HUT_ROOF));
  roof.position.y = 4.2;
  const banner = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.45, 0.18), mat(teamColor));
  banner.position.y = 4.8;
  root.add(platform, roof, banner);

  function setProgress(p: number): void {
    stakes.visible = p < 1;
    shaft.scale.y = Math.min(1, Math.max(0.04, p / 0.8));
    platform.visible = roof.visible = banner.visible = p >= 0.8;
  }
  setProgress(0);
  return { root, setProgress };
}

/**
 * The village totem: marks the tribe's spiritual center (and, practically,
 * the wood stockpile drop-off). Stacked carved blocks, team-color crest,
 * little wings. Phase 4's worship mechanics will happen around these.
 */
export function buildTotem(teamColor: number): THREE.Group {
  const root = new THREE.Group();
  const wood = mat(0x7a5634);
  const dark = mat(0x5a3e24);

  for (let i = 0; i < 4; i++) {
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.7 - i * 0.06, 0.62, 0.7 - i * 0.06), i % 2 ? dark : wood);
    block.position.y = 0.31 + i * 0.62;
    block.rotation.y = (i % 2) * 0.2; // slightly askew = hand-carved
    root.add(block);
  }
  const wings = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 0.3), dark);
  wings.position.y = 2.25;
  const crest = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.6, 4), mat(teamColor));
  crest.position.y = 2.85;
  crest.rotation.y = Math.PI / 4;
  root.add(wings, crest);
  return root;
}
