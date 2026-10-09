/**
 * ADR 0007: the benchmark behind `npm run bench:views` (scripts/bench/finding-views.ts) at a tiny
 * size. It has to stay runnable, deterministic, and honest about what it measured: the dataset is the
 * one it says, it is stored through the real scan save, and the two paths it compares answer the same
 * question.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { listFindings } from '@/lib/db/findings';
import { queryView } from '@/lib/db/finding-views';
import { RESULTS_KINDS } from '@/lib/finding-kinds';
import { applyView, emptyView } from '@/lib/finding-view';
import {
  BENCH_RULES, ROW_TARGET_BYTES, formatTable, generateDataset, generateRow, median, runBench, runMeasurements,
  type BenchResult,
} from '../../scripts/bench/finding-views';
import { isActiveSuppression, loadSuppressions } from '@/lib/suppressions';
import { countRows, resetDb } from '../helpers/db';

const OPTIONS = { findings: 60, rowsPerFinding: 3, seed: 7, warmRuns: 1 };

describe('the generated dataset', () => {
  it('is the same for the same seed and different for another', () => {
    const a = generateDataset(OPTIONS);
    expect(generateDataset(OPTIONS)).toEqual(a);
    expect(generateDataset({ ...OPTIONS, seed: 8 })).not.toEqual(a);
    expect(generateRow(7, a.resources[3]!, 1)).toEqual(generateRow(7, a.resources[3]!, 1));
    expect(generateRow(7, a.resources[3]!, 1)).not.toEqual(generateRow(7, a.resources[3]!, 2));
    expect(generateRow(8, a.resources[3]!, 1)).not.toEqual(generateRow(7, a.resources[3]!, 1));
  });

  it('has the findings asked for, spread over several rules, subscriptions, groups and locations', () => {
    const { rules, resources } = generateDataset({ ...OPTIONS, findings: 400 });
    expect(rules).toHaveLength(BENCH_RULES.length);
    expect(resources).toHaveLength(400);
    expect(new Set(resources.map(r => r.name)).size).toBe(400);
    expect(new Set(resources.map(r => r.ruleId)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(resources.map(r => r.subscriptionId)).size).toBe(5);
    expect(new Set(resources.map(r => r.resourceGroup)).size).toBeGreaterThan(10);
    expect(new Set(resources.map(r => r.location)).size).toBe(6);
    expect(new Set(rules.map(r => r.severity))).toEqual(new Set(['critical', 'high', 'medium', 'low', 'info']));
    expect(new Set(rules.map(r => r.kind))).toEqual(new Set(['state', 'advisory']));
    expect(resources.some(r => r.fixedByLaterScan)).toBe(true);
    expect(resources.some(r => !r.fixedByLaterScan)).toBe(true);
    const meanRows = resources.reduce((sum, r) => sum + r.rowCount, 0) / resources.length;
    expect(meanRows).toBeGreaterThan(2.5);
    expect(meanRows).toBeLessThan(3.5);
  });

  it('gives every row about 1.5 KB of nested JSON', () => {
    const { resources } = generateDataset(OPTIONS);
    for (const resource of resources.slice(0, 10)) {
      const row = generateRow(OPTIONS.seed, resource, 0);
      const bytes = Buffer.byteLength(JSON.stringify(row));
      expect(bytes).toBeGreaterThanOrEqual(ROW_TARGET_BYTES);
      expect(bytes).toBeLessThan(ROW_TARGET_BYTES + 40);
      expect((row.properties as { sku: { name: string } }).sku.name).toMatch(/^[SP]\d$/);
    }
  });
});

describe('the harness', () => {
  it('keeps the cold run apart from the median of the warm ones, and the bytes of the work', async () => {
    const calls: string[] = [];
    const [only] = await runMeasurements([{ name: 'm', run: async () => { calls.push('run'); return 42; } }], 3);
    expect(calls).toHaveLength(4);
    expect(only).toMatchObject({ name: 'm', bytes: 42 });
    expect(only!.coldMs).toBeGreaterThanOrEqual(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });

  it('reports no bytes for work that returns none', async () => {
    const [only] = await runMeasurements([{ name: 'm', run: async () => {} }], 0);
    expect(only).not.toHaveProperty('bytes');
    expect(only!.medianMs).toBe(only!.coldMs);
  });
});

describe('a run over a tiny database', () => {
  let result: BenchResult;

  beforeAll(async () => {
    await resetDb();
    result = await runBench(OPTIONS);
  }, 120_000);

  it('stores the dataset through the scan save: the findings, their rows, and some Fixed', async () => {
    const { dataset } = result;
    expect(dataset.findings).toBe(60);
    expect(await countRows('findings')).toBe(60);
    expect(await countRows('finding_rows')).toBe(dataset.rows);
    const stored = await listFindings({});
    expect(stored.reduce((sum, f) => sum + (f.rows?.length ?? 0), 0)).toBe(dataset.rows);
    expect(stored.filter(f => f.status === 'fixed')).toHaveLength(dataset.fixed);
    expect(dataset.fixed).toBeGreaterThan(0);
    expect(dataset.suppressed).toBeGreaterThan(0);
    expect(await loadSuppressions()).toHaveLength(dataset.suppressed);
    expect(dataset.averageRowBytes).toBeGreaterThanOrEqual(ROW_TARGET_BYTES);
  });

  it('measures the scan save, today and the new path, each with a time and the payloads with bytes', () => {
    const names = result.measurements.map(m => m.name);
    expect(names).toEqual([
      'scan save: first scan', 'scan save: second scan',
      'today: payload, Results tab', 'today: payload, Advisories tab', 'today: default view', 'today: row-filtered view', 'today: column dropdown',
      'new: default view', 'new: row-filtered view', 'new: default view, Advisories tab', 'new: column dropdown',
    ]);
    for (const m of result.measurements) {
      expect(m.coldMs, m.name).toBeGreaterThan(0);
      expect(m.medianMs, m.name).toBeGreaterThan(0);
    }
    for (const name of names.filter(n => n.includes('payload') || n.startsWith('new:'))) {
      expect(result.measurements.find(m => m.name === name)!.bytes, name).toBeGreaterThan(0);
    }
  });

  it('compares two paths that answer the same question', async () => {
    const view = emptyView();
    const suppressedFingerprints = new Set((await loadSuppressions()).filter(isActiveSuppression).map(s => s.fingerprint));
    const inFingerprintOrder = (await listFindings({ kinds: RESULTS_KINDS })).sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
    const today = applyView(inFingerprintOrder, view, { suppressedFingerprints, showSuppressed: false });
    const now = await queryView(view, { tab: 'results', showSuppressed: false });
    expect(now.total).toBe(today.total);
    expect(now.total).toBeGreaterThan(0);
    expect(now.items.map(i => i.finding.fingerprint)).toEqual(today.items.map(i => i.finding.fingerprint));
    // Showing suppressed findings adds the ones on this tab (an advisory's belongs to the other).
    expect((await queryView(view, { tab: 'results', showSuppressed: true })).total).toBeGreaterThan(now.total);
  });

  it('measures a row-filtered view that narrows the rows the default view sends', () => {
    const bytesOf = (name: string) => result.measurements.find(m => m.name === name)!.bytes!;
    expect(bytesOf('new: row-filtered view')).toBeLessThan(bytesOf('new: default view'));
  });

  it('prints a table naming every measurement and the dataset behind it', () => {
    const table = formatTable(result);
    expect(table).toContain('60 findings');
    expect(table).toContain('seed 7');
    for (const m of result.measurements) expect(table).toContain(m.name);
    expect(table.split('\n')[2]).toMatch(/^measurement\s+cold ms\s+median ms\s+bytes sent$/);
  });
});
