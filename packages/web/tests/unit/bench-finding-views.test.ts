/**
 * ADR 0007: the benchmark behind `npm run bench:views` (scripts/bench/finding-views.ts) at a tiny
 * size. It has to stay runnable, deterministic, and honest about what it measured: the dataset is the
 * one it says, it is stored through the real scan save, and the two paths it compares answer the same
 * question.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { db, pgDb } from '@/lib/db/client';
import { many, one } from '@/lib/db/exec';
import { scanFindings, scans } from '@/lib/db/tables';
import { listFindings } from '@/lib/db/findings';
import { queryCompare } from '@/lib/db/scan-compare';
import { emptyCompareQuery } from '@/lib/compare-query';
import { openExport, queryView } from '@/lib/db/finding-views';
import { openSnapshotExport, querySnapshot } from '@/lib/db/scan-snapshots';
import { streamSnapshotExport } from '@/lib/snapshot-export';
import { emptySnapshotQuery } from '@/lib/snapshot-query';
import { streamExport } from '@/lib/export-stream';
import { RESULTS_KINDS } from '@/lib/finding-kinds';
import { applyView, emptyView } from '@/lib/finding-view';
import {
  BENCH_RULES, BENCH_SNAPSHOT_FILTERS, ROW_TARGET_BYTES, comparedScans, formatTable, generateDataset, generateRow, largestSnapshotScanId, median, runBench, runMeasurements,
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
      'snapshot: first page', 'snapshot: later page', 'snapshot: page filtered with search',
      'compare: added page', 'compare: fixed page', 'compare: persisted page', 'compare: later page of the biggest side',
    ]);
    for (const m of result.measurements) {
      expect(m.coldMs, m.name).toBeGreaterThan(0);
      expect(m.medianMs, m.name).toBeGreaterThan(0);
    }
    for (const name of names.filter(n => n.includes('payload') || n.startsWith('new:') || n.startsWith('snapshot:') || n.startsWith('compare:'))) {
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

  it('measures the export as a file the size of the one the route sends, with the first byte before the end', async () => {
    expect(result.exports.map(e => e.name)).toEqual([
      'export: CSV, default view', 'export: CSV, row-filtered view', 'export: JSON, default view',
      'export: snapshot CSV, whole run', 'export: snapshot CSV, filtered with search', 'export: snapshot JSON, whole run',
    ]);
    for (const e of result.exports) {
      expect(e.bytes, e.name).toBeGreaterThan(0);
      expect(e.ttfbColdMs, e.name).toBeGreaterThan(0);
      expect(e.ttfbMedianMs, e.name).toBeLessThanOrEqual(e.totalMedianMs);
      expect(e.ttfbColdMs, e.name).toBeLessThanOrEqual(e.totalColdMs);
      expect(e.peakHeapGrowthBytes, e.name).toBeGreaterThanOrEqual(0);
    }
    const byName = (name: string) => result.exports.find(e => e.name === name)!;
    expect(byName('export: CSV, row-filtered view').bytes).toBeLessThan(byName('export: CSV, default view').bytes);

    // The file measured is the file the route streams for the same view.
    const file = await new Response(await streamExport(openExport(emptyView(), { tab: 'results', showSuppressed: false }), 'csv')).text();
    expect(Buffer.byteLength(file)).toBe(byName('export: CSV, default view').bytes);
  });

  it('measures the snapshot of the biggest scan: the page, a later page and a filtered one, which answer what the route answers', async () => {
    const scanId = await largestSnapshotScanId();
    const first = await querySnapshot(scanId, emptySnapshotQuery());
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    // The biggest scan holds at least as many records as any other, and the page is the run's first.
    expect(first.response.total).toBeGreaterThan(0);
    expect(first.response.items.length).toBe(Math.min(50, first.response.total));
    const mostRecords = Math.max(...(await many(db.select({ n: sql<number | string>`count(*)` }).from(scanFindings).groupBy(scanFindings.scanId))).map(r => Number(r.n)));
    expect(first.response.total).toBe(mostRecords);

    const filtered = await querySnapshot(scanId, { ...emptySnapshotQuery(), severity: [...BENCH_SNAPSHOT_FILTERS.severity], search: BENCH_SNAPSHOT_FILTERS.search });
    expect(filtered.status === 'ok' && filtered.response.total).toBeGreaterThan(0);
    expect(filtered.status === 'ok' && filtered.response.total).toBeLessThan(first.response.total);
    expect(filtered.status === 'ok' && filtered.response.items.every(i => i.severity === 'high' && i.title.includes('disks'))).toBe(true);
    // Search alone narrows the run too, so the filter measured is not the severity doing all the work.
    const severityOnly = await querySnapshot(scanId, { ...emptySnapshotQuery(), severity: [...BENCH_SNAPSHOT_FILTERS.severity] });
    expect(severityOnly.status === 'ok' && filtered.status === 'ok' && filtered.response.total < severityOnly.response.total).toBe(true);

    const bytes = (name: string) => result.measurements.find(m => m.name === name)!.bytes!;
    expect(bytes('snapshot: page filtered with search')).toBeLessThan(bytes('snapshot: first page'));
    expect(bytes('snapshot: first page')).toBe(Buffer.byteLength(JSON.stringify(first.response)));
  });

  it('says how many records the snapshot measurements ran over: the count the biggest scan stored', async () => {
    const scanId = await largestSnapshotScanId();
    const stored = Number((await one(db.select({ n: sql<number | string>`count(*)` }).from(scanFindings).where(eq(scanFindings.scanId, scanId))))!.n);
    expect(stored).toBeGreaterThan(0);
    expect(typeof result.snapshotRecords).toBe('number');
    expect(result.snapshotRecords).toBe(stored);
    expect(formatTable(result)).toContain(`snapshot measurements: the largest scan, ${stored.toLocaleString('en-US')} records`);
  });

  it('measures a compare of the largest category\'s two scans, each page answering what the route answers', async () => {
    const { ids, records } = await comparedScans();
    const [older, newer] = await Promise.all(ids.map(id => one(db.select({ category: scans.module, startedAt: scans.startedAt }).from(scans).where(eq(scans.id, id)))));
    // Two scans of the category that holds the biggest scan, the older one first.
    expect(older!.category).toBe(newer!.category);
    expect(older!.category).toBe((await one(db.select({ category: scans.module }).from(scans).where(eq(scans.id, await largestSnapshotScanId()))))!.category);
    expect(Date.parse(older!.startedAt)).toBeLessThan(Date.parse(newer!.startedAt));
    expect(records[0]).toBe(Number((await one(db.select({ n: sql<number | string>`count(*)` }).from(scanFindings).where(eq(scanFindings.scanId, ids[0]))))!.n));

    const answer = await queryCompare(ids[0], ids[1], emptyCompareQuery());
    expect(answer.status).toBe('ok');
    if (answer.status !== 'ok') return;
    const { totals } = answer.response;
    // The sides add up to the scans: what the newer scan holds is the added and the persisted, and what the older held is the fixed and the persisted.
    expect(totals.added + totals.persisted).toBe(records[1]);
    expect(totals.fixed + totals.persisted).toBe(records[0]);
    // The second scan leaves out the findings the dataset marks as fixed, so nothing in it is new.
    expect(totals.added).toBe(0);
    expect(totals.persisted).toBe(records[1]);

    const bytes = (name: string) => result.measurements.find(m => m.name === name)!.bytes!;
    expect(bytes('compare: added page')).toBe(Buffer.byteLength(JSON.stringify(answer.response)));
    const fixed = await queryCompare(ids[0], ids[1], { side: 'fixed', page: 1 });
    expect(fixed.status === 'ok' && bytes('compare: fixed page')).toBe(fixed.status === 'ok' ? Buffer.byteLength(JSON.stringify(fixed.response)) : -1);
  });

  it('says how many records each compared scan holds, beside the compare measurements', async () => {
    const { records } = await comparedScans();
    expect(result.compareRecords).toEqual({ older: records[0], newer: records[1] });
    expect(result.compareRecords.older).toBeGreaterThanOrEqual(result.compareRecords.newer);
    expect(formatTable(result)).toContain(
      `compare measurements: the two scans of the largest category, ${records[0].toLocaleString('en-US')} records (older) and ${records[1].toLocaleString('en-US')} records (newer)`,
    );
  });

  it('measures the snapshot export as the file the route streams for the same query, filtered one smaller', async () => {
    const scanId = await largestSnapshotScanId();
    const byName = (name: string) => result.exports.find(e => e.name === name)!;
    const query = { ...emptySnapshotQuery(), severity: [...BENCH_SNAPSHOT_FILTERS.severity], search: BENCH_SNAPSHOT_FILTERS.search };
    const csv = await new Response(await streamSnapshotExport(openSnapshotExport(scanId, emptySnapshotQuery()), 'csv')).text();
    const filteredCsv = await new Response(await streamSnapshotExport(openSnapshotExport(scanId, query), 'csv')).text();
    const json = await new Response(await streamSnapshotExport(openSnapshotExport(scanId, emptySnapshotQuery()), 'json')).text();
    expect(Buffer.byteLength(csv)).toBe(byName('export: snapshot CSV, whole run').bytes);
    expect(Buffer.byteLength(filteredCsv)).toBe(byName('export: snapshot CSV, filtered with search').bytes);
    expect(Buffer.byteLength(json)).toBe(byName('export: snapshot JSON, whole run').bytes);
    expect(byName('export: snapshot CSV, filtered with search').bytes).toBeLessThan(byName('export: snapshot CSV, whole run').bytes);
  });
  it('measures the records the two scans stored: one per finding per scan, with their size and the pages they take', async () => {
    const { records } = result;
    expect(records.count).toBe(await countRows('scan_findings'));
    // 60 findings in the first scan, and the second leaves out the ones it fixes.
    expect(records.count).toBe(60 + 60 - result.dataset.fixed);
    expect(records.averageRecordBytes).toBeGreaterThan(100);
    expect(records.averageRecordBytes).toBeLessThan(ROW_TARGET_BYTES);
    expect(records.tableBytes).toBeGreaterThanOrEqual(4096);
    if (dbKind === 'pg') {
      // What the server itself says the table and its indexes weigh.
      const res = await pgDb!.execute(sql.raw(`SELECT pg_relation_size('scan_findings') AS "table", pg_indexes_size('scan_findings') AS "indexes"`));
      const server = res.rows[0] as { table: unknown; indexes: unknown };
      expect(records.tableBytes).toBe(Number(server.table));
      expect(records.indexBytes).toBe(Number(server.indexes));
      expect(records.indexBytes).toBeGreaterThan(0);
      return;
    }
    // Every index the table has, as the database lists them: none may be left out of the figure.
    const { rawSqlite } = await import('@/lib/db/client');
    const indexes = (rawSqlite!.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scan_findings'`).all() as { name: string }[]).map(i => i.name);
    expect(indexes).toContain('idx_scan_findings_order');
    const pages = (rawSqlite!.prepare(`SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN (${indexes.map(() => '?').join(', ')})`).get(...indexes) as { bytes: number }).bytes;
    expect(records.indexBytes).toBe(pages);
  });

  it('prints a table naming every measurement and the dataset behind it, and a second for the export', () => {
    const table = formatTable(result);
    expect(table).toContain('60 findings');
    expect(table).toContain('seed 7');
    for (const m of result.measurements) expect(table).toContain(m.name);
    for (const e of result.exports) expect(table).toContain(e.name);
    expect(table.split('\n')[2]).toMatch(/^measurement\s+cold ms\s+median ms\s+bytes sent$/);
    expect(table).toMatch(/^scan records\s+count\s+bytes a record\s+table\s+indexes$/m);
    expect(table).toMatch(/^scan_findings\s+\d+\s+\d+\s+[\d.]+ KB\s+[\d.]+ KB$/m);
    expect(table).toMatch(/^export\s+first byte cold ms\s+first byte median ms\s+total cold ms\s+total median ms\s+file\s+peak heap growth\s+peak RSS growth$/m);
  });
});
