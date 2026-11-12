/**
 * Trust in dashboard numbers (map #320, ADR 0001 and ADR 0013): the one queued writer of trend points.
 * Every test writes through the real `refreshSnapshotsFor` and reads back through the trend reads
 * (`getSnapshots`, `computeWidgetSummary`); no count is re-derived in a test body, apart from the formula 2
 * oracle in the equivalence test, which is kept for exactly that purpose.
 *
 * Runs on both backends: the retention, failure and interleaving tests are the ones that differ between them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db/client';
import { run } from '@/lib/db/exec';
import { dbKind } from '@/lib/db/backend';
import { postureSnapshots } from '@/lib/db/tables';
import { refreshSnapshotsFor, SNAPSHOT_FORMULA_VERSION } from '@/lib/db/snapshots';
import { listFindings } from '@/lib/db/findings';
import { loadRules } from '@/lib/rules';
import { loadSuppressions, addSuppression } from '@/lib/suppressions';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { resolveDateWindow } from '@/lib/date-window';
import { countsInFindingTotals, countsTowardPosture, isActivityRule } from '@/lib/finding-kinds';
import { isActiveSuppression } from '@/lib/suppressions';
import { FINDING_COUNT_VERSION } from '@/lib/trend-point-counts';
import { clearRules, execRaw, insertTrendPoint, resetDb, stampSubscriptionPointsFormula3 } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { fakeHierarchy, group, refreshFrom, subscription } from '../helpers/fake-hierarchy';
import { allPoints, insertRuleRow, pointOn, pointsAt, storeFindings, syntheticFinding } from '../helpers/trend-writer';

const SUB_A = '0a000000-0000-4000-8000-00000000000a';
const SUB_B = '0b000000-0000-4000-8000-00000000000b';
const SUB_C = '0c000000-0000-4000-8000-00000000000c';
const DAY_MS = 86_400_000;
const at = (date: string) => new Date(`${date}T12:00:00.000Z`);
const dayOf = (offsetDays: number) => new Date(Date.now() - offsetDays * DAY_MS).toISOString().slice(0, 10);
const TODAY = () => dayOf(0);

beforeEach(async () => {
  await resetDb();
  await clearRules();
  await execRaw('DELETE FROM posture_snapshots');
});

describe('what a point holds', () => {
  it('writes the install, every known subscription (empty and uncovered ones too) and the Directory, as version 1', async () => {
    // SUB_A is in the tree only; SUB_B is named by a rule; SUB_C holds a finding. SUB_A is upper case in the tree.
    await insertRuleRow({ id: 'r-b', subscriptions: [SUB_B] });
    await storeFindings([syntheticFinding('vm-c', [{ z: 1 }], { ruleId: 'r-b', subscriptionId: SUB_C, severity: 'critical' })]);
    await refreshFrom(fakeHierarchy([group('mg', 'Root', null), subscription(SUB_A.toUpperCase(), 'A', 'mg')]));
    await refreshSnapshotsFor(['security'], at('2026-03-10'));

    const levels = (await allPoints('security')).filter(p => p.date === '2026-03-10').map(p => p.subscriptionId).sort();
    expect(levels).toEqual(['', 'directory', SUB_A, SUB_B, SUB_C].sort());
    for (const p of await allPoints('security')) {
      expect(p.findingCountVersion).toBe(FINDING_COUNT_VERSION);
      expect(p.formulaVersion).toBe(SNAPSHOT_FORMULA_VERSION);
    }
    // The tree-only subscription has no finding and no rule naming it: the rule that does is graded elsewhere.
    expect(await pointOn('security', SUB_A, '2026-03-10')).toMatchObject({ totalRules: 0, posturePct: null, activeFindings: 0 });
    // SUB_B is covered by the rule that names it; SUB_C is not, though a finding sits in it.
    expect(await pointOn('security', SUB_B, '2026-03-10')).toMatchObject({ totalRules: 1, passingRules: 1, posturePct: 100 });
    expect(await pointOn('security', SUB_C, '2026-03-10')).toMatchObject({ totalRules: 0, activeFindings: 1 });
    expect(JSON.parse((await pointOn('security', SUB_C, '2026-03-10'))!.severityCounts)).toMatchObject({ critical: 1, high: 0 });
    expect(await pointOn('security', 'directory', '2026-03-10')).toMatchObject({ totalRules: 0, activeFindings: 0 });
  });

  it('counts each active, unsuppressed Problem finding once, by its own severity, and no Advisory or Activity finding', async () => {
    await insertRuleRow({ id: 'r-problem' });
    await insertRuleRow({ id: 'r-advisory', kind: 'advisory' });
    await storeFindings([
      syntheticFinding('vm-1', [{ z: 1 }], { ruleId: 'r-problem', subscriptionId: SUB_A, severity: 'high' }),
      syntheticFinding('vm-2', [{ z: 1 }], { ruleId: 'r-problem', subscriptionId: SUB_A, severity: 'low' }),
      syntheticFinding('vm-3', [{ z: 1 }], { ruleId: 'r-problem', subscriptionId: SUB_A, severity: 'low' }),
      syntheticFinding('adv', [{ z: 1 }], { ruleId: 'r-advisory', subscriptionId: SUB_A, severity: 'high', kind: 'advisory' }),
    ]);
    const suppressed = (await listFindings(EVERYTHING_ACCESS)).find(f => f.resourceName === 'vm-3')!;
    await addSuppression({ id: 's1', fingerprint: suppressed.fingerprint, reason: 'test', suppressedAt: new Date().toISOString() });

    await refreshSnapshotsFor(['security'], at('2026-03-10'));

    for (const level of ['', SUB_A]) {
      const p = (await pointOn('security', level, '2026-03-10'))!;
      expect(p.activeFindings).toBe(2);
      expect(JSON.parse(p.severityCounts)).toMatchObject({ high: 1, low: 1, critical: 0 });
    }
  });

  it('keeps activity_rule_count at its formula 2 meaning at every level', async () => {
    await insertRuleRow({ id: 'r-a1', queryBackend: 'log-analytics' });
    await insertRuleRow({ id: 'r-a2', queryBackend: 'log-analytics' });
    await insertRuleRow({ id: 'r-p', subscriptions: [SUB_A] });
    await refreshSnapshotsFor(['security'], at('2026-03-10'));
    for (const level of ['', SUB_A, 'directory']) expect((await pointOn('security', level, '2026-03-10'))!.activityRuleCount).toBe(2);
  });

  it('replaces a differently-cased row for today with the lower-case one', async () => {
    await insertRuleRow({ id: 'r-b', subscriptions: [SUB_B] });
    await insertTrendPoint({ category: 'security', subscriptionId: SUB_B.toUpperCase(), date: '2026-03-10', passing: 0, total: 5, formulaVersion: 2 });

    await refreshSnapshotsFor(['security'], at('2026-03-10'));

    const rows = (await allPoints('security')).filter(p => p.subscriptionId.toLowerCase() === SUB_B && p.date === '2026-03-10');
    expect(rows.map(p => p.subscriptionId)).toEqual([SUB_B]);
    expect(rows[0]).toMatchObject({ totalRules: 1 });
  });

  it('writes nothing for a category that does not exist', async () => {
    await insertRuleRow({ id: 'r-gone', category: 'gone' });
    await refreshSnapshotsFor(['gone'], at('2026-03-10'));
    expect(await allPoints('gone')).toEqual([]);
  });

  it('writes only the UTC day of the now it is given', async () => {
    await insertRuleRow({ id: 'r' });
    await refreshSnapshotsFor(['security'], new Date('2026-03-10T23:59:59.000Z'));
    await refreshSnapshotsFor(['security'], new Date('2026-03-11T00:00:01.000Z'));
    expect((await pointsAt('security', '')).map(p => p.date)).toEqual(['2026-03-10', '2026-03-11']);
  });
});

describe('formula 3 under Everything equals formula 2 (Q15)', () => {
  /** The posture formula 2 computation, kept here as the oracle the install-wide point must keep agreeing with. */
  async function formula2(category: string) {
    const rules = (await loadRules()).filter(r => r.enabled && r.category === category);
    const counted = rules.filter(countsTowardPosture);
    const suppressed = new Set((await loadSuppressions(EVERYTHING_ACCESS)).filter(isActiveSuppression).map(s => s.fingerprint));
    const failing = new Set((await listFindings(EVERYTHING_ACCESS, { status: 'active' }))
      .filter(f => f.category === category && countsInFindingTotals(f) && !suppressed.has(f.fingerprint)).map(f => f.ruleId));
    const passing = counted.filter(r => !failing.has(r.id) && r.lastRunStatus === 'success').length;
    const failed = counted.filter(r => failing.has(r.id)).length;
    return {
      passingRules: passing, totalRules: counted.length, unknownRules: counted.length - failed - passing,
      activityRuleCount: rules.filter(isActivityRule).length,
    };
  }

  it('agrees in passing, total, unknown and activity_rule_count over every kind of scope', async () => {
    await insertRuleRow({ id: 'r-unscoped' });
    await insertRuleRow({ id: 'r-sub', subscriptions: [SUB_A] });
    await insertRuleRow({ id: 'r-mg-tree', managementGroups: ['mg-known'] });
    await insertRuleRow({ id: 'r-mg-notree', managementGroups: ['mg-missing'], lastRunStatus: 'failed' });
    await insertRuleRow({ id: 'r-graph', queryBackend: 'microsoft-graph' });
    await insertRuleRow({ id: 'r-advisory', kind: 'advisory' });
    await insertRuleRow({ id: 'r-activity', queryBackend: 'log-analytics' });
    await insertRuleRow({ id: 'r-disabled', enabled: false });
    await storeFindings([
      syntheticFinding('f1', [{ z: 1 }], { ruleId: 'r-unscoped', subscriptionId: SUB_A }),
      syntheticFinding('f2', [{ z: 1 }], { ruleId: 'r-graph', placement: 'directory' }),
      syntheticFinding('f3', [{ z: 1 }], { ruleId: 'r-mg-tree', subscriptionId: SUB_B }),
      syntheticFinding('f4', [{ z: 1 }], { ruleId: 'r-sub', subscriptionId: SUB_A }),
      syntheticFinding('f5', [{ z: 1 }], { ruleId: 'r-advisory', subscriptionId: SUB_A, kind: 'advisory' }),
    ]);
    const suppressedRuleFinding = (await listFindings(EVERYTHING_ACCESS)).find(f => f.resourceName === 'f4')!;
    await addSuppression({ id: 's1', fingerprint: suppressedRuleFinding.fingerprint, reason: 'test', suppressedAt: new Date().toISOString() });
    await refreshFrom(fakeHierarchy([group('mg-known', 'Known', null), subscription(SUB_B, 'B', 'mg-known')]));

    await refreshSnapshotsFor(['security'], at('2026-03-10'));

    const oracle = await formula2('security');
    expect(oracle).toMatchObject({ totalRules: 5, passingRules: 1, unknownRules: 1 });
    expect(await pointOn('security', '', '2026-03-10')).toMatchObject(oracle);
  });
});

describe('the skip rule', () => {
  /** Moves the clock so the live read and the writer agree on the day, and returns the lines a Trend chart draws. */
  async function summaryOn(date: string, days: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at(date));
    try {
      return await computeWidgetSummary({ categories: ['security'], subscriptions: [SUB_A], dateWindow: { mode: 'relative', days } }, days, EVERYTHING_ACCESS);
    } finally {
      vi.useRealTimers();
    }
  }

  async function seedThreeDays() {
    await insertRuleRow({ id: 'r', subscriptions: [SUB_A] });
    await refreshFrom(fakeHierarchy([group('mg', 'Root', null), subscription(SUB_A, 'A', 'mg')]));
    await run(db.delete(postureSnapshots));
    await refreshSnapshotsFor(['security'], at('2026-03-01'));
    await refreshSnapshotsFor(['security'], at('2026-03-02'));
    await storeFindings([syntheticFinding('vm', [{ z: 1 }], { ruleId: 'r', subscriptionId: SUB_A })]);
    await refreshSnapshotsFor(['security'], at('2026-03-03'));
    await refreshSnapshotsFor(['security'], at('2026-03-04'));
  }

  it('writes the install every day and a subscription only on the day it changed', async () => {
    await seedThreeDays();

    expect((await pointsAt('security', '')).map(p => p.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']);
    expect((await pointsAt('security', SUB_A)).map(p => [p.date, p.activeFindings])).toEqual([['2026-03-01', 0], ['2026-03-03', 1]]);
    expect((await pointsAt('security', 'directory')).map(p => p.date)).toEqual(['2026-03-01']);
  });

  it('draws the same line and finds the same baseline with or without the skipped points', async () => {
    await seedThreeDays();
    await stampSubscriptionPointsFormula3();
    const without = await summaryOn('2026-03-04', 2);

    // The points the rule skipped, written out: the 2nd repeats the 1st, the 4th repeats the 3rd.
    for (const [date, copyOf] of [['2026-03-02', '2026-03-01'], ['2026-03-04', '2026-03-03']] as const) {
      const source = (await pointOn('security', SUB_A, copyOf))!;
      await run(db.insert(postureSnapshots).values({ ...source, date }));
    }
    const withPoints = await summaryOn('2026-03-04', 2);

    expect(without.baseline).toMatchObject({ date: '2026-03-01' });
    expect(withPoints.baseline).toEqual(without.baseline);
    expect(withPoints.deltaPct).toEqual(without.deltaPct);
    const drawn = (lines: typeof without) => lines.trendByCategory!.security!.map(p => [p.date, p.pct, p.findings, p.passing, p.total, p.formulaVersion]);
    expect(drawn(withPoints)).toEqual(drawn(without));
    expect(without.trendByCategory!.security!.map(p => p.carried)).toEqual([true, false, true]);
  });

  it('writes a point when only a version differs', async () => {
    await insertRuleRow({ id: 'r', subscriptions: [SUB_A] });
    await refreshSnapshotsFor(['security'], at('2026-03-01'));
    await run(db.update(postureSnapshots).set({ findingCountVersion: 0 }));
    await refreshSnapshotsFor(['security'], at('2026-03-02'));
    expect((await pointsAt('security', SUB_A)).map(p => p.date)).toEqual(['2026-03-01', '2026-03-02']);
  });
});

describe('retention', () => {
  it('keeps 365 days and each level\'s newest older point, and gives a deleted category no exception', async () => {
    await insertRuleRow({ id: 'r', subscriptions: [SUB_A] });
    // 40 days before the cutoff is the newest older point of the subscription; the point before it is not kept.
    await insertTrendPoint({ category: 'security', subscriptionId: SUB_A, date: dayOf(405), passing: 1, total: 1 });
    await insertTrendPoint({ category: 'security', subscriptionId: SUB_A, date: dayOf(410), passing: 0, total: 1 });
    await insertTrendPoint({ category: 'security', subscriptionId: '', date: dayOf(380), passing: 1, total: 1, formulaVersion: 2 });
    await insertTrendPoint({ category: 'security', subscriptionId: '', date: dayOf(400), passing: 0, total: 1, formulaVersion: 2 });
    await insertTrendPoint({ category: 'security', subscriptionId: SUB_B.toUpperCase(), date: dayOf(500), passing: 1, total: 1 });
    await insertTrendPoint({ category: 'security', subscriptionId: SUB_B, date: dayOf(450), passing: 1, total: 1 });
    await insertTrendPoint({ category: 'gone', subscriptionId: '', date: dayOf(366), passing: 1, total: 1, formulaVersion: 2 });
    await insertTrendPoint({ category: 'gone', subscriptionId: '', date: dayOf(100), passing: 1, total: 1, formulaVersion: 2 });

    await refreshSnapshotsFor(['security']);

    expect((await pointsAt('security', SUB_A)).map(p => p.date)).toEqual([dayOf(405), TODAY()]);
    expect((await pointsAt('security', '')).map(p => p.date)).toEqual([dayOf(380), TODAY()]);
    // The same level in two cases is one level: only its newest point older than the cutoff is kept.
    expect((await pointsAt('security', SUB_B)).map(p => p.date)).toEqual([dayOf(450)]);
    expect((await pointsAt('gone', '')).map(p => p.date)).toEqual([dayOf(100)]);
  });

  it('finds the 365-day baseline for a subscription last written 40 days before the cutoff, and carries it onto the first day', async () => {
    await insertRuleRow({ id: 'r', subscriptions: [SUB_A] });
    await insertTrendPoint({ category: 'security', subscriptionId: SUB_A, date: dayOf(405), passing: 1, total: 2, activeFindings: 3 });
    await insertTrendPoint({ category: 'security', subscriptionId: SUB_A, date: dayOf(410), passing: 0, total: 2 });
    await refreshSnapshotsFor(['security']);

    const summary = await computeWidgetSummary(
      { categories: ['security'], subscriptions: [SUB_A], dateWindow: { mode: 'relative', days: 365 } }, 365, EVERYTHING_ACCESS);

    expect(summary.baseline).toMatchObject({ date: dayOf(405) });
    const line = summary.trendByCategory!.security!;
    expect(line[0]).toMatchObject({ date: resolveDateWindow({ mode: 'relative', days: 365 }).from, carried: true, findings: 3 });
    expect(line.at(-1)).toMatchObject({ date: TODAY(), carried: false });
  });
});

describe('the queue', () => {
  it('serializes overlapping refreshes, so the last write reflects the latest state', async () => {
    await insertRuleRow({ id: 'r' });
    const first = refreshSnapshotsFor(['security'], new Date('2026-03-10T08:00:00.000Z'));
    await insertRuleRow({ id: 'r2' });
    const second = refreshSnapshotsFor(['security'], new Date('2026-03-10T09:00:00.000Z'));
    const third = refreshSnapshotsFor(['security'], new Date('2026-03-10T10:00:00.000Z'));
    await Promise.all([first, second, third]);

    const point = (await pointOn('security', '', '2026-03-10'))!;
    expect(point.updatedAt).toBe('2026-03-10T10:00:00.000Z');
    expect(point.totalRules).toBe(2);
    expect((await pointsAt('security', '')).filter(p => p.date === '2026-03-10')).toHaveLength(1);
  });
});

describe('a failed write', () => {
  /** A trigger that refuses the point of one subscription in one category, to fail a write part way through it. */
  async function failInserts(category: string, level: string) {
    if (dbKind === 'pg') {
      await execRaw(`CREATE OR REPLACE FUNCTION trend_fail() RETURNS trigger AS $$ BEGIN
        IF NEW.category = '${category}' AND NEW.subscription_id = '${level}' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await execRaw('CREATE TRIGGER trend_fail BEFORE INSERT ON posture_snapshots FOR EACH ROW EXECUTE FUNCTION trend_fail()');
    } else {
      await execRaw(`CREATE TRIGGER trend_fail BEFORE INSERT ON posture_snapshots
        WHEN NEW.category = '${category}' AND NEW.subscription_id = '${level}' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    }
  }
  afterEach(async () => {
    await execRaw('DROP TRIGGER IF EXISTS trend_fail ON posture_snapshots'.replace(' ON posture_snapshots', dbKind === 'pg' ? ' ON posture_snapshots' : ''));
  });

  it('leaves no half-written category, writes the others, logs it and does not throw', async () => {
    // 250 subscriptions are three batches of inserts: the failing one is in the last, after two went in.
    const nodes = [group('mg', 'Root', null), ...Array.from({ length: 250 }, (_, i) => subscription(`sub-${String(i).padStart(3, '0')}`, `sub-${String(i).padStart(3, '0')}`, 'mg'))];
    await refreshFrom(fakeHierarchy(nodes));
    await run(db.delete(postureSnapshots));
    await failInserts('security', 'sub-249');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(refreshSnapshotsFor(['security', 'cost'], at('2026-03-10'))).resolves.toBeUndefined();

    expect(await allPoints('security')).toEqual([]);
    expect((await pointsAt('cost', 'sub-249')).length).toBe(1);
    expect((await pointsAt('cost', '')).length).toBe(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('"security"'), expect.anything());
    logged.mockRestore();
  });

  it('keeps the points of the day before when the write fails', async () => {
    await insertRuleRow({ id: 'r' });
    await refreshSnapshotsFor(['security'], at('2026-03-09'));
    const before = await allPoints('security');
    await failInserts('security', '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await refreshSnapshotsFor(['security'], at('2026-03-10'));

    expect(await allPoints('security')).toEqual(before);
    logged.mockRestore();
  });
});
