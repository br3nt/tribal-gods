/**
 * assets/models/figures.ts — the people, built from primitives in code.
 *
 * No modeling software, no mesh files: each figure is a recipe — boxes and
 * cylinders parented into a little skeleton of THREE.Groups. This is the
 * spiritual cousin of how 1998 did it (their units were a few dozen
 * hand-placed polygons), and it keeps characters as readable and tweakable
 * as any other source file. Want longer arms? Edit a number, hot reload.
 *
 * THE KEY STRUCTURAL IDEA — pivots: a limb's geometry is shifted so its
 * local origin sits at the JOINT (shoulder, hip), not at its center. Then
 * `arm.rotation.x = θ` swings the arm around the shoulder like a real
 * joint. That's all skeletal animation is at heart: rotations at offset
 * pivots, nested (hierarchies: the hand would follow the forearm, etc. —
 * one level deep is plenty for our chunky figures).
 *
 * Hierarchy:  root (placed/rotated by the renderer)
 *               └─ body (bobbed/leaned by the animator)
 *                    ├─ torso, head, legL, legR, armL, armR ...
 *
 * Figures face +z, so heading = atan2(dx, dz) maps straight to rotation.y.
 * All proportions in world units; a tile is 2 units wide for scale.
 */

import * as THREE from 'three';
import { Civ, COLOR_HAIR, COLOR_SKIN, COLOR_WILD_CLOTH } from '../../config';

export interface Figure {
  root: THREE.Group;
  /** The animator's handle: bob/lean target. */
  body: THREE.Group;
  /** Joints the animator drives. Missing entries are fine (the shaman has no visible legs). */
  parts: {
    legL?: THREE.Object3D;
    legR?: THREE.Object3D;
    armL?: THREE.Object3D;
    armR?: THREE.Object3D;
  };
  /** The log a lumberjack hauls home. Hidden unless the unit is carrying. */
  carryProp?: THREE.Mesh;
}

const mat = (color: number) => new THREE.MeshLambertMaterial({ color });

/** A box mesh whose local origin is at the TOP — i.e. pivoted like a limb. */
function limb(w: number, len: number, d: number, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, len, d);
  geo.translate(0, -len / 2, 0); // shift down so y=0 is the joint
  return new THREE.Mesh(geo, material);
}

function box(w: number, h: number, d: number, material: THREE.Material, y: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.y = y;
  return m;
}

/** Shared scaffold: torso, head, hair, two arm pivots. Legs/clothes differ per figure. */
function buildBody(clothColor: number): Figure {
  const skin = mat(COLOR_SKIN);
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  body.add(box(0.44, 0.5, 0.26, skin, 1.06)); // torso
  body.add(box(0.3, 0.3, 0.28, skin, 1.49)); // head
  body.add(box(0.33, 0.1, 0.31, mat(COLOR_HAIR), 1.66)); // hair mop

  // Eyes: two dark pips on the face (+z side — the facing direction).
  // Comically small geometry, disproportionately large charm: a figure
  // with eyes has a gaze, and a gaze makes it a character.
  const eyeMat = mat(0x1c1410);
  for (const ex of [-0.07, 0.07]) {
    const eye = box(0.05, 0.06, 0.03, eyeMat, 1.51);
    eye.position.x = ex;
    eye.position.z = 0.145;
    body.add(eye);
  }

  const armL = limb(0.12, 0.52, 0.12, skin);
  armL.position.set(-0.3, 1.28, 0);
  const armR = limb(0.12, 0.52, 0.12, skin);
  armR.position.set(0.3, 1.28, 0);
  body.add(armL, armR);

  // Loincloth — the team-color flag on every follower.
  body.add(box(0.34, 0.22, 0.3, mat(clothColor), 0.74));

  return { root, body, parts: { armL, armR } };
}

/** A brave: the basic follower. Skin, loincloth, purposeful little legs. */
export function buildBrave(teamColor: number): Figure {
  const fig = buildBody(teamColor);
  const skin = mat(COLOR_SKIN);
  const legL = limb(0.14, 0.62, 0.14, skin);
  legL.position.set(-0.13, 0.64, 0);
  const legR = limb(0.14, 0.62, 0.14, skin);
  legR.position.set(0.13, 0.64, 0);
  fig.body.add(legL, legR);
  fig.parts.legL = legL;
  fig.parts.legR = legR;

  // The log, cradled crosswise at chest height when carrying (the carry
  // clip raises the arms to meet it). Invisible the rest of the time.
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.8, 6), mat(0x6e4f30));
  log.rotation.z = Math.PI / 2;
  log.position.set(0, 1.05, 0.32);
  log.visible = false;
  fig.body.add(log);
  fig.carryProp = log;
  return fig;
}

/** A wildman: a brave nobody has converted yet — undyed rags, wilder hair. */
export function buildWildman(): Figure {
  const fig = buildBrave(COLOR_WILD_CLOTH);
  // Extra tuft of hair = instantly reads as "unkempt" at game zoom. Cheap
  // silhouette tricks beat texture detail at this art scale, every time.
  const tuft = box(0.18, 0.14, 0.18, mat(COLOR_HAIR), 1.76);
  tuft.rotation.y = 0.6;
  fig.body.add(tuft);
  return fig;
}

/**
 * A warrior: a brave who hit the gym. Bulkier torso, a club in the right
 * fist, a shield strapped to the left arm, and a bone-white headband.
 * Silhouette rules at game zoom: wider + holding things = "soldier".
 */
export function buildWarrior(teamColor: number): Figure {
  const fig = buildBrave(teamColor);

  // Bulk: a chest plate box over the torso, in team color.
  const chest = box(0.5, 0.34, 0.32, mat(teamColor), 1.16);
  fig.body.add(chest);

  // Headband — reads as a helmet from across the map.
  fig.body.add(box(0.34, 0.08, 0.32, mat(0xe8e2d4), 1.6));

  // Club: a tapering cylinder in the right hand, swinging with the arm.
  const club = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.05, 0.75, 6), mat(0x6b4a26));
  club.position.set(0.05, -0.62, 0.12);
  club.rotation.x = 0.4;
  fig.parts.armR!.add(club);

  // Shield: a flattened round on the left forearm.
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.07, 8), mat(0x8a6a40));
  shield.rotation.z = Math.PI / 2;
  shield.position.set(-0.09, -0.35, 0);
  fig.parts.armL!.add(shield);

  return fig;
}

/**
 * A firewarrior: the ranged specialist. Darker, leaner look, a soot-black
 * mask band across the eyes, and embers glowing in each palm (emissive —
 * they read in any light, which is the point of being the fire guy).
 */
export function buildFirewarrior(teamColor: number): Figure {
  const fig = buildBrave(teamColor);

  // Mask band over the face.
  fig.body.add(box(0.32, 0.1, 0.3, mat(0x261d16), 1.51));

  // Shoulder sash in team color.
  const sash = box(0.14, 0.5, 0.34, mat(teamColor), 1.1);
  sash.rotation.z = 0.5;
  fig.body.add(sash);

  // Embers in the palms.
  const emberMat = new THREE.MeshLambertMaterial({ color: 0xffb347, emissive: 0xd86018 });
  for (const arm of [fig.parts.armL!, fig.parts.armR!]) {
    const ember = new THREE.Mesh(new THREE.SphereGeometry(0.09, 7, 6), emberMat);
    ember.position.set(0, -0.55, 0.05);
    arm.add(ember);
  }

  return fig;
}

/**
 * The tribe's leader: your avatar in the world, so they get the extra
 * geometry budget — a robe instead of legs and a staff with a glowing tip.
 * The staff is parented INSIDE the right arm pivot, so it swings with the
 * arm for free, and the cast animation raises it skyward.
 *
 * The leader is where a civilization's identity concentrates: same body,
 * different regalia. Headgear is the single highest-value slot — at game
 * zoom, the silhouette above the shoulders IS the character.
 */
export function buildLeader(civ: Civ, teamColor: number): Figure {
  const fig = buildBody(teamColor);

  // Robe: a tapered cylinder. 8 radial segments — deliberately chunky.
  const robe = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.4, 0.85, 8), mat(teamColor));
  robe.position.y = 0.62;
  fig.body.add(robe);

  // Staff: shared shaft, civ-specific topper.
  const armR = fig.parts.armR!;
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6), mat(0x5a4326));
  staff.position.set(0.1, -0.35, 0.12); // held in the hand, reaching past it
  armR.add(staff);

  const glow = new THREE.MeshLambertMaterial({ color: civ.accent, emissive: civ.accent });

  switch (civ.id) {
    case 'forest': {
      // The classic shaman: white hair and an orb of cold light.
      fig.body.add(box(0.34, 0.12, 0.32, mat(0xe8e2d4), 1.67));
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), glow);
      orb.position.set(0.1, 0.45, 0.12);
      armR.add(orb);
      break;
    }
    case 'dynasty': {
      // The God-King: a tall tapering crown in gold, collar to match, and
      // a looped scepter head (a ring of office reads regal at any size).
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.2, 0.55, 6), mat(civ.accent));
      crown.position.y = 1.93;
      const collar = box(0.55, 0.1, 0.36, mat(civ.accent), 1.32);
      fig.body.add(crown, collar);
      const loopGeo = new THREE.TorusGeometry(0.12, 0.045, 6, 12);
      const loop = new THREE.Mesh(loopGeo, glow);
      loop.position.set(0.1, 0.45, 0.12);
      armR.add(loop);
      break;
    }
    case 'north': {
      // The Far-Seer: a deep fur hood, a heavy cloak, and a hammer-headed
      // staff crackling with sky-light.
      const hood = box(0.4, 0.36, 0.38, mat(0x4a3826), 1.56);
      hood.position.z = -0.03;
      const cloak = box(0.56, 0.7, 0.16, mat(0x4a3826), 1.0);
      cloak.position.z = -0.2;
      fig.body.add(hood, cloak);
      const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.14), glow);
      hammer.position.set(0.1, 0.42, 0.12);
      armR.add(hammer);
      break;
    }
  }

  fig.root.scale.setScalar(1.12); // a head taller than the flock
  return fig;
}

/**
 * A tree: trunk + two stacked cones. Two sizes of cone make it read as
 * "foliage" instead of "traffic cone". Phase 3 makes these choppable.
 */
export function buildTree(sizeJitter: number): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.7, 6), mat(0x6e4f30));
  trunk.position.y = 0.35;
  const lower = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.0, 7), mat(0x3f7034));
  lower.position.y = 1.05;
  const upper = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.8, 7), mat(0x47803a));
  upper.position.y = 1.65;
  g.add(trunk, lower, upper);
  g.scale.setScalar(0.85 + sizeJitter * 0.5);
  g.rotation.y = sizeJitter * Math.PI * 2; // free variety: just spin them
  return g;
}
