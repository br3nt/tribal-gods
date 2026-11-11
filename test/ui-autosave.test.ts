import { describe, expect, it } from 'vitest';
import { savedTally, SavedGame } from '../src/ui/autosave';

const game = (tally?: unknown) => ({ v: 1, kind: 'skirmish', label: 'x', world: {} as SavedGame['world'], ...(tally !== undefined ? { tally } : {}) }) as SavedGame;

describe('saved game-over tally', () => {
  it('comes back from the save so Continue does not undercount', () => {
    expect(savedTally(game({ peakPopulation: 41, spellsCast: 12 }))).toEqual({ peakPopulation: 41, spellsCast: 12 });
  });
  it('an old save without one, or a damaged one, still loads (just no tally)', () => {
    expect(savedTally(game())).toBeNull();
    expect(savedTally(game({ peakPopulation: 'lots', spellsCast: 1 }))).toBeNull();
    expect(savedTally(game({ peakPopulation: -1, spellsCast: 1 }))).toBeNull();
  });
});
