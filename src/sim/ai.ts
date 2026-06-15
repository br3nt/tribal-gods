/**
 * sim/ai.ts — the red tribe's brain.
 *
 * A utility-scored state machine, not a neural mystery box. Every couple
 * of seconds the AI looks at a handful of numbers (army size, threat,
 * wood, huts) and picks one of four postures:
 *
 *   GROW    — default. Expand housing, raise training buildings, recruit.
 *   HARASS  — army ≥ harass threshold: send a small squad to poke the
 *             player's village. Pressure teaches the player to build
 *             defenses, and keeps the mid-game alive.
 *   ASSAULT — army ≥ assault threshold: march EVERYTHING, shaman included,
 *             at the player's totem.
 *   DEFEND  — took damage recently: recall soldiers home. (Threat decays;
 *             after eight quiet seconds the AI exhales and re-evaluates.)
 *
 * Crucially the AI never cheats: it places buildings through the same
 * canPlaceBuilding, pays the same wood, breeds through the same huts, and
 * its shaman obeys the same mana pool and cast range as yours. Decisions
 * are its only input — which is why watching it (debug HUD shows its
 * state) feels like watching a player, not a script.
 *
 * Economy note: the AI doesn't micro its braves at all — assignWork
 * (world-state.ts) already runs the chop/build/move-in loop for any tribe.
 * The AI only does what YOU do: decide what to build, when to attack, and
 * what the shaman casts.
 */

import { COMBAT, DIFFICULTIES, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import type { Unit, World } from './world-state';

const HARASS_ARMY = 4;
const ASSAULT_ARMY = 9;
const SQUAD_SIZE = 3;

export function tickAi(world: World, dt: number): void {
  const tribe = world.tribes.red;
  if (!tribe.ai || world.gameOver) return;
  tribe.ai.evalTimer -= dt;
  if (tribe.ai.evalTimer > 0) return;
  // Difficulty IS tempo: a hard god thinks every 1.3s, an easy one every 4.
  tribe.ai.evalTimer = DIFFICULTIES[world.settings.difficulty].aiEvalSeconds;

  const soldiers = world.units.filter(
    (u) => u.tribe === 'red' && COMBAT[u.kind].sight > 0 && !u.hidden,
  );

  // --- Choose a posture ---
  const prev = tribe.ai.state;
  if (tribe.threatTimer > 0 && prev !== 'assault') tribe.ai.state = 'defend';
  else if (soldiers.length >= ASSAULT_ARMY) tribe.ai.state = 'assault';
  else if (soldiers.length >= HARASS_ARMY) tribe.ai.state = 'harass';
  else tribe.ai.state = 'grow';

  // --- Act on it ---
  switch (tribe.ai.state) {
    case 'defend': {
      // Recall the army; auto-engagement handles the actual fighting once
      // they're near whatever is burning the village.
      for (const s of soldiers) {
        if (s.task === 'none' || s.state === 'idle') {
          world.sendTo(s, tribe.home.x + (Math.random() * 6 - 3), tribe.home.z + (Math.random() * 6 - 3));
        }
      }
      break;
    }
    case 'harass': {
      // A few idle soldiers go make trouble at the player's doorstep.
      const squad = soldiers.filter((s) => s.task === 'none' && s.state === 'idle').slice(0, SQUAD_SIZE);
      for (const s of squad) {
        world.sendTo(s, world.tribes.player.home.x + (Math.random() * 8 - 4), world.tribes.player.home.z + (Math.random() * 8 - 4));
      }
      break;
    }
    case 'assault': {
      // Everyone. The shaman comes too — her spells are the siege engine.
      for (const s of soldiers) {
        if (s.task === 'none' || s.state === 'idle') {
          world.sendTo(s, world.tribes.player.home.x + (Math.random() * 6 - 3), world.tribes.player.home.z + (Math.random() * 6 - 3));
        }
      }
      const shaman = world.units.find((u) => u.kind === 'shaman' && u.tribe === 'red');
      if (shaman && shaman.task === 'none' && !shaman.castSpell && shaman.state === 'idle') {
        world.sendTo(shaman, world.tribes.player.home.x, world.tribes.player.home.z);
      }
      break;
    }
    case 'grow':
      growEconomy(world);
      seekMonuments(world);
      break;
  }

  aiShamanCasts(world);
}

/**
 * The other half of the knowledge race: an idle red leader walks to the
 * nearest unclaimed monument and worships, exactly as you would. On hard
 * difficulty the faster eval tempo means she leaves earlier — beat her to
 * the volcano or learn to live downhill of it.
 */
function seekMonuments(world: World): void {
  const shaman = world.units.find((u) => u.kind === 'shaman' && u.tribe === 'red');
  if (!shaman || shaman.task !== 'none' || shaman.state !== 'idle' || shaman.castSpell) return;
  let bestIdx = -1;
  let bestD = 55;
  for (let i = 0; i < world.monuments.length; i++) {
    const m = world.monuments[i];
    if (m.claimedBy) continue;
    const d = world.distTo(shaman, m.x, m.z);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) world.orderWorship([shaman.id], bestIdx);
}

/** Build order, re-derived from the current state every evaluation:
 *  housing first (population IS power), then a warrior hut, then ranged. */
function growEconomy(world: World): void {
  const tribe = world.tribes.red;
  const mine = world.buildings.filter((b) => b.tribe === 'red');
  const huts = mine.filter((b) => b.kind === 'hut').length;
  const warriorHuts = mine.filter((b) => b.kind === 'warriorHut').length;
  const fireHuts = mine.filter((b) => b.kind === 'fireHut').length;
  const underway = mine.some((b) => b.progress < 1);
  if (underway) return; // one project at a time keeps braves efficient

  const want =
    huts < 2 ? 'hut'
    : warriorHuts < 1 ? 'warriorHut'
    : huts < 4 ? 'hut'
    : fireHuts < 1 ? 'fireHut'
    : 'hut';

  // Spiral out from home until a legal site turns up. Same rules as you.
  for (let attempt = 0; attempt < 40; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = 4 + Math.random() * 10;
    const x = Math.round(tribe.home.x + Math.cos(a) * r);
    const z = Math.round(tribe.home.z + Math.sin(a) * r);
    if (world.canPlaceBuilding('red', want, x, z)) {
      world.placeBuilding('red', want, x, z);
      return;
    }
  }
}

/** The red shaman zaps player clusters — and rebuilds her flock when it thins. */
function aiShamanCasts(world: World): void {
  const shaman = world.units.find((u) => u.kind === 'shaman' && u.tribe === 'red');
  if (!shaman || shaman.castSpell || shaman.state === 'working') return;
  const tribe = world.tribes.red;

  // POPULATION EMERGENCY: braves do all the chopping, building and
  // breeding, so a tribe with none is sterile no matter how many soldiers
  // it has. The shaman's way out is the same one available to you —
  // Convert the nearest wildmen into fresh braves.
  const braves = world.countUnits((u) => u.tribe === 'red' && u.kind === 'brave');
  if (braves < 3 && tribe.mana >= 10) {
    let nearest: Unit | null = null;
    let nearestD = 60;
    for (const u of world.units) {
      if (u.kind !== 'wildman') continue;
      const d = world.distTo(shaman, u.x, u.z);
      if (d < nearestD) {
        nearestD = d;
        nearest = u;
      }
    }
    if (nearest) {
      world.orderCast('red', 'convert', nearest.x, nearest.z);
      return;
    }
  }

  // Find the juiciest player unit within reach (prefer crowds: score by
  // how many other player units stand within 3 tiles of the candidate).
  let best: Unit | null = null;
  let bestScore = 0;
  for (const u of world.units) {
    if (u.tribe !== 'player' || u.hidden) continue;
    if (world.distTo(shaman, u.x, u.z) > 13) continue;
    let score = 1;
    for (const q of world.units) {
      if (q.tribe !== 'player' || q.hidden || q === u) continue;
      if (Math.hypot(wrapDelta(q.x - u.x, WORLD_SIZE), wrapDelta(q.z - u.z, WORLD_SIZE)) < 3) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  if (!best) return;

  // Crowd → blast (knockback + splash). Lone target worth a bolt → zap it
  // (if the red god has learned lightning at a monument, same rule as you).
  if (bestScore >= 3 && tribe.mana >= 12) world.orderCast('red', 'blast', best.x, best.z);
  else if (bestScore >= 1 && tribe.mana >= 60 && tribe.unlocked.has('lightning')) {
    world.orderCast('red', 'lightning', best.x, best.z);
  }
}
