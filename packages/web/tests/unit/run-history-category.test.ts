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
import { many } from '@/lib/db/exec';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import { finishRun, listRunHistory, startRun } from '@/lib/schedule-runs';
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

async function recordRun(categories: string[], at: string, scans: ReturnType<typeof scan>[]): Promise<string> {
  const run = await startRun({ scheduleId: '', triggeredBy: 'manual', categories, now: new Date(at) });
  for (const s of scans) await saveScanResult(s.module, s, { runId: run.id });
  await finishRun(run.id, { status: 'success', totalFindings: 0, newFindings: 0, newFindingFingerprints: [], durationMs: 1, now: new Date(at) });
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
