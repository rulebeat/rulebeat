/**
 * Issue #193: the upgrade that adds `finding_events.row_payload` and `schedule_runs.changed_findings`
 * is additive. Every event and run already stored reads back exactly as it was, the new columns are
 * empty, and a run left pending before the upgrade keeps its new-finding fingerprints and reads as
 * having no changed findings. Migrations swallow their own errors, so these tests read the content
 * back rather than trusting that nothing threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { SHAPES } from '../fixtures/db-shapes';
import { runMigrations } from '@/lib/db/migrate';

const FINGERPRINT = 'abcdef0123456789';

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

/** Starts the product against `file`: a fresh import of the db client runs the real startup
 *  migrations, and the repositories then read that database, exactly as the running app does. */
async function startProductOn(file: string) {
  vi.resetModules();
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const runs = await import('@/lib/schedule-runs');
  return { getRun: runs.getRun, listAllRuns: runs.listAllRuns, recordCategoryProgress: runs.recordCategoryProgress };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];
const columns = (db: Database.Database, table: string) => all(db, `PRAGMA table_info(${table})`).map(c => c.name);

describe('upgrading to a database that records changed findings', () => {
  it('keeps a stored event and a pending run, and reads the run as having no changed findings', async () => {
    const sample = makeSample('current');
    let db = open(sample.file);
    runMigrations(db);
    db.exec(`ALTER TABLE finding_events DROP COLUMN row_payload;`);
    db.exec(`ALTER TABLE schedule_runs DROP COLUMN changed_findings;`);
    db.prepare(`
      INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at)
      VALUES ('evt-1', ?, 'rule-1', 'reliability', 'scan-1', 'created', '2026-01-02T03:04:05.000Z')
    `).run(FINGERPRINT);
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, triggered_by, started_at, finished_at, status, categories, total_findings,
        new_findings, new_finding_fingerprints, notify_status)
      VALUES ('run-1', 'sched-1', 'schedule', '2026-02-03T04:05:06.000Z', '2026-02-03T04:06:06.000Z', 'success', '["reliability"]', 3,
        1, ?, 'pending')
    `).run(JSON.stringify([FINGERPRINT]));
    expect(columns(db, 'finding_events')).not.toContain('row_payload');
    expect(columns(db, 'schedule_runs')).not.toContain('changed_findings');
    db.close();

    const product = await startProductOn(sample.file);

    const run = await product.getRun('run-1');
    expect(run).toMatchObject({
      id: 'run-1', status: 'success', totalFindings: 3, newFindings: 1,
      newFindingFingerprints: [FINGERPRINT], notifyStatus: 'pending', changedFindings: [],
    });

    db = sqlite = open(sample.file);
    expect(columns(db, 'finding_events')).toContain('row_payload');
    expect(columns(db, 'schedule_runs')).toContain('changed_findings');
    expect(all(db, `SELECT id, type, occurred_at, row_payload FROM finding_events WHERE id = 'evt-1'`)).toEqual([
      { id: 'evt-1', type: 'created', occurred_at: '2026-01-02T03:04:05.000Z', row_payload: null },
    ]);
  });

  it('records changed findings on a run that was stored before the column existed', async () => {
    const sample = makeSample('current');
    let db = open(sample.file);
    runMigrations(db);
    db.exec(`ALTER TABLE schedule_runs DROP COLUMN changed_findings;`);
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, triggered_by, started_at, status, categories, new_finding_fingerprints)
      VALUES ('run-2', 'sched-1', 'schedule', '2026-02-03T04:05:06.000Z', 'running', '["reliability"]', '["fp-existing"]')
    `).run();
    db.close();

    const product = await startProductOn(sample.file);
    await product.recordCategoryProgress('run-2', {
      totalFindings: 1, newFindings: 0, newFindingFingerprints: [],
      changedFindings: [{ fingerprint: FINGERPRINT, addedRows: [{ retirement: 'TLS 1.0' }] }],
    });

    expect(await product.getRun('run-2')).toMatchObject({
      newFindingFingerprints: ['fp-existing'],
      changedFindings: [{ fingerprint: FINGERPRINT, addedRows: [{ retirement: 'TLS 1.0' }] }],
    });
  });

  it('keeps stored changed findings and row events across a restart', async () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    let db = open(sample.file);
    db.prepare(`
      INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at, row_payload)
      VALUES ('evt-2', ?, 'rule-1', 'reliability', 'scan-2', 'row_added', '2026-03-01T00:00:00.000Z', '{"retirement":"TLS 1.0"}')
    `).run(FINGERPRINT);
    db.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, triggered_by, started_at, status, categories, changed_findings)
      VALUES ('run-3', 'sched-1', 'schedule', '2026-03-01T00:00:00.000Z', 'success', '[]', ?)
    `).run('[{"fingerprint":"abcdef0123456789","addedRows":[{"retirement":"TLS 1.0"}]}]');
    db.close();

    const product = await startProductOn(sample.file);

    expect((await product.getRun('run-3'))!.changedFindings).toEqual([
      { fingerprint: FINGERPRINT, addedRows: [{ retirement: 'TLS 1.0' }] },
    ]);
    // Nothing in the product reads a row event's payload, so this one is checked in the table.
    db = sqlite = open(sample.file);
    expect(all(db, `SELECT row_payload FROM finding_events WHERE id = 'evt-2'`)).toEqual([{ row_payload: '{"retirement":"TLS 1.0"}' }]);
  });

  it.each(SHAPES)('a %s database gains both columns, empty', async shape => {
    const sample = makeSample(shape);
    upgradeInProcess(sample);
    const product = await startProductOn(sample.file);

    // Every run the upgrade kept reads as having no changed findings.
    for (const run of await product.listAllRuns(1000)) expect(run.changedFindings).toEqual([]);
    const db = sqlite = open(sample.file);
    expect(columns(db, 'finding_events')).toContain('row_payload');
    expect(columns(db, 'schedule_runs')).toContain('changed_findings');
    expect(all(db, `SELECT id FROM finding_events WHERE row_payload IS NOT NULL`)).toEqual([]);
  });
});
