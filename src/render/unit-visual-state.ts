/**
 * render/unit-visual-state.ts — what a unit LOOKS like it is doing, decided
 * from sim state alone. Pure (no three.js, no DOM) so it is unit-tested.
 *
 * The unit renderer asks two questions every frame:
 *   pickClip()   — which animation clip (and, for strikes, which phase);
 *   statusTint() — which shared material variant (Stone Ward, Warsong).
 * and one question per frame of sim events:
 *   cheerersFor() — who should throw their arms up at good news.
 *
 * State → look:
 *   lifted > 0           tumble (caught in a cyclone; the renderer also lifts and spins the figure)
 *   pacified > 0         slack: arms down, head bowed, no strikes (a hostile chant holds it)
 *   chanter, task chant  chant (it only keeps the task while it has listeners)
 *   shrine garrison / worship task   pray
 *   wardTime > 0         stone sheen     warsongTime > 0   red-gold tint (and movers run)
 *   joins set            STRANDED kin: drawn in the colours of the tribe they will
 *                        join (figureTribe), beckoning while they wait
 *   guardOf set, stone asleep (ctx.dormant)   a guardian kneels, still as the stone
 *
 * And for the building renderer: hasHomeCircle() — a war band that has
 * never raised a building (raiders) gets no home stone circle.
 */

import { Tribe, UNITS } from '../sim/catalog';
import type { GameEvent, Unit } from '../sim/world-state';
import type { ClipName } from './figure-animator';

export type VisualUnit = Pick<
  Unit,
  | 'id' | 'kind' | 'tribe' | 'x' | 'z' | 'state' | 'task' | 'carrying' | 'castSpell' | 'hidden' | 'attackCooldown'
  | 'wardTime' | 'warsongTime' | 'lifted' | 'pacified' | 'chantBy'
> & Partial<Pick<Unit, 'joins' | 'guardOf'>>;

/** Whose colours a figure wears: stranded kin already dress as the tribe they'll join. */
export function figureTribe(u: Pick<Unit, 'tribe'> & Partial<Pick<Unit, 'joins'>>): Tribe {
  return u.tribe === 'wild' && u.joins ? u.joins : u.tribe;
}

/**
 * Does this tribe get a home stone circle? An explicit `homeless` flag
 * (if the sim ever sets one) decides; otherwise a war band (personality
 * builds: false) that has no buildings and never completed one has no home
 * to mark — raiders on a beach. Settling tribes keep theirs from the start.
 */
export function hasHomeCircle(
  t: { homeless?: boolean; personality?: { builds?: boolean }; everBuilt?: ReadonlySet<string> },
  buildingsNow: number,
): boolean {
  if (t.homeless !== undefined) return !t.homeless;
  if (t.personality?.builds !== false) return true;
  return buildingsNow > 0 || (t.everBuilt?.size ?? 0) > 0;
}

export type StatusTint = 'none' | 'ward' | 'warsong' | 'both';

export function statusTint(u: Pick<Unit, 'wardTime' | 'warsongTime'>): StatusTint {
  const ward = u.wardTime > 0;
  const song = u.warsongTime > 0;
  return ward && song ? 'both' : ward ? 'ward' : song ? 'warsong' : 'none';
}

export interface ClipContext {
  /** Kind of the building this figure is shown in (tower lookout, shrine worshipper), else null. */
  garrisonKind: string | null;
  inWater: boolean;
  /** Measured ground speed, world units/s. */
  speed: number;
  /** Speed above which a mover runs rather than walks. */
  runSpeed: number;
  /** A nearby event (a recruit trained, an objective met) says cheer. */
  cheering: boolean;
  /** world.gameOver. */
  winner: 'victory' | 'defeat' | null;
  /** A guardian whose stone sleeps (monument.guardsAwake false): it kneels dormant. */
  dormant?: boolean;
}

export interface ClipChoice {
  clip: ClipName;
  /** Strike phase 0..1 synced to the sim cooldown, when fighting. */
  phase?: number;
}

const _choice: ClipChoice = { clip: 'idle' };

/** Did this tribe's side win? ('victory' = the player won, 'defeat' = the rivals did.) */
export function victoryCheer(gameOver: 'victory' | 'defeat' | null, tribe: string): boolean {
  if (gameOver === 'victory') return tribe === 'player';
  if (gameOver === 'defeat') return tribe !== 'player' && tribe !== 'wild';
  return false;
}

/** Map sim state → clip. Returns a shared object: copy what you keep. */
export function pickClip(u: VisualUnit, c: ClipContext): ClipChoice {
  const out = _choice;
  out.phase = undefined;
  const kind = u.kind;
  const task = u.task;
  let clip: ClipName = 'idle';
  if (c.garrisonKind === 'shrine') clip = 'pray';
  else if (c.garrisonKind === 'tower') clip = 'idle';
  else if (c.inWater) clip = 'drown';
  else if (u.lifted > 0) clip = 'tumble';
  else if (c.dormant && u.state !== 'fighting' && u.state !== 'moving') clip = 'dormant';
  else if (u.pacified > 0 && u.state !== 'moving') clip = 'slack';
  else if (u.state === 'fighting' || (task === 'attack' && u.state !== 'moving')) {
    if (kind === 'chanter') clip = 'chant';
    else if (kind === 'firewarrior') clip = 'throw';
    else if (kind === 'shaman' || kind === 'wildman') clip = 'idle';
    else clip = 'attack';
    const cool = UNITS[kind]?.cooldown ?? 1.2;
    if (cool > 0 && clip !== 'chant' && clip !== 'idle') {
      // phase 0 at the sim's strike moment → our clip's impact frame
      const impact = clip === 'throw' ? 0.6 : 0.5;
      const k = Math.min(1, Math.max(0, u.attackCooldown / cool));
      out.phase = (1 - k + impact) % 1;
    }
  } else if (u.state === 'working') {
    if (u.castSpell) clip = 'cast';
    else if (task === 'chop') clip = 'chop';
    else if (task === 'worship') clip = 'pray';
    else if (task === 'chant' || kind === 'chanter') clip = 'chant';
    else clip = 'build';
  } else if (u.state === 'moving') {
    if (u.carrying) clip = 'carry';
    else clip = c.speed > c.runSpeed || u.warsongTime > 0 ? 'run' : 'walk';
  } else {
    if (u.joins && u.tribe === 'wild') clip = 'beckon';
    else if (task === 'worship') clip = 'pray';
    else if (kind === 'chanter' && task === 'chant') clip = 'chant';
    else if (c.cheering || victoryCheer(c.winner, u.tribe)) clip = 'cheer';
  }
  // still moving visibly but the sim says idle (end of path) → let the blend handle it
  if (clip === 'idle' && c.speed > 1.2 && !c.garrisonKind) clip = 'walk';
  out.clip = clip;
  return out;
}

/** How far good news carries (tiles). */
const CHEER_RADIUS = { trained: 6, objectiveDone: 12, rescued: 7 } as const;

/**
 * Units that should cheer at these events: idle, visible villagers of the
 * tribe the news is for, near where it happened. 'trained' carries the
 * training building's id in `magnitude`; 'objectiveDone' is the player's
 * and lands on the player's home. (Wrap is ignored: good news is local.)
 */
export function cheerersFor(
  events: readonly GameEvent[],
  units: readonly VisualUnit[],
  buildings: readonly { id: number; tribe: string }[],
): number[] {
  const ids: number[] = [];
  for (const ev of events) {
    let tribe: string | undefined;
    let r = 0;
    if (ev.type === 'trained') {
      tribe = buildings.find((b) => b.id === ev.magnitude)?.tribe;
      r = CHEER_RADIUS.trained;
    } else if (ev.type === 'objectiveDone') {
      tribe = 'player';
      r = CHEER_RADIUS.objectiveDone;
    } else if (ev.type === 'rescued') {
      tribe = ev.tribe;
      r = CHEER_RADIUS.rescued;
    }
    if (!tribe) continue;
    for (const u of units) {
      if (u.tribe !== tribe || u.hidden || u.state !== 'idle') continue;
      const dx = u.x - ev.x;
      const dz = u.z - ev.z;
      if (dx * dx + dz * dz <= r * r && !ids.includes(u.id)) ids.push(u.id);
    }
  }
  return ids;
}
