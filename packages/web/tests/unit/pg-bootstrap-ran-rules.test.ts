/**
 * #402: a Postgres database bootstrapped before `scans.ran_rule_ids` existed gains the column on the next
 * boot, keeps every column of the scans it held, and reads them as not recorded. Asserted through the
 * repository the app reads with. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { listOutcomeScans } from '@/lib/scan-history';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds the ran rules column to an existing database (#402)', () => {
  afterEach(async () => { await resetDb(); });

  it('keeps a stored scan whole, adds the column empty, and reads the scan as not recorded', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await pgDb!.execute(sql.raw('ALTER TABLE scans DROP COLUMN ran_rule_ids'));
    await pgDb!.execute(sql.raw(`
      INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules, triggered_by,
        schedule_id, run_id, coverage, incomplete_rules, has_records)
      VALUES ('pg-scan-old', 'reliability', '2026-02-03T04:05:06.000Z', '2026-02-03T04:06:06.000Z', 60000, '["sub-1"]', '[]',
        '{"critical":0,"high":2,"medium":5,"low":0,"info":0}', 12, 'schedule', 'sched-1', 'pg-run-old', 'partial', '[]', 1)
    `));

    await bootstrapPg(pgDb!);

    const reliability = (await listOutcomeScans(EVERYTHING_ACCESS)).get('reliability');
    expect(reliability).toMatchObject([{ finishedAt: '2026-02-03T04:06:06.000Z', subscriptionsScanned: ['sub-1'], ranRuleIds: null }]);
    const stored = await pgDb!.execute(sql.raw(`SELECT total_rules, coverage, ran_rule_ids FROM scans WHERE id = 'pg-scan-old'`));
    expect(stored.rows).toEqual([{ total_rules: 12, coverage: 'partial', ran_rule_ids: null }]);
  });
});
