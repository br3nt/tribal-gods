/**
 * ui/alerts.ts — the alert feed (right edge) and the game's running tally.
 *
 * A few times a second (sim time, so pause and speed are respected) it
 * snapshots the player's side of the world and asks ui/alert-rules.ts what
 * changed: under attack, leader fallen/returned, spell learned or lent,
 * dwelling grew, building finished/burning/lost, objective complete. Each
 * alert becomes a card for ~9 seconds; cards with a place in the world can
 * be clicked to jump there, and ping the minimap.
 *
 * The same snapshots feed the end-of-game numbers: peak population and
 * spells cast.
 */

import { alertSound } from '../core/audio';
import { SPELLS } from '../sim/catalog';
import type { World } from '../sim/world-state';
import { Alert, AlertMemory, castsBetween, deriveAlerts, ritualBrokenAlert, Snapshot } from './alert-rules';
import { UiContext } from './context';
import { css, escapeHtml, h } from './dom';
import { icon, UiIconName } from './icons';
import { ritualAt, tribeLabelOf } from './stones';

css('alerts', `
.al { width: 16.5rem; display: flex; flex-direction: column; gap: 0.35rem; align-items: stretch; }
/* A strip of bark with a stripe of paint down its edge, hung on a cord. */
.al-card { position: relative; display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.55rem 0.4rem 0.75rem; text-align: left; cursor: default;
  border: 0; border-radius: 0.2rem 0.45rem 0.3rem 0.5rem / 0.4rem 0.25rem 0.5rem 0.3rem;
  background: linear-gradient(90deg, var(--paint) 0 0.3rem, rgba(0,0,0,0.5) 0.3rem 0.38rem, transparent 0.38rem), linear-gradient(rgba(30,19,11,0.5), rgba(30,19,11,0.62)), var(--tex-bark) 0 0 / 11rem;
  box-shadow: 0 0 0 1px #120a04, inset 0 1px 0 rgba(255,226,180,0.15), 0 3px 8px rgba(0,0,0,0.45);
  font: 700 var(--t-sm)/1.25 var(--font); color: var(--bone); text-shadow: 0 1px 0 rgba(0,0,0,0.8);
  animation: al-in 260ms var(--ease); transition: opacity 600ms var(--ease); --paint: var(--woad); }
.al-card.bad { --paint: var(--red-ochre); }
.al-card.good { --paint: #6aa843; }
.al-card.info { --paint: #3d8fa8; }
.al-card.jump { cursor: pointer; }
.al-card.jump:hover { filter: brightness(1.15); }
.al-card .i { flex: none; width: 1.55rem; height: 1.55rem; border-radius: 50%; display: grid; place-items: center; background: rgba(0,0,0,0.35); box-shadow: inset 0 0 0 1px rgba(255,226,180,0.15); }
.al-card.bad .i { color: #ff9a7c; }
.al-card.good .i { color: var(--leaf); }
.al-card.info .i { color: var(--spirit); }
.al-card .go-hint { margin-left: auto; color: var(--bone-3); display: inline-flex; }
.al-card.fade { opacity: 0; }
@keyframes al-in { from { opacity: 0; transform: translateX(1rem) rotate(1deg); } to { opacity: 1; transform: none; } }
`);

const ICONS: Record<Alert['kind'], UiIconName> = {
  attack: 'attack', leaderDown: 'skull', leaderBack: 'leader', learned: 'book', gift: 'gift',
  grew: 'housed', burning: 'fire', built: 'hammer', lost: 'demolish', objective: 'objective', ritual: 'worship', ritualBroken: 'stone',
};

export interface GameTally {
  peakPopulation: number;
  spellsCast: number;
}

export function snapshot(w: World): Snapshot {
  const t = w.tribes.player;
  const casts: Snapshot['casts'] = {};
  const gifted: Snapshot['gifted'] = {};
  for (const s of SPELLS) {
    const st = w.spellState('player', s.id);
    casts[s.id] = st.charges + st.gifted;
    gifted[s.id] = st.gifted;
  }
  const units: Snapshot['units'] = new Map();
  for (const u of w.units) if (u.tribe === 'player') units.set(u.id, { hp: u.hp, x: u.x, z: u.z });
  const buildings: Snapshot['buildings'] = new Map();
  for (const b of w.buildings) {
    if (b.tribe === 'player') {
      buildings.set(b.id, { kind: b.kind, hp: b.hp, tier: b.tier, burning: b.burning > 0, done: b.progress >= 1, x: b.x, z: b.z });
    }
  }
  return {
    t: w.elapsed,
    leaderAlive: !!w.leaderOf('player'),
    known: t ? [...t.known] : [],
    casts,
    gifted,
    units,
    buildings,
    objectives: w.objectives.map((o) => ({ text: o.text, done: o.done })),
    population: w.tribePopulation('player'),
    rituals: w.monuments.flatMap((m, index) => {
      const r = ritualAt(w, index);
      return r && r.communing ? [{ index, tribe: r.tribe, who: tribeLabelOf(w, r.tribe), spell: m.spell, x: m.x, z: m.z }] : [];
    }),
  };
}

export class AlertFeed {
  readonly el: HTMLDivElement;
  private prev: Snapshot | null = null;
  private mem: AlertMemory = { attacks: [] };
  readonly tally: GameTally = { peakPopulation: 0, spellsCast: 0 };

  constructor(private readonly ctx: UiContext) {
    this.el = h('div.al');
  }

  /** New scenario: start the diff and the tally over. */
  reset(): void {
    this.prev = null;
    this.mem = { attacks: [] };
    this.tally.peakPopulation = 0;
    this.tally.spellsCast = 0;
    this.el.innerHTML = '';
  }

  update(): void {
    const w = this.ctx.world;
    // Events live for one frame (render/effects.ts drains them after the UI), so read them every frame.
    let rescued = null as { n: number; x: number; z: number } | null;
    for (const e of w.events) {
      const stone = w.monuments.find((m) => Math.abs(m.x - e.x) < 3 && Math.abs(m.z - e.z) < 3);
      const a = ritualBrokenAlert(e, stone?.spell ?? null);
      if (a) {
        this.push(a);
        alertSound('attack');
      } else if (e.type === 'landing' && e.tribe && e.tribe !== 'player' && e.tribe !== 'wild' && w.hostile('player', e.tribe as never)) {
        this.push({ kind: 'attack', text: `${(e.magnitude ?? 0) > 1 ? `${e.magnitude} raiders` : 'A raider'} came ashore`, tone: 'bad', x: e.x, z: e.z });
        alertSound('attack');
      } else if (e.type === 'rescued' && e.tribe === 'player') {
        rescued = { n: (rescued?.n ?? 0) + 1, x: e.x, z: e.z };
      }
    }
    if (rescued) {
      this.push({ kind: 'leaderBack', text: rescued.n > 1 ? `${rescued.n} of your stranded people are home` : 'One of your stranded people is home', tone: 'good', x: rescued.x, z: rescued.z });
      alertSound('good');
    }
    if (this.prev && w.elapsed < this.prev.t) this.reset(); // world was reset under us
    if (this.prev && w.elapsed - this.prev.t < 0.25) return;
    const next = snapshot(w);
    this.tally.peakPopulation = Math.max(this.tally.peakPopulation, next.population);
    if (this.prev) {
      this.tally.spellsCast += castsBetween(this.prev, next);
      const fresh = deriveAlerts(this.prev, next, this.mem);
      for (const a of fresh) this.push(a);
      // One sound per batch: the most urgent.
      if (fresh.length) alertSound(fresh.some((a) => a.kind === 'attack' || a.kind === 'leaderDown' || a.kind === 'ritual' || a.kind === 'ritualBroken') ? 'attack' : fresh.some((a) => a.tone === 'good') ? 'good' : 'info');
    }
    this.prev = next;
  }

  push(a: Alert): void {
    const hasPlace = a.x !== undefined && a.z !== undefined;
    const card = h(hasPlace ? 'button' : 'div', {
      class: `al-card tg-hit ${a.tone}${hasPlace ? ' jump' : ''}`,
      html: `<span class="i">${icon(ICONS[a.kind], 15)}</span><span>${escapeHtml(a.text)}</span>${hasPlace ? `<span class="go-hint">${icon('eye', 14)}</span>` : ''}`,
    });
    if (hasPlace) {
      card.setAttribute('type', 'button');
      card.addEventListener('click', () => this.ctx.actions.centreOn(a.x!, a.z!));
      this.ctx.actions.ping(a.x!, a.z!, a.tone);
    }
    this.el.prepend(card);
    while (this.el.children.length > 5) this.el.lastElementChild!.remove();
    setTimeout(() => card.classList.add('fade'), 8500);
    setTimeout(() => card.remove(), 9200);
  }
}
