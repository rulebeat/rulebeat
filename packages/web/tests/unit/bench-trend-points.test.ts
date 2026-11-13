/**
 * ADR 0013: the benchmark behind `npm run bench:trend-points` (scripts/bench/trend-points.ts) at a tiny
 * size. It has to stay runnable, deterministic, and honest about what it measured: the dataset is the one it
 * says, and the history it times a refresh against was written by the real queued writer.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { many } from '@/lib/db/exec';
import { findings as findingsTable, postureSnapshots } from '@/lib/db/tables';
import { listLastScanTimes } from '@/lib/scan-history';
import { DIRECTORY_SUBSCRIPTION } from '@/lib/placement';
import { FINDING_COUNT_VERSION } from '@/lib/trend-point-counts';
import {
  formatTable, generateDataset, median, runBench, runMeasurements, slicedAccess, THRESHOLD_MS,
  type BenchResult,
} from '../../scripts/bench/trend-points';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { resetDb } from '../helpers/db';

const OPTIONS = { subscriptions: 12, categories: 3, findings: 90, rulesPerCategory: 4, seed: 7, warmRuns: 1 };

describe('the generated dataset', () => {
  it('is the same for the same seed and different for another', () => {
    const a = generateDataset(OPTIONS);
    expect(generateDataset(OPTIONS)).toEqual(a);
    expect(generateDataset({ ...OPTIONS, seed: 8 })).not.toEqual(a);
  });

  it('has the sizes asked for, with every kind of rule scope and placement the writer counts', () => {
    const data = generateDataset({ ...OPTIONS, subscriptions: 200, categories: 10, findings: 2000 });
    expect(data.subscriptions).toHaveLength(200);
    expect(new Set(data.subscriptions).size).toBe(200);
    expect(data.rules).toHaveLength(40);
    expect(data.findings).toHaveLength(2000);
    expect(data.nodes.filter(n => n.kind === 'subscription')).toHaveLength(200);
    expect(new Set(data.rules.map(r => r.scope))).toEqual(new Set(['all', 'list', 'group', 'directory']));
    expect(new Set(data.findings.map(f => f.placement))).toEqual(new Set(['resource', 'directory', 'management-group']));
    expect(new Set(data.findings.map(f => f.category)).size).toBe(10);
    expect(data.findings.some(f => f.suppressed)).toBe(true);
    // Every finding sits in a subscription of the tree, or has none (the Directory, a management group).
    for (const f of data.findings) {
      if (f.placement === 'resource') expect(data.subscriptions).toContain(f.subscriptionId);
      else expect(f.subscriptionId).toBe('');
    }
  });
});

describe('the harness', () => {
  it('keeps the cold run apart from the median of the warm ones, and reports the longest', async () => {
    const calls: string[] = [];
    const [only] = await runMeasurements([{ name: 'm', runs: w => w, run: async () => { calls.push('run'); } }], 3);
    expect(calls).toHaveLength(4);
    expect(only).toMatchObject({ name: 'm' });
    expect(only!.maxMs).toBeGreaterThanOrEqual(only!.medianMs);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('the run', () => {
  let result: BenchResult;
  const data = generateDataset(OPTIONS);

  beforeAll(async () => {
    await resetDb();
    result = await runBench(OPTIONS);
  }, 120_000);

  it('times every measurement it names and reports the machine and the backend', () => {
    expect(result.measurements.map(m => m.name)).toEqual([
      expect.stringContaining('one refresh'),
      expect.stringContaining('transaction hold'),
      'computeWidgetSummary, Everything',
      'computeWidgetSummary, one category',
      expect.stringContaining('computeWidgetSummary, holds'),
      'last-scanned read, Everything',
      expect.stringContaining('last-scanned read, holds'),
    ]);
    for (const m of result.measurements) {
      expect(Number.isFinite(m.coldMs) && m.coldMs >= 0).toBe(true);
      expect(m.maxMs).toBeGreaterThanOrEqual(m.medianMs);
    }
    expect(result.machine).toMatch(/Node v/);
    expect(['sqlite', 'postgres']).toContain(result.backend);
    expect(result.counts).toMatchObject({ subscriptions: 12, categories: 3, rules: 12, findings: 90 });
    expect(result.overThreshold).toEqual(result.measurements.filter(m => m.maxMs > THRESHOLD_MS).map(m => m.name));
    expect(formatTable(result)).toContain(`Backend: ${result.backend}`);
  });

  it('stored the findings through the scan sync: the install-wide point of a category counts the unsuppressed ones planned for it', async () => {
    const stored = await many(db.select({ ruleId: findingsTable.ruleId }).from(findingsTable).where(eq(findingsTable.status, 'active')));
    expect(stored).toHaveLength(data.findings.length);
    const points = await many(db.select().from(postureSnapshots));
    const firstDay = points.map(p => p.date).sort()[0]!;
    // Read through the points the writer wrote; the expected figure comes from the plan, not a recount of the findings.
    for (let category = 0; category < OPTIONS.categories; category += 1) {
      const point = points.find(p => p.category === result.categoryIds[category] && p.subscriptionId === '' && p.date === firstDay);
      expect(point?.activeFindings).toBe(data.findings.filter(f => f.category === category && !f.suppressed).length);
    }
  });

  it('wrote the history it times against with the real writer: every level, formula and finding-count version', async () => {
    const points = await many(db.select().from(postureSnapshots));
    const levels = new Set(points.map(p => p.subscriptionId));
    expect(levels.has('')).toBe(true);
    expect(levels.has(DIRECTORY_SUBSCRIPTION)).toBe(true);
    // Every subscription of the tree has a point on the first day: nothing stood before it to match.
    for (const sub of data.subscriptions) expect(levels.has(sub)).toBe(true);
    expect(points.every(p => p.findingCountVersion === FINDING_COUNT_VERSION)).toBe(true);
    // Two earlier days were written with the writer's `now`, and the measured refreshes then wrote today's.
    const today = new Date().toISOString().slice(0, 10);
    expect([...new Set(points.map(p => p.date))].sort().filter(d => d < today)).toHaveLength(2);
    expect(points.some(p => p.date === today)).toBe(true);
  });

  it('reads the last scan of a person who holds a slice no later than the one of Everything', async () => {
    const all = result.categoryIds;
    const everything = await listLastScanTimes(all, EVERYTHING_ACCESS);
    const sliced = await listLastScanTimes(all, slicedAccess(data.subscriptions.slice(0, 3)));
    expect(everything.size).toBeGreaterThan(0);
    for (const [category, at] of sliced) expect(at <= everything.get(category)!).toBe(true);
  });
});
