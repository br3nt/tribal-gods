/**
 * sim/rules.ts — the default ScenarioRules a random skirmish (or a legacy
 * level with no rules) plays under: you against 1–3 AI gods, starter
 * spells, every building, destroy every rival tribe.
 */

import { BUILD_ORDER, ScenarioRules, SPELLS, TRIBE_IDS, TribeId } from './catalog';

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
      { objective: { type: 'destroyAll' }, text: n === 1 ? 'Destroy the rival tribe' : 'Destroy every rival tribe' },
    ],
    fail: [{ type: 'tribeDestroyed' }],
    briefing: {
      title: 'Skirmish',
      body: n === 1 ? 'One planet, two gods. Only one tribe walks away.' : `One planet, ${n + 1} gods. Only one tribe walks away.`,
      tips: [
        'Dwellings breed villagers and feed your spells.',
        'Train fighters at the lodges; garrison a watchtower to hold a hill.',
        'Leaders learn new spells at the standing stones.',
      ],
    },
  };
}

/** Everything a loadout leaves out. */
export const ALL_BUILDINGS = [...BUILD_ORDER];
