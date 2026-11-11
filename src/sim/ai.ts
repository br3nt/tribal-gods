/**
 * sim/ai.ts — the rival gods' brains. One runs for every tribe whose
 * scenario entry says `ai: true`.
 *
 * A utility-scored state machine, not a neural mystery box. Every couple
 * of seconds each AI looks at a handful of numbers (army size, threat,
 * wood, buildings) and picks one of four postures:
 *
 *   GROW    — default. Build toward prerequisites, queue training, race
 *             the leader to the standing stones.
 *   HARASS  — army ≥ harass threshold: a small squad pokes the nearest
 *             rival's village.
 *   ASSAULT — army ≥ assault threshold: march everything, leader included,
 *             at the rival's home circle; the leader opens with the big spells.
 *   DEFEND  — took damage recently: recall the army, garrison towers.
 *
 * A tribe's AiPersonality (catalog.ts, from the scenario) tunes these
 * decisions: raid/assault thresholds, passive-until-provoked, war bands that
 * never build, preferred units, a fixed enemy.
 *
 * The AI never cheats: it places buildings through canPlaceBuilding, pays
 * the same wood, trains through the same queues, and its leader casts
 * through the same charge model and range rules as yours. Difficulty
 * tunes tempo (how often it thinks) — never the rules.
 */

import { DIFFICULTIES, MIN_BRAVES, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { BuildingKind, BUILDINGS, ECONOMY, SpellId, SPELLS, spellDef, TribeId, UNITS } from './catalog';
import { findPath } from './pathfinding';
import type { Building, TribeState, Unit, World } from './world-state';

const HARASS_ARMY = 5;
const ASSAULT_ARMY = 11;
const SQUAD_SIZE = 3;
const MAX_ARMY = 24;

/** The order an AI wants its town in: [kind, how many]. */
const PLAN: Array<[BuildingKind, number]> = [
  ['hut', 2], ['lumberyard', 1], ['warriorHut', 1], ['hut', 3], ['tower', 1], ['shrine', 1],
  ['fireHut', 1], ['hut', 4], ['chantHall', 1], ['wardenHall', 1], ['hut', 6], ['tower', 2], ['hut', 8],
];

/** Spells the AI never casts — it switches them off so the rest charge faster. */
const UNUSED: SpellId[] = ['flatten', 'landbridge'];

export function tickAi(world: World, dt: number): void {
  if (world.gameOver) return;
  for (const id of world.activeTribes()) {
    const tribe = world.tribes[id]!;
    if (!tribe.ai) continue;
    tribe.ai.evalTimer -= dt;
    if (tribe.ai.evalTimer > 0) continue;
    // Difficulty IS tempo: a hard god thinks every 1.3s, an easy one every 4.
    tribe.ai.evalTimer = DIFFICULTIES[world.settings.difficulty].aiEvalSeconds;
    think(world, id, tribe);
  }
}

const dist = (ax: number, az: number, bx: number, bz: number) =>
  Math.hypot(wrapDelta(ax - bx, WORLD_SIZE), wrapDelta(az - bz, WORLD_SIZE));

const isFighter = (u: Unit) => UNITS[u.kind].dmg > 0 && UNITS[u.kind].sight > 0;

function pickTarget(world: World, id: TribeId, tribe: TribeState): TribeId | null {
  const pinned = tribe.personality.target;
  if (pinned && world.tribes[pinned] && world.hostile(id, pinned) && world.tribeAlive(pinned)) return pinned;
  let best: TribeId | null = null;
  let bestD = Infinity;
  for (const other of world.activeTribes()) {
    if (!world.hostile(id, other) || !world.tribeAlive(other)) continue;
    const h = world.tribes[other]!.home;
    const d = dist(h.x, h.z, tribe.home.x, tribe.home.z);
    if (d < bestD) {
      bestD = d;
      best = other;
    }
  }
  return best;
}

function think(world: World, id: TribeId, tribe: TribeState): void {
  const ai = tribe.ai!;
  ai.target = pickTarget(world, id, tribe);
  const enemyHome = ai.target ? world.tribes[ai.target]!.home : null;

  for (const s of SPELLS) {
    if (tribe.known.has(s.id)) world.setSpellCharging(id, s.id, !UNUSED.includes(s.id));
  }

  const army = world.units.filter((u) => u.tribe === id && !u.hidden && (isFighter(u) || u.kind === 'chanter'));
  const p = tribe.personality;
  const harassAt = p.harassAt ?? HARASS_ARMY;
  const assaultAt = p.assaultAt ?? ASSAULT_ARMY;

  // A passive god wakes when hurt, when its hour comes, or when a scenario event says so.
  if (!ai.awake && (tribe.threatTimer > 0 || (p.wakeAt !== undefined && world.elapsed >= p.wakeAt))) ai.awake = true;

  // --- Choose a posture ---
  const prev = ai.state;
  const defends = p.defends ?? true;
  if (defends && tribe.threatTimer > 0 && prev !== 'assault') ai.state = 'defend';
  else if (!ai.awake) ai.state = 'grow';
  else if (enemyHome && army.length >= assaultAt) ai.state = 'assault';
  else if (enemyHome && army.length >= harassAt) ai.state = 'harass';
  else ai.state = 'grow';
  if (prev === 'assault' && army.length < Math.min(harassAt, assaultAt) && ai.state === 'assault') ai.state = 'grow';

  // The town grows whatever the posture (unless this is a war band).
  if (p.builds ?? true) {
    buildTown(world, id, tribe);
    staffShrines(world, id);
  }
  queueTraining(world, id, tribe, army.length);

  const free = (u: Unit) => (u.task === 'none' || u.state === 'idle') && !u.castSpell;
  const jitter = (r: number) => world.random() * 2 * r - r;
  switch (ai.state) {
    case 'defend': {
      garrisonTowers(world, id, tribe);
      for (const s of army) {
        if (free(s)) world.sendTo(s, tribe.home.x + jitter(4), tribe.home.z + jitter(4));
      }
      break;
    }
    case 'harass': {
      garrisonTowers(world, id, tribe);
      const squad = army.filter((s) => s.task === 'none' && s.state === 'idle').slice(0, SQUAD_SIZE);
      for (const s of squad) world.sendTo(s, enemyHome!.x + jitter(5), enemyHome!.z + jitter(5));
      break;
    }
    case 'assault': {
      for (const s of army) {
        if (free(s)) world.sendTo(s, enemyHome!.x + jitter(4), enemyHome!.z + jitter(4));
      }
      const leader = world.leaderOf(id);
      if (leader && leader.task === 'none' && !leader.castSpell && leader.state === 'idle') {
        world.sendTo(leader, enemyHome!.x + jitter(6), enemyHome!.z + jitter(6));
      }
      break;
    }
    case 'grow':
      garrisonTowers(world, id, tribe);
      if (p.seeksStones ?? true) seekMonuments(world, id);
      break;
  }

  // A passive god keeps its hands down: no spells at anyone until it wakes.
  if (ai.awake) leaderCasts(world, id, tribe);
}

/** Next step of the plan that isn't done yet; places it if it can. */
function buildTown(world: World, id: TribeId, tribe: TribeState): void {
  const mine = world.buildings.filter((b) => b.tribe === id);
  const site = mine.find((b) => b.progress < 1);
  if (site) {
    // One project at a time keeps villagers efficient — but a site nobody
    // has touched in a minute is abandoned (cut off, or cursed ground).
    const ai = tribe.ai!;
    if (ai.site?.id !== site.id || site.progress > ai.site.progress) ai.site = { id: site.id, progress: site.progress, since: world.elapsed };
    else if (world.elapsed - ai.site.since > 60) world.demolish(site.id);
    return;
  }
  for (const [kind, n] of PLAN) {
    if (mine.filter((b) => b.kind === kind).length >= n) continue;
    // Not allowed here, or its prerequisite isn't up yet: the plan lists
    // prerequisites first, so skip ahead and come back to it.
    if (!tribe.allowed.has(kind)) continue;
    const st = world.buildState(id, kind);
    if (!st.unlocked) continue;
    if (!st.affordable) return; // save up for it
    placeNearHome(world, id, tribe, kind);
    return;
  }
  // Plan complete: keep adding dwellings while wood piles up.
  if (tribe.wood > 20 && tribe.allowed.has('hut')) placeNearHome(world, id, tribe, 'hut');
}

function placeNearHome(world: World, id: TribeId, tribe: TribeState, kind: BuildingKind): boolean {
  const big = BUILDINGS[kind].size === 5;
  for (let attempt = 0; attempt < 60; attempt++) {
    const a = world.random() * Math.PI * 2;
    const r = (big ? 7 : 5) + world.random() * (10 + attempt / 6);
    const x = Math.round(tribe.home.x + Math.cos(a) * r);
    const z = Math.round(tribe.home.z + Math.sin(a) * r);
    if (!world.canPlaceBuilding(id, kind, x, z)) continue;
    // Villagers must be able to walk there from home.
    const half = (BUILDINGS[kind].size - 1) / 2;
    if (!findPath(world.map, tribe.home.x, tribe.home.z, x, z + half + 1, 2500)) continue;
    return world.placeBuilding(id, kind, x, z);
  }
  return false;
}

/** Keep the training queues ticking over without starving the economy. */
function queueTraining(world: World, id: TribeId, tribe: TribeState, armySize: number): void {
  const p = tribe.personality;
  if (armySize >= (p.maxArmy ?? MAX_ARMY)) return;
  const braves = world.countUnits((u) => u.tribe === id && u.kind === 'brave');
  let halls = world.buildings.filter((b) => b.tribe === id && b.progress >= 1 && BUILDINGS[b.kind].trains);
  if (p.prefer) {
    const order = p.prefer;
    halls = halls
      .filter((b) => order.includes(BUILDINGS[b.kind].trains!))
      .sort((a, b) => order.indexOf(BUILDINGS[a.kind].trains!) - order.indexOf(BUILDINGS[b.kind].trains!));
  }
  const queued = halls.reduce((s, b) => s + b.queue, 0);
  const spare = braves - (MIN_BRAVES + 2) - queued;
  if (spare <= 0) return;
  const chanters = world.countUnits((u) => u.tribe === id && u.kind === 'chanter');
  for (const b of halls) {
    const kind = BUILDINGS[b.kind].trains!;
    if (kind === 'chanter' && chanters >= 3) continue;
    if (b.queue >= 2 || tribe.wood < UNITS[kind].trainWood) continue;
    world.queueTraining(b.id, 1);
    if (!b.rally) world.setRally(b.id, tribe.home.x + 3, tribe.home.z + 3);
    return; // one recruit per think
  }
}

function garrisonTowers(world: World, id: TribeId, tribe: TribeState): void {
  for (const t of world.buildings) {
    if (t.tribe !== id || t.kind !== 'tower' || t.progress < 1) continue;
    const enRoute = world.countUnits((u) => u.task === 'garrison' && u.targetBuilding === t.id);
    if (t.garrison.length + enRoute >= ECONOMY.towerGarrison) continue;
    const pick = world.units.find(
      (u) => u.tribe === id && !u.hidden && isFighter(u) && u.task === 'none' && dist(u.x, u.z, tribe.home.x, tribe.home.z) < 25,
    );
    if (pick) world.orderGarrison([pick.id], t.id);
  }
}

function staffShrines(world: World, id: TribeId): void {
  const braves = world.units.filter((u) => u.tribe === id && u.kind === 'brave');
  for (const s of world.buildings) {
    if (s.tribe !== id || s.kind !== 'shrine' || s.progress < 1) continue;
    const want = Math.min(ECONOMY.shrineWorshippers, Math.floor((braves.length - 6) / 3));
    const enRoute = world.countUnits((u) => u.task === 'garrison' && u.targetBuilding === s.id);
    if (s.garrison.length > Math.max(0, want)) {
      // Hands are short (a raid, a plague of lightning): back to work.
      world.ejectGarrison(s.id);
      continue;
    }
    if (s.garrison.length + enRoute >= want) continue;
    const pick = braves.find((u) => !u.hidden && u.task === 'none' && !u.carrying);
    if (pick) world.orderGarrison([pick.id], s.id);
  }
}

/** The knowledge race: an idle leader walks to the nearest open stone. */
function seekMonuments(world: World, id: TribeId): void {
  const leader = world.leaderOf(id);
  if (!leader || leader.task !== 'none' || leader.state !== 'idle' || leader.castSpell) return;
  let bestIdx = -1;
  let bestD = 55;
  for (let i = 0; i < world.monuments.length; i++) {
    const m = world.monuments[i];
    if (!world.monumentAvailable(m)) continue;
    // A taught spell we already know is worth nothing to us.
    if (m.mode === 'teach' && world.tribes[id]!.known.has(m.spell)) continue;
    const d = world.distTo(leader, m.x, m.z);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) world.orderWorship([leader.id], bestIdx);
}

const ready = (world: World, id: TribeId, spell: SpellId) => {
  const s = world.spellState(id, spell);
  return s.gifted > 0 || (s.known && s.charges > 0);
};

/** Best hostile cluster (units) within `range` of the leader: [unit, crowd size]. */
function bestCrowd(world: World, id: TribeId, leader: Unit, range: number): [Unit | null, number] {
  let best: Unit | null = null;
  let bestScore = 0;
  const foes = world.units.filter((u) => !u.hidden && u.tribe !== 'wild' && world.hostile(id, u.tribe));
  for (const u of foes) {
    if (world.distTo(leader, u.x, u.z) > range) continue;
    let score = 1;
    for (const q of foes) if (q !== u && dist(q.x, q.z, u.x, u.z) < 3) score++;
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return [best, bestScore];
}

function bestBuilding(world: World, id: TribeId, leader: Unit, range: number): [Building | null, number] {
  let best: Building | null = null;
  let bestScore = 0;
  const foes = world.buildings.filter((b) => world.hostile(id, b.tribe));
  for (const b of foes) {
    if (world.distTo(leader, b.x, b.z) > range) continue;
    let score = 1;
    for (const q of foes) if (q !== b && dist(q.x, q.z, b.x, b.z) < 8) score++;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return [best, bestScore];
}

/** The leader zaps crowds, flattens villages, blesses the army — and recruits when the flock thins. */
function leaderCasts(world: World, id: TribeId, tribe: TribeState): void {
  const leader = world.leaderOf(id);
  if (!leader || leader.castSpell || leader.state === 'working' || leader.hidden) return;
  const cast = (spell: SpellId, x: number, z: number) =>
    ready(world, id, spell) && world.orderCast(id, spell, x, z) === null;

  // POPULATION EMERGENCY: villagers do all the chopping, building and
  // breeding. Kindle the nearest wanderers into fresh villagers.
  const braves = world.countUnits((u) => u.tribe === id && u.kind === 'brave');
  if (braves < 4 && ready(world, id, 'convert')) {
    let nearest: Unit | null = null;
    let nearestD = 50;
    for (const u of world.units) {
      if (u.kind !== 'wildman') continue;
      const d = world.distTo(leader, u.x, u.z);
      if (d < nearestD) {
        nearestD = d;
        nearest = u;
      }
    }
    if (nearest && cast('convert', nearest.x, nearest.z)) return;
  }

  // Village-breakers first: the big spells on a rival town in reach.
  const [town, townScore] = bestBuilding(world, id, leader, 16);
  if (town) {
    for (const spell of ['volcano', 'earthquake', 'emberfall', 'sink', 'cyclone'] as SpellId[]) {
      if (townScore >= (spell === 'cyclone' ? 1 : 2) && cast(spell, town.x, town.z)) return;
    }
  }

  // Bless our own fighters when there's a fight to be had.
  const [crowd, crowdScore] = bestCrowd(world, id, leader, 16);
  if (crowd) {
    const ours = world.units.filter((u) => u.tribe === id && !u.hidden && isFighter(u) && world.distTo(leader, u.x, u.z) < 9);
    if (ours.length >= 3) {
      const c = ours[0];
      if (!ours.some((u) => u.warsongTime > 0) && cast('warsong', c.x, c.z)) return;
      if (!ours.some((u) => u.wardTime > 0) && cast('ward', c.x, c.z)) return;
    }
    // Crowd → blast (knockback + splash). Lone target → lightning, or a mire in their path.
    if (crowdScore >= 3 && cast('blast', crowd.x, crowd.z)) return;
    if (crowdScore >= 2 && cast('swamp', crowd.x, crowd.z)) return;
    if (cast('lightning', crowd.x, crowd.z)) return;
    if (crowdScore >= 2 && world.distTo(leader, crowd.x, crowd.z) <= spellDef('blast').range && cast('blast', crowd.x, crowd.z)) return;
  }

  // Short of wood and trees: bloom the home grove.
  if (tribe.wood < 4 && ready(world, id, 'bloom')) {
    const living = world.trees.filter((t) => t.alive && dist(t.x, t.z, tribe.home.x, tribe.home.z) < 14).length;
    if (living < 6) cast('bloom', tribe.home.x + 6, tribe.home.z + 6);
  }
}
