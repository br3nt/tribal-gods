/**
 * ui/selection-panel.ts — everything about what you've selected.
 *
 *   one person    portrait, name, health, what they're doing, buffs, stats
 *   many people   a grid of kinds with counts (click a kind to narrow to it,
 *                 shift-click to drop it) and the group's total health
 *   a building    name (dwellings by tier), health, construction, fire;
 *                 dwellings: residents/capacity and growth to the next tier;
 *                 lodges: the training queue with +1/+5/cancel, progress,
 *                 cost, rally point; tower/shrine: who's inside + eject;
 *                 demolish (asks twice)
 *   a stone       what it teaches or lends, and whether it's free now
 *   theirs        the same, read-only
 *
 * The panel is rebuilt only when its STRUCTURE changes (a signature of the
 * selection and the shape of what's shown); live numbers (health, timers,
 * progress) are patched into `data-k` slots a few times a second, so the
 * buttons under your cursor are never torn down mid-click.
 */

import { CIVS } from '../config';
import { BUILDINGS, DWELLING_TIERS, ECONOMY, spellDef, TribeId, UNITS, UnitKind } from '../sim/catalog';
import type { Building, Unit } from '../sim/world-state';
import { UiContext } from './context';
import { css, escapeHtml, h } from './dom';
import { activityText, buildingName, fmtEta } from './format';
import { labelFor } from './hotkeys';
import { buildingIcon, icon, spellIcon, unitIcon } from './icons';
import { tribeCss } from './orders';
import { groupByKind } from './selection';
import { hideTip, tip } from './tooltip';

css('selection-panel', `
.sp { width: auto; min-width: 19rem; max-width: min(27rem, 100%); min-height: 7.5rem; padding: 0.75rem; box-sizing: border-box; display: flex; flex-direction: column; gap: 0.5rem; }
.sp-head { display: flex; gap: 0.75rem; align-items: center; }
.sp-portrait { flex: none; width: 3.5rem; height: 3.5rem; border-radius: 50%; display: grid; place-items: center; color: var(--text);
  background: radial-gradient(circle at 50% 30%, rgba(255,255,255,0.16), rgba(0,0,0,0.35)); box-shadow: inset 0 0 0 2px var(--tc, var(--rim-strong)); }
.sp-title { flex: 1; min-width: 0; }
.sp-name { font-size: var(--t-lg); font-weight: 650; display: flex; align-items: center; gap: 0.4rem; }
.sp-sub { font-size: var(--t-xs); color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em; display: flex; align-items: center; gap: 0.35rem; }
.sp-sub .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--tc); }
.sp-act { font-size: var(--t-sm); color: var(--text-2); margin-top: 0.15rem; }
.sp-hp { display: flex; align-items: center; gap: 0.5rem; font-size: var(--t-xs); color: var(--text-2); }
.sp-hp .bar { flex: 1; height: 0.45rem; }
.sp-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: var(--t-sm); color: var(--text-2); }
.sp-row .lbl { color: var(--text-3); font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.08em; min-width: 4.5rem; }
.sp-chip { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.15rem 0.45rem; border-radius: var(--r-pill); background: var(--ink-2); border: 1px solid var(--rim); font-size: var(--t-xs); font-weight: 600; }
.sp-chip.ward { color: #c9d4e8; } .sp-chip.song { color: var(--gold); } .sp-chip.bad { color: var(--bad); border-color: rgba(255,106,92,0.5); background: var(--bad-soft); }
.sp-stats { display: flex; gap: 0.9rem; font-size: var(--t-xs); color: var(--text-3); }
.sp-stats b { color: var(--text); font-weight: 600; }
.sp-kinds { display: grid; grid-template-columns: repeat(auto-fill, minmax(5.4rem, 1fr)); gap: 0.375rem; }
.sp-kind { display: flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.5rem; border-radius: var(--r2); border: 1px solid var(--rim); background: var(--ink-2); color: var(--text); cursor: pointer; font: inherit; text-align: left; }
.sp-kind:hover { border-color: var(--rim-strong); background: var(--ink-3); }
.sp-kind .n { font-size: var(--t-lg); font-weight: 700; }
.sp-kind .k { font-size: var(--t-xs); color: var(--text-3); line-height: 1.1; }
.sp-pips { display: flex; gap: 0.2rem; }
.sp-pips i { width: 0.6rem; height: 0.6rem; border-radius: 0.15rem; background: rgba(255,255,255,0.12); }
.sp-pips i.on { background: var(--good); }
.sp-pips i.q { background: var(--mana); }
.sp-queue { display: flex; align-items: center; gap: 0.375rem; }
.sp-queue .tg-btn { min-height: 1.75rem; padding: 0 0.55rem; }
.sp-train { flex: 1; display: flex; flex-direction: column; gap: 0.2rem; font-size: var(--t-xs); color: var(--text-2); }
.sp-actions { display: flex; gap: 0.375rem; flex-wrap: wrap; margin-top: auto; }
.sp-actions .tg-btn { min-height: 1.75rem; }
.sp-warn { display: flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.5rem; border-radius: var(--r1); background: var(--bad-soft); color: #ffd0ca; font-size: var(--t-sm); font-weight: 600; }
.sp-inside { display: flex; gap: 0.25rem; flex-wrap: wrap; }
.sp-inside span { width: 1.75rem; height: 1.75rem; border-radius: 50%; display: grid; place-items: center; background: var(--ink-2); box-shadow: inset 0 0 0 1px var(--rim); }
.sp-inside span.empty { opacity: 0.35; }
.sp-spell { display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.6rem; border-radius: var(--r2); background: var(--mana-soft); color: var(--mana); }
.sp-spell b { color: var(--text); }
.sp-note { font-size: var(--t-sm); color: var(--text-2); line-height: 1.4; }
.sp-empty { color: var(--text-3); font-size: var(--t-sm); display: flex; align-items: center; gap: 0.5rem; }
`);

const tribeLabel = (ctx: UiContext, t: string): string => {
  if (t === 'player') return 'Your tribe';
  if (t === 'wild') return 'No tribe';
  const civ = ctx.world.tribes[t as TribeId]?.civ;
  return `${civ ? CIVS[civ].name : t} · ${t}`;
};

export class SelectionPanel {
  readonly el: HTMLDivElement;
  private sig = '';
  private confirmDemolish = 0;
  /** Set by the Rally button: the next ground click sets this building's rally point. */
  rallyPick: number | null = null;

  constructor(private readonly ctx: UiContext) {
    this.el = h('div.sp.tg-panel');
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  // ---------------------------------------------------------------------------

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!t) return;
    const w = this.ctx.world;
    const sel = this.ctx.selection;
    const a = t.dataset.a!;
    const bid = sel.building;
    switch (a) {
      case 'kind': {
        const kind = t.dataset.kind as UnitKind;
        const ids = [...sel.units].filter((id) => w.unitById(id)?.kind === kind);
        if (e.shiftKey) sel.setUnits([...sel.units].filter((id) => !ids.includes(id)));
        else sel.setUnits(ids);
        hideTip();
        break;
      }
      case 'q':
        if (bid !== null) w.queueTraining(bid, Number(t.dataset.n));
        break;
      case 'eject':
        if (bid !== null) w.ejectGarrison(bid);
        break;
      case 'rally':
        this.rallyPick = bid;
        break;
      case 'demolish':
        if (bid === null) break;
        if (performance.now() < this.confirmDemolish) {
          w.demolish(bid);
          sel.clear();
          this.confirmDemolish = 0;
        } else {
          this.confirmDemolish = performance.now() + 3000;
          this.sig = ''; // re-render to show the confirm state
        }
        break;
      case 'commune': {
        const leader = w.leaderOf('player');
        if (leader && sel.monument !== null) w.orderWorship([leader.id], sel.monument);
        break;
      }
      case 'focus': {
        const x = Number(t.dataset.x), z = Number(t.dataset.z);
        this.ctx.actions.centreOn(x, z);
        break;
      }
    }
    this.update();
  }

  /** Called by the demolish hotkey: same two-step confirm as the button. */
  demolishSelected(): void {
    const btn = this.el.querySelector<HTMLElement>('[data-a="demolish"]');
    btn?.click();
  }

  // ---------------------------------------------------------------------------

  update(): void {
    const w = this.ctx.world;
    const sel = this.ctx.selection;
    sel.prune((id) => !!w.unitById(id), (id) => !!w.getBuilding(id));
    if (this.rallyPick !== null && sel.building !== this.rallyPick) this.rallyPick = null;

    let sig: string;
    let render: () => string;
    const units = [...sel.units].map((id) => w.unitById(id)).filter((u): u is Unit => !!u);
    if (sel.building !== null) {
      const b = w.getBuilding(sel.building)!;
      const trains = BUILDINGS[b.kind].trains;
      sig = `b${b.id}|${b.tier}|${b.progress >= 1}|${b.burning > 0}|${b.garrison.join(',')}|${trains ? b.queue : ''}|${performance.now() < this.confirmDemolish}|${this.rallyPick}`;
      render = () => this.renderBuilding(b);
    } else if (sel.monument !== null) {
      const m = w.monuments[sel.monument];
      sig = `m${sel.monument}|${w.monumentAvailable(m)}|${m.claimedBy}`;
      render = () => this.renderMonument(sel.monument!);
    } else if (units.length === 1) {
      const u = units[0];
      sig = `u${u.id}|${u.kind}|${u.wardTime > 0}|${u.warsongTime > 0}`;
      render = () => this.renderUnit(u);
    } else if (units.length > 1) {
      const groups = groupByKind(units);
      sig = `g${sel.version}|${groups.map((g) => `${g.kind}${g.ids.length}`).join(',')}`;
      render = () => this.renderGroup(units);
    } else {
      sig = 'none';
      render = () => '';
    }
    if (sig !== this.sig) {
      this.sig = sig;
      this.el.innerHTML = render();
      this.el.hidden = sig === 'none';
      for (const k of this.el.querySelectorAll<HTMLElement>('[data-kind]')) {
        const kind = k.dataset.kind as UnitKind;
        tip(k, () => `<h4>${UNITS[kind].name}</h4><p>${escapeHtml(UNITS[kind].blurb)}</p><p class="hint">Click: select only these. Shift-click: drop them.</p>`);
      }
      for (const b of this.el.querySelectorAll<HTMLElement>('[data-tip]')) tip(b, () => b.dataset.tip!);
    }
    this.patch(units);
  }

  /** Live numbers into data-k slots. */
  private patch(units: Unit[]): void {
    const w = this.ctx.world;
    const set = (k: string, text: string) => {
      const el = this.el.querySelector(`[data-k="${k}"]`);
      if (el && el.textContent !== text) el.textContent = text;
    };
    const bar = (k: string, frac: number) => {
      const el = this.el.querySelector<HTMLElement>(`[data-k="${k}"]`);
      if (el) el.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    };
    const sel = this.ctx.selection;
    if (sel.building !== null) {
      const b = w.getBuilding(sel.building);
      if (!b) return;
      bar('hp', b.progress < 1 ? b.progress : b.hp / b.maxHp);
      set('hpt', b.progress < 1 ? `${Math.floor(b.progress * 100)}% built` : `${Math.ceil(b.hp)} / ${b.maxHp}`);
      if (b.kind === 'hut') {
        set('res', `${b.residents} / ${w.dwellingCapacity(b)}`);
        const next = DWELLING_TIERS[b.tier + 1];
        if (next) {
          const full = b.residents >= DWELLING_TIERS[b.tier].capacity;
          bar('grow', b.fullTime / next.growSeconds);
          const wood = w.tribes[b.tribe]?.wood ?? 0;
          set('growt', !full
            ? `Grows once full`
            : b.fullTime >= next.growSeconds && wood < next.growWood
              ? `Needs ${next.growWood - wood} more wood to grow`
              : `Grows in ${fmtEta(next.growSeconds - b.fullTime)}`);
        }
      }
      const trains = BUILDINGS[b.kind].trains;
      if (trains) {
        const inside = b.trainee >= 0 && w.unitById(b.trainee)?.garrison === b.id;
        const def = UNITS[trains];
        bar('train', inside ? 1 - b.trainTime / def.trainSeconds : 0);
        const wood = w.tribes[b.tribe]?.wood ?? 0;
        set('traint', b.queue === 0
          ? 'Queue empty'
          : inside
            ? `Training a ${def.name} · ${fmtEta(b.trainTime)}`
            : b.trainee >= 0
              ? 'A villager is on the way'
              : wood < def.trainWood
                ? `Needs ${def.trainWood - wood} more wood`
                : 'Waiting for an idle villager');
        set('qn', `${b.queue}`);
      }
    } else if (sel.monument !== null) {
      const m = w.monuments[sel.monument];
      if (m) set('sleep', m.sleep > 0 ? `Sleeping — wakes in ${fmtEta(m.sleep)}` : '');
    } else if (units.length === 1) {
      const u = units[0];
      bar('hp', u.hp / u.maxHp);
      set('hpt', `${Math.ceil(u.hp)} / ${u.maxHp}`);
      const inside = u.garrison >= 0 ? w.getBuilding(u.garrison)?.kind ?? null : null;
      set('act', activityText(u, inside));
      set('ward', u.wardTime > 0 ? `${Math.ceil(u.wardTime)}s` : '');
      set('song', u.warsongTime > 0 ? `${Math.ceil(u.warsongTime)}s` : '');
    } else if (units.length > 1) {
      const hp = units.reduce((s, u) => s + u.hp, 0);
      const max = units.reduce((s, u) => s + u.maxHp, 0);
      bar('hp', hp / max);
      set('hpt', `${Math.round((hp / max) * 100)}%`);
    }
  }

  // ---------------------------------------------------------------------------

  private head(iconHtml: string, tc: string, name: string, sub: string, extra = ''): string {
    return `<div class="sp-head"><div class="sp-portrait" style="--tc:${tc}">${iconHtml}</div>` +
      `<div class="sp-title"><div class="sp-name">${escapeHtml(name)}</div>` +
      `<div class="sp-sub"><span class="dot" style="--tc:${tc}"></span>${escapeHtml(sub)}</div>${extra}</div></div>`;
  }

  private hpRow(): string {
    return `<div class="sp-hp">${icon('heart', 14)}<div class="bar"><i data-k="hp"></i></div><span data-k="hpt"></span></div>`;
  }

  private renderUnit(u: Unit): string {
    const def = UNITS[u.kind];
    const tc = tribeCss(u.tribe);
    const civ = u.kind === 'shaman' && u.tribe !== 'wild' ? this.ctx.world.tribes[u.tribe as TribeId]?.civ : undefined;
    const name = civ ? `${def.name} · ${CIVS[civ].leaderTitle.replace(/^the /, '')}` : def.name;
    let html = this.head(unitIcon(u.kind, 34), tc, name, tribeLabel(this.ctx, u.tribe), `<div class="sp-act" data-k="act"></div>`);
    html += this.hpRow();
    const chips: string[] = [];
    if (u.wardTime > 0) chips.push(`<span class="sp-chip ward">${icon('shield', 12)}Stone Ward <span data-k="ward"></span></span>`);
    if (u.warsongTime > 0) chips.push(`<span class="sp-chip song">${icon('speed', 12)}Warsong <span data-k="song"></span></span>`);
    if (chips.length) html += `<div class="sp-row">${chips.join('')}</div>`;
    const stats: string[] = [];
    if (def.dmg > 0) stats.push(`Damage <b>${def.dmg}</b>`);
    if (def.range > 1.5) stats.push(`Range <b>${def.range}</b>`);
    if (def.armor > 0) stats.push(`Armour <b>${Math.round(def.armor * 100)}%</b>`);
    stats.push(`Speed <b>${def.speed}</b>`);
    html += `<div class="sp-stats">${stats.map((s) => `<span>${s}</span>`).join('')}</div>`;
    if (u.tribe === 'player' && u.kind === 'shaman') {
      html += `<div class="sp-note">Pick a spell, then click the world. Right-click a standing stone to commune with it.</div>`;
    } else if (u.tribe === 'player' && u.kind === 'brave') {
      html += `<div class="sp-note">Villagers work on their own. Right-click a Shrine to pray there, or a lodge's queue will train them.</div>`;
    }
    return html;
  }

  private renderGroup(units: Unit[]): string {
    const groups = groupByKind(units);
    const own = units.every((u) => u.tribe === 'player');
    let html = `<div class="sp-head"><div class="sp-title"><div class="sp-name">${units.length} selected</div>` +
      `<div class="sp-sub">${own ? 'Right-click to give orders' : 'Mixed'}</div></div></div>`;
    html += `<div class="sp-kinds">${groups
      .map((g) => `<button type="button" class="sp-kind" data-a="kind" data-kind="${g.kind}">${unitIcon(g.kind, 24)}<span><div class="n">${g.ids.length}</div><div class="k">${UNITS[g.kind].name}</div></span></button>`)
      .join('')}</div>`;
    html += this.hpRow();
    return html;
  }

  private renderBuilding(b: Building): string {
    const w = this.ctx.world;
    const def = BUILDINGS[b.kind];
    const ours = b.tribe === 'player';
    const tc = tribeCss(b.tribe);
    const status = b.progress < 1 ? 'Under construction' : tribeLabel(this.ctx, b.tribe);
    let html = this.head(buildingIcon(b.kind, 32), tc, buildingName(b), status);
    if (b.burning > 0) html += `<div class="sp-warn">${icon('fire', 16)}Burning! Villagers nearby will put it out.</div>`;
    html += this.hpRow();

    if (b.progress >= 1 && b.kind === 'hut') {
      const tier = DWELLING_TIERS[b.tier];
      const cap = w.dwellingCapacity(b);
      html += `<div class="sp-row"><span class="lbl">Residents</span><div class="sp-pips">${Array.from({ length: cap }, (_, i) => `<i class="${i < b.residents ? 'on' : ''}"></i>`).join('')}</div><span data-k="res"></span></div>`;
      const next = DWELLING_TIERS[b.tier + 1];
      if (next) {
        html += `<div class="sp-row"><span class="lbl">Growth</span><div class="sp-train"><div class="bar gold"><i data-k="grow"></i></div><span data-k="growt"></span></div></div>` +
          `<div class="sp-note">A full ${tier.name} grows into a ${next.name} (${next.capacity} beds) after ${next.growSeconds}s, for ${next.growWood} wood.</div>`;
      } else {
        html += `<div class="sp-note">Fully grown: ${tier.capacity} beds, a villager every ${tier.breedSeconds}s while there's room.</div>`;
      }
    }

    const trains = def.trains;
    if (b.progress >= 1 && trains) {
      const ud = UNITS[trains];
      if (ours) {
        html += `<div class="sp-row"><span class="lbl">Training</span><div class="sp-train"><div class="bar mana"><i data-k="train"></i></div><span data-k="traint"></span></div></div>` +
          `<div class="sp-row"><span class="lbl">Queue</span><div class="sp-queue">` +
          `<span class="sp-pips">${Array.from({ length: ECONOMY.trainQueueMax }, (_, i) => `<i class="${i < b.queue ? 'q' : ''}"></i>`).join('')}</span>` +
          `<button type="button" class="tg-btn" data-a="q" data-n="1" data-tip="&lt;h4&gt;Train one ${ud.name}&lt;/h4&gt;&lt;p&gt;${ud.trainWood} wood and ${ud.trainSeconds}s each. An idle villager walks in and comes out a ${ud.name}.&lt;/p&gt;">${icon('plus', 14)}1</button>` +
          `<button type="button" class="tg-btn" data-a="q" data-n="5">${icon('plus', 14)}5</button>` +
          `<button type="button" class="tg-btn" data-a="q" data-n="-1" aria-label="Cancel one" data-tip="&lt;h4&gt;Cancel one&lt;/h4&gt;">${icon('minus', 14)}</button>` +
          `</div></div>`;
      } else {
        html += `<div class="sp-note">Trains ${ud.name}s.</div>`;
      }
    }

    if (b.progress >= 1 && (b.kind === 'tower' || b.kind === 'shrine')) {
      const cap = b.kind === 'tower' ? ECONOMY.towerGarrison : ECONOMY.shrineWorshippers;
      const slots = Array.from({ length: cap }, (_, i) => {
        const u = b.garrison[i] !== undefined ? w.unitById(b.garrison[i]) : undefined;
        return u ? `<span title="${UNITS[u.kind].name}">${unitIcon(u.kind, 16)}</span>` : `<span class="empty">${icon('plus', 12)}</span>`;
      });
      html += `<div class="sp-row"><span class="lbl">${b.kind === 'shrine' ? 'Praying' : 'Garrison'}</span><div class="sp-inside">${slots.join('')}</div></div>`;
      if (ours) {
        html += `<div class="sp-note">${b.kind === 'shrine'
          ? `Select villagers and right-click the shrine to send them to pray (+${Math.round(ECONOMY.shrinePrayerBonus * 100)}% spell charging each).`
          : 'Select fighters and right-click the tower to man it. They see farther and hit harder from the top.'}</div>`;
      }
    }

    if (b.progress >= 1 && b.kind === 'lumberyard') html += `<div class="sp-note">${escapeHtml(def.blurb)}</div>`;

    if (ours) {
      const confirm = performance.now() < this.confirmDemolish;
      const acts: string[] = [];
      if (b.progress >= 1 && trains) {
        acts.push(`<button type="button" class="tg-btn${this.rallyPick === b.id ? ' on' : ''}" data-a="rally" data-tip="&lt;h4&gt;Rally point&lt;/h4&gt;&lt;p&gt;Click, then click the ground: new ${UNITS[trains].name}s gather there. (Or right-click the ground with the lodge selected.)&lt;/p&gt;">${icon('rally', 14)}${this.rallyPick === b.id ? 'Click the ground…' : 'Rally point'}</button>`);
      }
      if (b.garrison.length > 0 && (b.kind === 'tower' || b.kind === 'shrine')) acts.push(`<button type="button" class="tg-btn" data-a="eject">${icon('eject', 14)}Send out</button>`);
      acts.push(`<button type="button" class="tg-btn danger${confirm ? ' on' : ''}" data-a="demolish" style="margin-left:auto" data-tip="&lt;h4&gt;Demolish &lt;span class='kbd'&gt;${labelFor('demolish')}&lt;/span&gt;&lt;/h4&gt;&lt;p&gt;Tear it down. Half its wood (${Math.floor(def.wood / 2)}) comes back.&lt;/p&gt;">${icon('demolish', 14)}${confirm ? 'Click again to demolish' : 'Demolish'}</button>`);
      html += `<div class="sp-actions">${acts.join('')}</div>`;
    }
    return html;
  }

  private renderMonument(index: number): string {
    const w = this.ctx.world;
    const m = w.monuments[index];
    const s = spellDef(m.spell);
    const avail = w.monumentAvailable(m);
    let html = this.head(icon('stone', 32), avail ? 'var(--gold)' : 'var(--rim-strong)', 'Standing stone', m.mode === 'teach' ? 'Teaches a spell' : 'Lends a spell');
    html += `<div class="sp-spell">${spellIcon(m.spell, 26)}<div><b>${escapeHtml(s.name)}</b> · Tier ${s.tier}<div style="color:var(--text-2);font-size:var(--t-xs)">${escapeHtml(s.blurb)}</div></div></div>`;
    let note: string;
    if (m.mode === 'teach') {
      note = avail
        ? 'The first leader to commune here learns this spell for good.'
        : m.claimedBy === 'player' ? 'Your tribe learned this spell here.' : `Claimed by ${escapeHtml(tribeLabel(this.ctx, m.claimedBy ?? ''))}.`;
    } else {
      note = `Whoever communes gets ${m.charges ?? 2} free casts, known or not. Then it sleeps for ${m.cooldown ?? 90}s.`;
    }
    html += `<div class="sp-note">${note} <span data-k="sleep" style="color:var(--warn)"></span></div>`;
    const leader = w.leaderOf('player');
    if (avail) {
      html += `<div class="sp-actions"><button type="button" class="tg-btn primary" data-a="commune" ${leader ? '' : 'disabled'}>${icon('worship', 14)}Send your leader to commune</button></div>`;
    }
    return html;
  }
}
