/**
 * ui/help.ts — the How to play page, built from the real data.
 *
 * Concepts: a handful of illustrated cards (icons from ui/icons.ts) — the
 * tribe, mana and charges, the leader, standing stones, buildings and
 * training, winning. Controls: printed straight from ui/hotkeys.ts, with
 * each spell and building shown by its icon and catalog name, so this page
 * can never disagree with the keys the game actually listens to.
 */

import { BUILDINGS, BuildingKind, SPELLS, SpellId } from '../sim/catalog';
import { css, escapeHtml } from './dom';
import { DESCRIBED_CONTROLS, HOTKEYS, HotkeyGroup, keyLabel } from './hotkeys';
import { buildingIcon, icon, spellIcon, UiIconName } from './icons';

css('help', `
.help { display: grid; gap: 1.5rem; }
.help h3 { margin: 0 0 0.6rem; font: 600 var(--t-lg)/1.2 var(--font-display); color: var(--gold); letter-spacing: 0.02em; }
.help-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(14.5rem, 1fr)); gap: 0.6rem; }
.help-card { display: flex; gap: 0.7rem; padding: 0.75rem; border-radius: var(--r2); background: var(--ink-2); border: 1px solid var(--rim); }
.help-card .ic { flex: none; width: 2.4rem; height: 2.4rem; border-radius: 50%; display: grid; place-items: center; background: var(--gold-soft); color: var(--gold); }
.help-card b { display: block; color: var(--text); margin-bottom: 0.15rem; font-size: var(--t-md); }
.help-card p { margin: 0; color: var(--text-2); font-size: var(--t-sm); line-height: 1.45; }
.help-keys { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 0.25rem 1.5rem; }
.help-group { break-inside: avoid; }
.help-group h4 { margin: 0.6rem 0 0.3rem; font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-3); }
.help-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.22rem 0; font-size: var(--t-sm); color: var(--text-2); border-bottom: 1px solid rgba(255,255,255,0.05); }
.help-row .keys { flex: none; min-width: 5.5rem; display: flex; gap: 0.2rem; flex-wrap: wrap; }
.help-row .kbd { height: 1.3rem; min-width: 1.3rem; font-size: 0.6875rem; padding: 0 0.3rem; }
.help-row svg { flex: none; color: var(--text); }
.help-group.compact .keys { min-width: 2.2rem; }
`);

const CONCEPTS: Array<{ icon: UiIconName; title: string; text: string }> = [
  { icon: 'population', title: 'Your tribe', text: 'Villagers fell trees, haul wood, raise buildings and move into dwellings, which breed more villagers. You guide them; they get on with life.' },
  { icon: 'mana', title: 'Mana and charges', text: 'Faith flows from your people into every spell that is charging. A spell holds a few charges; casting spends one. Switch spells off (right-click) to charge the rest faster.' },
  { icon: 'leader', title: 'Your leader', text: 'The only one who casts. Pick a spell, click the world: the leader walks into range and casts. If they fall, they return to the home circle while the tribe lives.' },
  { icon: 'stone', title: 'Standing stones', text: 'Commune with a stone to learn its spell for good, or to borrow a few free casts. Select your leader and right-click the stone.' },
  { icon: 'hammer', title: 'Buildings and training', text: 'Lodges turn villagers into fighters — queue them on the building. A watchtower holds two fighters; a shrine full of praying villagers charges spells faster.' },
  { icon: 'trophy', title: 'Winning', text: 'Each scenario has objectives (top right). In a skirmish: be the last tribe standing.' },
];

const GROUPS: HotkeyGroup[] = ['Camera', 'Selection', 'Spells', 'Build', 'Game'];

function row(keys: string[], label: string, ic = ''): string {
  return `<div class="help-row"><span class="keys">${keys.map((k) => `<span class="kbd">${escapeHtml(k)}</span>`).join('')}</span>${ic}<span>${label}</span></div>`;
}

export function helpHtml(): string {
  let html = `<div class="help"><section><h3>The idea</h3><div class="help-cards">`;
  for (const c of CONCEPTS) html += `<div class="help-card"><span class="ic">${icon(c.icon, 20)}</span><div><b>${c.title}</b><p>${c.text}</p></div></div>`;
  html += `</div></section><section><h3>Controls</h3><div class="help-keys">`;
  for (const g of GROUPS) {
    html += `<div class="help-group${g === 'Spells' || g === 'Build' ? ' compact' : ''}"><h4>${g}</h4>`;
    for (const d of DESCRIBED_CONTROLS.filter((x) => x.group === g)) html += row(d.keys, d.desc);
    if (g === 'Selection') {
      html += row(['1', '–', '9'], 'Select a control group (twice: jump to it)');
      html += row(['Ctrl', '1', '–', '9'], 'Make the selection a control group');
    }
    for (const hk of HOTKEYS.filter((x) => x.group === g && !x.action.startsWith('group-') && x.code !== 'Backspace')) {
      if (hk.action.startsWith('spell:')) {
        const id = hk.action.slice(6) as SpellId;
        html += row([keyLabel(hk)], `${escapeHtml(SPELLS.find((s) => s.id === id)!.name)} <span style="color:var(--text-3)">· tier ${SPELLS.find((s) => s.id === id)!.tier}</span>`, spellIcon(id, 18));
      } else if (hk.action.startsWith('build:')) {
        const kind = hk.action.slice(6) as BuildingKind;
        html += row([keyLabel(hk)], escapeHtml(BUILDINGS[kind].name), buildingIcon(kind, 18));
      } else html += row([keyLabel(hk)], escapeHtml(hk.desc));
    }
    html += `</div>`;
  }
  html += `</div></section></div>`;
  return html;
}
