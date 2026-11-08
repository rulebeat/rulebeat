/**
 * Run History by category (#403): `?tab=history&category=a,b` lists only the runs that scanned one of
 * those categories, and each run says Complete or Partial for every category it scanned, read from that
 * category's own `incompleteRules`. The seed goes through the real write paths and every expectation is
 * written by hand from it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { scans as scansTable } from '@/lib/db/tables';
import { many, run as run_ } from '@/lib/db/exec';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import { finishRun, listRunHistory, startRun } from '@/lib/schedule-runs';
import { categoryFailureMessage } from '@/lib/category-failure';
import { saveScanResult } from '@/lib/scan-history';
import { emptySeverityCounts } from '@/lib/severity';
import { filterValues, viewFromSearchParams } from '@/lib/finding-view';
import { runHistoryHref } from '@/lib/scans-link';
import type { Finding, IncompleteRule } from '@/lib/types';
import { resetDb } from '../helpers/db';
import { syntheticFinding } from '../helpers/synthetic-findings';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const EVERYTHING = everythingAccess('admin');
const ON_A: Access = buildAccess([{ tenantId: 't', scope: parseScope(`/subscriptions/${SUB_A}`)!, role: 'viewer' as const }], 'manual');

const FAILED: IncompleteRule = { ruleId: 'r-cost', ruleName: 'Idle disks', status: 'failed' };

// `storedCoverage` overrides the coverage column a scan is saved with, so a test can make it disagree with
// `incompleteRules` (the list Run History must read).
function scan(
  module: string, startedAt: string, findings: Finding[], incompleteRules: IncompleteRule[] = [],
  storedCoverage: 'complete' | 'partial' = incompleteRules.length > 0 ? 'partial' : 'complete',
) {
  const counts = emptySeverityCounts();
  for (const f of findings) counts[f.severity]++;
  return {
    module, startedAt, finishedAt: startedAt, durationMs: 1, subscriptionsScanned: [SUB_A], findings, counts,
    totalRules: 2, coverage: storedCoverage, incompleteRules,
  };
}

async function recordRun(
  categories: string[], at: string, scans: ReturnType<typeof scan>[],
  end: { status: 'success' | 'partial'; error?: string } = { status: 'success' },
): Promise<string> {
  const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories, now: new Date(at) });
  for (const s of scans) await saveScanResult(s.module, s, { runId: run.id });
  await finishRun(run.id, { ...end, totalFindings: 0, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date(at) });
  return run.id;
}

let securityOnly: string;
let mixed: string;
let costOnly: string;

beforeAll(async () => {
  await resetDb();
  const a1 = syntheticFinding('a1', [{ zone: 'a' }], { ruleId: 'r-sec', subscriptionId: SUB_A, resourceGroup: 'rg', severity: 'high' });
  const b1 = syntheticFinding('b1', [{ zone: 'a' }], { ruleId: 'r-sec', subscriptionId: SUB_B, resourceGroup: 'rg', severity: 'high' });
  securityOnly = await recordRun(['security'], '2026-06-01T00:00:00.000Z', [scan('security', '2026-06-01T00:00:00.000Z', [a1, b1])]);
  // One run, two categories: cost lost a rule, security did not. The stored coverage column says the
  // opposite of each, so only a reader of `incompleteRules` gets both right.
  mixed = await recordRun(['security', 'cost'], '2026-06-02T00:00:00.000Z', [
    scan('security', '2026-06-02T00:00:00.000Z', [a1], [], 'partial'),
    scan('cost', '2026-06-02T00:00:01.000Z', [], [FAILED], 'complete'),
  ]);
  costOnly = await recordRun(['cost'], '2026-06-03T00:00:00.000Z', [scan('cost', '2026-06-03T00:00:00.000Z', [])]);
});

const ids = (runs: { id: string }[]) => runs.map(r => r.id);

describe('listRunHistory · the category filter', () => {
  it('lists every run, newest first, when no category is asked for', async () => {
    expect(ids(await listRunHistory(EVERYTHING))).toEqual([costOnly, mixed, securityOnly]);
    expect(ids(await listRunHistory(EVERYTHING, { categories: [] }))).toEqual([costOnly, mixed, securityOnly]);
  });

  it('lists only the runs that scanned the category', async () => {
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['security'] }))).toEqual([mixed, securityOnly]);
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['cost'] }))).toEqual([costOnly, mixed]);
  });

  it('lists a run that scanned any of several categories once', async () => {
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['security', 'cost'] }))).toEqual([costOnly, mixed, securityOnly]);
  });

  it('lists nothing for a category no run scanned', async () => {
    expect(await listRunHistory(EVERYTHING, { categories: ['identity'] })).toEqual([]);
  });

  it('applies the limit after the filter', async () => {
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['security'], limit: 1 }))).toEqual([mixed]);
  });

  it('gives a person below Everything the same runs with their own counts', async () => {
    const runs = await listRunHistory(ON_A, { categories: ['security'] });
    expect(ids(runs)).toEqual([mixed, securityOnly]);
    expect(runs.map(r => r.totalFindings)).toEqual([1, 1]);
  });
});

describe('listRunHistory · coverage per category', () => {
  it('shows Complete for one category and Partial for another in the same run', async () => {
    const run = (await listRunHistory(EVERYTHING)).find(r => r.id === mixed)!;
    expect(run.categoryCoverage).toEqual([
      { category: 'security', coverage: 'complete', incompleteRules: [] },
      { category: 'cost', coverage: 'partial', incompleteRules: [FAILED] },
    ]);
  });

  it('reads the coverage from incompleteRules, not from the stored coverage column', async () => {
    // The mixed run is saved with security stored 'partial' over an empty list and cost stored 'complete'
    // over a failed rule; the list wins in both.
    const stored = await many(db.select({ module: scansTable.module, coverage: scansTable.coverage }).from(scansTable).where(eq(scansTable.runId, mixed)));
    expect(Object.fromEntries(stored.map(s => [s.module, s.coverage]))).toEqual({ security: 'partial', cost: 'complete' });
    const run = (await listRunHistory(EVERYTHING)).find(r => r.id === mixed)!;
    expect(run.categoryCoverage.map(c => [c.category, c.coverage])).toEqual([['security', 'complete'], ['cost', 'partial']]);
  });

  it('shows Complete for a category with no incomplete rules', async () => {
    const run = (await listRunHistory(EVERYTHING)).find(r => r.id === costOnly)!;
    expect(run.categoryCoverage).toEqual([{ category: 'cost', coverage: 'complete', incompleteRules: [] }]);
  });

  it('lists every category the run scanned, whatever the filter asked for', async () => {
    const run = (await listRunHistory(EVERYTHING, { categories: ['cost'] })).find(r => r.id === mixed)!;
    expect(run.categoryCoverage.map(c => c.category)).toEqual(['security', 'cost']);
  });
});

describe('listRunHistory · a category that threw', () => {
  let partlyFailed: string;
  let allFailed: string;

  beforeAll(async () => {
    await resetDb();
    // `cost` threw before it saved a scan, so the run has a scan for `security` only.
    partlyFailed = await recordRun(['security', 'cost'], '2026-07-01T00:00:00.000Z', [scan('security', '2026-07-01T00:00:00.000Z', [])], { status: 'partial', error: categoryFailureMessage('cost') });
    // An error run: every category threw, nothing was saved, and the run says so.
    const failed = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: ['cost'], now: new Date('2026-07-02T00:00:00.000Z') });
    await finishRun(failed.id, { status: 'error', error: categoryFailureMessage('cost'), totalFindings: 0, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date('2026-07-02T00:00:00.000Z') });
    allFailed = failed.id;
  });

  it('lists the runs that attempted the category, saved scan or not', async () => {
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['cost'] }))).toEqual([allFailed, partlyFailed]);
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['security'] }))).toEqual([partlyFailed]);
  });

  it('shows Partial for a category that threw, beside Complete for one that finished', async () => {
    const run = (await listRunHistory(EVERYTHING)).find(r => r.id === partlyFailed)!;
    expect(run.categoryCoverage).toEqual([
      { category: 'security', coverage: 'complete', incompleteRules: [] },
      { category: 'cost', coverage: 'partial', incompleteRules: [] },
    ]);
  });

  it('shows Partial for every category of an error run', async () => {
    const run = (await listRunHistory(EVERYTHING)).find(r => r.id === allFailed)!;
    expect(run.categoryCoverage).toEqual([{ category: 'cost', coverage: 'partial', incompleteRules: [] }]);
  });

  it('shows Partial for a category the run names as failed even though its scan was saved', async () => {
    // The scan is saved before the steps after it (syncing findings, snapshots) can throw, so a category
    // can hold a scan with no incomplete rules and still be recorded as failed.
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: ['security', 'cost'], now: new Date('2026-07-05T00:00:00.000Z') });
    await saveScanResult('security', scan('security', '2026-07-05T00:00:00.000Z', []), { runId: run.id });
    await saveScanResult('cost', scan('cost', '2026-07-05T00:00:01.000Z', []), { runId: run.id });
    await finishRun(run.id, { status: 'partial', error: categoryFailureMessage('cost'), totalFindings: 0, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date('2026-07-05T00:00:00.000Z') });
    const entry = (await listRunHistory(EVERYTHING)).find(r => r.id === run.id)!;
    expect(entry.categoryCoverage).toEqual([
      { category: 'security', coverage: 'complete', incompleteRules: [] },
      { category: 'cost', coverage: 'partial', incompleteRules: [] },
    ]);
  });

  it('marks no category of an error run whose error does not name one and whose scans are gone', async () => {
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: ['security', 'cost'], now: new Date('2026-07-06T00:00:00.000Z') });
    await finishRun(run.id, { status: 'error', error: 'Scan run failed. Check the RuleBeat server logs for details', totalFindings: 0, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date('2026-07-06T00:00:00.000Z') });
    const entry = (await listRunHistory(EVERYTHING)).find(r => r.id === run.id)!;
    expect(entry.categoryCoverage).toEqual([]);
  });

  it('matches a category id exactly, wildcard characters included', async () => {
    const odd = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: ['a_b', '50%'], now: new Date('2026-07-04T00:00:00.000Z') });
    await finishRun(odd.id, { status: 'error', totalFindings: 0, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date('2026-07-04T00:00:00.000Z') });
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['a_b'] }))).toEqual([odd.id]);
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['axb'] }))).toEqual([]);
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['5'] }))).toEqual([]);
    expect(ids(await listRunHistory(EVERYTHING, { categories: ['50%'] }))).toEqual([odd.id]);
  });

  it('does not mark a category of a run still in progress', async () => {
    const running = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: ['security', 'cost'], now: new Date('2026-07-03T00:00:00.000Z') });
    const run = (await listRunHistory(EVERYTHING)).find(r => r.id === running.id)!;
    expect(run.categoryCoverage).toEqual([]);
  });
});

describe('listRunHistory · a category whose scan history has since expired', () => {
  const FINISH = { totalFindings: 0, newFindings: 0, newFindingFingerprints: [], durationMs: 1 };

  // A run as the executor leaves it, then the way history keeps only the newest scans of a category:
  // its scan rows go, the run stays.
  async function expiredRun(status: 'success' | 'partial' | 'error', error: string | undefined, at: string): Promise<string> {
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: ['security', 'cost'], now: new Date(at) });
    await saveScanResult('security', scan('security', at, []), { runId: run.id });
    await saveScanResult('cost', scan('cost', at, []), { runId: run.id });
    await finishRun(run.id, { ...FINISH, status, error, now: new Date(at) });
    await run_(db.delete(scansTable).where(eq(scansTable.runId, run.id)));
    return run.id;
  }

  beforeAll(async () => { await resetDb(); });

  it('shows Complete for the categories of a successful run, never Partial', async () => {
    const id = await expiredRun('success', undefined, '2026-08-01T00:00:00.000Z');
    const run = (await listRunHistory(EVERYTHING, { categories: ['security'] })).find(r => r.id === id)!;
    expect(run.categoryCoverage).toEqual([
      { category: 'security', coverage: 'complete', incompleteRules: [] },
      { category: 'cost', coverage: 'complete', incompleteRules: [] },
    ]);
  });

  it('still shows Partial for a category the run recorded as failed', async () => {
    const id = await expiredRun('partial', categoryFailureMessage('cost'), '2026-08-02T00:00:00.000Z');
    const run = (await listRunHistory(EVERYTHING)).find(r => r.id === id)!;
    expect(run.categoryCoverage).toEqual([{ category: 'cost', coverage: 'partial', incompleteRules: [] }]);
  });

  it('marks nothing for a category of a partial run when the scan that said so is gone', async () => {
    const id = await expiredRun('partial', 'security: one or more rules did not complete. See the category\'s scan for details', '2026-08-03T00:00:00.000Z');
    const run = (await listRunHistory(EVERYTHING)).find(r => r.id === id)!;
    expect(run.categoryCoverage).toEqual([]);
  });
});

describe('listRunHistory · an error run that names one category and has lost the scan of another', () => {
  it('marks only the category it names', async () => {
    await resetDb();
    const at = '2026-09-01T00:00:00.000Z';
    const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories: ['security', 'cost'], now: new Date(at) });
    await finishRun(run.id, { status: 'error', error: categoryFailureMessage('cost'), totalFindings: 0, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date(at) });
    const entry = (await listRunHistory(EVERYTHING)).find(r => r.id === run.id)!;
    expect(entry.categoryCoverage).toEqual([{ category: 'cost', coverage: 'partial', incompleteRules: [] }]);
  });
});

describe('runHistoryHref', () => {
  it('writes the categories the Scans page reads back', () => {
    for (const categories of [[], ['security'], ['security', 'cost']]) {
      const params = new URLSearchParams(runHistoryHref(categories).split('?')[1]);
      expect(params.get('tab')).toBe('history');
      expect(filterValues(viewFromSearchParams(params).filters, 'category')).toEqual(categories);
    }
  });

  it('writes no category param when none is picked', () => {
    expect(runHistoryHref([])).toBe('/scans?tab=history');
  });
});
