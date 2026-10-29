import { describe, expect, it } from 'vitest';
import { nextAllowedAt, randomBetween, transientBackoff } from '../src/engine/pacing.js';

describe('pacing', () => {
  it('randomBetween cobre os limites', () => {
    expect(randomBetween({ min: 10, max: 20 }, () => 0)).toBe(10);
    expect(randomBetween({ min: 10, max: 20 }, () => 0.9999)).toBe(20);
  });

  it('transientBackoff: 1min, 5min, 15min, 1h, 3h e satura', () => {
    expect([1, 2, 3, 4, 5, 9].map(transientBackoff)).toEqual([60_000, 300_000, 900_000, 3_600_000, 10_800_000, 10_800_000]);
  });

  it('nextAllowedAt respeita intervalo mínimo de 8s e teto por hora', () => {
    expect(nextAllowedAt({ now: 100_000, lastActionAt: null, actionsLastHour: 0, maxPerHour: 200 })).toBe(100_000);
    expect(nextAllowedAt({ now: 100_000, lastActionAt: 95_000, actionsLastHour: 0, maxPerHour: 200 })).toBe(103_000);
    expect(nextAllowedAt({ now: 100_000, lastActionAt: null, actionsLastHour: 200, maxPerHour: 200 })).toBe(400_000);
  });
});
