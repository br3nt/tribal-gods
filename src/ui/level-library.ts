/**
 * ui/level-library.ts — browse, rate, filter, share.
 *
 * Two shelves: OFFICIAL (the levels that ship with the game, built fresh
 * from their recipes each time) and MY LEVELS (everything saved from the
 * editor or imported from a share code). One search box, a minimum-star
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
import { deleteLevel, getRating, listLevels, saveLevel, setRating } from '../level/store';

interface CardEntry {
  id: string;
  level: LevelData | null; // official levels build lazily on demand
  build?: () => Promise<LevelData>;
  official: boolean;
  savedAt: number;
}

const BTN = `
  padding: 4px 10px; cursor: pointer; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.07);
  color: #e8e4d8; font: 11px ui-monospace, Menlo, monospace;
`;

export class LevelLibrary {
  private readonly overlay: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly minStars: HTMLSelectElement;
  private readonly sortBy: HTMLSelectElement;

  constructor(
    private readonly hooks: {
      onPlay(level: LevelData): void;
      onEdit(id: string | undefined, level: LevelData): void;
      onClose(): void;
    },
  ) {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 30; display: none; overflow-y: auto;
      background: rgba(10, 14, 20, 0.88); color: #e8e4d8;
      font: 13px ui-monospace, Menlo, monospace; padding: 30px 0 60px;
    `;

    const inner = document.createElement('div');
    inner.style.cssText = 'max-width: 860px; margin: 0 auto; padding: 0 20px;';
    this.overlay.appendChild(inner);

    const header = document.createElement('div');
    header.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;';
    const title = document.createElement('div');
    title.textContent = 'LEVEL LIBRARY';
    title.style.cssText = 'font-size: 22px; letter-spacing: 2px; flex: 1;';

    this.search = document.createElement('input');
    this.search.placeholder = 'search…';
    this.search.style.cssText = BTN + 'width: 130px; cursor: text;';
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => e.stopPropagation());

    this.minStars = this.select(['any rating', '★+', '★★+', '★★★+', '★★★★+', '★★★★★']);
    this.sortBy = this.select(['newest', 'name', 'rating']);

    const importBtn = document.createElement('button');
    importBtn.textContent = '📥 import code';
    importBtn.style.cssText = BTN;
    importBtn.addEventListener('click', () => void this.importCode());

    const close = document.createElement('button');
    close.textContent = '✕ close';
    close.style.cssText = BTN;
    close.addEventListener('click', () => {
      this.hide();
      hooks.onClose();
    });

    header.append(title, this.search, this.minStars, this.sortBy, importBtn, close);
    inner.appendChild(header);

    this.grid = document.createElement('div');
    this.grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(255px, 1fr)); gap: 12px;';
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
    return [...official, ...mine];
  }

  private render(): void {
    this.grid.innerHTML = '';
    const q = this.search.value.toLowerCase();
    const minStars = this.minStars.selectedIndex; // index doubles as the threshold
    let entries = this.entries().filter((e) => {
      if (getRating(e.id) < minStars) return false;
      if (!q) return true;
      const name = e.level?.name ?? OFFICIAL_NAMES[e.id] ?? e.id;
      const author = e.level?.author ?? 'Tribal Gods';
      return (name + ' ' + author).toLowerCase().includes(q);
    });

    const sort = this.sortBy.value;
    entries = entries.sort((a, b) => {
      if (sort === 'rating') return getRating(b.id) - getRating(a.id);
      if (sort === 'name') {
        return (a.level?.name ?? OFFICIAL_NAMES[a.id] ?? '').localeCompare(b.level?.name ?? OFFICIAL_NAMES[b.id] ?? '');
      }
      return (b.official ? 1 : 0) - (a.official ? 1 : 0) || b.savedAt - a.savedAt; // newest, officials pinned first
    });

    for (const e of entries) this.grid.appendChild(this.card(e));
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.style.opacity = '0.6';
      empty.textContent = 'Nothing here. Build something in the editor, or import a friend’s code.';
      this.grid.appendChild(empty);
    }
  }

  private card(e: CardEntry): HTMLDivElement {
    const card = document.createElement('div');
    card.style.cssText = `
      padding: 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.05); display: flex; flex-direction: column; gap: 7px;
    `;
    const name = e.level?.name ?? OFFICIAL_NAMES[e.id] ?? e.id;
    const author = e.level?.author ?? 'Tribal Gods';
    const desc = e.level?.desc ?? OFFICIAL_DESCS[e.id] ?? '';

    const head = document.createElement('div');
    head.innerHTML =
      `<span style="font-size:14px">${escapeHtml(name)}</span>` +
      `<span style="opacity:0.55"> — ${escapeHtml(author)}</span>` +
      (e.official ? ' <span style="color:#ffd75e">◆ official</span>' : '');
    const blurb = document.createElement('div');
    blurb.style.cssText = 'opacity: 0.65; min-height: 2.4em;';
    blurb.textContent = desc;

    // Clickable stars: your rating, persisted, filterable.
    const stars = document.createElement('div');
    const paint = () => {
      const r = getRating(e.id);
      stars.innerHTML = '';
      for (let s = 1; s <= 5; s++) {
        const star = document.createElement('span');
        star.textContent = s <= r ? '★' : '☆';
        star.style.cssText = `cursor: pointer; color: ${s <= r ? '#ffd75e' : '#777'}; font-size: 15px;`;
        star.addEventListener('click', () => {
          setRating(e.id, s === r ? 0 : s); // click your current rating to clear it
          paint();
        });
        stars.appendChild(star);
      }
    };
    paint();

    const actions = document.createElement('div');
    actions.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap;';
    const act = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = BTN;
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };

    const resolve = async (): Promise<LevelData> => e.level ?? (await e.build!());
    act('▶ play', () => {
      this.hide();
      void resolve().then((l) => this.hooks.onPlay(l));
    });
    act('✎ edit', () => {
      this.hide();
      void resolve().then((l) => this.hooks.onEdit(e.official ? undefined : e.id, l));
    });
    act('📋 code', () => void resolve().then(async (l) => {
      const code = await levelToCode(l);
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        prompt('Copy your level code:', code);
      }
    }));
    if (!e.official) {
      act('🗑', () => {
        deleteLevel(e.id);
        this.render();
      });
    }

    card.append(head, blurb, stars, actions);
    return card;
  }

  private async importCode(): Promise<void> {
    const code = prompt('Paste a level code (TG1.…):');
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
    s.style.cssText = BTN;
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
  official_the_strait: 'An ocean apart. Landbridge is on your shore — claim it first.',
  official_crucible: 'One continent, one volcano, two gods. Exactly the standoff it looks like.',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
