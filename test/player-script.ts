/**
 * A scripted PLAYER for balance runs — not the AI brain. It acts at a
 * human cadence (one decision round every few seconds of game time) and
 * only through the orders a player has: place a building, queue training,
 * set a rally, move/attack with a selection, send the leader to a stone,
 * cast a spell at a spot. It plays a sensible, unspectacular opening:
 * dwellings first, a lumberyard, a War Lodge, warriors in batches, the
 * stones, Blast on crowds near home, then an attack when the army is big
 * enough. Per-chapter hooks add the one thing each scenario asks for.
 */
import { BUILDINGS, BuildingKind, SpellId, spellDef, TribeId, UNITS } from '../src/sim/catalog';
import { findPath } from '../src/sim/pathfinding';
import { regionNear } from '../src/sim/regions';
import type { Unit, World } from '../src/sim/world-state';
import { wrapDelta } from '../src/core/util';

const N = 128;
const d = (ax: number, az: number, bx: number, bz: number) => Math.hypot(wrapDelta(ax - bx, N), wrapDelta(az - bz, N));

export interface ScriptOptions {
  /** Seconds between decision rounds (a calm human ≈ 3). */
  cadence?: number;
  /** Dwellings to aim for before military. */
  huts?: number;
  /** Attack when this many fighters stand ready (0 = never attack). */
  attackAt?: number;
  /** Build order beyond dwellings, in order (skips what the scenario forbids). */
  plan?: BuildingKind[];
  /** Fighters to keep training up to. */
  armyCap?: number;
  /** Extra per-round behaviour for a chapter. */
  extra?: (w: World, s: PlayerScript) => void;
  /** Run `extra` before the stock leader logic (a chapter whose story beats come first). */
  extraFirst?: boolean;
  /** Hold off placing buildings until this says so (a chapter that wants ground Levelled first). */
  buildWhen?: (w: World) => boolean;
}

export class PlayerScript {
  private t = 0;
  log: string[] = [];
  firstLodgeAt: number | null = null;
  firstEnemyContact: number | null = null;
  attacks = 0;
  marching = false;
  casts: Partial<Record<SpellId, number>> = {};

  constructor(readonly opts: ScriptOptions = {}) {}

  tick(w: World, dt: number): void {
    if (this.firstLodgeAt === null && w.buildings.some((b) => b.tribe === 'player' && b.kind === 'warriorHut' && b.progress >= 1)) this.firstLodgeAt = w.elapsed;
    if (this.firstEnemyContact === null) {
      const home = w.tribes.player!.home;
      if (w.units.some((u) => !u.hidden && u.tribe !== 'wild' && u.tribe !== 'player' && w.hostile('player', u.tribe) && UNITS[u.kind].dmg > 0 && d(u.x, u.z, home.x, home.z) < 18)) {
        this.firstEnemyContact = w.elapsed;
      }
    }
    this.t -= dt;
    if (this.t > 0) return;
    this.t = this.opts.cadence ?? 3;
    this.round(w);
  }

  private mine(w: World) {
    return w.buildings.filter((b) => b.tribe === 'player');
  }

  /** A site near home the way a player picks one: ring outward, first that fits. */
  place(w: World, kind: BuildingKind, near?: { x: number; z: number }): boolean {
    const home = near ?? w.tribes.player!.home;
    const r0 = BUILDINGS[kind].size === 5 ? 7 : 5;
    for (let r = r0; r < r0 + 16; r += 2) {
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2 + r;
        const x = Math.round(home.x + Math.cos(a) * r);
        const z = Math.round(home.z + Math.sin(a) * r);
        if (w.canPlaceBuilding('player', kind, x, z) && regionNear(w.map, x, z) === regionNear(w.map, home.x, home.z) &&
          findPath(w.map, home.x, home.z, x, z + (BUILDINGS[kind].size - 1) / 2 + 1, 2500, 0)) {
          return w.placeBuilding('player', kind, x, z);
        }
      }
    }
    return false;
  }

  cast(w: World, spell: SpellId, x: number, z: number): boolean {
    const ok = w.orderCast('player', spell, x, z) === null;
    if (ok) this.casts[spell] = (this.casts[spell] ?? 0) + 1;
    return ok;
  }

  fighters(w: World): Unit[] {
    return w.units.filter((u) => u.tribe === 'player' && !u.hidden && UNITS[u.kind].dmg > 0 && UNITS[u.kind].sight > 0);
  }

  private round(w: World): void {
    if (this.opts.extraFirst) this.opts.extra?.(w, this);
    const t = w.tribes.player!;
    const mine = this.mine(w);
    const sites = mine.filter((b) => b.progress < 1).length;
    const huts = mine.filter((b) => b.kind === 'hut').length;
    const wantHuts = this.opts.huts ?? 6;

    // Economy: a dwelling at a time (two once the village is going).
    if (sites < (huts >= 3 ? 2 : 1) && (this.opts.buildWhen?.(w) ?? true)) {
      const plan = this.opts.plan ?? ['lumberyard', 'warriorHut', 'tower'];
      const next = huts < Math.min(3, wantHuts)
        ? 'hut'
        : plan.find((k) => t.allowed.has(k) && !mine.some((b) => b.kind === k) && w.buildState('player', k).unlocked) ??
          (huts < wantHuts ? 'hut' : null);
      if (next && w.buildState('player', next).affordable) this.place(w, next);
      else if (huts < wantHuts && t.wood >= 12) this.place(w, 'hut');
    }

    // Military: keep a lodge queue going while villagers are plentiful.
    const braves = w.countUnits((u) => u.tribe === 'player' && u.kind === 'brave');
    const army = this.fighters(w);
    for (const b of mine) {
      const trains = BUILDINGS[b.kind].trains;
      if (!trains || b.progress < 1 || trains === 'chanter') continue;
      if (army.length < (this.opts.armyCap ?? 16) && braves > 8 && b.queue < 2 && t.wood >= UNITS[trains].trainWood + 4) {
        w.queueTraining(b.id, 2);
        if (!b.rally) w.setRally(b.id, t.home.x + 4, t.home.z + 4);
      }
    }

    // Home guard: idle fighters go for raiders near the village, and man empty towers.
    const raiders = w.units.filter((u) => !u.hidden && w.foeOfTribe('player', u) && UNITS[u.kind].dmg > 0 && d(u.x, u.z, t.home.x, t.home.z) < 16);
    const idleFighters = army.filter((u) => u.task === 'none' && u.state === 'idle');
    if (raiders.length && idleFighters.length) {
      for (const f of idleFighters) {
        const r = raiders.reduce((a, b) => (w.distTo(f, a.x, a.z) < w.distTo(f, b.x, b.z) ? a : b));
        w.orderAttack([f.id], r.id);
      }
    } else {
      for (const b of mine) {
        if (b.kind !== 'tower' || b.progress < 1 || b.garrison.length >= 2) continue;
        const f = idleFighters.find((u) => d(u.x, u.z, t.home.x, t.home.z) < 30);
        if (f) w.orderGarrison([f.id], b.id);
      }
    }

    // Leader: the stones first (nearest open one we can walk to), else home.
    const leader = w.leaderOf('player');
    if (leader && !leader.castSpell && leader.task === 'none') {
      let best = -1;
      let bestD = Infinity;
      w.monuments.forEach((m, i) => {
        if (!w.monumentAvailable(m) || (m.mode === 'teach' && t.known.has(m.spell))) return;
        // A guarded stone only with spears enough to win (as a sensible player would judge it).
        const guards = Object.values(m.guards ?? {}).reduce((n, k) => n + (k ?? 0), 0);
        if (guards > 0 && this.fighters(w).length < guards + 2) return;
        if (regionNear(w.map, m.x, m.z) !== regionNear(w.map, leader.x, leader.z)) return;
        const dd = w.distTo(leader, m.x, m.z);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      });
      if (best >= 0 && bestD < 70) {
        // A guarded or great stone: walk the spears there first, like a sensible player.
        const m = w.monuments[best];
        if (m.guards || spellDef(m.spell).tier >= 2) {
          const escort = this.fighters(w).filter((u) => u.task === 'none').slice(0, 4);
          if (escort.length) w.orderMove(escort.map((u) => u.id), m.x, m.z + 3);
        }
        w.orderWorship([leader.id], best);
      }
      // Kindle wanderers in reach.
      else if (w.spellState('player', 'convert').charges > 0) {
        const wild = w.units.find((u) => u.kind === 'wildman' && w.distTo(leader, u.x, u.z) < 25);
        if (wild) this.cast(w, 'convert', wild.x, wild.z);
      }
    }

    // Defend: Blast a crowd of hostiles near home or near our army.
    if (leader && !leader.castSpell) {
      const foes = w.units.filter((u) => !u.hidden && w.foeOfTribe('player', u) && w.distTo(leader, u.x, u.z) < spellDef('blast').range);
      for (const f of foes) {
        const crowd = foes.filter((q) => d(q.x, q.z, f.x, f.z) < 4).length;
        const ours = w.units.filter((q) => q.tribe === 'player' && !q.hidden && d(q.x, q.z, f.x, f.z) < 4).length;
        if (crowd >= 3 && ours === 0 && w.spellState('player', 'blast').charges > 0 && this.cast(w, 'blast', f.x, f.z)) break;
        if (f.kind === 'shaman' && w.spellState('player', 'lightning').charges > 0 && this.cast(w, 'lightning', f.x, f.z)) break;
      }
    }

    // Short of wood: Bloom the home grove where most stumps stand.
    if (t.wood < 6 && leader && !leader.castSpell && w.spellState('player', 'bloom').charges > 0) {
      let best: { x: number; z: number } | null = null;
      let bestN = 3;
      for (const tr of w.trees) {
        if (tr.alive || d(tr.x, tr.z, t.home.x, t.home.z) > 20) continue;
        const n = w.trees.filter((q) => !q.alive && d(q.x, q.z, tr.x, tr.z) < 6).length;
        if (n > bestN) {
          bestN = n;
          best = tr;
        }
      }
      if (best) this.cast(w, 'bloom', best.x, best.z);
    }

    if (!this.opts.extraFirst) this.opts.extra?.(w, this);

    // Attack like a patient player: gather at home until the army is big
    // enough, then march ALL of it (leader behind, casting); fall back and
    // regather if it is beaten down to a third.
    const attackAt = this.opts.attackAt ?? 10;
    if (attackAt > 0) {
      const target = this.enemyHome(w);
      if (this.marching && (army.length < Math.max(3, attackAt * 0.6) || !target)) {
        this.marching = false;
        const idleArmy = army.filter((u) => u.task === 'none');
        if (idleArmy.length) w.orderMove(idleArmy.map((u) => u.id), t.home.x + 3, t.home.z + 3);
      } else if (!this.marching && target && army.length >= attackAt) {
        this.marching = true;
        this.attacks++;
      }
      if (this.marching && target) {
        // A home guard (a quarter of the army, nearest home) stays behind.
        const byHome = [...army].sort((a, b) => w.distTo(a, t.home.x, t.home.z) - w.distTo(b, t.home.x, t.home.z));
        const guard = new Set(byHome.slice(0, Math.floor(army.length / 4)).map((u) => u.id));
        const idle = army.filter((u) => !guard.has(u.id) && u.task === 'none' && u.state === 'idle');
        if (idle.length) w.orderMove(idle.map((u) => u.id), target.x, target.z);
        const lead = w.leaderOf('player');
        if (lead && lead.task === 'none' && !lead.castSpell && lead.state === 'idle' && army.length) {
          const c = army[Math.floor(army.length / 2)];
          if (w.distTo(lead, c.x, c.z) > 6) w.sendTo(lead, c.x, c.z);
        }
      }
    }
  }

  enemyHome(w: World): { x: number; z: number } | null {
    const home = w.tribes.player!.home;
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (const id of w.activeTribes() as TribeId[]) {
      if (!w.hostile('player', id) || !w.tribeAlive(id)) continue;
      // Rival buildings first (that's what destroyTribe needs), else any of its people.
      const b = w.buildings.find((q) => q.tribe === id);
      const u = w.units.find((q) => q.tribe === id && !q.hidden);
      const at = b ?? u;
      if (!at) continue;
      const dd = d(at.x, at.z, home.x, home.z);
      if (dd < bestD) {
        bestD = dd;
        best = { x: at.x, z: at.z };
      }
    }
    return best;
  }
}

/**
 * Chapter 1 (Landfall), played the way the narrator tells it: Causeway to
 * the kin, Kindle the meadow, Level the slope twice (then the economy
 * builds), Lightning + Blast on the first raiders, then kneel at the
 * headland and drop the Volcano on the massed host.
 */
export function landfallExtra(layout: { sandbar: { x: number; z: number }; home: { x: number; z: number }; strand: { x: number; z: number } }) {
  const levelAt = [
    { x: layout.home.x + 6, z: layout.home.z + 2 },
    { x: layout.home.x + 2, z: layout.home.z - 6 },
  ];
  return (w: World, s: PlayerScript): void => {
    const leader = w.leaderOf('player');
    if (!leader || leader.castSpell || leader.state === 'working') return;
    const st = (id: SpellId) => w.spellState('player', id);
    const ready = (id: SpellId) => st(id).gifted > 0 || (st(id).known && st(id).charges > 0);
    // 1. Kin on the sandbar.
    if (ready('landbridge') && w.units.some((u) => u.joins === 'player')) {
      if (s.cast(w, 'landbridge', layout.sandbar.x, layout.sandbar.z)) s.log.push(`${w.elapsed.toFixed(0)}s causeway`);
      return;
    }
    // 2. Level the slope (the first two casts), the objective's whole point.
    const level = w.objectives.findIndex((o) => o.objective.type === 'castSpell' && o.objective.spell === 'flatten');
    if (level >= 0 && w.objectives[level].active && !w.objectives[level].done && ready('flatten')) {
      const n = s.casts.flatten ?? 0;
      const p = levelAt[Math.min(n, levelAt.length - 1)];
      if (s.cast(w, 'flatten', p.x, p.z)) s.log.push(`${w.elapsed.toFixed(0)}s level`);
      return;
    }
    // 4. The host masses on the strand: wake the mountain under it.
    const host = w.units.filter((u) => u.tribe === 'violet' && (u.holdUntil ?? 0) > w.elapsed && w.distTo(u, layout.strand.x, layout.strand.z) < 8);
    if (ready('volcano') && host.length >= 6) {
      let cx = 0;
      let cz = 0;
      for (const u of host) {
        cx += u.x;
        cz += u.z;
      }
      if (s.cast(w, 'volcano', cx / host.length, cz / host.length)) s.log.push(`${w.elapsed.toFixed(0)}s volcano on ${host.length}`);
      return;
    }
    // 3. Raiders near the village: Lightning the nearest, else Blast.
    const home = w.tribes.player!.home;
    const raider = w.units
      .filter((u) => u.tribe === 'violet' && !u.hidden && !((u.holdUntil ?? 0) > w.elapsed) && w.distTo(u, home.x, home.z) < 24)
      .sort((a, b) => w.distTo(leader, a.x, a.z) - w.distTo(leader, b.x, b.z))[0];
    if (raider && ready('lightning') && w.distTo(leader, raider.x, raider.z) < 16 && s.cast(w, 'lightning', raider.x, raider.z)) return;
    if (raider && ready('blast') && w.distTo(leader, raider.x, raider.z) < 14 && s.cast(w, 'blast', raider.x, raider.z)) return;
    // Raiders on the island and the leader far from the village: go home to meet them.
    if (raider && leader.task === 'none' && w.distTo(leader, home.x, home.z) > 10) w.sendTo(leader, home.x + 3, home.z + 6);
  };
}
