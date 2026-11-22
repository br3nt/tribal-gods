/**
 * sim/rules.ts — the default ScenarioRules a random skirmish (or a legacy
 * level with no rules) plays under: you against 1–3 AI gods, starter
 * spells, every building, destroy every rival tribe.
 */

import { BUILD_ORDER, ScenarioRules, SPELLS, TRIBE_IDS, TribeId } from './catalog';
import { tr } from '../i18n';

export const STARTER_SPELLS = SPELLS.filter((s) => s.starter).map((s) => s.id);

export function skirmishRules(enemies = 1): ScenarioRules {
  const n = Math.max(1, Math.min(3, Math.round(enemies)));
  const rivals = TRIBE_IDS.slice(1, 1 + n) as TribeId[];
  return {
    tribes: [
      { id: 'player', ai: false },
      ...rivals.map((id) => ({ id, ai: true })),
    ],
    objectives: [
      { objective: { type: 'destroyAll' }, text: n === 1 ? tr('Destroy the rival tribe') : tr('Destroy every rival tribe') },
    ],
    fail: [{ type: 'tribeDestroyed' }],
    briefing: {
      title: tr('Skirmish'),
      body: n === 1 ? tr('One planet, two gods. Only one tribe walks away.') : tr('One planet, {0} gods. Only one tribe walks away.', n + 1),
      tips: [
        tr('Dwellings breed villagers and feed your spells.'),
        tr('Train fighters at the lodges; garrison a watchtower to hold a hill.'),
        tr('Leaders learn new spells at the standing stones.'),
      ],
    },
  };
}

/** Everything a loadout leaves out. */
export const ALL_BUILDINGS = [...BUILD_ORDER];
