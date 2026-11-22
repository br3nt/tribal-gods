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
import { tr } from '../i18n';

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
  if (!s.known && s.gifted === 0) return tr('{0} isn\'t yours yet — a standing stone or the story will bring it.', def.name);
  if (!world.leaderOf('player')) return tr('Your leader casts {0}; they are returning to the home circle.', def.name);
  if (s.charges + s.gifted === 0) {
    if (!s.charging) return tr('{0} is not charging: right-click it in the spell book to pour mana in.', def.name);
    return tr('{0} is gathering power{1}. When its stone glows, press{2} and {3}.', def.name, Number.isFinite(s.eta) ? tr(' (about {0}s)', Math.ceil(s.eta)) : '', k(`spell:${spell}`), where);
  }
  return tr('Pick {0}{1} and {2}.', def.name, k(`spell:${spell}`), where);
}

/**
 * Foes expected but none ashore yet: if a stone is open to you, the story
 * (and this chip) points at it — the lull is for kneeling there; else hold.
 */
function quietAdvice(world: World, click: string): string {
  if (world.landings.length) return tr(`Boats are running in — they step ashore in a moment. Be ready to strike them on the sand.`);
  const kneeling = world.monuments.find((m) => m.communing && m.communer === 'player');
  if (kneeling) return tr('None of them ashore yet. Your leader is kneeling at the {0} stone — let her finish.', spellDef(kneeling.spell).name);
  const open = world.monuments.find((m) => world.monumentAvailable(m) && !(m.mode === 'teach' && m.claimedBy !== null) && !world.tribes.player?.known.has(m.spell));
  if (open && world.leaderOf('player')) {
    return tr('None of them ashore yet. Use the time: select your leader{0} and {1} the {2} stone.', k('select-leader'), click, spellDef(open.spell).name);
  }
  return tr(`None of them in sight yet. Keep your fighters near the village and a spell charged.`);
}

/** The leader is dead and returning: say so (never "select your leader" when there is none). */
function leaderAway(world: World, then: string): string {
  const back = world.tribeSummary('player').leaderRespawn;
  return tr('Your leader has fallen and returns to the home circle{0} — {1}. A broken ritual fades slowly.', back > 0 ? tr(' in {0}s', Math.ceil(back)) : '', then);
}

/** Strongest first: what to hit a host with when the leader holds it. */
const STRIKES: SpellId[] = ['volcano', 'emberfall', 'earthquake', 'lightning', 'blast'];

/** Foes in sight: name the strongest spell in hand (a stone's gift first), then the fighters. */
function strikeAdvice(world: World, click: string): string {
  const fighters = tr('select your fighters ({0}) and {1} an enemy', labelFor('select-army') || ',', click);
  const ready = world.leaderOf('player') && STRIKES.find((id) => {
    const s = world.spellState('player', id);
    return s.gifted > 0 || (s.known && s.charges > 0);
  });
  if (!ready) return tr('{0}{1} to attack.', fighters[0].toUpperCase(), fighters.slice(1));
  return tr('Strike them with {0}{1} — or {2}.', spellDef(ready).name, k(`spell:${ready}`), fighters);
}

/** The chip's text (HTML) for an objective, or null when there's nothing useful to add. */
export function objectiveAdvice(world: World, o: Objective, leftClickOrders: boolean): string | null {
  const click = orderVerb(leftClickOrders);
  switch (o.type) {
    case 'castSpell':
      return spellAdvice(world, o.spell, o.x !== undefined ? tr('click the marked place (the narrator points to it; the minimap pings it)') : tr('click the world'));
    case 'chargeSpell':
      return tr('Let {0} gather {1} charge{2}: more people, homes and prayer fill it faster.', spellDef(o.spell).name, o.charges ?? 1, (o.charges ?? 1) === 1 ? '' : 's');
    case 'convertWanderers':
      return spellAdvice(world, 'convert', tr('click among the wanderers to kindle them'));
    case 'buildCount': {
      const st = world.buildState('player', o.kind);
      const name = BUILDINGS[o.kind].name;
      if (!st.allowed) return null;
      if (!st.unlocked || !st.affordable) return tr('{0}: {1}. Your villagers fetch wood on their own.', name, st.reason ?? tr('not yet'));
      return tr('Pick {0}{1} in the Build panel and click open ground.', name, k(`build:${o.kind}`));
    }
    case 'reachPopulation':
      return tr('Grow the tribe: Dwellings{0} breed villagers while they have room.', k('build:hut'));
    case 'claimMonument': {
      const m = world.monuments[o.index];
      if (!world.leaderOf('player')) return leaderAway(world, tr('then send her back to the stone'));
      const name = m ? `${spellDef(m.spell).name} ` : '';
      const pct = (p: number | undefined) => `${Math.round((p ?? 0) * 100)}%`;
      if (m?.communing && m.communer === 'player') {
        return m.contested
          ? tr('The ritual is held still ({0}): foes stand in the ring. Drive them off — strike them, or send your fighters.', pct(m.communeProgress))
          : tr('Your leader is kneeling at the {0}stone ({1}). Keep foes off her — one blow breaks the ritual.', name, pct(m.communeProgress));
      }
      if (m && (m.communeProgress ?? 0) > 0.02 && m.communer !== 'player') {
        return tr('The ritual broke at {0} and is fading. Select your leader{1} and {2} the {3}stone to kneel again.', pct(m.communeProgress), k('select-leader'), click, name);
      }
      const l = world.leaderOf('player')!;
      if (l.hp < l.maxHp * 0.6) {
        const bloom = world.spellState('player', 'bloom');
        const heal = bloom.gifted > 0 || (bloom.known && bloom.charges > 0) ? tr(' Bloom{0} on her heals her now;', k('spell:bloom')) : '';
        return tr('Your leader is wounded ({0}%), and a kneeling leader takes extra blows.{1} out of the fight she mends on her own. Then select her{2} and {3} the {4}stone.', Math.round((l.hp / l.maxHp) * 100), heal, k('select-leader'), click, name);
      }
      return tr('Select your leader{0} and {1} the {2}stone. Bring warriors: the ritual breaks if she\'s hit.', k('select-leader'), click, name);
    }
    case 'leaderReach':
      if (!world.leaderOf('player')) return leaderAway(world, tr('then walk her there'));
      return tr('Select your leader{0} and {1} the ground where the story points.', k('select-leader'), click);
    case 'rescueStranded': {
      const cb = world.spellState('player', 'landbridge');
      if (cb.known || cb.gifted > 0) return spellAdvice(world, 'landbridge', tr('click the land where they stand — the road runs from her feet'));
      return tr(`Your stranded people join when a walking path reaches them — raise land to them.`);
    }
    case 'holdPoint':
      return tr(`Keep your people standing on the marked ground until the time is up.`);
    case 'killUnits':
      if (!world.units.some((u) => u.tribe === o.tribe && !u.hidden)) return quietAdvice(world, click);
      return strikeAdvice(world, click);
    case 'destroyTribe':
    case 'destroyAll':
      return tr('Select your fighters ({0}) and {1} an enemy to attack.', labelFor('select-army') || ',', click);
    default:
      return null;
  }
}
