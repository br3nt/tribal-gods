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

/** The objective the player should be working on: the first active, unfinished, required one (else optional). */
export function currentObjective(world: World): { index: number; objective: Objective; text: string } | null {
  const open = world.objectives
    .map((o, index) => ({ o, index }))
    .filter(({ o }) => o.active !== false && !o.done && !o.failed);
  const pick = open.find(({ o }) => !o.optional) ?? open[0];
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
      return `Select your leader${k('select-leader')} and ${click} the ${m ? spellDef(m.spell).name + ' ' : ''}stone. Bring warriors: the ritual breaks if she's hit.`;
    }
    case 'leaderReach':
      return `Select your leader${k('select-leader')} and ${click} the ground where the story points.`;
    case 'rescueStranded':
      return `Your stranded people join when a walking path reaches them — raise land to them.`;
    case 'holdPoint':
      return `Keep your people standing on the marked ground until the time is up.`;
    case 'destroyTribe':
    case 'destroyAll':
    case 'killUnits':
      return `Select your fighters (${labelFor('select-army') || ','}) and ${click} an enemy to attack.`;
    default:
      return null;
  }
}
