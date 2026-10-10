/**
 * ADR 0007: the upgrade that builds `column_catalogue` once from the rows already stored.
 * It adds one table, fills it for every rule from `finding_rows` (Fixed findings included), proves what
 * it wrote, then sets its marker; a build that fails changes nothing and is retried on the next start.
 * A rule id rewrite moves a rule's entries. Migrations swallow their own errors, so these tests read
 * the content back rather than trusting that nothing threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';
import { FINDING_ROWS_COPY_MARKER } from '@/lib/db/finding-rows-copy';
import { COLUMN_CATALOGUE_MARKER } from '@/lib/db/column-catalogue-build';

const RULE = '9a4e7c31-5b2d-4e8f-8c6a-1d3f5b7a9c20';
const OTHER_RULE = '1b2c3d4e-0000-4000-8000-000000000001';
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
  vi.stubEnv('RULEBEAT_DATABASE_URL', '');
  vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const findings = await import('@/lib/db/findings');
  const suppressions = await import('@/lib/suppressions');
  const catalogue = await import('@/lib/db/column-catalogue');
  return { listFindings: findings.listFindings, loadSuppressions: suppressions.loadSuppressions, listReturnedColumns: catalogue.listReturnedColumns };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

function insertRule(db: Database.Database, id: string, name: string): void {
  db.prepare(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type)
    VALUES (?, ?, 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]',
      'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom')
  `).run(id, name);
}

/** A database exactly as the release before the catalogue left it: finding_rows filled and proven,
 *  no catalogue table and no catalogue marker. */
function previousReleaseDatabase() {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  db.exec(`DROP TABLE column_catalogue`);
  db.prepare(`DELETE FROM meta WHERE key = ?`).run(COLUMN_CATALOGUE_MARKER);
  insertRule(db, RULE, 'VM retirements');
  insertRule(db, OTHER_RULE, 'Other');
  return { sample, db };
}

function insertFinding(db: Database.Database, f: {
  fingerprint: string; ruleId?: string; name: string; status?: 'active' | 'fixed'; rows: Record<string, unknown>[];
}): void {
  db.prepare(`
    INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
      subscription_id, title, evidence, evidence_rows, status, first_seen_at, last_seen_at, last_scan_id, times_seen, row_count, rows_scan_id)
    VALUES (?, ?, 'reliability', 'medium', 'state', ?, 'microsoft.compute/virtualmachines', ?, ?, 'VM retirements', ?, ?,
      ?, '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 'scan-1', 9, ?, 'scan-1')
  `).run(f.fingerprint, f.ruleId ?? RULE, vm(f.name), f.name, SUB, JSON.stringify(f.rows[0] ?? {}), JSON.stringify(f.rows), f.status ?? 'active', f.rows.length);
  f.rows.forEach((row, position) => {
    db.prepare(`INSERT INTO finding_rows (fingerprint, position, data) VALUES (?, ?, ?)`).run(f.fingerprint, position, JSON.stringify(row));
  });
}

const seedFindings = (db: Database.Database) => {
  insertFinding(db, { fingerprint: 'fp-a', name: 'vm-1', rows: [{ feature: 'Basic tier', properties: { sku: { name: 'S1' } } }, { feature: 'TLS 1.0', date: '2026-09-30' }] });
  insertFinding(db, { fingerprint: 'fp-fixed', name: 'vm-2', status: 'fixed', rows: [{ onlyWhenFixed: 'x' }] });
  insertFinding(db, { fingerprint: 'fp-empty', name: 'vm-3', rows: [] });
  insertFinding(db, { fingerprint: 'fp-other', ruleId: OTHER_RULE, name: 'vm-4', rows: [{ other: 1, _rule: { hidden: true } }] });
};

describe('upgrading to the column catalogue', () => {
  it('builds every rule\'s columns from the stored rows, and changes nothing already stored', async () => {
    const { sample, db } = previousReleaseDatabase();
    seedFindings(db);
    db.prepare(`
      INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
      VALUES ('sup-1', 'fp-a', ?, 'Accepted risk', '2026-02-01T00:00:00.000Z')
    `).run(vm('vm-1'));
    const findingsBefore = all(db, `SELECT * FROM findings ORDER BY fingerprint`);
    const rowsBefore = all(db, `SELECT * FROM finding_rows ORDER BY fingerprint, position`);
    db.close();

    const product = await startProductOn(sample.file);

    expect(await product.listReturnedColumns([RULE])).toEqual(['date', 'feature', 'onlyWhenFixed', 'properties.sku.name']);
    expect(await product.listReturnedColumns([OTHER_RULE])).toEqual(['other']);
    expect((await product.loadSuppressions()).filter(s => s.fingerprint === 'fp-a')).toEqual([
      expect.objectContaining({ id: 'sup-1', reason: 'Accepted risk' }),
    ]);
    expect((await product.listFindings()).find(f => f.fingerprint === 'fp-a')).toMatchObject({
      firstSeenAt: '2026-01-02T03:04:05.000Z', timesSeen: 9, status: 'active',
    });

    sqlite = open(sample.file);
    expect(all(sqlite, `SELECT * FROM findings ORDER BY fingerprint`)).toEqual(findingsBefore);
    expect(all(sqlite, `SELECT * FROM finding_rows ORDER BY fingerprint, position`)).toEqual(rowsBefore);
    expect(all(sqlite, `SELECT key FROM meta WHERE key = ?`, COLUMN_CATALOGUE_MARKER)).toHaveLength(1);
  });

  it('builds it on the same start that copies the rows, for a database from before finding_rows', async () => {
    const sample = makeSample('current');
    const db = open(sample.file);
    runMigrations(db);
    db.exec(`
      DROP TABLE column_catalogue;
      DROP TABLE finding_rows;
      ALTER TABLE findings DROP COLUMN row_count;
      ALTER TABLE findings DROP COLUMN rows_scan_id;
    `);
    db.prepare(`DELETE FROM meta WHERE key IN (?, ?)`).run(COLUMN_CATALOGUE_MARKER, FINDING_ROWS_COPY_MARKER);
    insertRule(db, RULE, 'VM retirements');
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, evidence_rows, status, first_seen_at, last_seen_at, last_scan_id, times_seen)
      VALUES ('fp-old', ?, 'reliability', 'medium', 'state', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 't', '{"a":1}',
        '[{"a":1},{"b":2}]', 'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 'scan-1', 1)
    `).run(RULE, vm('vm-1'), SUB);
    db.close();

    const product = await startProductOn(sample.file);

    expect(await product.listReturnedColumns([RULE])).toEqual(['a', 'b']);
  });

  it('does not build before the rows are copied: no copy marker, no catalogue marker', async () => {
    const { sample, db } = previousReleaseDatabase();
    seedFindings(db);
    // The copy cannot prove out: a trigger corrupts what is written to finding_rows during the copy.
    db.prepare(`DELETE FROM meta WHERE key = ?`).run(FINDING_ROWS_COPY_MARKER);
    db.exec(`
      CREATE TRIGGER corrupt_rows AFTER INSERT ON finding_rows BEGIN
        UPDATE finding_rows SET data = '{}' WHERE fingerprint = NEW.fingerprint AND position = NEW.position;
      END;
    `);
    db.close();

    vi.spyOn(console, 'error').mockImplementation(() => {});
    await startProductOn(sample.file);

    sqlite = open(sample.file);
    expect(all(sqlite, `SELECT key FROM meta WHERE key = ?`, FINDING_ROWS_COPY_MARKER)).toEqual([]);
    expect(all(sqlite, `SELECT key FROM meta WHERE key = ?`, COLUMN_CATALOGUE_MARKER)).toEqual([]);
    expect(all(sqlite, `SELECT COUNT(*) AS n FROM column_catalogue`)).toEqual([{ n: 0 }]);
  });

  it('a build that fails leaves no trace, and the next start builds it', async () => {
    const { sample, db } = previousReleaseDatabase();
    seedFindings(db);
    // The table as the upgrade creates it, with a trigger that fails the write of one entry.
    db.exec(`
      CREATE TABLE column_catalogue (rule_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (rule_id, path));
      CREATE TRIGGER fail_build BEFORE INSERT ON column_catalogue WHEN NEW.path = 'properties.sku.name' BEGIN
        SELECT RAISE(ABORT, 'cannot write this entry');
      END;
    `);
    db.close();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await startProductOn(sample.file);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not build the column catalogue'), expect.anything());
    sqlite = open(sample.file);
    expect(all(sqlite, `SELECT COUNT(*) AS n FROM column_catalogue`)).toEqual([{ n: 0 }]);
    expect(all(sqlite, `SELECT key FROM meta WHERE key = ?`, COLUMN_CATALOGUE_MARKER)).toEqual([]);

    // The next start, with whatever broke it gone, builds it and proves it.
    sqlite.exec(`DROP TRIGGER fail_build`);
    runMigrations(sqlite);
    expect(all(sqlite, `SELECT rule_id, path FROM column_catalogue ORDER BY rule_id, path`)).toEqual([
      { rule_id: OTHER_RULE, path: 'other' },
      { rule_id: RULE, path: 'date' },
      { rule_id: RULE, path: 'feature' },
      { rule_id: RULE, path: 'onlyWhenFixed' },
      { rule_id: RULE, path: 'properties.sku.name' },
    ].sort((a, b) => (a.rule_id + a.path < b.rule_id + b.path ? -1 : 1)));
    expect(all(sqlite, `SELECT key FROM meta WHERE key = ?`, COLUMN_CATALOGUE_MARKER)).toHaveLength(1);
  });

  it('builds once: a later start leaves the catalogue as scans have kept it', () => {
    const { sample, db } = previousReleaseDatabase();
    seedFindings(db);
    runMigrations(db);
    sqlite = db;
    db.prepare(`INSERT INTO column_catalogue (rule_id, path) VALUES (?, 'added-by-a-scan')`).run(RULE);
    db.prepare(`DELETE FROM column_catalogue WHERE rule_id = ? AND path = 'date'`).run(RULE);

    runMigrations(db);

    const paths = all(db, `SELECT path FROM column_catalogue WHERE rule_id = ? ORDER BY path`, RULE).map(r => r.path);
    expect(paths).toEqual(['added-by-a-scan', 'feature', 'onlyWhenFixed', 'properties.sku.name']);
    expect(sample.file).toBeTruthy();
  });
});

describe('a rule id rewrite carries its column catalogue', () => {
  const OLD_ID = 'builtin::tag-environment';
  const NEW_ID = 'db175338-5c33-484a-bcf5-24f20e3bc60c';

  function databaseWithOldRule() {
    const sample = makeSample('current');
    const db = sqlite = open(sample.file);
    runMigrations(db);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type)
      VALUES (?, 'Tag: environment', 'test', 'compliance', 'low', 1, '{"level":"subscription"}', '[]', '[]', 'builtin')
    `).run(OLD_ID);
    return db;
  }

  it('moves the entries to the new id', () => {
    const db = databaseWithOldRule();
    db.prepare(`INSERT INTO column_catalogue (rule_id, path) VALUES (?, 'tag'), (?, 'value')`).run(OLD_ID, OLD_ID);

    runMigrations(db);

    expect(all(db, `SELECT rule_id, path FROM column_catalogue WHERE rule_id IN (?, ?) ORDER BY path`, OLD_ID, NEW_ID)).toEqual([
      { rule_id: NEW_ID, path: 'tag' },
      { rule_id: NEW_ID, path: 'value' },
    ]);
  });

  it('keeps one entry when the new id already holds the same path', () => {
    const db = databaseWithOldRule();
    db.prepare(`INSERT INTO column_catalogue (rule_id, path) VALUES (?, 'tag'), (?, 'tag'), (?, 'only-old')`).run(OLD_ID, NEW_ID, OLD_ID);

    runMigrations(db);

    expect(all(db, `SELECT rule_id, path FROM column_catalogue WHERE rule_id IN (?, ?) ORDER BY path`, OLD_ID, NEW_ID)).toEqual([
      { rule_id: NEW_ID, path: 'only-old' },
      { rule_id: NEW_ID, path: 'tag' },
    ]);
  });
});
