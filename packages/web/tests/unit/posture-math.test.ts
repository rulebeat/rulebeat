/**
 * The one percentage and delta function every posture reader uses (ADR 0013, docs/public/posture.md).
 * The percentage rounds to the nearest whole number but never claims 100 while a counted rule fails
 * or is unknown, nor 0 while one passes. The delta comes from the unrounded ratios and is rounded once.
 */
import { describe, expect, it } from 'vitest';
import { posturePct, postureDelta, pointsLabel } from '@/lib/posture-math';

describe('posturePct', () => {
  it('rounds to the nearest whole number', () => {
    expect(posturePct(1, 3)).toBe(33);
    expect(posturePct(2, 3)).toBe(67);
    expect(posturePct(3, 4)).toBe(75);
    expect(posturePct(1, 8)).toBe(13);
  });

  it('is 100 only when every counted rule passes', () => {
    expect(posturePct(240, 240)).toBe(100);
    expect(posturePct(239, 240)).toBe(99);
    expect(posturePct(999, 1000)).toBe(99);
  });

  it('is 0 only when no counted rule passes', () => {
    expect(posturePct(0, 240)).toBe(0);
    expect(posturePct(1, 240)).toBe(1);
    expect(posturePct(1, 1000)).toBe(1);
  });

  it('gives none for a total of 0', () => {
    expect(posturePct(0, 0)).toBeNull();
  });
});

describe('postureDelta', () => {
  it('reads 240/240 to 239/240 as -1, not flat', () => {
    expect(postureDelta({ passing: 239, total: 240 }, { passing: 240, total: 240 })).toBe(-1);
  });

  it('shows a non-zero change that rounds to 0 as +1 or -1', () => {
    expect(postureDelta({ passing: 240, total: 240 }, { passing: 239, total: 240 })).toBe(1);
    expect(postureDelta({ passing: 1999, total: 2000 }, { passing: 2000, total: 2000 })).toBe(-1);
  });

  it('is rounded once from the unrounded ratios, not subtracted from rounded percentages', () => {
    // 1/3 (33.33) to 2/3 (66.67) is 33.33 points. The rounded percentages 33 and 67 would give 34.
    expect(postureDelta({ passing: 2, total: 3 }, { passing: 1, total: 3 })).toBe(33);
  });

  it('is 0 only when the ratios are exactly equal', () => {
    expect(postureDelta({ passing: 2, total: 4 }, { passing: 1, total: 2 })).toBe(0);
    expect(postureDelta({ passing: 3, total: 3 }, { passing: 7, total: 7 })).toBe(0);
  });

  it('computes 3/4 to 1/1 as +25', () => {
    expect(postureDelta({ passing: 1, total: 1 }, { passing: 3, total: 4 })).toBe(25);
  });

  it('is none when either side has a total of 0', () => {
    expect(postureDelta({ passing: 0, total: 0 }, { passing: 1, total: 2 })).toBeNull();
    expect(postureDelta({ passing: 1, total: 2 }, { passing: 0, total: 0 })).toBeNull();
  });
});

describe('pointsLabel', () => {
  it('names the baseline date and uses the singular for one point', () => {
    expect(pointsLabel(25, '2026-10-01')).toBe('+25 pts vs 2026-10-01');
    expect(pointsLabel(-1, '2026-10-01')).toBe('-1 pt vs 2026-10-01');
    expect(pointsLabel(0, '2026-10-01')).toBe('flat vs 2026-10-01');
  });
});
