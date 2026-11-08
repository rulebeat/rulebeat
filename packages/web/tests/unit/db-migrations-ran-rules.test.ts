/**
 * #402: the upgrade that adds `scans.ran_rule_ids` is additive. Which rules an earlier scan ran was never
 * recorded, so the column is NULL on every scan already stored and nothing else about the row changes. A
 * NULL reads as "not recorded", so a rule's Outcome falls back to the rule's own last run for that scan.
 * Migrations swallow their own errors, so these tests read every column back rather than trusting that
 * nothing threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { SHAPES } from '../fixtures/db-shapes';
import { runMigrations } from '@/lib/db/migrate';
import { EVERYTHING_ACCESS } from '../helpers/access';

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
  const history = await import('@/lib/scan-history');
  return { listOutcomeScans: history.listOutcomeScans };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];
const columns = (db: Database.Database, table: string) => all(db, `PRAGMA table_info(${table})`).map(c => c.name);

describe('upgrading to a database that records the rules a scan ran', () => {
  it('keeps every column of a stored scan, adds the column empty, and reads the scan as not recorded', async () => {
    const sample = makeSample('current');
    let db = open(sample.file);
    runMigrations(db);
    db.exec(`ALTER TABLE scans DROP COLUMN ran_rule_ids;`);
    db.prepare(`
      INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules, triggered_by,
        schedule_id, run_id, coverage, incomplete_rules, has_records)
      VALUES ('scan-old', 'reliability', '2026-02-03T04:05:06.000Z', '2026-02-03T04:06:06.000Z', 60000, '["sub-1"]', '[]',
        '{"critical":0,"high":2,"medium":5,"low":0,"info":0}', 12, 'schedule', 'sched-1', 'run-old', 'partial',
        '[{"ruleId":"r1","ruleName":"R one","status":"capped"}]', 1)
    `).run();
    const before = all(db, `SELECT * FROM scans WHERE id = 'scan-old'`)[0]!;
    expect(columns(db, 'scans')).not.toContain('ran_rule_ids');
    db.close();

    const product = await startProductOn(sample.file);

    db = sqlite = open(sample.file);
    expect(columns(db, 'scans')).toContain('ran_rule_ids');
    // Every column of the stored scan is what it was, and the new one is NULL (no backfill).
    expect(all(db, `SELECT * FROM scans WHERE id = 'scan-old'`)[0]).toEqual({ ...before, ran_rule_ids: null });

    const reliability = (await product.listOutcomeScans(EVERYTHING_ACCESS)).get('reliability');
    expect(reliability).toEqual([{
      finishedAt: '2026-02-03T04:06:06.000Z',
      subscriptionsScanned: ['sub-1'],
      coveredScope: [{ tenantId: '', path: '/' }],
      incompleteRuleIds: ['r1'],
      ranRuleIds: null,
    }]);
  });

  it.each(SHAPES)('a %s database gains the column, NULL on every scan it kept', async shape => {
    const sample = makeSample(shape);
    upgradeInProcess(sample);
    await startProductOn(sample.file);

    const db = sqlite = open(sample.file);
    expect(columns(db, 'scans')).toContain('ran_rule_ids');
    expect(all(db, `SELECT id FROM scans WHERE ran_rule_ids IS NOT NULL`)).toEqual([]);
  });
});

describe('upgrading to a database that records when a rule was switched on (#402)', () => {
  // What each rule kept through an upgrade is recorded by the golden snapshots (db-migrations-golden.test.ts).
  it.each(SHAPES)('a %s database gains the column, NULL on every rule it kept', async shape => {
    const sample = makeSample(shape);
    upgradeInProcess(sample);
    await startProductOn(sample.file);

    const db = sqlite = open(sample.file);
    expect(columns(db, 'rules')).toContain('enabled_at');
    // NULL reads as enabled since before it was recorded: no rule moves to Unknown because of the upgrade.
    expect(all(db, `SELECT id FROM rules WHERE enabled_at IS NOT NULL`)).toEqual([]);
    expect(all(db, `SELECT COUNT(*) AS n FROM rules`)[0]!.n).toBeGreaterThan(0);
  });
});
