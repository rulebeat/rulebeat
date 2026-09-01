/**
 * Spec 033(a) — the trend chart tooltip must read "passing/total (pct%)", not a bare percentage,
 * so a posture move is legible without cross-referencing another widget. Tested at the extracted
 * pure function rather than by rendering TrendWidget: this codebase has no React component-rendering
 * test layer (see tests/unit/toggle-set.test.ts's own note — Vitest runs environment: 'node', no
 * @testing-library/react), so the formatting logic lives in dashboard-constants.ts precisely so it
 * can be exercised directly.
 */
import { describe, expect, it } from 'vitest';
import { formatTrendTooltipLabel } from '@/components/dashboard/dashboard-constants';

describe('formatTrendTooltipLabel (spec 033)', () => {
  it('reads passing/total off the prefixed per-category fields when present', async () => {
    const payload = { date: '2026-08-01', security: 75, security__passing: 3, security__total: 4 };
    expect(formatTrendTooltipLabel('security', 75, payload)).toBe('3/4 passing (75%)');
  });

  it('falls back to the unprefixed fields for the single-category chart shape', async () => {
    const payload = { date: '2026-08-01', pct: 25, passing: 1, total: 4 };
    expect(formatTrendTooltipLabel('pct', 25, payload)).toBe('1/4 passing (25%)');
  });

  it('falls back to a bare percentage when no passing/total is on the row at all', async () => {
    const payload = { date: '2026-08-01', security: 75 };
    expect(formatTrendTooltipLabel('security', 75, payload)).toBe('75%');
  });
});
