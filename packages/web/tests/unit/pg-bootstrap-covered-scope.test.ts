/**
 * #276: a Postgres database bootstrapped before `schedule_runs.covered_scope` and `scans.covered_scope`
 * existed gains both columns on the next boot, keeps every column of the rows it held, and reads them as
 * Everything. Asserted through the repositories the app reads with. Postgres only by nature; skipped on the
 * default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { getRun } from '@/lib/schedule-runs';
import { getScansForRun } from '@/lib/scan-history';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds the covered Scope columns to an existing database (#276)', () => {
  afterEach(async () => { await resetDb(); });

  it('keeps a stored run and scan whole, adds the column empty, and reads both as Everything', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await pgDb!.execute(sql.raw('ALTER TABLE schedule_runs DROP COLUMN covered_scope'));
    await pgDb!.execute(sql.raw('ALTER TABLE scans DROP COLUMN covered_scope'));
    await pgDb!.execute(sql.raw(`
      INSERT INTO schedule_runs (id, schedule_id, triggered_by, started_at, finished_at, status, categories, total_findings, new_findings,
        new_finding_fingerprints, error, duration_ms, notify_status)
      VALUES ('pg-run-old', 'sched-1', 'schedule', '2026-02-03T04:05:06.000Z', '2026-02-03T04:06:06.000Z', 'partial', '["reliability"]', 7, 2,
        '["fp-1","fp-2"]', 'one or more rules did not complete', 60000, 'sent')
    `));
    await pgDb!.execute(sql.raw(`
      INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules, triggered_by,
        schedule_id, run_id, coverage, incomplete_rules, has_records)
      VALUES ('pg-scan-old', 'reliability', '2026-02-03T04:05:06.000Z', '2026-02-03T04:06:06.000Z', 60000, '["sub-1"]', '[]',
        '{"critical":0,"high":2,"medium":5,"low":0,"info":0}', 12, 'schedule', 'sched-1', 'pg-run-old', 'partial', '[]', 1)
    `));

    await bootstrapPg(pgDb!);

    const run = await getRun('pg-run-old', EVERYTHING_ACCESS);
    expect(run).toMatchObject({ status: 'partial', totalFindings: 7, newFindings: 2, newFindingFingerprints: ['fp-1', 'fp-2'], error: 'one or more rules did not complete' });
    expect(run!.coveredScope.entries).toEqual([{ label: 'Everything', outside: false }]);
    const [scan] = await getScansForRun('pg-run-old', EVERYTHING_ACCESS);
    expect(scan).toMatchObject({ id: 'pg-scan-old', counts: { critical: 0, high: 2, medium: 5, low: 0, info: 0 }, totalRules: 12 });
    expect(scan!.coveredScope.entries).toEqual([{ label: 'Everything', outside: false }]);

    const stored = await pgDb!.execute(sql.raw(`SELECT covered_scope FROM schedule_runs WHERE id = 'pg-run-old'`));
    expect(stored.rows).toEqual([{ covered_scope: null }]);
  });
});
