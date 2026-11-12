/**
 * ui/objective-advice.ts — "how do I do THAT?" for the objective in front of you.
 *
 * In a campaign chapter the story (narrator lines, objectives chained with
 * `after`) already says WHAT to do next; generic onboarding chips ("Build a
 * Dwelling") would argue with it. So in a guided scenario the hint chip is
 * derived from the current active objective instead, and says HOW, with
 * the real key — and, like every hint, only asks for what is possible now:
 * a spell still gathering power says so rather than "press J".
 *
 * Pure strings from data (World is only read), so it is unit-tested.
 */

import { BUILDINGS, Objective, spellDef, SpellId } from '../sim/catalog';
import type { World } from '../sim/world-state';
import { ActionId, labelFor, orderVerb } from './hotkeys';

const k = (a: ActionId) => {
  const l = labelFor(a);
  return l ? ` <span class="kbd">${l}</span>` : '';
};

/** A scenario that tells its own story (scripted events): generic onboarding hints stand aside. */
export function isGuided(world: World): boolean {
  return (world.rules.events?.length ?? 0) > 0;
}

/**
 * The objective the player should be working on: of the active, unfinished,
 * required ones, the one that became active MOST RECENTLY (the story moves
 * forward; it is what the narrator is talking about), the earliest-listed
 * among those that activated together. `activatedAt` (index → sim seconds)
 * is kept by the caller; without it, the first open one.
 */
export function currentObjective(world: World, activatedAt?: ReadonlyMap<number, number>): { index: number; objective: Objective; text: string } | null {
  const open = world.objectives
    .map((o, index) => ({ o, index }))
    .filter(({ o }) => o.active !== false && !o.done && !o.failed);
  const required = open.filter(({ o }) => !o.optional);
  const when = (i: number) => activatedAt?.get(i) ?? 0;
  const pick = required.reduce<(typeof required)[number] | undefined>((best, c) => (!best || when(c.index) > when(best.index) ? c : best), undefined) ?? open[0];
  return pick ? { index: pick.index, objective: pick.o.objective, text: pick.o.text } : null;
}

function spellAdvice(world: World, spell: SpellId, where: string): string {
  const def = spellDef(spell);
  const s = world.spellState('player', spell);
  if (!s.known && s.gifted === 0) return `${def.name} isn't yours yet — a standing stone or the story will bring it.`;
  if (!world.leaderOf('player')) return `Your leader casts ${def.name}; they are returning to the home circle.`;
  if (s.charges + s.gifted === 0) {
    if (!s.charging) return `${def.name} is not charging: right-click it in the spell book to pour mana in.`;
    return `${def.name} is gathering power${Number.isFinite(s.eta) ? ` (about ${Math.ceil(s.eta)}s)` : ''}. When its stone glows, press${k(`spell:${spell}`)} and ${where}.`;
  }
  return `Pick ${def.name}${k(`spell:${spell}`)} and ${where}.`;
}

/**
 * Foes expected but none ashore yet: if a stone is open to you, the story
 * (and this chip) points at it — the lull is for kneeling there; else hold.
 */
function quietAdvice(world: World, click: string): string {
  if (world.landings.length) return `Boats are running in — they step ashore in a moment. Be ready to strike them on the sand.`;
  const kneeling = world.monuments.find((m) => m.communing && m.communer === 'player');
  if (kneeling) return `None of them ashore yet. Your leader is kneeling at the ${spellDef(kneeling.spell).name} stone — let her finish.`;
  const open = world.monuments.find((m) => world.monumentAvailable(m) && !(m.mode === 'teach' && m.claimedBy !== null) && !world.tribes.player?.known.has(m.spell));
  if (open && world.leaderOf('player')) {
    return `None of them ashore yet. Use the time: select your leader${k('select-leader')} and ${click} the ${spellDef(open.spell).name} stone.`;
  }
  return `None of them in sight yet. Keep your fighters near the village and a spell charged.`;
}

/** The leader is dead and returning: say so (never "select your leader" when there is none). */
function leaderAway(world: World, then: string): string {
  const back = world.tribeSummary('player').leaderRespawn;
  return `Your leader has fallen and returns to the home circle${back > 0 ? ` in ${Math.ceil(back)}s` : ''} — ${then}. A broken ritual fades slowly.`;
}

/** Strongest first: what to hit a host with when the leader holds it. */
const STRIKES: SpellId[] = ['volcano', 'emberfall', 'earthquake', 'lightning', 'blast'];

/** Foes in sight: name the strongest spell in hand (a stone's gift first), then the fighters. */
function strikeAdvice(world: World, click: string): string {
  const fighters = `select your fighters (${labelFor('select-army') || ','}) and ${click} an enemy`;
  const ready = world.leaderOf('player') && STRIKES.find((id) => {
    const s = world.spellState('player', id);
    return s.gifted > 0 || (s.known && s.charges > 0);
  });
  if (!ready) return `${fighters[0].toUpperCase()}${fighters.slice(1)} to attack.`;
  return `Strike them with ${spellDef(ready).name}${k(`spell:${ready}`)} — or ${fighters}.`;
}

/** The chip's text (HTML) for an objective, or null when there's nothing useful to add. */
export function objectiveAdvice(world: World, o: Objective, leftClickOrders: boolean): string | null {
  const click = orderVerb(leftClickOrders);
  switch (o.type) {
    case 'castSpell':
      return spellAdvice(world, o.spell, o.x !== undefined ? 'click the marked place (the narrator points to it; the minimap pings it)' : 'click the world');
    case 'chargeSpell':
      return `Let ${spellDef(o.spell).name} gather ${o.charges ?? 1} charge${(o.charges ?? 1) === 1 ? '' : 's'}: more people, homes and prayer fill it faster.`;
    case 'convertWanderers':
      return spellAdvice(world, 'convert', 'click among the wanderers to kindle them');
    case 'buildCount': {
      const st = world.buildState('player', o.kind);
      const name = BUILDINGS[o.kind].name;
      if (!st.allowed) return null;
      if (!st.unlocked || !st.affordable) return `${name}: ${st.reason ?? 'not yet'}. Your villagers fetch wood on their own.`;
      return `Pick ${name}${k(`build:${o.kind}`)} in the Build panel and click open ground.`;
    }
    case 'reachPopulation':
      return `Grow the tribe: Dwellings${k('build:hut')} breed villagers while they have room.`;
    case 'claimMonument': {
      const m = world.monuments[o.index];
      if (!world.leaderOf('player')) return leaderAway(world, 'then send her back to the stone');
      const name = m ? `${spellDef(m.spell).name} ` : '';
      const pct = (p: number | undefined) => `${Math.round((p ?? 0) * 100)}%`;
      if (m?.communing && m.communer === 'player') {
        return m.contested
          ? `The ritual is held still (${pct(m.communeProgress)}): foes stand in the ring. Drive them off — strike them, or send your fighters.`
          : `Your leader is kneeling at the ${name}stone (${pct(m.communeProgress)}). Keep foes off her — one blow breaks the ritual.`;
      }
      if (m && (m.communeProgress ?? 0) > 0.02 && m.communer !== 'player') {
        return `The ritual broke at ${pct(m.communeProgress)} and is fading. Select your leader${k('select-leader')} and ${click} the ${name}stone to kneel again.`;
      }
      const l = world.leaderOf('player')!;
      if (l.hp < l.maxHp * 0.6) {
        const bloom = world.spellState('player', 'bloom');
        const heal = bloom.gifted > 0 || (bloom.known && bloom.charges > 0) ? ` Bloom${k('spell:bloom')} on her heals her now;` : '';
        return `Your leader is wounded (${Math.round((l.hp / l.maxHp) * 100)}%), and a kneeling leader takes extra blows.${heal} out of the fight she mends on her own. Then select her${k('select-leader')} and ${click} the ${name}stone.`;
      }
      return `Select your leader${k('select-leader')} and ${click} the ${name}stone. Bring warriors: the ritual breaks if she's hit.`;
    }
    case 'leaderReach':
      if (!world.leaderOf('player')) return leaderAway(world, 'then walk her there');
      return `Select your leader${k('select-leader')} and ${click} the ground where the story points.`;
    case 'rescueStranded': {
      const cb = world.spellState('player', 'landbridge');
      if (cb.known || cb.gifted > 0) return spellAdvice(world, 'landbridge', 'click the land where they stand — the road runs from her feet');
      return `Your stranded people join when a walking path reaches them — raise land to them.`;
    }
    case 'holdPoint':
      return `Keep your people standing on the marked ground until the time is up.`;
    case 'killUnits':
      if (!world.units.some((u) => u.tribe === o.tribe && !u.hidden)) return quietAdvice(world, click);
      return strikeAdvice(world, click);
    case 'destroyTribe':
    case 'destroyAll':
      return `Select your fighters (${labelFor('select-army') || ','}) and ${click} an enemy to attack.`;
    default:
      return null;
  }
}
