/**
 * Issue #193: a Postgres database bootstrapped before `finding_events.row_payload` and
 * `schedule_runs.changed_findings` existed gains both columns on the next boot, keeps the events and
 * runs it held, and then records and reads row events and changed findings like SQLite does. Asserted
 * through the repositories the app reads with. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { getRun, recordCategoryProgress } from '@/lib/schedule-runs';
import { resetDb } from '../helpers/db';

const FINGERPRINT = 'pg-changed-fp';

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds the changed-finding columns to an existing database (issue #193)', () => {
  afterEach(async () => { await resetDb(); });

  it('keeps a stored event and pending run, then records changed findings and row events on them', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await pgDb!.execute(sql.raw('ALTER TABLE finding_events DROP COLUMN row_payload'));
    await pgDb!.execute(sql.raw('ALTER TABLE schedule_runs DROP COLUMN changed_findings'));
    await pgDb!.execute(sql.raw(`
      INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at)
      VALUES ('pg-evt-1', '${FINGERPRINT}', 'rule-1', 'reliability', 'scan-1', 'created', '2026-01-02T03:04:05.000Z')
    `));
    await pgDb!.execute(sql.raw(`
      INSERT INTO schedule_runs (id, schedule_id, triggered_by, started_at, status, categories, new_finding_fingerprints, notify_status)
      VALUES ('pg-run-1', 'sched-1', 'schedule', '2026-02-03T04:05:06.000Z', 'running', '["reliability"]', '["${FINGERPRINT}"]', 'pending')
    `));

    await bootstrapPg(pgDb!);

    expect(await getRun('pg-run-1')).toMatchObject({ newFindingFingerprints: [FINGERPRINT], notifyStatus: 'pending', changedFindings: [] });
    const event = await pgDb!.execute(sql.raw(`SELECT type, row_payload FROM finding_events WHERE id = 'pg-evt-1'`));
    expect(event.rows).toEqual([{ type: 'created', row_payload: null }]);

    await pgDb!.execute(sql.raw(`
      INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at, row_payload)
      VALUES ('pg-evt-2', '${FINGERPRINT}', 'rule-1', 'reliability', 'scan-2', 'row_added', '2026-03-01T00:00:00.000Z', '{"retirement":"TLS 1.0"}')
    `));
    await recordCategoryProgress('pg-run-1', {
      totalFindings: 1, newFindings: 0, newFindingFingerprints: [],
      changedFindings: [{ fingerprint: FINGERPRINT, addedRows: [{ retirement: 'TLS 1.0' }] }],
    });
    const added = await pgDb!.execute(sql.raw(`SELECT row_payload FROM finding_events WHERE id = 'pg-evt-2'`));
    expect(added.rows).toEqual([{ row_payload: '{"retirement":"TLS 1.0"}' }]);
    expect((await getRun('pg-run-1'))!.changedFindings).toEqual([{ fingerprint: FINGERPRINT, addedRows: [{ retirement: 'TLS 1.0' }] }]);
  });
});
