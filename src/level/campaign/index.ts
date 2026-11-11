/**
 * level/campaign/index.ts — the campaign, in order.
 *
 * Ten chapters of one journey (see common.ts for the fiction). Each file
 * is one scenario; this list is the order the campaign map shows and the
 * order progress unlocks them in.
 *
 *   1 Landfall               settle and grow, no enemy
 *   2 The Speaking Stones    first stones, first raids
 *   3 Smoke Over the Ridge   first rival, War Lodge, a pass
 *   4 The Scattered Shallows island start, Causeway as a scarce gift
 *   5 Vigil at the Caldera   charge a great spell while waves come
 *   6 The Barefoot Road      no buildings, leader must survive
 *   7 Two Banners            two allied rivals, Chanters
 *   8 The Firemount Race     race for a stone, then a deadline
 *   9 When the Tide Came     the land sinks, hold the summit
 *  10 The Crown              three rivals, last tribe standing
 */

import { CampaignScenario } from './common';
import { scenario as c01 } from './c01-landfall';
import { scenario as c02 } from './c02-speaking-stones';
import { scenario as c03 } from './c03-smoke-over-the-ridge';
import { scenario as c04 } from './c04-scattered-shallows';
import { scenario as c05 } from './c05-vigil-at-the-caldera';
import { scenario as c06 } from './c06-barefoot-road';
import { scenario as c07 } from './c07-two-banners';
import { scenario as c08 } from './c08-firemount-race';
import { scenario as c09 } from './c09-when-the-tide-came';
import { scenario as c10 } from './c10-the-crown';

export type { CampaignScenario } from './common';

export const CAMPAIGN: CampaignScenario[] = [c01, c02, c03, c04, c05, c06, c07, c08, c09, c10].sort((a, b) => a.chapter - b.chapter);

export function campaignScenario(id: string): CampaignScenario | undefined {
  return CAMPAIGN.find((s) => s.id === id);
}
