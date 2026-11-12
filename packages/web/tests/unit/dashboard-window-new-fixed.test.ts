/**
 * New, Fixed and the New vs Fixed bars are the Scans lists for the dashboard's date window. The summary
 * is read through computeWidgetSummary, the Scans lists through the view engine (queryView), over
 * findings a scan stored with their real lifecycle: opened, fixed, reactivated, suppressed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { syncScanFindings } from '@/lib/db/findings';
import { queryView } from '@/lib/db/finding-views';
import { emptyView, type View } from '@/lib/finding-view';
import { saveSuppressions } from '@/lib/suppressions';
import { resolveDateWindow, todayKey, type DateWindow } from '@/lib/date-window';
import { newVsFixedBarHref } from '@/lib/scans-link';
import { viewFromSearchParams } from '@/lib/finding-view';
import { trendRetentionNote, activityRetentionNote } from '@/lib/widget-limits';
import type { Finding } from '@/lib/types';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

const RULE = 'nvf-rule';
const ADVISORY_RULE = 'nvf-advisory';
const CATEGORY = 'security';
const DAY_MS = 86_400_000;

/** Noon UTC, `n` days ago, so a day key never depends on the time the test runs at. Today is "now". */
function at(n: number): string {
  return n === 0 ? new Date().toISOString() : new Date(`${new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10)}T12:00:00.000Z`).toISOString();
}
const dayKey = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

function finding(name: string, ruleId = RULE, kind?: Finding['kind']): Finding {
  const resourceId = `/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${name}`;
  return {
    module: CATEGORY, ruleId, fingerprint: computeFingerprint(ruleId, resourceId), severity: 'medium', category: CATEGORY,
    resourceId, resourceType: 'microsoft.compute/virtualmachines', resourceName: name, subscriptionId: 'sub-1', resourceGroup: 'rg1',
    ...(kind ? { kind } : {}),
    title: 't', description: 'd', evidence: {}, recommendation: 'r', remediationSteps: [], detectedAt: new Date().toISOString(),
  };
}

let n = 0;
async function scan(daysAgo: number, findings: Finding[]): Promise<void> {
  await syncScanFindings({
    scanId: `scan-${++n}`, category: CATEGORY, ranRuleIds: [RULE, ADVISORY_RULE], findings, finishedAt: at(daysAgo),
  });
}

/** The count of the Scans list for a status over a window: what the dashboard's number must equal. */
async function scansCount(status: 'new' | 'fixed', window: DateWindow): Promise<number> {
  const view: View = { ...emptyView(), filters: [{ field: 'status', values: [status] }], window };
  return (await queryView(view, { tab: 'results', showSuppressed: false }, EVERYTHING_ACCESS)).total;
}

const sevenDays: DateWindow = { mode: 'relative', days: 7 };

beforeEach(async () => {
  await resetDb();
  n = 0;
  const a = finding('vm-a');          // opened 2 days ago, still open
  const b = finding('vm-b');          // opened 10 days ago, fixed yesterday
  const c = finding('vm-c');          // opened 3 days ago and fixed 2 days ago, both inside the window
  const d = finding('vm-d');          // opened 20 days ago, fixed 5 days ago, reactivated yesterday
  const e = finding('vm-e');          // opened yesterday, then suppressed
  const adv = finding('vm-adv', ADVISORY_RULE, 'advisory');
  await scan(20, [d]);
  await scan(10, [d, b]);
  await scan(5, [b]);
  await scan(3, [b, c]);
  await scan(2, [b, a]);
  await scan(1, [a, d, e]);
  await scan(0, [a, d, e, adv]);
  await saveSuppressions([{ id: 's1', fingerprint: e.fingerprint, resourceId: e.resourceId!, reason: 'test', suppressedAt: at(0) }]);
});

describe('New and Fixed for the dashboard window', () => {
  it('count exactly the Scans New and Fixed lists', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: sevenDays }, EVERYTHING_ACCESS);
    expect(summary.current.newInWindow).toBe(await scansCount('new', sevenDays));
    expect(summary.current.fixedInWindow).toBe(await scansCount('fixed', sevenDays));
    expect(summary.current.newInWindow).toBe(1);
    expect(summary.current.fixedInWindow).toBe(2);
    expect(summary.deltaFindings).toBe(-1);
  });

  it('do not count a reactivated finding with an old first-seen date as New', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: sevenDays }, EVERYTHING_ACCESS);
    // vm-d was reactivated yesterday but first seen 20 days ago.
    expect(summary.current.newInWindow).toBe(1);
  });

  it('count a finding opened and fixed inside the window only as Fixed', async () => {
    const today: DateWindow = { mode: 'relative', days: 4 };
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: today }, EVERYTHING_ACCESS);
    // vm-c opened (day 3) and fixed (day 2) inside a 4-day window: Fixed, not New.
    expect(summary.current.newInWindow).toBe(await scansCount('new', today));
    expect(summary.current.fixedInWindow).toBe(await scansCount('fixed', today));
    expect(summary.current.newInWindow).toBe(1);
    expect(summary.current.fixedInWindow).toBe(2);
  });

  it('read a window of one day as today only', async () => {
    const one: DateWindow = { mode: 'relative', days: 1 };
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: one }, EVERYTHING_ACCESS);
    expect(summary.current.newInWindow).toBe(0);
    expect(summary.current.fixedInWindow).toBe(0);
  });
});

describe('the New vs Fixed bars', () => {
  it('hold one zero-filled bar per day of the window, oldest first', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: sevenDays }, EVERYTHING_ACCESS);
    const { from, to } = resolveDateWindow(sevenDays);
    expect(summary.newVsFixedTrend).toHaveLength(7);
    expect(summary.newVsFixedTrend[0]!.date).toBe(from);
    expect(summary.newVsFixedTrend[6]!.date).toBe(to);
    expect(summary.newVsFixedTrend.map(b => b.date)).toEqual([6, 5, 4, 3, 2, 1, 0].map(dayKey));
  });

  it('hold one bar for the one-day window', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 1 } }, EVERYTHING_ACCESS);
    expect(summary.newVsFixedTrend.map(b => b.date)).toEqual([todayKey()]);
  });

  it('equal the one-day Scans list each opens', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: sevenDays }, EVERYTHING_ACCESS);
    for (const bar of summary.newVsFixedTrend) {
      const day: DateWindow = { mode: 'custom', from: bar.date, to: bar.date };
      expect(bar.created, `New on ${bar.date}`).toBe(await scansCount('new', day));
      expect(bar.resolved, `Fixed on ${bar.date}`).toBe(await scansCount('fixed', day));
    }
    // And the fixture is not trivially empty: yesterday's fix and the day-before's fix are both there.
    expect(summary.newVsFixedTrend.find(b => b.date === dayKey(1))).toMatchObject({ created: 0, resolved: 1 });
    expect(summary.newVsFixedTrend.find(b => b.date === dayKey(2))).toMatchObject({ created: 1, resolved: 1 });
  });

  it('open the one-day Scans list holding exactly their number', async () => {
    const filters = { categories: [CATEGORY], dateWindow: sevenDays };
    const summary = await computeWidgetSummary(filters, EVERYTHING_ACCESS);
    for (const bar of summary.newVsFixedTrend) {
      for (const [status, expected] of [['new', bar.created], ['fixed', bar.resolved]] as const) {
        const href = newVsFixedBarHref(filters, bar.date, status);
        const view = viewFromSearchParams(new URLSearchParams(href.split('?')[1]));
        const opened = (await queryView(view, { tab: 'results', showSuppressed: false }, EVERYTHING_ACCESS)).total;
        expect(opened, `${status} on ${bar.date}`).toBe(expected);
      }
    }
  });

  it('do not count a reactivation as new, a suppressed finding, or an advisory', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: sevenDays }, EVERYTHING_ACCESS);
    const created = summary.newVsFixedTrend.reduce((sum, b) => sum + b.created, 0);
    expect(created).toBe(1);
    expect(summary.newVsFixedTrend.find(b => b.date === dayKey(1))!.created).toBe(0);
    expect(summary.newVsFixedTrend.find(b => b.date === dayKey(0))!.created).toBe(0);
  });

  it('sum to the New and Fixed numbers', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: sevenDays }, EVERYTHING_ACCESS);
    expect(summary.newVsFixedTrend.reduce((sum, b) => sum + b.created, 0)).toBe(summary.current.newInWindow);
    expect(summary.newVsFixedTrend.reduce((sum, b) => sum + b.resolved, 0)).toBe(summary.current.fixedInWindow);
  });
});

describe('the retention notes', () => {
  it('say nothing while the window sits inside the kept data', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 365 } }, EVERYTHING_ACCESS);
    expect(summary.trendRetentionNote).toBeNull();
    const activity = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 180 } }, EVERYTHING_ACCESS);
    expect(activity.activityRetentionNote).toBeNull();
  });

  it('name the first day the chart can draw once the window reaches past it', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'relative', days: 400 } }, EVERYTHING_ACCESS);
    expect(summary.trendRetentionNote).toBe(trendRetentionNote(dayKey(364)));
    expect(summary.activityRetentionNote).toBe(activityRetentionNote(dayKey(179)));
  });

  it('apply to a custom range that starts before the kept data', async () => {
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: { mode: 'custom', from: dayKey(500), to: dayKey(450) } }, EVERYTHING_ACCESS);
    expect(summary.trendRetentionNote).toBe(trendRetentionNote(dayKey(364)));
  });
});
