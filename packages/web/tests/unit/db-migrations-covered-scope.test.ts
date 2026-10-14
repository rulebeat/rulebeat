/**
 * #276: the upgrade that adds `schedule_runs.covered_scope` and `scans.covered_scope` is additive. No run
 * was ever narrowed before, so every row already stored covered Everything: the new column is NULL on it,
 * NULL reads as Everything, and nothing else about the row changes. Migrations swallow their own errors, so
 * these tests read every column back rather than trusting that nothing threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { SHAPES } from '../fixtures/db-shapes';
import { runMigrations } from '@/lib/db/migrate';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { buildAccess, parseScope } from '@/lib/access-model';

let sqlite: Database.Database | undefined;
let closeProductDb: (() => void) | undefined;
afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
  closeProductDb?.();
  closeProductDb = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Starts the product against `file`, as the running app does: the real startup migrations, then the repositories. */
async function startProductOn(file: string) {
  vi.resetModules();
  vi.stubEnv('RULEBEAT_DATABASE_URL', '');
  vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const runs = await import('@/lib/schedule-runs');
  const history = await import('@/lib/scan-history');
  return { listAllRuns: runs.listAllRuns, getRun: runs.getRun, getScansForRun: history.getScansForRun, listScanMetas: history.listScanMetas };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];
const columns = (db: Database.Database, table: string) => all(db, `PRAGMA table_info(${table})`).map(c => c.name);

const EVERYTHING_ENTRY = [{ label: 'Everything', outside: false }];

describe('upgrading to a database that records the Scope a run covered', () => {
  it('keeps every column of a stored run and scan, adds the column empty, and reads both as Everything', async () => {
    const sample = makeSample('current');
    let db = open(sample.file);
    runMigrations(db);
    db.exec(`ALTER TABLE schedule_runs DROP COLUMN covered_scope;`);
    db.exec(`ALTER TABLE scans DROP COLUMN covered_scope;`);
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, triggered_by, target_type, target_values, started_at, finished_at, status, categories,
        total_findings, new_findings, new_finding_fingerprints, error, duration_ms, notify_status, heartbeat_at, owner_id, changed_findings)
      VALUES ('run-old', 'sched-1', 'schedule', 'categories', '["reliability"]', '2026-02-03T04:05:06.000Z', '2026-02-03T04:06:06.000Z', 'partial',
        '["reliability"]', 7, 2, '["fp-1","fp-2"]', 'one or more rules did not complete', 60000, 'sent', '2026-02-03T04:06:00.000Z', 'owner-1',
        '[{"fingerprint":"fp-1","addedRows":[{"a":1}]}]')
    `).run();
    db.prepare(`
      INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules, triggered_by,
        schedule_id, run_id, coverage, incomplete_rules, has_records)
      VALUES ('scan-old', 'reliability', '2026-02-03T04:05:06.000Z', '2026-02-03T04:06:06.000Z', 60000, '["sub-1"]', '[]',
        '{"critical":0,"high":2,"medium":5,"low":0,"info":0}', 12, 'schedule', 'sched-1', 'run-old', 'partial',
        '[{"ruleId":"r1","ruleName":"R one","status":"capped"}]', 1)
    `).run();
    const runBefore = all(db, `SELECT * FROM schedule_runs WHERE id = 'run-old'`)[0]!;
    const scanBefore = all(db, `SELECT * FROM scans WHERE id = 'scan-old'`)[0]!;
    expect(columns(db, 'schedule_runs')).not.toContain('covered_scope');
    expect(columns(db, 'scans')).not.toContain('covered_scope');
    db.close();

    const product = await startProductOn(sample.file);

    db = sqlite = open(sample.file);
    expect(columns(db, 'schedule_runs')).toContain('covered_scope');
    expect(columns(db, 'scans')).toContain('covered_scope');
    // Every column of the stored rows is what it was, and the new one is NULL (no backfill).
    expect(all(db, `SELECT * FROM schedule_runs WHERE id = 'run-old'`)[0]).toEqual({ ...runBefore, covered_scope: null });
    expect(all(db, `SELECT * FROM scans WHERE id = 'scan-old'`)[0]).toEqual({ ...scanBefore, covered_scope: null });

    const run = await product.getRun('run-old', EVERYTHING_ACCESS);
    expect(run).toMatchObject({
      id: 'run-old', status: 'partial', totalFindings: 7, newFindings: 2, newFindingFingerprints: ['fp-1', 'fp-2'],
      error: 'one or more rules did not complete', countsUnavailable: false,
    });
    expect(run!.coveredScope.entries).toEqual(EVERYTHING_ENTRY);
    const [scan] = await product.getScansForRun('run-old', EVERYTHING_ACCESS);
    expect(scan).toMatchObject({ id: 'scan-old', counts: { critical: 0, high: 2, medium: 5, low: 0, info: 0 }, totalRules: 12, coverage: 'partial' });
    expect(scan!.coveredScope.entries).toEqual(EVERYTHING_ENTRY);
    // The same Scope as a run that recorded Everything, so a compare between the two is not refused.
    expect(scan!.coveredScope.key).toBe(run!.coveredScope.key);
  });

  it('reads the covered Scope of an old run to a person below Everything as Everything, naming nothing', async () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    const db = open(sample.file);
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, triggered_by, started_at, status, categories, total_findings)
      VALUES ('run-old-2', '', 'manual', '2026-02-03T04:05:06.000Z', 'success', '["reliability"]', 4)
    `).run();
    db.close();

    const product = await startProductOn(sample.file);
    const viewer = buildAccess([{ tenantId: 't', scope: parseScope('/subscriptions/sub-1')!, role: 'viewer' }], 'manual');
    const run = await product.getRun('run-old-2', viewer);
    expect(run!.coveredScope.entries).toEqual(EVERYTHING_ENTRY);
  });

  it.each(SHAPES)('a %s database gains both columns, NULL on every row it kept', async shape => {
    const sample = makeSample(shape);
    upgradeInProcess(sample);
    const product = await startProductOn(sample.file);

    const runs = await product.listAllRuns(EVERYTHING_ACCESS, 1000);
    for (const run of runs) expect(run.coveredScope.entries).toEqual(EVERYTHING_ENTRY);
    const db = sqlite = open(sample.file);
    expect(columns(db, 'schedule_runs')).toContain('covered_scope');
    expect(columns(db, 'scans')).toContain('covered_scope');
    expect(all(db, `SELECT id FROM schedule_runs WHERE covered_scope IS NOT NULL`)).toEqual([]);
    expect(all(db, `SELECT id FROM scans WHERE covered_scope IS NOT NULL`)).toEqual([]);
  });
});
