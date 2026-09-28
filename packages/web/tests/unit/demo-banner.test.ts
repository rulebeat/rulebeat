/**
 * The Demo banner tells a Visitor when the Demo resets next. The wording rounds up, so the banner
 * never promises more time than there is.
 */
import { describe, expect, it } from 'vitest';
import { describeNextReset } from '@/components/layout/demo-banner-status';

const at = (minutes: number, seconds = 0) => new Date(Date.UTC(2026, 0, 10, 15, minutes, seconds));
const now = at(0);

describe('describeNextReset()', () => {
  it('counts whole minutes, rounding up', () => {
    expect(describeNextReset(at(42), now)).toBe('It resets in 42 minutes.');
    expect(describeNextReset(at(41, 1), now)).toBe('It resets in 42 minutes.');
  });

  it('says under a minute for the last minute, and any moment once the time has passed', () => {
    expect(describeNextReset(at(0, 30), now)).toBe('It resets in under a minute.');
    expect(describeNextReset(at(0), now)).toBe('It resets any moment now.');
    expect(describeNextReset(now, at(1))).toBe('It resets any moment now.');
  });

  it('switches to hours for a long interval', () => {
    expect(describeNextReset(new Date(now.getTime() + 180 * 60_000), now)).toBe('It resets in 3 hours.');
  });
});
