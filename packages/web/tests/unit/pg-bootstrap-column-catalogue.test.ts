/**
 * ADR 0007: a Postgres database bootstrapped before `column_catalogue` existed gains the
 * table on the next boot and has it built once from the stored rows, every rule's columns, Fixed
 * findings included, with every finding and suppression intact. A build that fails leaves no trace and
 * the boot after builds it. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { COLUMN_CATALOGUE_MARKER } from '@/lib/db/column-catalogue-build';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import { listFindings } from '@/lib/db/findings';
import { listReturnedColumns } from '@/lib/db/column-catalogue';
import { addSuppression, loadSuppressions } from '@/lib/suppressions';
import { resetDb } from '../helpers/db';

const RULE = 'pg-catalogue-rule';
const OTHER_RULE = 'pg-catalogue-other-rule';

const raw = async (statement: string) => (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[];

async function insertFinding(fingerprint: string, ruleId: string, status: 'active' | 'fixed', rows: Record<string, unknown>[]): Promise<void> {
  await pgDb!.execute(sql`
    INSERT INTO findings (fingerprint, rule_id, category, severity, subscription_id, title, evidence, evidence_rows,
      status, first_seen_at, last_seen_at, last_scan_id, times_seen, row_count, rows_scan_id)
    VALUES (${fingerprint}, ${ruleId}, 'reliability', 'medium', 'sub', 'VM retirements', ${JSON.stringify(rows[0] ?? {})},
      ${JSON.stringify(rows)}, ${status}, '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 'scan-1', 9, ${rows.length}, 'scan-1')
  `);
  for (const [position, row] of rows.entries()) {
    await pgDb!.execute(sql`INSERT INTO finding_rows (fingerprint, position, data) VALUES (${fingerprint}, ${position}, ${JSON.stringify(row)})`);
  }
}

/** The database as the previous release left it: finding_rows proven, no catalogue, no marker. */
async function previousReleaseDatabase(): Promise<void> {
  await dbReady;
  await resetDb();
  await bootstrapPg(pgDb!);
  await raw(`DROP TABLE column_catalogue`);
  await raw(`DELETE FROM meta WHERE key = '${COLUMN_CATALOGUE_MARKER}'`);
  await insertFinding('pg-fp-a', RULE, 'active', [{ feature: 'Basic tier', properties: { sku: { name: 'S1' } } }, { feature: 'TLS 1.0', date: '2026-09-30' }]);
  await insertFinding('pg-fp-fixed', RULE, 'fixed', [{ onlyWhenFixed: 'x' }]);
  await insertFinding('pg-fp-empty', RULE, 'active', []);
  await insertFinding('pg-fp-other', OTHER_RULE, 'active', [{ other: 1, _rule: { hidden: true } }]);
}

describe.skipIf(dbKind !== 'pg')('bootstrapPg builds the column catalogue', () => {
  afterEach(async () => { await resetDb(); vi.restoreAllMocks(); });

  it('builds every rule\'s columns from the stored rows, keeps findings and suppressions, and sets the marker', async () => {
    await previousReleaseDatabase();
    await addSuppression({ id: 'pg-catalogue-sup', fingerprint: 'pg-fp-a', reason: 'Accepted risk', suppressedAt: '2026-02-01T00:00:00.000Z' });
    const findingsBefore = await raw(`SELECT * FROM findings ORDER BY fingerprint`);

    await bootstrapPg(pgDb!);

    expect(await listReturnedColumns([RULE])).toEqual(['date', 'feature', 'onlyWhenFixed', 'properties.sku.name']);
    expect(await listReturnedColumns([OTHER_RULE])).toEqual(['other']);
    expect((await loadSuppressions()).filter(s => s.fingerprint === 'pg-fp-a')).toEqual([
      expect.objectContaining({ id: 'pg-catalogue-sup', reason: 'Accepted risk' }),
    ]);
    expect((await listFindings()).find(f => f.fingerprint === 'pg-fp-a')).toMatchObject({ firstSeenAt: '2026-01-02T03:04:05.000Z', timesSeen: 9 });
    expect(await raw(`SELECT * FROM findings ORDER BY fingerprint`)).toEqual(findingsBefore);
    expect(await raw(`SELECT key FROM meta WHERE key = '${COLUMN_CATALOGUE_MARKER}'`)).toHaveLength(1);
  });

  it('builds once: a later boot leaves the catalogue as scans have kept it', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    await raw(`INSERT INTO column_catalogue (rule_id, path) VALUES ('${RULE}', 'added-by-a-scan')`);
    await raw(`DELETE FROM column_catalogue WHERE rule_id = '${RULE}' AND path = 'date'`);

    await bootstrapPg(pgDb!);

    expect(await listReturnedColumns([RULE])).toEqual(['added-by-a-scan', 'feature', 'onlyWhenFixed', 'properties.sku.name']);
  });

  it('does not build before the rows are copied', async () => {
    await previousReleaseDatabase();
    await raw(`DELETE FROM meta WHERE key = '${FINDING_ROWS_COPY_MARKER}'`);
    // The copy cannot prove out: a trigger corrupts what is written to finding_rows during the copy.
    await raw(`CREATE OR REPLACE FUNCTION corrupt_rows() RETURNS trigger AS $$ BEGIN NEW.data := '{}'; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await raw(`CREATE TRIGGER corrupt_rows BEFORE INSERT ON finding_rows FOR EACH ROW EXECUTE FUNCTION corrupt_rows()`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await bootstrapPg(pgDb!);
      expect(await raw(`SELECT key FROM meta WHERE key = '${FINDING_ROWS_COPY_MARKER}'`)).toEqual([]);
      expect(await raw(`SELECT key FROM meta WHERE key = '${COLUMN_CATALOGUE_MARKER}'`)).toEqual([]);
    } finally {
      await raw(`DROP TRIGGER corrupt_rows ON finding_rows`);
      await raw(`DROP FUNCTION corrupt_rows()`);
    }
  });

  it('a build that fails leaves no trace, and the next boot builds it', async () => {
    await previousReleaseDatabase();
    // The table as the bootstrap creates it, with a trigger that fails the write of one entry.
    await raw(`CREATE TABLE column_catalogue (rule_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (rule_id, path))`);
    await raw(`CREATE OR REPLACE FUNCTION fail_build() RETURNS trigger AS $$ BEGIN IF NEW.path = 'properties.sku.name' THEN RAISE EXCEPTION 'cannot write this entry'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await raw(`CREATE TRIGGER fail_build BEFORE INSERT ON column_catalogue FOR EACH ROW EXECUTE FUNCTION fail_build()`);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await bootstrapPg(pgDb!);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not build the column catalogue'), expect.anything());
    expect(await raw(`SELECT COUNT(*)::int AS n FROM column_catalogue`)).toEqual([{ n: 0 }]);
    expect(await raw(`SELECT key FROM meta WHERE key = '${COLUMN_CATALOGUE_MARKER}'`)).toEqual([]);

    await raw(`DROP TRIGGER fail_build ON column_catalogue`);
    await raw(`DROP FUNCTION fail_build()`);
    await bootstrapPg(pgDb!);
    expect(await listReturnedColumns([RULE])).toEqual(['date', 'feature', 'onlyWhenFixed', 'properties.sku.name']);
    expect(await raw(`SELECT key FROM meta WHERE key = '${COLUMN_CATALOGUE_MARKER}'`)).toHaveLength(1);
  });
});
