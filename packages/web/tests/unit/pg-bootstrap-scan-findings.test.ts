/**
 * Issue #216 (ADR 0008): a Postgres database bootstrapped before `scan_findings` existed gains the table
 * and the scan marker column on the next boot, converts every stored scan's blob into records, one
 * transaction a scan, and converts what a returning previous release saved on the boot after. Postgres
 * only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { computeActivityFingerprint, computeFingerprint, computeLegacyFingerprint } from '@rulebeat/core/finding';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { resetDb } from '../helpers/db';

const RULE = 'pg-scan-findings-rule';
const SUB = '00000000-0000-0000-0000-000000000000';
const vm = (name: string) => `/subscriptions/${SUB}/resourceGroups/rg/providers/microsoft.compute/virtualmachines/${name}`;

const raw = async (statement: string) => (await pgDb!.execute(sql.raw(statement))).rows as Record<string, unknown>[];

function blobFinding(name: string, over: Record<string, unknown> = {}) {
  return {
    module: 'reliability', ruleId: RULE, fingerprint: `stale-${name}`, severity: 'medium', category: 'reliability',
    resourceId: vm(name), resourceType: 'microsoft.compute/virtualmachines', resourceName: name, subscriptionId: SUB,
    resourceGroup: 'rg', title: 'VM retirements', description: 'd', evidence: { retirement: 'Basic tier' },
    recommendation: 'r', remediationSteps: [], detectedAt: '2026-01-02T03:04:05.000Z', ...over,
  };
}

async function insertScan(id: string, findings: unknown, startedAt: string): Promise<void> {
  await pgDb!.execute(sql`
    INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules)
    VALUES (${id}, 'reliability', ${startedAt}, ${startedAt}, 10, '[]', ${typeof findings === 'string' ? findings : JSON.stringify(findings)}, '{}', 1)
  `);
}

const recordsOf = (scanId: string) => raw(`SELECT fingerprint, rule_id, severity, kind, category, resource_id, resource_name, row_count
  FROM scan_findings WHERE scan_id = '${scanId}' ORDER BY fingerprint COLLATE "C"`);
const markers = () => raw(`SELECT id, has_records FROM scans ORDER BY id COLLATE "C"`);

/** The database as the previous release left it. */
async function previousReleaseDatabase(): Promise<void> {
  await dbReady;
  await resetDb();
  await bootstrapPg(pgDb!);
  await raw(`DROP TABLE scan_findings`);
  await raw(`ALTER TABLE scans DROP COLUMN has_records`);
}

describe.skipIf(dbKind !== 'pg')('bootstrapPg stores scans as scan_findings records (issue #216)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    // A test that failed after dropping the table or the column must not leave the next suite without them.
    await raw(`DROP TRIGGER IF EXISTS refuse_poison ON scan_findings`).catch(() => {});
    await raw(`DROP FUNCTION IF EXISTS refuse_poison()`);
    await bootstrapPg(pgDb!);
    await resetDb();
  });

  it('converts every stored scan to the records the scan path would have written, and changes nothing stored', async () => {
    await previousReleaseDatabase();
    await insertScan('pg-scan-1', [
      blobFinding('vm-1', { fingerprint: computeLegacyFingerprint(RULE, vm('vm-1')), severity: 'high', rows: [{ n: 1 }, { n: 2 }, { n: 3 }] }),
      blobFinding('vm-2', { kind: 'advisory' }),
      blobFinding('vm-3', { kind: 'activity', dimensionKey: 'user-1', resourceId: undefined, resourceName: undefined, resourceType: undefined, resourceGroup: undefined }),
    ], '2026-01-01T00:00:00.000Z');
    await insertScan('pg-scan-empty', [], '2026-01-02T00:00:00.000Z');
    const before = await raw(`SELECT id, findings, counts FROM scans ORDER BY id COLLATE "C"`);

    await bootstrapPg(pgDb!);

    const records = await recordsOf('pg-scan-1');
    expect(records).toHaveLength(3);
    expect(records.find(r => r.resource_name === 'vm-1')).toMatchObject({ fingerprint: computeFingerprint(RULE, vm('vm-1')), severity: 'high', kind: 'state', row_count: 3, category: 'reliability' });
    expect(records.find(r => r.kind === 'advisory')).toMatchObject({ fingerprint: computeFingerprint(RULE, vm('vm-2')), row_count: 1 });
    expect(records.find(r => r.kind === 'activity')).toMatchObject({ fingerprint: computeActivityFingerprint(RULE, 'user-1'), resource_id: null, resource_name: null });
    expect(await recordsOf('pg-scan-empty')).toEqual([]);
    expect(await markers()).toEqual([{ id: 'pg-scan-1', has_records: 1 }, { id: 'pg-scan-empty', has_records: 1 }]);
    expect(await raw(`SELECT id, findings, counts FROM scans ORDER BY id COLLATE "C"`)).toEqual(before);
  });

  it('does nothing on a second boot, and converts what a returning previous release saved', async () => {
    await previousReleaseDatabase();
    await insertScan('pg-scan-old', [blobFinding('vm-1')], '2026-01-01T00:00:00.000Z');
    await insertScan('pg-scan-kept', [blobFinding('vm-2')], '2026-01-02T00:00:00.000Z');
    await bootstrapPg(pgDb!);
    await raw(`UPDATE scan_findings SET title = 'kept' WHERE scan_id = 'pg-scan-kept'`);
    await bootstrapPg(pgDb!);
    expect(await raw(`SELECT DISTINCT title FROM scan_findings WHERE scan_id = 'pg-scan-kept'`)).toEqual([{ title: 'kept' }]);

    // The previous release again: it saves a scan without naming the marker and prunes one without
    // knowing it has records.
    await insertScan('pg-scan-new', [blobFinding('vm-3'), blobFinding('vm-4')], '2026-01-03T00:00:00.000Z');
    await raw(`DELETE FROM scans WHERE id = 'pg-scan-old'`);
    expect(await markers()).toEqual([{ id: 'pg-scan-kept', has_records: 1 }, { id: 'pg-scan-new', has_records: 0 }]);

    await bootstrapPg(pgDb!);

    expect(await recordsOf('pg-scan-new')).toHaveLength(2);
    // DISTINCT sits in a subquery: Postgres wants an ORDER BY expression of a DISTINCT select to be in its list,
    // and `scan_id COLLATE "C"` is not the `scan_id` that is.
    expect(await raw(`SELECT scan_id FROM (SELECT DISTINCT scan_id FROM scan_findings) AS stored ORDER BY scan_id COLLATE "C"`)).toEqual([{ scan_id: 'pg-scan-kept' }, { scan_id: 'pg-scan-new' }]);
    expect(await raw(`SELECT DISTINCT title FROM scan_findings WHERE scan_id = 'pg-scan-kept'`)).toEqual([{ title: 'kept' }]);
    expect(await markers()).toEqual([{ id: 'pg-scan-kept', has_records: 1 }, { id: 'pg-scan-new', has_records: 1 }]);
  });

  it('costs an unreadable blob only its own scan, and leaves no partial records for one that fails part way', async () => {
    await previousReleaseDatabase();
    await bootstrapPg(pgDb!);
    await insertScan('pg-scan-good', [blobFinding('vm-1')], '2026-01-01T00:00:00.000Z');
    await insertScan('pg-scan-broken', '{not json', '2026-01-02T00:00:00.000Z');
    await insertScan('pg-scan-poisoned', [blobFinding('vm-2'), blobFinding('vm-3', { title: 'poison' })], '2026-01-03T00:00:00.000Z');
    // One statement a call: the driver runs a parameterless call as a simple query, but nothing here depends on that.
    await raw(`CREATE OR REPLACE FUNCTION refuse_poison() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused'; END; $$ LANGUAGE plpgsql`);
    await raw(`CREATE TRIGGER refuse_poison BEFORE INSERT ON scan_findings FOR EACH ROW WHEN (NEW.title = 'poison') EXECUTE FUNCTION refuse_poison()`);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await bootstrapPg(pgDb!);

    const logged = error.mock.calls.map(call => call.map(String).join(' ')).join('\n');
    expect(logged).toContain('pg-scan-broken');
    expect(logged).toContain('pg-scan-poisoned');
    expect(await recordsOf('pg-scan-good')).toHaveLength(1);
    expect(await recordsOf('pg-scan-broken')).toEqual([]);
    expect(await recordsOf('pg-scan-poisoned')).toEqual([]);
    expect(await markers()).toEqual([
      { id: 'pg-scan-broken', has_records: 0 }, { id: 'pg-scan-good', has_records: 1 }, { id: 'pg-scan-poisoned', has_records: 0 },
    ]);

    await raw(`DROP TRIGGER refuse_poison ON scan_findings`);
    await bootstrapPg(pgDb!);
    expect(await recordsOf('pg-scan-poisoned')).toHaveLength(2);
  });
});
