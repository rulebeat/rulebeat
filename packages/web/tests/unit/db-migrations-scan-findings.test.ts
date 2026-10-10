/**
 * Issue #216 (ADR 0008): the upgrade that converts every stored scan's findings blob into
 * `scan_findings` records. One transaction a scan, each scan marked converted, so a restart part way
 * resumes and a second start does nothing; an unreadable blob costs only its own scan; a database that
 * comes back from the previous release converts what that release saved. Migrations swallow their own
 * errors, so these tests read the content back rather than trusting that nothing threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { computeActivityFingerprint, computeFingerprint, computeLegacyFingerprint } from '@rulebeat/core/finding';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';

const RULE = '9a4e7c31-5b2d-4e8f-8c6a-1d3f5b7a9c20';
const SUB = '00000000-0000-0000-0000-000000000000';
const vm = (name: string) => `/subscriptions/${SUB}/resourceGroups/rg/providers/microsoft.compute/virtualmachines/${name}`;

let sqlite: Database.Database | undefined;
let closeProductDb: (() => void) | undefined;
afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
  closeProductDb?.();
  closeProductDb = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Starts the product against `file`: a fresh import of the db client runs the real startup
 *  migrations, and the repositories then read that database, exactly as the running app does. */
async function startProductOn(file: string) {
  vi.resetModules();
  // A SQLite upgrade test: the Postgres CI job must not point the product at its database instead.
  vi.stubEnv('RULEBEAT_DATABASE_URL', '');
  vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const findings = await import('@/lib/db/findings');
  return { listFindings: findings.listFindings };
}

const all = (db: Database.Database, text: string, ...params: unknown[]) => db.prepare(text).all(...params) as Record<string, unknown>[];

/** A database exactly as the release before scan_findings left it: no table, no marker column. */
function previousReleaseDatabase() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  db.exec(`
    DROP TABLE scan_findings;
    ALTER TABLE scans DROP COLUMN has_records;
  `);
  db.prepare(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type)
    VALUES (?, 'VM retirements', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]',
      'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom')
  `).run(RULE);
  return { sample, db };
}

/** A finding as a scan stored it in its blob. */
function blobFinding(name: string, over: Record<string, unknown> = {}) {
  return {
    module: 'reliability',
    ruleId: RULE,
    fingerprint: `stale-${name}`,
    severity: 'medium',
    category: 'reliability',
    resourceId: vm(name),
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: name,
    subscriptionId: SUB,
    resourceGroup: 'rg',
    location: 'westeurope',
    title: 'VM retirements',
    description: 'd',
    evidence: { retirement: 'Basic tier' },
    recommendation: 'r',
    remediationSteps: [],
    detectedAt: '2026-01-02T03:04:05.000Z',
    ...over,
  };
}

function insertScan(db: Database.Database, id: string, findings: unknown, startedAt: string, module = 'reliability'): void {
  db.prepare(`
    INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules)
    VALUES (?, ?, ?, ?, 10, '[]', ?, '{}', 1)
  `).run(id, module, startedAt, startedAt, typeof findings === 'string' ? findings : JSON.stringify(findings));
}

const recordsOf = (db: Database.Database, scanId: string) => all(db,
  `SELECT fingerprint, rule_id, severity, title, kind, category, resource_id, resource_name, resource_type, resource_group, subscription_id, row_count
   FROM scan_findings WHERE scan_id = ? ORDER BY fingerprint`, scanId);
const converted = (db: Database.Database) => all(db, `SELECT id, has_records FROM scans ORDER BY id`);

describe('upgrading to scan_findings', () => {
  it('converts every stored scan to the records the scan path would have written, and changes nothing stored', async () => {
    const { sample, db } = previousReleaseDatabase();
    insertScan(db, 'scan-1', [
      // Rows, and a fingerprint from before the case-insensitive formula: the record gets today's.
      blobFinding('vm-1', { fingerprint: computeLegacyFingerprint(RULE, vm('vm-1')), severity: 'high', rows: [{ n: 1 }, { n: 2 }, { n: 3 }] }),
      // A finding stored before rows existed reads as one row made from its evidence.
      blobFinding('vm-2', { kind: 'advisory' }),
      blobFinding('vm-3', { evidence: {} }),
      // An Activity finding has no resource and is keyed by its dimension.
      blobFinding('vm-4', { kind: 'activity', dimensionKey: 'user-1', resourceId: undefined, resourceName: undefined, resourceType: undefined, resourceGroup: undefined, fingerprint: 'stale-activity' }),
    ], '2026-01-01T00:00:00.000Z');
    insertScan(db, 'scan-2', [blobFinding('vm-1')], '2026-01-02T00:00:00.000Z');
    insertScan(db, 'scan-empty', [], '2026-01-03T00:00:00.000Z');
    insertScan(db, 'scan-other', [blobFinding('vm-9', { category: 'security', module: 'security' })], '2026-01-04T00:00:00.000Z', 'security');
    db.prepare(`
      INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
      VALUES ('sup-1', ?, ?, 'Accepted risk', '2026-02-01T00:00:00.000Z')
    `).run(computeFingerprint(RULE, vm('vm-1')), vm('vm-1'));
    const before = all(db, `SELECT id, module, findings, counts, started_at FROM scans ORDER BY id`);
    const suppressionsBefore = all(db, `SELECT * FROM suppressions`);
    db.close();

    const product = await startProductOn(sample.file);
    await product.listFindings();

    sqlite = open(sample.file);
    const scanOne = recordsOf(sqlite, 'scan-1');
    expect(scanOne).toHaveLength(4);
    const byFingerprint = (fingerprint: string) => scanOne.find(r => r.fingerprint === fingerprint);
    expect(byFingerprint(computeFingerprint(RULE, vm('vm-1')))).toMatchObject({ severity: 'high', kind: 'state', row_count: 3, resource_name: 'vm-1', resource_group: 'rg', category: 'reliability', subscription_id: SUB });
    expect(byFingerprint(computeFingerprint(RULE, vm('vm-2')))).toMatchObject({ kind: 'advisory', row_count: 1 });
    expect(byFingerprint(computeFingerprint(RULE, vm('vm-3')))).toMatchObject({ row_count: 0 });
    expect(byFingerprint(computeActivityFingerprint(RULE, 'user-1'))).toEqual({
      fingerprint: computeActivityFingerprint(RULE, 'user-1'), rule_id: RULE, severity: 'medium', title: 'VM retirements', kind: 'activity',
      category: 'reliability', resource_id: null, resource_name: null, resource_type: null, resource_group: null, subscription_id: SUB, row_count: 1,
    });
    expect(recordsOf(sqlite, 'scan-2')).toHaveLength(1);
    expect(recordsOf(sqlite, 'scan-empty')).toEqual([]);
    // The scan's own category, as the findings table keeps it, not the finding's.
    expect(recordsOf(sqlite, 'scan-other')).toEqual([expect.objectContaining({ category: 'security' })]);
    expect(converted(sqlite)).toEqual([
      { id: 'scan-1', has_records: 1 }, { id: 'scan-2', has_records: 1 }, { id: 'scan-empty', has_records: 1 }, { id: 'scan-other', has_records: 1 },
    ]);
    // Nothing already stored was rewritten.
    expect(all(sqlite, `SELECT id, module, findings, counts, started_at FROM scans ORDER BY id`)).toEqual(before);
    expect(all(sqlite, `SELECT * FROM suppressions`)).toEqual(suppressionsBefore);
  });

  it('folds findings that share a fingerprint into one record, as the scan does', async () => {
    const { sample, db } = previousReleaseDatabase();
    const upper = vm('VM-1');
    insertScan(db, 'scan-1', [
      blobFinding('vm-1', { rows: [{ n: 1 }, { n: 2 }] }),
      // The same resource under different casing, from a release that did not ignore it.
      blobFinding('VM-1', { resourceId: upper, rows: [{ n: 2 }, { n: 3 }], title: 'Last one wins' }),
    ], '2026-01-01T00:00:00.000Z');
    db.close();

    await startProductOn(sample.file);

    sqlite = open(sample.file);
    expect(recordsOf(sqlite, 'scan-1')).toEqual([
      expect.objectContaining({ fingerprint: computeFingerprint(RULE, vm('vm-1')), title: 'Last one wins', row_count: 3 }),
    ]);
  });

  it('does nothing on a second start, and resumes the scans a restart part way left unconverted', async () => {
    const { sample, db } = previousReleaseDatabase();
    insertScan(db, 'scan-a', [blobFinding('vm-1'), blobFinding('vm-2')], '2026-01-01T00:00:00.000Z');
    insertScan(db, 'scan-b', [blobFinding('vm-3'), blobFinding('vm-4')], '2026-01-02T00:00:00.000Z');
    runMigrations(db);
    expect(converted(db)).toEqual([{ id: 'scan-a', has_records: 1 }, { id: 'scan-b', has_records: 1 }]);

    // A second start finds nothing to do: a record changed by hand survives it.
    db.prepare(`UPDATE scan_findings SET title = 'kept' WHERE scan_id = 'scan-a'`).run();
    runMigrations(db);
    expect(all(db, `SELECT DISTINCT title FROM scan_findings WHERE scan_id = 'scan-a'`)).toEqual([{ title: 'kept' }]);
    expect(all(db, `SELECT COUNT(*) AS n FROM scan_findings`)).toEqual([{ n: 4 }]);

    // A start that died in the middle of scan-b: one record written, one stray, scan-a done.
    db.prepare(`UPDATE scans SET has_records = 0 WHERE id = 'scan-b'`).run();
    db.prepare(`DELETE FROM scan_findings WHERE scan_id = 'scan-b' AND fingerprint = ?`).run(computeFingerprint(RULE, vm('vm-4')));
    db.prepare(`
      INSERT INTO scan_findings (scan_id, fingerprint, rule_id, severity, title, kind, category, subscription_id, row_count)
      VALUES ('scan-b', 'stray', ?, 'low', 'stray', 'state', 'reliability', ?, 0)
    `).run(RULE, SUB);
    db.close();

    await startProductOn(sample.file);

    sqlite = open(sample.file);
    expect(recordsOf(sqlite, 'scan-b').map(r => r.fingerprint).sort()).toEqual(
      [computeFingerprint(RULE, vm('vm-3')), computeFingerprint(RULE, vm('vm-4'))].sort(),
    );
    expect(all(sqlite, `SELECT DISTINCT title FROM scan_findings WHERE scan_id = 'scan-a'`)).toEqual([{ title: 'kept' }]);
    expect(converted(sqlite)).toEqual([{ id: 'scan-a', has_records: 1 }, { id: 'scan-b', has_records: 1 }]);
  });

  it('costs an unreadable blob only its own scan: it is logged, left as it was, and retried next start', async () => {
    const { sample, db } = previousReleaseDatabase();
    insertScan(db, 'scan-good', [blobFinding('vm-1')], '2026-01-01T00:00:00.000Z');
    insertScan(db, 'scan-broken', '{not json', '2026-01-02T00:00:00.000Z');
    insertScan(db, 'scan-wrong-shape', [{ ruleId: 7 }], '2026-01-03T00:00:00.000Z');
    insertScan(db, 'scan-later', [blobFinding('vm-2')], '2026-01-04T00:00:00.000Z');
    db.close();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const product = await startProductOn(sample.file);

    // The app started and still reads.
    await expect(product.listFindings()).resolves.toEqual(expect.any(Array));
    const logged = error.mock.calls.map(call => call.map(String).join(' ')).join('\n');
    expect(logged).toContain('scan-broken');
    expect(logged).toContain('scan-wrong-shape');
    expect(logged).not.toContain('scan-good');

    sqlite = open(sample.file);
    expect(converted(sqlite)).toEqual([
      { id: 'scan-broken', has_records: 0 }, { id: 'scan-good', has_records: 1 }, { id: 'scan-later', has_records: 1 }, { id: 'scan-wrong-shape', has_records: 0 },
    ]);
    // Such a scan has no records, so it reads as an empty snapshot until its blob is readable; the blob is untouched.
    expect(recordsOf(sqlite, 'scan-broken')).toEqual([]);
    expect(recordsOf(sqlite, 'scan-wrong-shape')).toEqual([]);
    expect(all(sqlite, `SELECT findings FROM scans WHERE id = 'scan-broken'`)).toEqual([{ findings: '{not json' }]);

    // The next start retries it.
    sqlite.prepare(`UPDATE scans SET findings = ? WHERE id = 'scan-broken'`).run(JSON.stringify([blobFinding('vm-3')]));
    runMigrations(sqlite);
    expect(recordsOf(sqlite, 'scan-broken')).toHaveLength(1);
    expect(all(sqlite, `SELECT has_records FROM scans WHERE id = 'scan-broken'`)).toEqual([{ has_records: 1 }]);
  });

  it('leaves no partial records for a scan whose conversion fails part way, and converts the rest', () => {
    const { db } = previousReleaseDatabase();
    sqlite = db;
    insertScan(db, 'scan-1', [blobFinding('vm-1')], '2026-01-01T00:00:00.000Z');
    insertScan(db, 'scan-2', [blobFinding('vm-2'), blobFinding('vm-3', { title: 'poison' })], '2026-01-02T00:00:00.000Z');
    insertScan(db, 'scan-3', [blobFinding('vm-4')], '2026-01-03T00:00:00.000Z');
    // The table as the upgrade creates it, with a trigger that refuses one finding of scan-2.
    db.exec(`
      CREATE TABLE scan_findings (
        scan_id TEXT NOT NULL, fingerprint TEXT NOT NULL, rule_id TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL,
        kind TEXT NOT NULL, category TEXT NOT NULL, resource_id TEXT, resource_name TEXT, resource_type TEXT, resource_group TEXT,
        subscription_id TEXT NOT NULL, row_count INTEGER NOT NULL, PRIMARY KEY (scan_id, fingerprint)
      );
      CREATE TRIGGER refuse_poison BEFORE INSERT ON scan_findings WHEN NEW.title = 'poison' BEGIN SELECT RAISE(ABORT, 'refused'); END;
    `);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    runMigrations(db);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('scan-2'), expect.anything());
    expect(recordsOf(db, 'scan-2')).toEqual([]);
    expect(recordsOf(db, 'scan-1')).toHaveLength(1);
    expect(recordsOf(db, 'scan-3')).toHaveLength(1);
    expect(converted(db)).toEqual([{ id: 'scan-1', has_records: 1 }, { id: 'scan-2', has_records: 0 }, { id: 'scan-3', has_records: 1 }]);

    db.exec(`DROP TRIGGER refuse_poison`);
    runMigrations(db);
    expect(recordsOf(db, 'scan-2')).toHaveLength(2);
    expect(converted(db)).toEqual([{ id: 'scan-1', has_records: 1 }, { id: 'scan-2', has_records: 1 }, { id: 'scan-3', has_records: 1 }]);
  });

  it('converts, on the next start, what the previous release saved after the database went back to it', async () => {
    const { sample, db } = previousReleaseDatabase();
    insertScan(db, 'scan-old', [blobFinding('vm-1')], '2026-01-01T00:00:00.000Z');
    insertScan(db, 'scan-kept', [blobFinding('vm-2')], '2026-01-02T00:00:00.000Z');
    runMigrations(db);
    db.prepare(`UPDATE scan_findings SET title = 'kept' WHERE scan_id = 'scan-kept'`).run();

    // The previous release again: it saves a scan without naming the marker, and its pruning deletes a
    // scan row without knowing it has records.
    insertScan(db, 'scan-new', [blobFinding('vm-3'), blobFinding('vm-4')], '2026-01-03T00:00:00.000Z');
    db.prepare(`DELETE FROM scans WHERE id = 'scan-old'`).run();
    expect(converted(db)).toEqual([{ id: 'scan-kept', has_records: 1 }, { id: 'scan-new', has_records: 0 }]);
    db.close();

    await startProductOn(sample.file);

    sqlite = open(sample.file);
    expect(recordsOf(sqlite, 'scan-new')).toHaveLength(2);
    expect(recordsOf(sqlite, 'scan-old')).toEqual([]);
    expect(all(sqlite, `SELECT DISTINCT scan_id FROM scan_findings ORDER BY scan_id`)).toEqual([{ scan_id: 'scan-kept' }, { scan_id: 'scan-new' }]);
    expect(all(sqlite, `SELECT DISTINCT title FROM scan_findings WHERE scan_id = 'scan-kept'`)).toEqual([{ title: 'kept' }]);
    expect(converted(sqlite)).toEqual([{ id: 'scan-kept', has_records: 1 }, { id: 'scan-new', has_records: 1 }]);
  });

  it('converts a scan to exactly the records the scan path stored for it, fingerprint for fingerprint', async () => {
    const sample = makeSample('current');
    const seed = open(sample.file);
    runMigrations(seed);
    const insertRule = seed.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, query_backend, logs_query, type)
      VALUES (?, ?, 'test', 'identity', ?, 1, '{"level":"subscription"}', '[]', '[]', ?, ?, ?, 'custom')
    `);
    insertRule.run('parity-arg-rule', 'VM retirements', 'high', 'resources | where type == "microsoft.compute/virtualmachines"', 'resource-graph', null);
    insertRule.run('parity-logs-rule', 'Failed sign-ins', 'medium', null, 'log-analytics',
      JSON.stringify({ kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30, dimensionKeyField: 'UserId' }));
    seed.close();

    // A real scan through the product: its ARM ids are mixed case, so the legacy and the current
    // fingerprint formulas differ, and one finding is Activity, which hashes its dimension instead.
    await startProductOn(sample.file);
    const { runCategoryScan } = await import('@/lib/scan-runner');
    const { getCategory } = await import('@/lib/db/categories');
    const { fakeTenantContext, argRow } = await import('../helpers/fake-azure');
    const { summary } = await runCategoryScan((await getCategory('identity'))!, {
      ctx: fakeTenantContext({
        rows: [{ ...argRow({ name: 'VM-One' }), retirement: 'a' }, { ...argRow({ name: 'vm-two' }), retirement: 'b' }, { ...argRow({ name: 'VM-One' }), retirement: 'c' }],
        logsRows: [{ UserId: 'u1', ResultType: '50126' }, { UserId: 'u1', ResultType: '50057' }],
      }),
      ruleIds: ['parity-arg-rule', 'parity-logs-rule'],
    });
    closeProductDb?.();
    closeProductDb = undefined;

    const scanPath = open(sample.file);
    const stored = recordsOf(scanPath, summary.id!);
    expect(stored).toHaveLength(3);
    expect(stored.map(r => r.kind).sort()).toEqual(['activity', 'state', 'state']);
    // Back to a scan the upgrade has not converted: no records, no marker, only the blob.
    scanPath.prepare(`DELETE FROM scan_findings`).run();
    scanPath.prepare(`UPDATE scans SET has_records = 0`).run();
    scanPath.close();

    await startProductOn(sample.file);

    sqlite = open(sample.file);
    expect(recordsOf(sqlite, summary.id!)).toEqual(stored);
    expect(converted(sqlite)).toEqual([{ id: summary.id, has_records: 1 }]);
  });

  it('serves a scan\'s records in display order from its index', () => {
    const { db } = previousReleaseDatabase();
    sqlite = db;
    runMigrations(db);
    const plan = all(db, `EXPLAIN QUERY PLAN SELECT fingerprint FROM scan_findings WHERE scan_id = 'x'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5 END, title, fingerprint`);
    const detail = plan.map(p => String(p.detail)).join('\n');
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_scan_findings_order/);
    expect(detail).not.toContain('TEMP B-TREE');
  });
});

describe('a rule id rewrite carries the records of the scans it touched', () => {
  const OLD_ID = 'builtin::tag-environment';
  const NEW_ID = 'db175338-5c33-484a-bcf5-24f20e3bc60c';

  it('moves rule_id and fingerprint together in converted scans, and converts an unconverted one under the new id', () => {
    const sample = makeSample('current');
    const db = sqlite = open(sample.file);
    runMigrations(db);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type)
      VALUES (?, 'Tag: environment', 'test', 'compliance', 'low', 1, '{"level":"subscription"}', '[]', '[]', 'builtin')
    `).run(OLD_ID);
    const oldFingerprint = computeFingerprint(OLD_ID, vm('vm-1'));
    const record = db.prepare(`
      INSERT INTO scan_findings (scan_id, fingerprint, rule_id, severity, title, kind, category, resource_id, resource_name, subscription_id, row_count)
      VALUES (?, ?, ?, 'low', 'Tag: environment', 'state', 'compliance', ?, 'vm-1', ?, 1)
    `);
    record.run('scan-1', oldFingerprint, OLD_ID, vm('vm-1'), SUB);
    record.run('scan-2', oldFingerprint, OLD_ID, vm('vm-1'), SUB);
    insertScan(db, 'scan-1', [], '2026-01-01T00:00:00.000Z', 'compliance');
    insertScan(db, 'scan-2', [], '2026-01-02T00:00:00.000Z', 'compliance');
    db.prepare(`UPDATE scans SET has_records = 1`).run();
    // A scan the upgrade has not converted yet holds the old id in its blob, which the rename rewrites.
    insertScan(db, 'scan-3', [blobFinding('vm-1', { ruleId: OLD_ID, category: 'compliance', module: 'compliance' })], '2026-01-03T00:00:00.000Z', 'compliance');
    // A record of another rule is left alone.
    record.run('scan-1', computeFingerprint(RULE, vm('vm-2')), RULE, vm('vm-2'), SUB);

    runMigrations(db);

    const newFingerprint = computeFingerprint(NEW_ID, vm('vm-1'));
    expect(all(db, `SELECT scan_id, fingerprint, rule_id FROM scan_findings WHERE rule_id <> ? ORDER BY scan_id`, RULE)).toEqual([
      { scan_id: 'scan-1', fingerprint: newFingerprint, rule_id: NEW_ID },
      { scan_id: 'scan-2', fingerprint: newFingerprint, rule_id: NEW_ID },
      { scan_id: 'scan-3', fingerprint: newFingerprint, rule_id: NEW_ID },
    ]);
    expect(all(db, `SELECT fingerprint, rule_id FROM scan_findings WHERE scan_id = 'scan-1' AND rule_id = ?`, RULE)).toEqual([
      { fingerprint: computeFingerprint(RULE, vm('vm-2')), rule_id: RULE },
    ]);
  });
});
