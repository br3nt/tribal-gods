/**
 * ui/level-library.ts — browse, rate, filter, share.
 *
 * Three shelves: OFFICIAL (the levels that ship with the game, built fresh
 * from their recipes each time), CAMPAIGN (the chapters — played through the
 * campaign flow, and only once reached) and MY LEVELS (everything saved
 * from the editor or imported from a share code). One search box, a minimum-star
 * filter, and a sort order cover the browsing story; stars are clickable
 * on every card and stored locally (level/store.ts explains how the same
 * UI would ride a community backend unchanged).
 *
 * Every card's actions are verbs against the rest of the app: Play hands
 * the level to main.ts, Edit hands it to the editor, Code copies a share
 * string, Delete is only offered for levels that are yours to delete.
 */

import { LevelData, codeToLevel, levelToCode } from '../level/level-format';
import { OFFICIAL_LEVELS } from '../level/official-levels';
import { CAMPAIGN } from '../level/campaign';
import { deleteLevel, getRating, listLevels, saveLevel, setRating } from '../level/store';
import { css } from './dom';
import { icon } from './icons';

css('library', `
.lib { position: fixed; inset: 0; z-index: 30; display: none; overflow-y: auto; background: rgba(8,11,18,0.82); backdrop-filter: blur(6px);
  color: var(--text); font: var(--t-md)/1.45 var(--font); padding: 2rem 0 4rem; pointer-events: auto; }
.lib-inner { max-width: 60rem; margin: 0 auto; padding: 0 1.25rem; }
.lib-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
.lib-head h2 { flex: 1; margin: 0; font: 600 var(--t-xl)/1 var(--font-display); }
.lib input, .lib select { min-height: 2rem; padding: 0 0.6rem; border-radius: var(--r2); border: 1px solid var(--rim); background: var(--ink-2); color: var(--text); font: var(--t-sm) var(--font); }
.lib select option { background: var(--ink-solid); }
.lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: 0.75rem; }
.lib-card { padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
.lib-card .name { font-size: var(--t-lg); font-weight: 650; }
.lib-card .by { color: var(--text-3); font-size: var(--t-sm); }
.lib-card .off { display: inline-block; margin-left: 0.4rem; padding: 0 0.4rem; border-radius: var(--r1); background: var(--gold-soft); color: var(--gold); font-size: var(--t-xs); font-weight: 600; vertical-align: 2px; }
.lib-card .desc { color: var(--text-2); font-size: var(--t-sm); min-height: 2.6em; }
.lib-stars span { cursor: pointer; font-size: 1.05rem; color: var(--text-3); }
.lib-stars span.on { color: var(--gold); }
.lib-acts { display: flex; gap: 0.4rem; flex-wrap: wrap; }
`);

interface CardEntry {
  id: string;
  level: LevelData | null; // official levels build lazily on demand
  build?: () => Promise<LevelData>;
  official: boolean;
  savedAt: number;
  /** Campaign chapters: played through the campaign flow; locked until reached. */
  campaign?: { chapter: number; title: string; tagline: string; locked: boolean };
}


export class LevelLibrary {
  private readonly overlay: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly minStars: HTMLSelectElement;
  private readonly sortBy: HTMLSelectElement;
  private readonly shelf: HTMLSelectElement;

  constructor(
    private readonly hooks: {
      onPlay(level: LevelData): void;
      onEdit(id: string | undefined, level: LevelData): void;
      onClose(): void;
      /** Campaign chapters open through the campaign (briefing, boons, progress). */
      onPlayScenario?(id: string): void;
      isScenarioUnlocked?(id: string): boolean;
    },
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'lib';

    const inner = document.createElement('div');
    inner.className = 'lib-inner';
    this.overlay.appendChild(inner);

    const header = document.createElement('div');
    header.className = 'lib-head';
    const title = document.createElement('h2');
    title.textContent = 'Level library';

    this.search = document.createElement('input');
    this.search.placeholder = 'Search…';
    this.search.style.width = '10rem';
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => e.stopPropagation());

    this.minStars = this.select(['Any rating', '★+', '★★+', '★★★+', '★★★★+', '★★★★★']);
    this.sortBy = this.select(['Newest', 'Name', 'Rating']);
    this.shelf = this.select(['All shelves', 'Official', 'Campaign', 'My levels']);

    const importBtn = document.createElement('button');
    importBtn.className = 'tg-btn';
    importBtn.innerHTML = `${icon('plus', 14)}<span>Import code</span>`;
    importBtn.addEventListener('click', () => void this.importCode());

    const close = document.createElement('button');
    close.className = 'tg-btn';
    close.innerHTML = `${icon('close', 14)}<span>Close</span>`;
    close.addEventListener('click', () => {
      this.hide();
      hooks.onClose();
    });

    header.append(title, this.search, this.shelf, this.minStars, this.sortBy, importBtn, close);
    inner.appendChild(header);

    this.grid = document.createElement('div');
    this.grid.className = 'lib-grid';
    inner.appendChild(this.grid);

    document.body.appendChild(this.overlay);
  }

  show(): void {
    this.overlay.style.display = 'block';
    this.render();
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }

  // -------------------------------------------------------------------------

  private entries(): CardEntry[] {
    const official: CardEntry[] = OFFICIAL_LEVELS.map((o) => ({
      id: o.id,
      level: null,
      build: o.build,
      official: true,
      savedAt: 0,
    }));
    const mine: CardEntry[] = listLevels().map((s) => ({
      id: s.id,
      level: s.level,
      official: false,
      savedAt: s.savedAt,
    }));
    const campaign: CardEntry[] = CAMPAIGN.map((c) => ({
      id: c.id,
      level: null,
      build: c.build,
      official: true,
      savedAt: 0,
      campaign: { chapter: c.chapter, title: c.title, tagline: c.tagline, locked: !(this.hooks.isScenarioUnlocked?.(c.id) ?? false) },
    }));
    const shelf = this.shelf?.selectedIndex ?? 0;
    if (shelf === 1) return official;
    if (shelf === 2) return campaign;
    if (shelf === 3) return mine;
    return [...official, ...campaign, ...mine];
  }

  private render(): void {
    this.grid.innerHTML = '';
    const q = this.search.value.toLowerCase();
    const minStars = this.minStars.selectedIndex; // index doubles as the threshold
    let entries = this.entries().filter((e) => {
      if (getRating(e.id) < minStars) return false;
      if (!q) return true;
      const name = e.campaign?.title ?? e.level?.name ?? OFFICIAL_NAMES[e.id] ?? e.id;
      const author = e.level?.author ?? 'Tribal Gods';
      return (name + ' ' + author).toLowerCase().includes(q);
    });

    const sort = this.sortBy.value.toLowerCase();
    entries = entries.sort((a, b) => {
      if (sort === 'rating') return getRating(b.id) - getRating(a.id);
      if (sort === 'name') {
        const nm = (e: CardEntry) => e.campaign?.title ?? e.level?.name ?? OFFICIAL_NAMES[e.id] ?? '';
        return nm(a).localeCompare(nm(b));
      }
      return (b.official ? 1 : 0) - (a.official ? 1 : 0) || (a.campaign?.chapter ?? 0) - (b.campaign?.chapter ?? 0) || b.savedAt - a.savedAt; // newest, officials pinned first
    });

    for (const e of entries) this.grid.appendChild(this.card(e));
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.style.color = 'var(--text-3)';
      empty.textContent = 'Nothing here. Build something in the editor, or import a friend’s code.';
      this.grid.appendChild(empty);
    }
  }

  private card(e: CardEntry): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'lib-card tg-panel';
    const name = e.campaign ? `${e.campaign.chapter}. ${e.campaign.title}` : e.level?.name ?? OFFICIAL_NAMES[e.id] ?? e.id;
    const author = e.level?.author ?? 'Tribal Gods';
    const desc = e.campaign ? (e.campaign.locked ? 'Locked — reach this chapter in the campaign.' : e.campaign.tagline) : e.level?.desc ?? OFFICIAL_DESCS[e.id] ?? '';

    const head = document.createElement('div');
    head.innerHTML =
      `<div class="name">${escapeHtml(name)}${e.campaign ? '<span class="off">campaign</span>' : e.official ? '<span class="off">official</span>' : ''}</div>` +
      `<div class="by">by ${escapeHtml(author)}</div>`;
    const blurb = document.createElement('div');
    blurb.className = 'desc';
    blurb.textContent = desc;

    // Clickable stars: your rating, persisted, filterable.
    const stars = document.createElement('div');
    stars.className = 'lib-stars';
    const paint = () => {
      const r = getRating(e.id);
      stars.innerHTML = '';
      for (let s = 1; s <= 5; s++) {
        const star = document.createElement('span');
        star.textContent = s <= r ? '★' : '☆';
        star.className = s <= r ? 'on' : '';
        star.addEventListener('click', () => {
          setRating(e.id, s === r ? 0 : s); // click your current rating to clear it
          paint();
        });
        stars.appendChild(star);
      }
    };
    paint();

    const actions = document.createElement('div');
    actions.className = 'lib-acts';
    const act = (label: string, fn: () => void, primary = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = primary ? 'tg-btn primary' : 'tg-btn';
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };

    const resolve = async (): Promise<LevelData> => e.level ?? (await e.build!());
    if (e.campaign) {
      // Chapters play through the campaign (briefing, boons, progress) — once reached.
      if (!e.campaign.locked) {
        act('Play', () => {
          this.hide();
          this.hooks.onPlayScenario?.(e.id);
        }, true);
      }
      card.append(head, blurb, stars, actions);
      return card;
    }
    act('Play', () => {
      this.hide();
      void resolve().then((l) => this.hooks.onPlay(l));
    }, true);
    act('Edit', () => {
      this.hide();
      void resolve().then((l) => this.hooks.onEdit(e.official ? undefined : e.id, l));
    });
    act('Copy code', () => void resolve().then(async (l) => {
      const code = await levelToCode(l);
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        prompt('Copy your level code:', code);
      }
    }));
    if (!e.official) {
      act('Delete', () => {
        deleteLevel(e.id);
        this.render();
      });
    }

    card.append(head, blurb, stars, actions);
    return card;
  }

  private async importCode(): Promise<void> {
    const code = prompt('Paste a level code (TG2.… or TG1.…):');
    if (!code) return;
    try {
      const level = await codeToLevel(code);
      saveLevel(level);
      this.render();
    } catch (err) {
      alert(`Could not import: ${(err as Error).message}`);
    }
  }

  private select(options: string[]): HTMLSelectElement {
    const s = document.createElement('select');

    for (const o of options) {
      const opt = document.createElement('option');
      opt.textContent = o;
      opt.value = o;
      s.appendChild(opt);
    }
    s.addEventListener('change', () => this.render());
    return s;
  }
}

/** Official metadata without building the whole level (cards render instantly). */
const OFFICIAL_NAMES: Record<string, string> = {
  official_first_light: 'First Light',
  official_the_strait: 'The Strait',
  official_crucible: 'The Crucible',
};
const OFFICIAL_DESCS: Record<string, string> = {
  official_first_light: 'A kind world to learn godhood on. The stones are near; the enemy is far.',
  official_the_strait: 'An ocean apart. Causeway is on your shore — claim it first.',
  official_crucible: 'One continent, one volcano, two gods. Exactly the standoff it looks like.',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
