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
 *   ASSAULT — army ≥ assault threshold: march everything at the rival's
 *             home circle; the leader follows behind the army and opens
 *             with the big spells when a village is in reach.
 *   DEFEND  — took damage recently: recall the army, garrison towers.
 *
 * Two judgements sit on top of the posture:
 *
 *   CASTING WITH RESTRAINT — the leader waits the difficulty's cast gap
 *   after every spell, spends a charge only on a target worth it (a crowd,
 *   a champion, a village — never one villager; our own people under the
 *   circle count against it), and keeps world-shapers for a real town. A
 *   hurt leader with soldiers near walks home instead of dying for nothing.
 *
 *   A RITUAL IS AN OPENING — a rival leader kneeling at a stone is
 *   helpless for half a minute. An awake, aggressive god sends a raiding
 *   party at her (once per ritual) and its own leader casts at her if she
 *   is in reach. And its own leader never walks to a great (tier 2–3) or
 *   guarded stone without an escort of fighters, if it has any to send.
 *
 *   AN ANSWER TO WATER — if the rival lives across a strait (or up a
 *   cliff), the leader learns or charges Causeway (Level for cliffs),
 *   walks to the narrowest gap (sim/crossing.ts) and bridges it, cast by
 *   cast, until the land joins; the army waits at the shore, then marches.
 *
 * A tribe's AiPersonality (catalog.ts, from the scenario) tunes these
 * decisions: raid/assault thresholds, passive-until-provoked, war bands that
 * never build, preferred units, a fixed enemy.
 *
 * The AI never cheats: it places buildings through canPlaceBuilding, pays
 * the same wood, trains through the same queues, and its leader casts
 * through the same charge model and range rules as yours. Difficulty
 * tunes tempo (how often it thinks and casts) — never the rules.
 */

import { DIFFICULTIES, MIN_BRAVES, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { BuildingKind, BUILDINGS, ECONOMY, SpellId, SPELLS, spellDef, TribeId, UnitKind, UNITS } from './catalog';
import { findCrossing } from './crossing';
import { findPath } from './pathfinding';
import { regionNear } from './regions';
import type { TribeState, Unit, World } from './world-state';

const HARASS_ARMY = 5;
const ASSAULT_ARMY = 11;
const SQUAD_SIZE = 3;
const MAX_ARMY = 24;

/** The order an AI wants its town in: [kind, how many]. */
const PLAN: Array<[BuildingKind, number]> = [
  ['hut', 3], ['lumberyard', 1], ['hut', 4], ['warriorHut', 1], ['hut', 5], ['tower', 1], ['shrine', 1],
  ['fireHut', 1], ['hut', 6], ['chantHall', 1], ['wardenHall', 1], ['hut', 7], ['warriorHut', 2], ['tower', 2], ['hut', 8],
];

/** Spells the AI doesn't charge unless it needs them (bridging switches them on). */
const UNUSED: SpellId[] = ['flatten', 'landbridge'];

export function tickAi(world: World, dt: number): void {
  if (world.gameOver) return;
  for (const id of world.activeTribes()) {
    const tribe = world.tribes[id]!;
    if (!tribe.ai) continue;
    tribe.ai.castCooldown = Math.max(0, (tribe.ai.castCooldown ?? 0) - dt);
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
  const here = regionNear(world.map, tribe.home.x, tribe.home.z, 3);
  for (const other of world.activeTribes()) {
    if (!world.hostile(id, other) || !world.tribeAlive(other)) continue;
    const h = world.tribes[other]!.home;
    // A rival we can walk to beats a nearer one across the water.
    const d = dist(h.x, h.z, tribe.home.x, tribe.home.z) + (regionNear(world.map, h.x, h.z, 3) === here ? 0 : 1000);
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

  // A host holding its beach (spawn `hold`) is the scenario's, not the god's, until its hour comes.
  const army = world.units.filter((u) => u.tribe === id && !u.hidden && (isFighter(u) || u.kind === 'chanter') && !((u.holdUntil ?? 0) > world.elapsed));
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

  // The town grows whatever the posture (unless this is a war band).
  if (p.builds ?? true) {
    buildTown(world, id, tribe);
    staffShrines(world, id);
  }
  // The army cap counts everyone: towers' garrisons and trainees inside too.
  queueTraining(world, id, tribe, world.countUnits((u) => u.tribe === id && (isFighter(u) || u.kind === 'chanter')));

  // Across the water? An awake god with an army to send makes land.
  const across = !!enemyHome &&
    regionNear(world.map, tribe.home.x, tribe.home.z, 3) !== regionNear(world.map, enemyHome.x, enemyHome.z, 3);
  if (!across) ai.crossing = null;
  const retreating = leaderSafety(world, id, tribe);
  const bridging = across && ai.awake && !retreating && army.length >= Math.min(harassAt, assaultAt) &&
    bridgeTo(world, id, tribe, enemyHome!);
  // Where the army goes: the enemy, or the shore of the gap while the bridge rises.
  const goal = across && ai.crossing ? ai.crossing.from : enemyHome;

  const free = (u: Unit) => (u.task === 'none' || u.state === 'idle') && !u.castSpell;
  const jitter = (r: number) => world.random() * 2 * r - r;
  // Armies move as groups (world.groupMove): one shared path search per
  // order, not one per soldier — a woken AI sending eighty fighters used
  // to stall the frame with eighty A* searches.
  switch (ai.state) {
    case 'defend': {
      garrisonTowers(world, id, tribe);
      world.groupMove(army.filter(free), tribe.home.x + jitter(2), tribe.home.z + jitter(2));
      break;
    }
    case 'harass': {
      garrisonTowers(world, id, tribe);
      if (goal) {
        const squad = army.filter((s) => s.task === 'none' && s.state === 'idle').slice(0, SQUAD_SIZE);
        world.groupMove(squad, goal.x + jitter(4), goal.z + jitter(4));
      }
      break;
    }
    case 'assault': {
      if (goal) world.groupMove(army.filter(free), goal.x + jitter(3), goal.z + jitter(3));
      // The leader walks behind the army, not in front of it.
      const leader = world.leaderOf(id);
      if (!bridging && !retreating && leader && leader.task === 'none' && !leader.castSpell && leader.state === 'idle' && army.length) {
        let cx = 0;
        let cz = 0;
        for (const s of army) {
          cx += wrapDelta(s.x - leader.x, WORLD_SIZE);
          cz += wrapDelta(s.z - leader.z, WORLD_SIZE);
        }
        cx = leader.x + cx / army.length;
        cz = leader.z + cz / army.length;
        const bx = wrapDelta(tribe.home.x - cx, WORLD_SIZE);
        const bz = wrapDelta(tribe.home.z - cz, WORLD_SIZE);
        const bl = Math.hypot(bx, bz) || 1;
        const back = Math.min(4, bl);
        const tx = cx + (bx / bl) * back;
        const tz = cz + (bz / bl) * back;
        if (dist(leader.x, leader.z, tx, tz) > 4) world.sendTo(leader, tx, tz);
      }
      break;
    }
    case 'grow':
      garrisonTowers(world, id, tribe);
      if (!bridging && !retreating && (p.seeksStones ?? true)) seekMonuments(world, id, army);
      break;
  }
  if (ai.awake) answerRituals(world, id, tribe, army);

  // A passive god keeps its hands down: no spells at anyone until it wakes.
  if (ai.awake && !retreating) leaderCasts(world, id, tribe);
}

/** Next step of the plan that isn't done yet; places it if it can. */
function buildTown(world: World, id: TribeId, tribe: TribeState): void {
  const mine = world.buildings.filter((b) => b.tribe === id);
  const huts = mine.filter((b) => b.kind === 'hut').length;
  const sites = mine.filter((b) => b.progress < 1);
  if (sites.length) {
    // A site nobody has touched in a minute is abandoned (cut off, or cursed ground).
    const site = sites[0];
    const ai = tribe.ai!;
    if (ai.site?.id !== site.id || site.progress > ai.site.progress) ai.site = { id: site.id, progress: site.progress, since: world.elapsed };
    else if (world.elapsed - ai.site.since > 60) world.demolish(site.id);
    // One project at a time while the village is small; two once it can staff them.
    if (sites.length >= (huts >= 3 ? 2 : 1)) return;
  }
  const maxHuts = tribe.personality.maxDwellings ?? DIFFICULTIES[world.settings.difficulty].aiDwellings;
  for (const [kind, n] of PLAN) {
    if (mine.filter((b) => b.kind === kind).length >= n) continue;
    if (kind === 'hut' && huts >= maxHuts) continue;
    // Not allowed here, or its prerequisite isn't up yet: the plan lists
    // prerequisites first, so skip ahead and come back to it.
    if (!tribe.allowed.has(kind)) continue;
    const st = world.buildState(id, kind);
    if (!st.unlocked) continue;
    if (!st.affordable) return; // save up for it
    placeNearHome(world, id, tribe, kind);
    return;
  }
  // Plan complete: more dwellings while wood piles up (to the town's size),
  // then a second lodge to turn the surplus into soldiers.
  if (tribe.wood > 20 && tribe.allowed.has('hut') && huts < maxHuts) placeNearHome(world, id, tribe, 'hut');
  else if (tribe.wood > 25 && tribe.allowed.has('warriorHut') && mine.filter((b) => b.kind === 'warriorHut').length < 3) {
    placeNearHome(world, id, tribe, 'warriorHut');
  }
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
  if (armySize + queued >= (p.maxArmy ?? MAX_ARMY)) return; // queued recruits count against the cap
  // Roofs before spears: a village under three dwellings trains only when threatened.
  const huts = world.buildings.filter((b) => b.tribe === id && b.kind === 'hut').length;
  if (huts < 3 && tribe.threatTimer <= 0 && tribe.allowed.has('hut') && (p.builds ?? true)) return;
  // Half the tribe stays villagers: an army with no economy behind it is a raid, not a rival.
  const pop = world.tribePopulation(id);
  const spare = braves - Math.max(MIN_BRAVES + 2, Math.ceil(pop * 0.45)) - queued;
  if (spare <= 0) return;
  const chanters = world.countUnits((u) => u.tribe === id && u.kind === 'chanter');
  // A recruit per think, more when villagers are plentiful (a big village
  // that never arms is no rival at all).
  let budget = Math.min(3, Math.max(1, Math.floor(spare / 6)));
  for (const b of halls) {
    if (budget <= 0) return;
    const kind = BUILDINGS[b.kind].trains!;
    if (kind === 'chanter' && chanters >= 3) continue;
    if (b.queue >= 3 || tribe.wood < UNITS[kind].trainWood) continue;
    world.queueTraining(b.id, 1);
    if (!b.rally) world.setRally(b.id, tribe.home.x + 3, tribe.home.z + 3);
    budget--;
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

/** Aggressive = awake, not passive, and quick to raid (harass threshold ≤ 6). */
function aggressive(tribe: TribeState): boolean {
  const p = tribe.personality;
  return !p.passive && (p.harassAt ?? HARASS_ARMY) <= 6;
}

/**
 * A hostile leader is kneeling at a stone: send a party at her (once per
 * ritual), if she is within marching distance of home.
 */
function answerRituals(world: World, id: TribeId, tribe: TribeState, army: Unit[]): void {
  if (!aggressive(tribe)) return;
  const ai = tribe.ai!;
  world.monuments.forEach((m, i) => {
    if (!m.communing || typeof m.communer !== 'string' || m.communer === id || !world.hostile(id, m.communer)) return;
    const key = `${i}:${m.communerId}`;
    if (ai.answered?.includes(key)) return;
    if (dist(m.x, m.z, tribe.home.x, tribe.home.z) > 70) return;
    const squad = army.filter((u) => isFighter(u) && u.task === 'none' && u.state === 'idle' && u.garrison < 0).slice(0, 4);
    if (squad.length === 0) return;
    (ai.answered ??= []).push(key);
    if (ai.answered.length > 20) ai.answered.shift();
    world.groupMove(squad, m.x, m.z + 1);
  });
}

const guardCount = (m: World['monuments'][number]) => Object.values(m.guards ?? {}).reduce((n, k) => n + (k ?? 0), 0);

/** Stones that need an escort: a great spell, or guardians. */
const needsEscort = (m: World['monuments'][number]) =>
  spellDef(m.spell).tier >= 2 || Object.keys(m.guards ?? {}).length > 0;

/** The knowledge race: an idle leader walks to the nearest open stone (with an escort, to a great one). */
function seekMonuments(world: World, id: TribeId, army: Unit[] = []): void {
  const leader = world.leaderOf(id);
  if (!leader || leader.task !== 'none' || leader.state !== 'idle' || leader.castSpell) return;
  const tribe = world.tribes[id]!;
  const canTrain = [...tribe.allowed].some((k) => BUILDINGS[k].trains);
  const fighters = army.filter((u) => isFighter(u) && u.garrison < 0);
  const villages = new Set(world.buildings.map((b) => b.tribe));
  let bestIdx = -1;
  let bestD = 55;
  for (let i = 0; i < world.monuments.length; i++) {
    const m = world.monuments[i];
    if (!world.canCommune(m, id)) continue;
    // Early on, a rival village's doorstep stone is that rival's errand, not ours.
    if (world.elapsed < 600 && world.activeTribes().some((o) => o !== id && world.hostile(id, o) && villages.has(o) &&
      dist(m.x, m.z, world.tribes[o]!.home.x, world.tribes[o]!.home.z) < dist(m.x, m.z, tribe.home.x, tribe.home.z))) continue;
    // A great or guarded stone waits for an escort (unless this god can never raise one).
    // Guardians: only with spears enough to beat them (their number and two more).
    const guards = guardCount(m);
    if (guards > 0 && fighters.length < guards + 2 && (canTrain || fighters.length > 0)) continue;
    if (needsEscort(m) && fighters.length < 2) {
      if (canTrain && world.elapsed < 600) continue; // early on, wait for spears
    }
    // A taught spell we already know is worth nothing to us.
    if (m.mode === 'teach' && world.tribes[id]!.known.has(m.spell)) continue;
    const d = world.distTo(leader, m.x, m.z);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return;
  const m = world.monuments[bestIdx];
  if (needsEscort(m) && fighters.length > 0) {
    const free = fighters.filter((u) => u.task === 'none' || u.state === 'idle').slice(0, Math.max(4, guardCount(m) + 2));
    if (free.length) world.groupMove(free, m.x, m.z + 2.5);
  }
  world.orderWorship([leader.id], bestIdx);
}

const ready = (world: World, id: TribeId, spell: SpellId) => {
  const s = world.spellState(id, spell);
  return s.gifted > 0 || (s.known && s.charges > 0);
};

// ---------------------------------------------------------------------------
// Judging a target. A god spends a charge when the blow is worth it: a crowd
// of soldiers, a leader, a village — never one villager in a field. Our own
// people under the circle count against it, twice over.
// ---------------------------------------------------------------------------

const UNIT_VALUE: Record<UnitKind, number> = { brave: 1, warrior: 2, firewarrior: 2, warden: 3, chanter: 2, shaman: 6, wildman: 0 };
const BUILDING_VALUE: Record<BuildingKind, number> = {
  hut: 3, lumberyard: 2, warriorHut: 4, fireHut: 4, tower: 3, shrine: 5, wardenHall: 5, chantHall: 4,
};

/** Hostile value minus twice our own (and allies') value of people within r of (x, z). */
function peopleValue(world: World, id: TribeId, x: number, z: number, r: number): number {
  let v = 0;
  for (const u of world.units) {
    if (u.hidden || u.tribe === 'wild' || dist(u.x, u.z, x, z) > r) continue;
    if (world.hostile(id, u.tribe)) v += UNIT_VALUE[u.kind];
    else v -= 2 * UNIT_VALUE[u.kind];
  }
  return v;
}

/** Same for buildings (a building counts if its footprint touches the circle). */
function townValue(world: World, id: TribeId, x: number, z: number, r: number): number {
  let v = 0;
  for (const b of world.buildings) {
    if (dist(b.x, b.z, x, z) > r + b.size / 2) continue;
    if (world.hostile(id, b.tribe)) v += BUILDING_VALUE[b.kind] * (b.progress >= 1 ? 1 : 0.5);
    else v -= 2 * BUILDING_VALUE[b.kind];
  }
  return v;
}

/** The best centre (a hostile unit or building) for a circle, within `range` of the leader. */
function bestCentre(
  world: World, id: TribeId, leader: Unit, range: number, score: (x: number, z: number) => number, pool: 'units' | 'buildings',
): { x: number; z: number; v: number } | null {
  let best: { x: number; z: number; v: number } | null = null;
  const consider = (x: number, z: number) => {
    if (world.distTo(leader, x, z) > range) return;
    const v = score(x, z);
    if (!best || v > best.v) best = { x, z, v };
  };
  if (pool === 'units') {
    for (const u of world.units) if (!u.hidden && u.tribe !== 'wild' && world.hostile(id, u.tribe)) consider(u.x, u.z);
  } else {
    for (const b of world.buildings) if (world.hostile(id, b.tribe)) consider(b.x, b.z);
  }
  return best;
}

/** Minimum target value per spell (net of friendly fire). */
const WORTH: Partial<Record<SpellId, number>> = {
  blast: 4, lightning: 2, swamp: 5, cyclone: 7,
  emberfall: 12, sink: 12, earthquake: 12, volcano: 14,
};

/**
 * The leader casts with intent: one spell per think at most, and after any
 * cast she waits the difficulty's cast gap (longer after a world-shaper).
 * Recruiting and blessings come before violence; tier-3 charges are saved
 * for a village worth breaking.
 */
function leaderCasts(world: World, id: TribeId, tribe: TribeState): void {
  const ai = tribe.ai!;
  const leader = world.leaderOf(id);
  if (!leader || leader.castSpell || leader.state === 'working' || leader.hidden) return;
  if (ai.castCooldown > 0) return;
  const gap = DIFFICULTIES[world.settings.difficulty].aiCastGap;
  const cast = (spell: SpellId, x: number, z: number) => {
    if (!ready(world, id, spell) || world.orderCast(id, spell, x, z) !== null) return false;
    ai.castCooldown = gap * (spellDef(spell).tier === 3 ? 1.6 : 1);
    return true;
  };

  // A rival leader kneeling at a stone, in reach: break the ritual.
  for (const m of world.monuments) {
    if (!m.communing || typeof m.communer !== 'string' || m.communer === id || !world.hostile(id, m.communer)) continue;
    const kneeler = world.unitById(m.communerId ?? -1);
    if (!kneeler || kneeler.hidden) continue;
    for (const spell of ['lightning', 'blast'] as SpellId[]) {
      if (ready(world, id, spell) && world.distTo(leader, kneeler.x, kneeler.z) <= spellDef(spell).range && cast(spell, kneeler.x, kneeler.z)) return;
    }
  }

  // Kindle wanderers: two or more are always worth a charge; one only when
  // the flock is thin (villagers do all the chopping, building and breeding).
  const braves = world.countUnits((u) => u.tribe === id && u.kind === 'brave');
  if (ready(world, id, 'convert')) {
    const R = spellDef('convert').radius;
    let best: Unit | null = null;
    let bestN = 0;
    for (const u of world.units) {
      if (u.kind !== 'wildman' || world.distTo(leader, u.x, u.z) > spellDef('convert').range) continue;
      let n = 0;
      for (const q of world.units) if (q.kind === 'wildman' && dist(q.x, q.z, u.x, u.z) <= R) n++;
      if (n > bestN) {
        bestN = n;
        best = u;
      }
    }
    if (best && (bestN >= 2 || braves < 4) && cast('convert', best.x, best.z)) return;
  }

  // Bless our own fighters when there's a real fight.
  const enemyFighters = world.units.filter(
    (u) => !u.hidden && u.tribe !== 'wild' && world.hostile(id, u.tribe) && isFighter(u) && world.distTo(leader, u.x, u.z) < 12,
  );
  const ours = world.units.filter((u) => u.tribe === id && !u.hidden && isFighter(u) && world.distTo(leader, u.x, u.z) < 9);
  if (enemyFighters.length >= 2 && ours.length >= 4) {
    const c = ours[0];
    if (!ours.some((u) => u.warsongTime > 0) && cast('warsong', c.x, c.z)) return;
    if (!ours.some((u) => u.wardTime > 0) && cast('ward', c.x, c.z)) return;
  }

  // Village-breakers: only on a town worth it.
  for (const spell of ['volcano', 'earthquake', 'emberfall', 'sink', 'cyclone'] as SpellId[]) {
    if (!ready(world, id, spell)) continue;
    const def = spellDef(spell);
    const r = spell === 'earthquake' ? def.radius * 0.8 : def.radius;
    const t = bestCentre(world, id, leader, def.range, (x, z) => townValue(world, id, x, z, r), 'buildings');
    if (t && t.v >= WORTH[spell]! && cast(spell, t.x, t.z)) return;
  }

  // People: Blast a crowd, Lightning a champion, Mire a column.
  for (const spell of ['blast', 'lightning', 'swamp'] as SpellId[]) {
    if (!ready(world, id, spell)) continue;
    const def = spellDef(spell);
    const r = spell === 'lightning' ? 2.5 : def.radius;
    const t = bestCentre(world, id, leader, def.range, (x, z) => peopleValue(world, id, x, z, r), 'units');
    if (t && t.v >= WORTH[spell]! && cast(spell, t.x, t.z)) return;
  }

  // Short of wood and trees: bloom the home grove.
  if (tribe.wood < 4 && ready(world, id, 'bloom')) {
    const living = world.trees.filter((t) => t.alive && dist(t.x, t.z, tribe.home.x, tribe.home.z) < 14).length;
    if (living < 6) cast('bloom', tribe.home.x + 6, tribe.home.z + 6);
  }
}

/**
 * Keep the leader out of pointless danger: hurt, with enemy soldiers close,
 * she walks home. Returns true while she is retreating.
 */
function leaderSafety(world: World, id: TribeId, tribe: TribeState): boolean {
  const leader = world.leaderOf(id);
  if (!leader || leader.hidden || leader.castSpell) return false;
  if (leader.hp / leader.maxHp >= 0.45) return false;
  const threat = world.units.some(
    (u) => !u.hidden && u.tribe !== 'wild' && world.hostile(id, u.tribe) && isFighter(u) && world.distTo(leader, u.x, u.z) < 8,
  );
  if (!threat) return false;
  const home = tribe.home;
  const headingHome = leader.goal && dist(leader.goal.x, leader.goal.z, home.x, home.z) < 3;
  if (world.distTo(leader, home.x, home.z) > 3 && !headingHome) {
    world.abandonTask(leader);
    world.sendTo(leader, home.x, home.z);
  }
  return true;
}

/**
 * The answer to water: when the rival lives across a strait (or up a cliff),
 * walk the leader to the narrowest gap and raise a Causeway (or Level the
 * cliff), one cast at a time, until the land joins. Learns the spell at a
 * stone first if it must. Returns true while the leader is busy with it.
 */
function bridgeTo(world: World, id: TribeId, tribe: TribeState, target: { x: number; z: number }): boolean {
  const ai = tribe.ai!;
  const leader = world.leaderOf(id);
  if (!leader || leader.hidden) return false;
  // A bridge is rising: wait for the land, then plan the next leg from the new shore.
  if (ai.crossing?.wait !== undefined) {
    if (world.elapsed < ai.crossing.wait) return true;
    ai.crossing = null;
  }
  if (!ai.crossing || world.elapsed - ai.crossing.at > 10) {
    const c = findCrossing(world.map, tribe.home, target);
    ai.crossing = c ? { from: c.from, to: c.to, kind: c.kind, width: c.width, at: world.elapsed } : null;
  }
  const c = ai.crossing;
  if (!c) return false;
  const spell: SpellId = c.kind === 'water' ? 'landbridge' : 'flatten';
  world.setSpellCharging(id, spell, true);
  if (!ready(world, id, spell)) {
    // Not known and nothing gifted: a stone that holds it, on our side of the water?
    if (!tribe.known.has(spell)) return seekStone(world, leader, spell);
    return false; // charging — the leader carries on meanwhile
  }
  if (leader.castSpell || leader.state === 'working' || leader.task === 'worship') return true;
  if (world.distTo(leader, c.from.x, c.from.z) > 2.5) {
    if (!(leader.goal && dist(leader.goal.x, leader.goal.z, c.from.x, c.from.z) < 2)) {
      world.abandonTask(leader);
      if (!world.sendTo(leader, c.from.x, c.from.z)) ai.crossing = null;
    }
    return true;
  }
  const def = spellDef(spell);
  const dx = wrapDelta(c.to.x - leader.x, WORLD_SIZE);
  const dz = wrapDelta(c.to.z - leader.z, WORLD_SIZE);
  const len = Math.hypot(dx, dz) || 1;
  const reach = spell === 'landbridge' ? Math.min(len + 2, def.range - 1) : Math.min(len / 2, def.range - 1);
  if (world.orderCast(id, spell, leader.x + (dx / len) * reach, leader.z + (dz / len) * reach) === null) {
    // Re-plan once the land has risen: the next gap starts at the new shore.
    ai.crossing = { ...c, wait: world.elapsed + def.castSeconds + def.duration + 1 };
  }
  return true;
}

/** Walk the leader to a stone holding `spell`, on ground she can reach. */
function seekStone(world: World, leader: Unit, spell: SpellId): boolean {
  if (leader.task === 'worship') return true;
  const here = regionNear(world.map, leader.x, leader.z);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < world.monuments.length; i++) {
    const m = world.monuments[i];
    if (m.spell !== spell || !world.monumentAvailable(m) || regionNear(world.map, m.x, m.z) !== here) continue;
    const d = world.distTo(leader, m.x, m.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return false;
  if (leader.castSpell || leader.state === 'working') return true;
  world.orderWorship([leader.id], best);
  return true;
}
