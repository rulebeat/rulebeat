/**
 * #276: Run History for a person below Everything. A run's list entry, its snapshot and its counts are
 * recounted from the per-finding records of its scans inside the person's access, never read from the
 * totals the run stored; a snapshot and a compare list, count and offer facets only for records inside it;
 * a scan with no records reads as unavailable, never 0. An Everything reader gets what was stored.
 *
 * The seed is written through the real write paths (`saveScanResult`, `startRun`, `recordCategoryProgress`),
 * and every expectation is written by hand from it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { scans as scansTable, scheduleRuns } from '@/lib/db/tables';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import { getLatestRun, getRun, listAllRuns, listRuns, finishRun, recordCategoryProgress, startRun } from '@/lib/schedule-runs';
import { getScansForRun, listScanMetas, saveScanResult } from '@/lib/scan-history';
import { openSnapshotExport, querySnapshot } from '@/lib/db/scan-snapshots';
import { queryCompare } from '@/lib/db/scan-compare';
import { emptySnapshotQuery } from '@/lib/snapshot-query';
import { emptyCompareQuery } from '@/lib/compare-query';
import { emptySeverityCounts } from '@/lib/severity';
import { OUTSIDE_ACCESS_LABEL } from '@/lib/outside-access';
import type { Finding, Severity } from '@/lib/types';
import { resetDb } from '../helpers/db';
import { syntheticFinding } from '../helpers/synthetic-findings';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const RULE = 'history-rule';
const SCHEDULE = 'schedule-1';

const viewerAt = (...paths: string[]): Access =>
  buildAccess(paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })), 'manual');
const EVERYTHING = everythingAccess('admin');
const ON_A = viewerAt(`/subscriptions/${SUB_A}`);
const ON_A_GROUP = viewerAt(`/subscriptions/${SUB_A}/resourceGroups/rg-one`);
const ON_B = viewerAt(`/subscriptions/${SUB_B}`);
const NOTHING = viewerAt();

const finding = (name: string, sub: string, rg: string, severity: Severity): Finding =>
  ({ ...syntheticFinding(name, [{ zone: 'a' }], { ruleId: RULE, subscriptionId: sub, resourceGroup: rg, severity }) });

const A1 = finding('a1', SUB_A, 'rg-one', 'critical');
const A2 = finding('a2', SUB_A, 'rg-two', 'high');
const B1 = finding('b1', SUB_B, 'rg-one', 'critical');

function summaryOf(id: string, startedAt: string, findings: Finding[], subscriptionsScanned: string[]) {
  const counts = emptySeverityCounts();
  for (const f of findings) counts[f.severity]++;
  return {
    id, module: 'security', startedAt, finishedAt: startedAt, durationMs: 1, subscriptionsScanned, findings, counts,
    totalRules: 1, coverage: 'complete' as const, incompleteRules: [],
  };
}

let runId: string;
let scopedRunId: string;
let emptyRunId: string;
const SCAN_ALL = '00000000-0000-0000-0000-0000000000f1';
const SCAN_OLDER = '00000000-0000-0000-0000-0000000000f0';
const SCAN_SCOPED = '00000000-0000-0000-0000-0000000000f2';
const SCAN_NO_RECORDS = '00000000-0000-0000-0000-0000000000f3';
const SCAN_OTHER_SCOPE = '00000000-0000-0000-0000-0000000000f4';

beforeAll(async () => {
  await resetDb();

  // One run of Everything: a scan with all three findings, two of them new, one of them changed. The totals the run
  // stored are deliberately wrong for anyone who counts from them (999 and 99).
  const run = await startRun({ scheduleId: SCHEDULE, triggeredBy: 'schedule', categories: ['security'], now: new Date('2026-06-02T00:00:00.000Z') });
  runId = run.id;
  await saveScanResult('security', summaryOf(SCAN_ALL, '2026-06-02T00:00:00.000Z', [A1, A2, B1], [SUB_A, SUB_B]), { id: SCAN_ALL, runId });
  await recordCategoryProgress(runId, {
    totalFindings: 999, newFindings: 99, newFindingFingerprints: [A1.fingerprint, B1.fingerprint],
    changedFindings: [{ fingerprint: B1.fingerprint, addedRows: [{ secret: 'row of another team' }] }, { fingerprint: A2.fingerprint, addedRows: [{ zone: 'z' }] }],
  });
  await finishRun(runId, { status: 'success', totalFindings: 999, newFindings: 99, newFindingFingerprints: [A1.fingerprint, B1.fingerprint], durationMs: 1, now: new Date('2026-06-02T00:01:00.000Z') });

  // An older scan of Everything, for the compare.
  await saveScanResult('security', summaryOf(SCAN_OLDER, '2026-06-01T00:00:00.000Z', [A1, B1], [SUB_A, SUB_B]), { id: SCAN_OLDER });

  // A run that covered subscription A only, with only subscription A's findings.
  const scoped = await startRun({
    scheduleId: SCHEDULE, triggeredBy: 'manual', categories: ['security'], now: new Date('2026-06-03T00:00:00.000Z'),
    coveredScope: [{ tenantId: 't', path: `/subscriptions/${SUB_A}` }],
  });
  scopedRunId = scoped.id;
  await saveScanResult('security', summaryOf(SCAN_SCOPED, '2026-06-03T00:00:00.000Z', [A1, A2], [SUB_A]), {
    id: SCAN_SCOPED, runId: scopedRunId, coveredScope: [{ tenantId: 't', path: `/subscriptions/${SUB_A}` }],
  });
  await saveScanResult('security', summaryOf(SCAN_OTHER_SCOPE, '2026-06-03T01:00:00.000Z', [B1], [SUB_B]), {
    id: SCAN_OTHER_SCOPE, coveredScope: [{ tenantId: 't', path: `/subscriptions/${SUB_B}` }],
  });
  await finishRun(scopedRunId, { status: 'success', totalFindings: 2, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date('2026-06-03T00:01:00.000Z') });

  // A run whose scan has no stored records, as an earlier release saved it.
  const empty = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: ['security'], now: new Date('2026-06-04T00:00:00.000Z') });
  emptyRunId = empty.id;
  await saveScanResult('security', summaryOf(SCAN_NO_RECORDS, '2026-06-04T00:00:00.000Z', [A1], [SUB_A]), { id: SCAN_NO_RECORDS, runId: emptyRunId });
  await execRun(db.update(scansTable).set({ hasRecords: 0 }).where(eq(scansTable.id, SCAN_NO_RECORDS)));
  await finishRun(emptyRunId, { status: 'success', totalFindings: 1, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date('2026-06-04T00:01:00.000Z') });
});

describe('the run list and a run\'s detail', () => {
  const totals = (r: { totalFindings: number; newFindings: number; countsUnavailable: boolean }) => [r.totalFindings, r.newFindings, r.countsUnavailable];

  it('gives Everything the totals as stored', async () => {
    expect(totals((await getRun(runId, EVERYTHING))!)).toEqual([999, 99, false]);
    expect((await getRun(runId, EVERYTHING))!.changedFindings.map(c => c.fingerprint)).toEqual([B1.fingerprint, A2.fingerprint]);
  });

  it('recounts for a person below Everything from the records inside their access, not from the stored totals', async () => {
    expect(totals((await getRun(runId, ON_A))!)).toEqual([2, 1, false]);
    expect(totals((await getRun(runId, ON_A_GROUP))!)).toEqual([1, 1, false]);
    expect(totals((await getRun(runId, ON_B))!)).toEqual([1, 1, false]);
    expect(totals((await getRun(runId, NOTHING))!)).toEqual([0, 0, false]);
  });

  it('narrows the new and changed fingerprints the same way', async () => {
    const run = (await getRun(runId, ON_A))!;
    expect(run.newFindingFingerprints).toEqual([A1.fingerprint]);
    // The rows of a finding in another team's subscription never reach this person.
    expect(run.changedFindings.map(c => c.fingerprint)).toEqual([A2.fingerprint]);
    expect(JSON.stringify(await getRun(runId, ON_A))).not.toContain('row of another team');
    expect((await getRun(runId, ON_B))!.changedFindings.map(c => c.fingerprint)).toEqual([B1.fingerprint]);
    expect((await getRun(runId, NOTHING))!.newFindingFingerprints).toEqual([]);
  });

  it('gives the same numbers from the list, a schedule\'s runs and its latest run', async () => {
    const fromList = (await listAllRuns(ON_A, 10)).find(r => r.id === runId)!;
    const fromSchedule = (await listRuns(SCHEDULE, ON_A, 10)).find(r => r.id === runId)!;
    expect(totals(fromList)).toEqual([2, 1, false]);
    expect(totals(fromSchedule)).toEqual([2, 1, false]);
    // The latest run of the schedule is the one that covered subscription A only.
    expect((await getLatestRun(SCHEDULE, ON_A))!.id).toBe(scopedRunId);
    expect(totals((await getLatestRun(SCHEDULE, ON_A))!)).toEqual([2, 0, false]);
    expect(totals((await getLatestRun(SCHEDULE, ON_B))!)).toEqual([0, 0, false]);
  });

  it('says the counts are unavailable for a run with a scan that has no records, and never reads 0', async () => {
    expect((await getRun(emptyRunId, ON_A))!.countsUnavailable).toBe(true);
    expect((await getRun(emptyRunId, NOTHING))!.countsUnavailable).toBe(true);
    expect((await getRun(emptyRunId, EVERYTHING))!.countsUnavailable).toBe(false);
    expect((await getRun(emptyRunId, EVERYTHING))!.totalFindings).toBe(1);
  });

  it('labels the covered Scope of each run, and an entry outside the reader\'s access as outside', async () => {
    expect((await getRun(runId, ON_A))!.coveredScope.entries).toEqual([{ label: 'Everything', outside: false }]);
    expect((await getRun(scopedRunId, EVERYTHING))!.coveredScope.entries).toEqual([{ label: `/subscriptions/${SUB_A}`, outside: false }]);
    expect((await getRun(scopedRunId, ON_A))!.coveredScope.entries).toEqual([{ label: `/subscriptions/${SUB_A}`, outside: false }]);
    for (const outside of [ON_B, ON_A_GROUP, NOTHING]) {
      const run = (await getRun(scopedRunId, outside))!;
      expect(run.coveredScope.entries).toEqual([{ label: OUTSIDE_ACCESS_LABEL, outside: true }]);
      expect(JSON.stringify(run)).not.toContain(SUB_A);
    }
  });

  it('gives two runs that covered the same Scope one key, and different Scopes different keys, without printing a Scope', async () => {
    const everything = (await getRun(runId, ON_B))!.coveredScope.key;
    const scoped = (await getRun(scopedRunId, ON_B))!.coveredScope.key;
    expect(everything).not.toBe(scoped);
    expect((await getRun(emptyRunId, ON_B))!.coveredScope.key).toBe(everything);
    expect(scoped).not.toContain(SUB_A);
  });
});

describe('a run\'s scans', () => {
  it('recounts the severities from the records inside the access, and narrows the subscriptions scanned', async () => {
    const [everything] = await getScansForRun(runId, EVERYTHING);
    expect(everything).toMatchObject({ counts: { critical: 2, high: 1, medium: 0, low: 0, info: 0 }, subscriptionsScanned: [SUB_A, SUB_B], countsUnavailable: false });

    const [onA] = await getScansForRun(runId, ON_A);
    expect(onA).toMatchObject({ counts: { critical: 1, high: 1, medium: 0, low: 0, info: 0 }, subscriptionsScanned: [SUB_A], countsUnavailable: false });
    const [onGroup] = await getScansForRun(runId, ON_A_GROUP);
    expect(onGroup).toMatchObject({ counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, subscriptionsScanned: [SUB_A] });
    const [onB] = await getScansForRun(runId, ON_B);
    expect(onB).toMatchObject({ counts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, subscriptionsScanned: [SUB_B] });
    const [nothing] = await getScansForRun(runId, NOTHING);
    expect(nothing).toMatchObject({ counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, subscriptionsScanned: [], countsUnavailable: false });
  });

  it('does the same for the history list of a category', async () => {
    const asSeen = async (access: Access) => (await listScanMetas('security', access, 10)).find(m => m.id === SCAN_ALL)!;
    expect((await asSeen(EVERYTHING)).counts.critical).toBe(2);
    expect((await asSeen(ON_A)).counts.critical).toBe(1);
    expect((await asSeen(ON_B)).subscriptionsScanned).toEqual([SUB_B]);
  });

  it('marks a scan with no records unavailable for a person below Everything, with the counts it stored for Everything', async () => {
    const [noRecords] = await getScansForRun(emptyRunId, ON_A);
    expect(noRecords).toMatchObject({ id: SCAN_NO_RECORDS, countsUnavailable: true });
    const [stored] = await getScansForRun(emptyRunId, EVERYTHING);
    expect(stored).toMatchObject({ countsUnavailable: false, counts: { critical: 1 } });
  });

  it('labels the covered Scope of each scan', async () => {
    const metas = await listScanMetas('security', ON_B, 10);
    const label = (id: string) => metas.find(m => m.id === id)!.coveredScope.entries.map(e => e.label);
    expect(label(SCAN_ALL)).toEqual(['Everything']);
    expect(label(SCAN_SCOPED)).toEqual([OUTSIDE_ACCESS_LABEL]);
    expect(label(SCAN_OTHER_SCOPE)).toEqual([`/subscriptions/${SUB_B}`]);
    expect(new Set(metas.map(m => m.coveredScope.key)).size).toBe(3);
  });
});

describe('a snapshot', () => {
  const names = (items: { resourceName: string | null }[]) => items.map(i => i.resourceName).sort();

  it('lists, counts and offers facets for only the records inside the access', async () => {
    const read = async (access: Access, query = emptySnapshotQuery()) => {
      const answer = await querySnapshot(SCAN_ALL, query, access);
      if (answer.status !== 'ok') throw new Error(answer.status);
      return answer.response;
    };
    const everything = await read(EVERYTHING);
    expect([everything.total, names(everything.items)]).toEqual([3, ['a1', 'a2', 'b1']]);

    const onA = await read(ON_A);
    expect([onA.total, names(onA.items)]).toEqual([2, ['a1', 'a2']]);
    expect(onA.facets.severity).toEqual([{ value: 'critical', label: 'critical', count: 1 }, { value: 'high', label: 'high', count: 1 }]);
    expect(onA.facets.rule.map(f => [f.value, f.count])).toEqual([[RULE, 2]]);

    const onGroup = await read(ON_A_GROUP);
    expect([onGroup.total, names(onGroup.items)]).toEqual([1, ['a1']]);
    expect(onGroup.facets.severity).toEqual([{ value: 'critical', label: 'critical', count: 1 }]);

    const nothing = await read(NOTHING);
    expect([nothing.total, nothing.items, nothing.facets.severity, nothing.facets.rule]).toEqual([0, [], [], []]);
  });

  it('narrows a filtered read the same way, so a filter cannot reach past the access', async () => {
    const answer = await querySnapshot(SCAN_ALL, { ...emptySnapshotQuery(), severity: ['critical'] }, ON_A);
    expect(answer.status === 'ok' && names(answer.response.items)).toEqual(['a1']);
    const searched = await querySnapshot(SCAN_ALL, { ...emptySnapshotQuery(), search: 'b1' }, ON_A);
    expect(searched.status === 'ok' && searched.response.total).toBe(0);
  });

  it('narrows the export to the same records', async () => {
    const exported = async (access: Access) => {
      const records: { resourceName: string | null }[] = [];
      await openSnapshotExport(SCAN_ALL, emptySnapshotQuery(), access)(async source => {
        for await (const batch of source.batches()) records.push(...batch);
      });
      return names(records);
    };
    expect(await exported(EVERYTHING)).toEqual(['a1', 'a2', 'b1']);
    expect(await exported(ON_A)).toEqual(['a1', 'a2']);
    expect(await exported(ON_B)).toEqual(['b1']);
    expect(await exported(NOTHING)).toEqual([]);
  });

  it('is still no-records for a scan with none, whoever asks', async () => {
    expect((await querySnapshot(SCAN_NO_RECORDS, emptySnapshotQuery(), ON_A)).status).toBe('no-records');
  });
});

describe('a compare', () => {
  // Older: a1, b1. Newer: a1, a2, b1. So a2 was added and nothing was fixed.
  const totalsFor = async (access: Access) => {
    const answer = await queryCompare(SCAN_OLDER, SCAN_ALL, emptyCompareQuery(), access);
    if (answer.status !== 'ok') throw new Error(answer.status);
    return { totals: answer.response.totals, added: answer.response.items.map(i => i.resourceName) };
  };

  it('narrows every side and total by access', async () => {
    expect(await totalsFor(EVERYTHING)).toEqual({ totals: { added: 1, fixed: 0, persisted: 2 }, added: ['a2'] });
    expect(await totalsFor(ON_A)).toEqual({ totals: { added: 1, fixed: 0, persisted: 1 }, added: ['a2'] });
    expect(await totalsFor(ON_A_GROUP)).toEqual({ totals: { added: 0, fixed: 0, persisted: 1 }, added: [] });
    expect(await totalsFor(ON_B)).toEqual({ totals: { added: 0, fixed: 0, persisted: 1 }, added: [] });
    expect(await totalsFor(NOTHING)).toEqual({ totals: { added: 0, fixed: 0, persisted: 0 }, added: [] });
  });

  it('reads the other scan as the person sees it too: a finding they could not read in the older scan is added, not persisted', async () => {
    // The same finding (one fingerprint) sat nowhere RuleBeat could place it in the older scan, and in subscription A in the newer.
    const unplaced: Finding = { ...A1, placement: 'unplaceable', subscriptionId: '', resourceGroup: undefined };
    const OLDER = '00000000-0000-0000-0000-0000000000f5';
    const NEWER = '00000000-0000-0000-0000-0000000000f6';
    await saveScanResult('compare-category', { ...summaryOf(OLDER, '2026-06-05T00:00:00.000Z', [unplaced], []), module: 'compare-category' }, { id: OLDER });
    await saveScanResult('compare-category', { ...summaryOf(NEWER, '2026-06-06T00:00:00.000Z', [A1], [SUB_A]), module: 'compare-category' }, { id: NEWER });
    const totals = async (access: Access) => {
      const answer = await queryCompare(OLDER, NEWER, emptyCompareQuery(), access);
      if (answer.status !== 'ok') throw new Error(answer.status);
      return answer.response.totals;
    };
    expect(await totals(EVERYTHING)).toEqual({ added: 0, fixed: 0, persisted: 1 });
    expect(await totals(ON_A)).toEqual({ added: 1, fixed: 0, persisted: 0 });
  });

  it('refuses two scans that covered different Scopes', async () => {
    expect((await queryCompare(SCAN_SCOPED, SCAN_OTHER_SCOPE, emptyCompareQuery(), EVERYTHING)).status).toBe('different-scopes');
    expect((await queryCompare(SCAN_ALL, SCAN_SCOPED, emptyCompareQuery(), ON_A)).status).toBe('different-scopes');
  });
});

describe('the stored run is never changed by reading it', () => {
  it('keeps the totals it stored', async () => {
    await getRun(runId, ON_A);
    const [stored] = await (await import('@/lib/db/exec')).many(db.select({ total: scheduleRuns.totalFindings, news: scheduleRuns.newFindings }).from(scheduleRuns).where(eq(scheduleRuns.id, runId)));
    expect(stored).toEqual({ total: 999, news: 99 });
  });
});
