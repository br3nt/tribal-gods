import { describe, expect, it } from 'vitest';
import { activityText, buildingName, fmtClock, fmtEta, fmtRate, fmtSeconds, fmtTiles } from '../src/ui/format';

const unit = (over: Record<string, unknown> = {}) => ({
  kind: 'brave', state: 'idle', task: 'none', carrying: false, castSpell: null, garrison: -1,
  hidden: false, pacified: 0, lifted: 0, hp: 10, ...over,
}) as Parameters<typeof activityText>[0];

describe('formatters', () => {
  it('clock', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(75.9)).toBe('1:15');
    expect(fmtClock(3725)).toBe('1:02:05');
  });
  it('eta', () => {
    expect(fmtEta(4.2)).toBe('5s');
    expect(fmtEta(95)).toBe('1m 35s');
    expect(fmtEta(Infinity)).toBe('—');
  });
  it('rate, tiles, seconds', () => {
    expect(fmtRate(1.53)).toBe('+1.5/s');
    expect(fmtTiles(1)).toBe('1 tile');
    expect(fmtTiles(4.5)).toBe('4.5 tiles');
    expect(fmtSeconds(0)).toBe('Instant');
    expect(fmtSeconds(2.5)).toBe('2.5s');
  });
  it('dwellings are named by tier', () => {
    expect(buildingName({ kind: 'hut', tier: 0 })).toBe('Small Dwelling');
    expect(buildingName({ kind: 'hut', tier: 2 })).toBe('Great Dwelling');
    expect(buildingName({ kind: 'tower', tier: 0 })).toBe('Watchtower');
  });
});

describe('activityText', () => {
  it('describes what a villager is doing', () => {
    expect(activityText(unit())).toBe('Idle');
    expect(activityText(unit({ task: 'chop', state: 'working' }))).toBe('Felling a tree');
    expect(activityText(unit({ task: 'deliverWood', state: 'moving' }))).toBe('Hauling wood');
    expect(activityText(unit({ garrison: 5, hidden: true, state: 'inside' }), 'shrine')).toBe('Praying at the shrine');
    expect(activityText(unit({ hidden: true, state: 'inside' }), 'hut')).toBe('At home');
  });
  it('describes the leader casting', () => {
    expect(activityText(unit({ kind: 'shaman', castSpell: 'blast', state: 'working' }))).toBe('Casting Blast');
    expect(activityText(unit({ kind: 'shaman', castSpell: 'convert', state: 'moving' }))).toBe('Going to cast Kindle');
  });
  it('fighters at rest stand guard', () => {
    expect(activityText(unit({ kind: 'warrior' }))).toBe('Standing guard');
  });
});
