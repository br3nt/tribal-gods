/**
 * ui/campaign.ts — the campaign flow: menu → map → briefing → play →
 * debrief → next.
 *
 * The controller owns no game rules. It reads progress (campaign/progress.ts),
 * builds a scenario's level (level/campaign), applies carried boons to its
 * rules, and asks main.ts to start it through `startScenario`. While a
 * campaign scenario is running, main.ts calls `update()` every frame; that
 * shows scripted scenario lines as a banner and, when world.gameOver
 * latches, records the result and opens the debrief.
 *
 * The result is recorded the moment world.gameOver latches. With the game
 * UI's overlay (ui/game-over.ts) main.ts constructs this with
 * `{ autoDebrief: false }` and registers a "Campaign debrief" button that
 * calls `handleGameOver()`; without one, autoDebrief opens it by itself.
 */

import { BoonId, BOONS } from '../campaign/boons';
import {
  boonOffer, boonsFor, chooseBoon, currentChapter, isCompleted, isUnlocked, localProgressStore, nextScenario,
  ProgressStore, recordResult, rulesForPlay,
} from '../campaign/progress';
import { CAMPAIGN, campaignScenario } from '../level/campaign';
import type { LevelData } from '../level/level-format';
import type { ScenarioRules } from '../sim/catalog';
import type { World } from '../sim/world-state';
import { BriefingScreen, CampaignMapScreen, CampaignToast, DebriefScreen, MapNode } from './campaign-screens';

export interface CampaignHooks {
  world: World;
  /** Load this level under these rules and switch to play. */
  startScenario(level: LevelData, rules: ScenarioRules): Promise<void>;
  /** Freeze the sim (debrief / map open over a finished game). */
  pause(): void;
  /** Back to the main menu. */
  showMenu(): void;
}

export class CampaignController {
  /** Id of the scenario being played (null outside campaign play). */
  active: string | null = null;
  private readonly store: ProgressStore;
  private readonly levels = new Map<string, Promise<LevelData>>();
  private readonly map: CampaignMapScreen;
  private readonly briefing: BriefingScreen;
  private readonly debrief: DebriefScreen;
  private readonly toast = new CampaignToast();
  private seenMessages = 0;
  private handled = false;
  private recorded = false;
  /** Sim time when the game ended (the sim may keep running under "Keep watching"). */
  private endedAt = 0;
  private debriefTimer = 0;
  private readonly autoDebrief: boolean;

  constructor(private readonly hooks: CampaignHooks, opts: { store?: ProgressStore; autoDebrief?: boolean } = {}) {
    this.store = opts.store ?? localProgressStore();
    this.autoDebrief = opts.autoDebrief ?? true;
    this.map = new CampaignMapScreen({
      onPick: (id) => void this.brief(id),
      onClose: () => {
        this.map.hide();
        this.hooks.showMenu();
      },
    });
    this.briefing = new BriefingScreen({
      onPlay: () => {
        const id = this.briefingFor;
        this.briefing.hide();
        if (id) void this.play(id);
      },
      onBack: () => {
        this.briefing.hide();
        this.showMap();
      },
    });
    this.debrief = new DebriefScreen({
      onNext: () => {
        const next = this.lastPlayed && nextScenario(this.lastPlayed);
        this.debrief.hide();
        if (next) void this.brief(next);
        else this.showMap();
      },
      onRetry: () => {
        this.debrief.hide();
        if (this.lastPlayed) void this.play(this.lastPlayed);
      },
      onMap: () => {
        this.debrief.hide();
        this.showMap();
      },
      onBoon: (boon: BoonId) => {
        if (this.lastPlayed) this.store.save(chooseBoon(this.store.load(), this.lastPlayed, boon));
      },
    });
  }

  private briefingFor: string | null = null;
  private lastPlayed: string | null = null;

  /** Build (once) and cache a scenario's level document. */
  level(id: string): Promise<LevelData> {
    let p = this.levels.get(id);
    if (!p) {
      const s = campaignScenario(id);
      if (!s) return Promise.reject(new Error(`no scenario ${id}`));
      p = s.build();
      this.levels.set(id, p);
    }
    return p.then((l) => structuredClone(l));
  }

  /** Is this scenario playable now (for the level library)? */
  unlocked(id: string): boolean {
    return isUnlocked(this.store.load(), id);
  }

  showMap(): void {
    this.active = null;
    this.toast.clear();
    this.hooks.pause();
    const p = this.store.load();
    const current = currentChapter(p);
    const nodes: MapNode[] = CAMPAIGN.map((s) => {
      const rec = p.records[s.id];
      return {
        id: s.id, chapter: s.chapter, title: s.title, tagline: s.tagline, teaches: s.teaches,
        state: isCompleted(p, s.id) ? 'won' : isUnlocked(p, s.id) ? 'open' : 'locked',
        current: s.id === current && !isCompleted(p, s.id),
        bestTime: rec?.bestTime ?? null,
        stars: rec?.stars.length ?? 0,
        starsTotal: null,
        boon: p.boons[s.id] ? BOONS[p.boons[s.id]].name : undefined,
      };
    });
    this.map.show(nodes);
    // Star totals need the rules; fill them in as levels build.
    void Promise.all(
      nodes.filter((n) => n.state === 'won').map(async (n) => {
        n.starsTotal = (await this.level(n.id)).rules?.objectives.filter((o) => o.optional).length ?? 0;
      }),
    ).then(() => {
      if (this.map.visible) this.map.show(nodes);
    });
  }

  async brief(id: string): Promise<void> {
    const s = campaignScenario(id);
    if (!s || !this.unlocked(id)) return this.showMap();
    this.map.hide();
    this.hooks.pause();
    const level = await this.level(id);
    const p = this.store.load();
    this.briefingFor = id;
    this.briefing.show({ chapter: s.chapter, level, rules: rulesForPlay(p, id, level.rules!), boons: boonsFor(p, id) });
  }

  /** Start a scenario now (no briefing). Locked scenarios are refused unless `force`. */
  async play(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
    if (!campaignScenario(id) || (!opts.force && !this.unlocked(id))) return false;
    this.hideAll();
    const level = await this.level(id);
    const rules = rulesForPlay(this.store.load(), id, level.rules!);
    await this.hooks.startScenario(level, rules);
    this.active = id;
    this.lastPlayed = id;
    this.handled = false;
    this.recorded = false;
    this.seenMessages = 0;
    return true;
  }

  /** Per-frame: scenario lines → banner; game over → debrief. Cheap when idle. */
  update(): void {
    if (!this.active) return;
    const w = this.hooks.world;
    if (w.messages.length > this.seenMessages) {
      this.toast.say(w.messages[w.messages.length - 1].text);
      this.seenMessages = w.messages.length;
    }
    // The result counts the moment the game ends — whichever button is pressed next.
    if (w.gameOver && !this.recorded) this.record();
    if (w.gameOver && !this.handled && this.autoDebrief && !this.debriefTimer) {
      // A beat to see the last blow land before the curtain.
      this.debriefTimer = window.setTimeout(() => {
        this.debriefTimer = 0;
        this.handleGameOver();
      }, 1800);
    }
  }

  /** Save this game's result to progress (once per game). */
  private record(): void {
    const id = this.active;
    const w = this.hooks.world;
    if (!id || !w.gameOver || this.recorded) return;
    this.recorded = true;
    this.endedAt = w.elapsed;
    const optionalMet = w.objectives.map((o, i) => (o.optional && o.done ? i : -1)).filter((i) => i >= 0);
    this.store.save(recordResult(this.store.load(), id, { victory: w.gameOver === 'victory', seconds: w.elapsed, optionalMet }));
  }

  /** Open the debrief for the finished game (recording it if update() hasn't). Once per game. */
  handleGameOver(): void {
    const id = this.active;
    const w = this.hooks.world;
    if (!id || !w.gameOver || this.handled) return;
    this.handled = true;
    this.record();
    const p = this.store.load();
    this.hooks.pause();
    this.toast.clear();
    const s = campaignScenario(id)!;
    const offer = w.gameOver === 'victory' ? boonOffer(p, id) : [];
    this.debrief.show({
      chapter: s.chapter,
      title: s.title,
      result: w.gameOver,
      reason: w.gameOverReason ?? '',
      seconds: this.endedAt,
      bestTime: p.records[id]?.bestTime ?? null,
      objectives: w.objectives.map((o) => ({ text: o.text, done: o.done, optional: o.optional })),
      boonOffer: offer,
      boonChosen: p.boons[id] ?? null,
      hasNext: !!nextScenario(id),
    });
  }

  /** Leave campaign play (e.g. the player opened the main menu). */
  leave(): void {
    this.active = null;
    this.toast.clear();
    clearTimeout(this.debriefTimer);
    this.debriefTimer = 0;
    this.hideAll();
  }

  private hideAll(): void {
    this.map.hide();
    this.briefing.hide();
    this.debrief.hide();
  }
}
