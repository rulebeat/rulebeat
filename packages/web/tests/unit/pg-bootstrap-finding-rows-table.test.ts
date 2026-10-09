/**
 * Issue #199 (ADR 0007): a Postgres database bootstrapped before `finding_rows` existed gains the
 * table and the two row columns on the next boot, has every finding's rows copied into the table in
 * order, and keeps every finding and suppression it held. A finding the previous release rescanned
 * is copied again on the boot after. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import { listFindings } from '@/lib/db/findings';
import { addSuppression, loadSuppressions } from '@/lib/suppressions';
import { resetDb } from '../helpers/db';

const ROWS = [{ retirement: 'Basic tier' }, { retirement: 'TLS 1.0' }, { retirement: 'Gen1 images' }];

const raw = async (statement: string) => (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[];

async function insertOldFinding(fingerprint: string, evidenceRows: unknown[] | null, lastScanId: string): Promise<void> {
  await pgDb!.execute(sql`
    INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, title, evidence, evidence_rows,
      status, first_seen_at, last_seen_at, last_scan_id, times_seen)
    VALUES (${fingerprint}, 'pg-rows-table-rule', 'reliability', 'medium', 'sub', 'VM retirements', ${JSON.stringify(ROWS[0])},
      ${evidenceRows ? JSON.stringify(evidenceRows) : null}, 'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z',
      ${lastScanId}, 9)
  `);
}

describe.skipIf(dbKind !== 'pg')('bootstrapPg moves finding rows into finding_rows (issue #199)', () => {
  afterEach(async () => { await resetDb(); });

  it('copies every finding\'s rows in order, keeps its age and suppression, and sets the marker', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    // The database as the previous release left it.
    await raw(`DROP TABLE finding_rows`);
    await raw(`ALTER TABLE findings DROP COLUMN row_count`);
    await raw(`ALTER TABLE findings DROP COLUMN rows_scan_id`);
    await raw(`DELETE FROM meta WHERE key = '${FINDING_ROWS_COPY_MARKER}'`);
    await insertOldFinding('pg-fp-many', ROWS, 'scan-1');
    await insertOldFinding('pg-fp-evidence', null, 'scan-1');
    await addSuppression({ id: 'pg-rows-table-sup', fingerprint: 'pg-fp-many', reason: 'Accepted risk', suppressedAt: '2026-02-01T00:00:00.000Z' });

    await bootstrapPg(pgDb!);

    const found = new Map((await listFindings()).map(f => [f.fingerprint, f]));
    expect(found.get('pg-fp-many')).toMatchObject({ firstSeenAt: '2026-01-02T03:04:05.000Z', timesSeen: 9, evidence: ROWS[0], rows: ROWS });
    expect(found.get('pg-fp-evidence')).toMatchObject({ rows: [ROWS[0]] });
    expect((await loadSuppressions()).filter(s => s.fingerprint === 'pg-fp-many')).toEqual([
      expect.objectContaining({ id: 'pg-rows-table-sup', reason: 'Accepted risk' }),
    ]);
    expect(await raw(`SELECT fingerprint, position, data FROM finding_rows WHERE fingerprint = 'pg-fp-many' ORDER BY position`)).toEqual(
      ROWS.map((row, position) => ({ fingerprint: 'pg-fp-many', position, data: JSON.stringify(row) })),
    );
    expect(await raw(`SELECT row_count, rows_scan_id FROM findings WHERE fingerprint = 'pg-fp-many'`)).toEqual([{ row_count: 3, rows_scan_id: 'scan-1' }]);
    expect(await raw(`SELECT key FROM meta WHERE key = '${FINDING_ROWS_COPY_MARKER}'`)).toHaveLength(1);
  });

  it('copies again what the previous release rescanned, and drops the rows of what it deleted', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await insertOldFinding('pg-fp-rescanned', [ROWS[0]], 'scan-1');
    await insertOldFinding('pg-fp-deleted', [ROWS[1]], 'scan-1');
    await bootstrapPg(pgDb!);

    await raw(`UPDATE findings SET evidence_rows = '${JSON.stringify(ROWS)}', last_scan_id = 'scan-2' WHERE fingerprint = 'pg-fp-rescanned'`);
    await raw(`DELETE FROM findings WHERE fingerprint = 'pg-fp-deleted'`);
    await bootstrapPg(pgDb!);

    expect((await listFindings()).find(f => f.fingerprint === 'pg-fp-rescanned')!.rows).toEqual(ROWS);
    expect(await raw(`SELECT fingerprint FROM finding_rows WHERE fingerprint = 'pg-fp-deleted'`)).toEqual([]);
    expect(await raw(`SELECT row_count, rows_scan_id FROM findings WHERE fingerprint = 'pg-fp-rescanned'`)).toEqual([{ row_count: 3, rows_scan_id: 'scan-2' }]);
  });
});
