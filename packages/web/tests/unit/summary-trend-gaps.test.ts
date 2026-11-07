/**
 * What the summary tells a chart about which days exist: a day recorded under an earlier posture formula
 * is marked so the trend can draw it as a gap, and the days a snapshot exists are listed so a chart of
 * event counts can tell a day with nothing to report from a day nobody recorded.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { upsertDailySnapshot } from '@/lib/db/snapshots';
import { db } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { postureSnapshots } from '@/lib/db/tables';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { everythingAccess } from '@/lib/access-model';

async function summary(filters: Record<string, unknown> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
  return computeWidgetSummary({ dateWindow: { mode: 'relative', days: 7 }, ...filters }, 30, everythingAccess('admin'));
}

afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  await resetDb();
  const f = (name: string) => syntheticFinding(name, [{ zone: 'a' }], { ruleId: 'gap-rule', subscriptionId: '00000000-0000-0000-0000-00000000000a', resourceGroup: 'rg-one' });
  for (const [id, day] of [['e1', '2026-06-01'], ['e2', '2026-06-02'], ['e3', '2026-06-04']] as const) {
    await storeScan([f('a1')], { scanId: `00000000-0000-0000-0000-0000000000${id}`, finishedAt: `${day}T10:00:00.000Z` });
    await upsertDailySnapshot('security', new Date(`${day}T10:00:00.000Z`));
  }
  await run(db.update(postureSnapshots).set({ formulaVersion: 1 }).where(eq(postureSnapshots.date, '2026-06-02')));
});

describe('the summary trend and the days it records', () => {
  it('marks a day written under an earlier formula, and only that day', async () => {
    const { trend } = await summary();
    expect(trend.map(p => [p.date, p.earlierFormula])).toEqual([['2026-06-01', false], ['2026-06-02', true], ['2026-06-04', false]]);
  });

  it('marks it on the per-category series too', async () => {
    const { trendByCategory } = await summary({ categories: ['security'] });
    expect(trendByCategory!.security!.map(p => p.earlierFormula)).toEqual([false, true, false]);
  });

  it('lists each day a snapshot exists, so 2026-06-03 is not one of them', async () => {
    expect((await summary()).recordedDays).toEqual(['2026-06-01', '2026-06-02', '2026-06-04']);
  });

  it('lists no recorded days when the filter keeps no snapshots', async () => {
    expect((await summary({ severities: ['high'] })).recordedDays).toBeNull();
  });
});
