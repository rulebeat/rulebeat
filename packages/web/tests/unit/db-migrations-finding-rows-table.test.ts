/**
 * Issue #199 (ADR 0007): the upgrade that moves a finding's rows into `finding_rows`. It adds one
 * table and two columns, copies every finding's rows into the table exactly as the app read them
 * before, proves the copy, and changes nothing already stored. A database that went back to the
 * previous release and came forward again has its stale copies redone on the next start.
 * Migrations swallow their own errors, so these tests read the content back rather than trusting
 * that nothing threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { computeFingerprint, computeLegacyFingerprint } from '@rulebeat/core/finding';
import { makeSample, open } from '../fixtures/upgrade';
import { openDatabase, runMigrations } from '@/lib/db/migrate';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import { FINGERPRINT_CASE_MARKER } from '@/lib/db/fingerprint-rekey';

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
  const suppressions = await import('@/lib/suppressions');
  return { listFindings: findings.listFindings, loadSuppressions: suppressions.loadSuppressions };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

/** A database exactly as the release before finding_rows left it: no table, no row columns, no marker. */
function previousReleaseDatabase() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  db.exec(`
    DROP TABLE finding_rows;
    ALTER TABLE findings DROP COLUMN row_count;
    ALTER TABLE findings DROP COLUMN rows_scan_id;
  `);
  db.prepare(`DELETE FROM meta WHERE key = ?`).run(FINDING_ROWS_COPY_MARKER);
  db.prepare(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type)
    VALUES (?, 'VM retirements', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]',
      'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom')
  `).run(RULE);
  return { sample, db };
}

/** A finding as the previous release wrote it: only the old row columns. */
function insertOldFinding(db: Database.Database, f: {
  fingerprint: string; name: string; evidence: string; evidenceRows: string | null; lastScanId?: string | null; timesSeen?: number;
}): void {
  db.prepare(`
    INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
      subscription_id, title, evidence, evidence_rows, status, first_seen_at, last_seen_at, last_scan_id, times_seen)
    VALUES (?, ?, 'reliability', 'medium', 'state', ?, 'microsoft.compute/virtualmachines', ?, ?, 'VM retirements', ?, ?,
      'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', ?, ?)
  `).run(f.fingerprint, RULE, vm(f.name), f.name, SUB, f.evidence, f.evidenceRows, f.lastScanId ?? null, f.timesSeen ?? 1);
}

const THREE_ROWS = '[{"retirement":"Basic tier"},{"retirement":"TLS 1.0"},{"retirement":"Gen1 images"}]';

describe('upgrading to finding_rows', () => {
  it('copies every finding\'s rows in order, keeps its age and suppression, and changes nothing stored', async () => {
    const { sample, db } = previousReleaseDatabase();
    insertOldFinding(db, { fingerprint: 'fp-many', name: 'vm-1', evidence: '{"retirement":"Basic tier"}', evidenceRows: THREE_ROWS, lastScanId: 'scan-1', timesSeen: 9 });
    insertOldFinding(db, { fingerprint: 'fp-evidence', name: 'vm-2', evidence: '{"retirement":"TLS 1.0"}', evidenceRows: null });
    insertOldFinding(db, { fingerprint: 'fp-empty', name: 'vm-3', evidence: '{}', evidenceRows: null });
    db.prepare(`
      INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
      VALUES ('sup-1', 'fp-many', ?, 'Accepted risk', '2026-02-01T00:00:00.000Z')
    `).run(vm('vm-1'));
    const oldColumns = all(db, `SELECT fingerprint, evidence, evidence_rows, last_scan_id, times_seen, first_seen_at FROM findings ORDER BY fingerprint`);
    db.close();

    const product = await startProductOn(sample.file);

    const found = new Map((await product.listFindings()).map(f => [f.fingerprint, f]));
    expect(found.get('fp-many')).toMatchObject({
      firstSeenAt: '2026-01-02T03:04:05.000Z',
      timesSeen: 9,
      evidence: { retirement: 'Basic tier' },
      rows: [{ retirement: 'Basic tier' }, { retirement: 'TLS 1.0' }, { retirement: 'Gen1 images' }],
    });
    expect(found.get('fp-evidence')).toMatchObject({ evidence: { retirement: 'TLS 1.0' }, rows: [{ retirement: 'TLS 1.0' }] });
    expect(found.get('fp-empty')).toMatchObject({ evidence: {}, rows: [] });
    expect((await product.loadSuppressions()).filter(s => s.fingerprint === 'fp-many')).toEqual([
      expect.objectContaining({ id: 'sup-1', reason: 'Accepted risk' }),
    ]);

    sqlite = open(sample.file);
    // The rows really are in the table: one record a row, in query order.
    expect(all(sqlite, `SELECT fingerprint, position, data FROM finding_rows ORDER BY fingerprint, position`)).toEqual([
      { fingerprint: 'fp-evidence', position: 0, data: '{"retirement":"TLS 1.0"}' },
      { fingerprint: 'fp-many', position: 0, data: '{"retirement":"Basic tier"}' },
      { fingerprint: 'fp-many', position: 1, data: '{"retirement":"TLS 1.0"}' },
      { fingerprint: 'fp-many', position: 2, data: '{"retirement":"Gen1 images"}' },
    ]);
    expect(all(sqlite, `SELECT fingerprint, row_count, rows_scan_id FROM findings ORDER BY fingerprint`)).toEqual([
      { fingerprint: 'fp-empty', row_count: 0, rows_scan_id: null },
      { fingerprint: 'fp-evidence', row_count: 1, rows_scan_id: null },
      { fingerprint: 'fp-many', row_count: 3, rows_scan_id: 'scan-1' },
    ]);
    // Nothing already stored was rewritten, and the marker says the copy proved out.
    expect(all(sqlite, `SELECT fingerprint, evidence, evidence_rows, last_scan_id, times_seen, first_seen_at FROM findings ORDER BY fingerprint`)).toEqual(oldColumns);
    expect(all(sqlite, `SELECT key FROM meta WHERE key = ?`, FINDING_ROWS_COPY_MARKER)).toHaveLength(1);
  });

  it('redoes the copy for what the previous release changed after moving back to it and forward again', async () => {
    const { sample, db } = previousReleaseDatabase();
    insertOldFinding(db, { fingerprint: 'fp-rescanned', name: 'vm-1', evidence: '{"retirement":"Basic tier"}', evidenceRows: '[{"retirement":"Basic tier"}]', lastScanId: 'scan-1' });
    insertOldFinding(db, { fingerprint: 'fp-unchanged', name: 'vm-2', evidence: '{"retirement":"TLS 1.0"}', evidenceRows: '[{"retirement":"TLS 1.0"}]', lastScanId: 'scan-1' });
    insertOldFinding(db, { fingerprint: 'fp-deleted', name: 'vm-3', evidence: '{"retirement":"Gen1 images"}', evidenceRows: null, lastScanId: 'scan-1' });
    runMigrations(db);
    expect(all(db, `SELECT COUNT(*) AS n FROM finding_rows`)).toEqual([{ n: 3 }]);

    // The previous release again: it writes the old columns only, and knows nothing of the table.
    db.prepare(`UPDATE findings SET evidence_rows = ?, last_scan_id = 'scan-2' WHERE fingerprint = 'fp-rescanned'`)
      .run('[{"retirement":"Basic tier"},{"retirement":"TLS 1.0"}]');
    insertOldFinding(db, { fingerprint: 'fp-new', name: 'vm-4', evidence: '{"retirement":"Classic"}', evidenceRows: '[{"retirement":"Classic"}]', lastScanId: 'scan-2' });
    db.prepare(`DELETE FROM findings WHERE fingerprint = 'fp-deleted'`).run();
    // A record the copy must leave alone, to prove a finding that is current is not copied again.
    db.prepare(`UPDATE finding_rows SET data = '{"retirement":"TLS 1.0","kept":true}' WHERE fingerprint = 'fp-unchanged'`).run();
    db.close();

    const product = await startProductOn(sample.file);

    const rows = new Map((await product.listFindings()).map(f => [f.fingerprint, f.rows]));
    expect(rows.get('fp-rescanned')).toEqual([{ retirement: 'Basic tier' }, { retirement: 'TLS 1.0' }]);
    expect(rows.get('fp-new')).toEqual([{ retirement: 'Classic' }]);
    expect(rows.get('fp-unchanged')).toEqual([{ retirement: 'TLS 1.0', kept: true }]);
    sqlite = open(sample.file);
    expect(all(sqlite, `SELECT fingerprint FROM finding_rows WHERE fingerprint = 'fp-deleted'`)).toEqual([]);
    expect(all(sqlite, `SELECT fingerprint, row_count, rows_scan_id FROM findings WHERE fingerprint IN ('fp-rescanned', 'fp-new') ORDER BY fingerprint`)).toEqual([
      { fingerprint: 'fp-new', row_count: 1, rows_scan_id: 'scan-2' },
      { fingerprint: 'fp-rescanned', row_count: 2, rows_scan_id: 'scan-2' },
    ]);
  });

  it('a copy that does not prove out leaves no trace, and the app keeps reading the old columns', async () => {
    const { sample, db } = previousReleaseDatabase();
    insertOldFinding(db, { fingerprint: 'fp-many', name: 'vm-1', evidence: '{"retirement":"Basic tier"}', evidenceRows: THREE_ROWS, lastScanId: 'scan-1' });
    // The table as the upgrade creates it, with a trigger that corrupts what is written to it.
    db.exec(`
      CREATE TABLE finding_rows (fingerprint TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (fingerprint, position));
      CREATE TRIGGER corrupt_rows AFTER INSERT ON finding_rows BEGIN
        UPDATE finding_rows SET data = '{}' WHERE fingerprint = NEW.fingerprint AND position = NEW.position;
      END;
    `);
    db.close();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const product = await startProductOn(sample.file);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not copy finding rows'), expect.anything());
    const [finding] = (await product.listFindings()).filter(f => f.fingerprint === 'fp-many');
    expect(finding!.rows).toEqual([{ retirement: 'Basic tier' }, { retirement: 'TLS 1.0' }, { retirement: 'Gen1 images' }]);
    sqlite = open(sample.file);
    expect(all(sqlite, `SELECT COUNT(*) AS n FROM finding_rows`)).toEqual([{ n: 0 }]);
    expect(all(sqlite, `SELECT row_count, rows_scan_id FROM findings WHERE fingerprint = 'fp-many'`)).toEqual([{ row_count: null, rows_scan_id: null }]);
    expect(all(sqlite, `SELECT key FROM meta WHERE key = ?`, FINDING_ROWS_COPY_MARKER)).toEqual([]);

    // The next start, with whatever broke it gone, copies and proves it.
    sqlite.exec(`DROP TRIGGER corrupt_rows`);
    runMigrations(sqlite);
    expect(all(sqlite, `SELECT COUNT(*) AS n FROM finding_rows`)).toEqual([{ n: 3 }]);
    expect(all(sqlite, `SELECT key FROM meta WHERE key = ?`, FINDING_ROWS_COPY_MARKER)).toHaveLength(1);
  });
});

describe('a rule id rewrite carries its findings\' rows', () => {
  it('moves the rows to the fingerprint the new id produces', () => {
    const OLD_ID = 'builtin::tag-environment';
    const NEW_ID = 'db175338-5c33-484a-bcf5-24f20e3bc60c';
    const sample = makeSample('current');
    const db = sqlite = open(sample.file);
    runMigrations(db);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type)
      VALUES (?, 'Tag: environment', 'test', 'compliance', 'low', 1, '{"level":"subscription"}', '[]', '[]', 'builtin')
    `).run(OLD_ID);
    const oldFingerprint = computeFingerprint(OLD_ID, vm('vm-1'));
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, status, first_seen_at, last_seen_at, times_seen, row_count)
      VALUES (?, ?, 'compliance', 'low', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 'Tag: environment', '{}',
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 1, 1)
    `).run(oldFingerprint, OLD_ID, vm('vm-1'), SUB);
    db.prepare(`INSERT INTO finding_rows (fingerprint, position, data) VALUES (?, 0, '{"tag":"missing"}')`).run(oldFingerprint);

    runMigrations(db);

    const newFingerprint = computeFingerprint(NEW_ID, vm('vm-1'));
    expect(all(db, `SELECT fingerprint, position, data FROM finding_rows WHERE fingerprint IN (?, ?)`, oldFingerprint, newFingerprint)).toEqual([
      { fingerprint: newFingerprint, position: 0, data: '{"tag":"missing"}' },
    ]);
  });
});

describe('the fingerprint case rekey carries its findings\' rows', () => {
  it('moves the rows to the lowercased fingerprint', () => {
    const resourceId = `/subscriptions/${SUB}/resourceGroups/RG-App/providers/Microsoft.Compute/virtualMachines/vm-1`;
    const sample = makeSample('current');
    const db = sqlite = open(sample.file);
    runMigrations(db);
    db.prepare(`DELETE FROM meta WHERE key = ?`).run(FINGERPRINT_CASE_MARKER);
    const legacy = computeLegacyFingerprint(RULE, resourceId);
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, status, first_seen_at, last_seen_at, times_seen, row_count)
      VALUES (?, ?, 'security', 'high', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 't', '{}',
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 1, 1)
    `).run(legacy, RULE, resourceId, SUB);
    db.prepare(`INSERT INTO finding_rows (fingerprint, position, data) VALUES (?, 0, '{"backup":"off"}')`).run(legacy);

    runMigrations(db);

    const current = computeFingerprint(RULE, resourceId);
    expect(current).not.toBe(legacy);
    expect(all(db, `SELECT fingerprint, position, data FROM finding_rows WHERE fingerprint IN (?, ?)`, legacy, current)).toEqual([
      { fingerprint: current, position: 0, data: '{"backup":"off"}' },
    ]);
  });
});

describe('the SQLite connection', () => {
  it('opens with a 64 MB page cache and a 256 MB memory map', () => {
    const sample = makeSample('current');
    const db = sqlite = openDatabase(sample.file);
    expect(db.pragma('cache_size', { simple: true })).toBe(-65536);
    expect(db.pragma('mmap_size', { simple: true })).toBe(268435456);
  });
});
