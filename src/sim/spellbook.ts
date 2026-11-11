/**
 * sim/spellbook.ts — the charge model (see the comment above SpellDef in
 * catalog.ts, which is binding).
 *
 * Each tribe holds one SpellSlot per spell in the catalog. Mana income is
 * computed per tick from the tribe's people, then poured evenly into every
 * slot that is known, switched to charge and not full. A slot that has
 * soaked `chargeMana` gains a charge. Casting spends a gifted cast first,
 * else one charge. There is no mana pool to spend from.
 */

import { MANA_BASE_RATE, MANA_PER_FOLLOWER, MANA_PER_RESIDENT } from '../config';
import { ECONOMY, SPELLS, spellDef, SpellId, SpellState } from './catalog';

export interface SpellSlot {
  /** Mana soaked toward the next charge (0..chargeMana). */
  mana: number;
  charges: number;
  charging: boolean;
  /** Free casts from gift monuments; spent before charges; usable even if unknown. */
  gifted: number;
  /** Scenario/boon extras: charges above the catalog max, and a chargeMana multiplier. */
  bonus: number;
  cost: number;
}

/** This slot's max charges and mana per charge (catalog numbers + scenario extras). */
export const slotMax = (id: SpellId, slot: SpellSlot): number => spellDef(id).maxCharges + slot.bonus;
export const slotCost = (id: SpellId, slot: SpellSlot): number => spellDef(id).chargeMana * slot.cost;

export type SpellBook = Record<SpellId, SpellSlot>;

export function newSpellBook(): SpellBook {
  const book = {} as SpellBook;
  for (const s of SPELLS) book[s.id] = { mana: 0, charges: 0, charging: true, gifted: 0, bonus: 0, cost: 1 };
  return book;
}

/**
 * The opening is generous: for the first two minutes every tribe's income
 * is multiplied by `boost`, easing back to normal by `fadeEnd` seconds.
 * A tiny tribe can't feed its spells yet, and the first minutes are when
 * a leader most needs something to do. Mid-game is untouched.
 */
export const OPENING_MANA = { boost: 1.8, fadeStart: 120, fadeEnd: 300 };

export function openingBoost(elapsed: number): number {
  const { boost, fadeStart, fadeEnd } = OPENING_MANA;
  if (elapsed <= fadeStart) return boost;
  if (elapsed >= fadeEnd) return 1;
  const t = (elapsed - fadeStart) / (fadeEnd - fadeStart);
  return boost + (1 - boost) * t * t * (3 - 2 * t);
}

/** Raw income per second from a tribe's people (`elapsed` = scenario seconds, for the opening boost). */
export function manaIncome(followers: number, housed: number, praying: number, elapsed = Infinity): number {
  return (MANA_BASE_RATE + followers * MANA_PER_FOLLOWER + housed * MANA_PER_RESIDENT) *
    (1 + praying * ECONOMY.shrinePrayerBonus) * openingBoost(elapsed);
}

/** Slots currently soaking up mana. */
export function activeSlots(book: SpellBook, known: Set<SpellId>): SpellId[] {
  const out: SpellId[] = [];
  for (const s of SPELLS) {
    const slot = book[s.id];
    if (known.has(s.id) && slot.charging && slot.charges < slotMax(s.id, slot)) out.push(s.id);
  }
  return out;
}

/**
 * Pour `income * dt` evenly into the active slots. Returns the mana rate
 * actually flowing (0 when nothing is charging — income with nowhere to go
 * is lost, which is the price of switching everything off).
 */
export function pourMana(book: SpellBook, known: Set<SpellId>, income: number, dt: number): number {
  const active = activeSlots(book, known);
  if (active.length === 0) return 0;
  const share = (income * dt) / active.length;
  for (const id of active) {
    const slot = book[id];
    const max = slotMax(id, slot);
    const cost = slotCost(id, slot);
    slot.mana += share;
    while (slot.mana >= cost && slot.charges < max) {
      slot.mana -= cost;
      slot.charges++;
    }
    if (slot.charges >= max) slot.mana = 0;
  }
  return income;
}

export function slotState(book: SpellBook, known: Set<SpellId>, id: SpellId, income: number): SpellState {
  const slot = book[id];
  const max = slotMax(id, slot);
  const cost = slotCost(id, slot);
  const isKnown = known.has(id);
  const full = slot.charges >= max;
  const active = activeSlots(book, known);
  const soaking = isKnown && slot.charging && !full;
  const share = soaking && active.length > 0 ? income / active.length : 0;
  return {
    known: isKnown,
    charges: slot.charges,
    max,
    progress: full ? 0 : slot.mana / cost,
    charging: slot.charging,
    gifted: slot.gifted,
    eta: share > 0 ? (cost - slot.mana) / share : Infinity,
    chargeMana: cost,
    bonusCharges: slot.bonus,
  };
}

/** Can this tribe cast `id` right now (ignoring range/target)? */
export function hasCast(book: SpellBook, known: Set<SpellId>, id: SpellId): boolean {
  const slot = book[id];
  return slot.gifted > 0 || (known.has(id) && slot.charges > 0);
}

/** Spend one cast: a gift first, else a charge. Returns false if neither. */
export function spendCast(book: SpellBook, known: Set<SpellId>, id: SpellId): boolean {
  const slot = book[id];
  if (slot.gifted > 0) {
    slot.gifted--;
    return true;
  }
  if (known.has(id) && slot.charges > 0) {
    slot.charges--;
    return true;
  }
  return false;
}
