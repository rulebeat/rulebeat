/**
 * Issue #216 (ADR 0008): a Postgres database bootstrapped before `scan_findings` existed gains the table
 * and the scan marker column on the next boot, converts every stored scan's blob into records, one
 * transaction a scan, and converts what a returning previous release saved on the boot after. Since #219 it
 * then empties each converted scan's blob, once both one-time backfills have run. Postgres only by nature;
 * skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { computeActivityFingerprint, computeFingerprint, computeLegacyFingerprint } from '@rulebeat/core/finding';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { backfillFindings } from '@/lib/db/findings';
import { SCAN_COPY_READ_PENDING } from '@/lib/db/scan-findings-copy';
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

async function insertScan(id: string, findings: unknown, startedAt: string, module = 'reliability'): Promise<void> {
  await pgDb!.execute(sql`
    INSERT INTO scans (id, module, started_at, finished_at, duration_ms, subscriptions_scanned, findings, counts, total_rules)
    VALUES (${id}, ${module}, ${startedAt}, ${startedAt}, 10, '[]', ${typeof findings === 'string' ? findings : JSON.stringify(findings)}, '{}', 1)
  `);
}

const recordsOf = (scanId: string) => raw(`SELECT fingerprint, rule_id, severity, kind, category, resource_id, resource_name, row_count
  FROM scan_findings WHERE scan_id = '${scanId}' ORDER BY fingerprint COLLATE "C"`);
const markers = () => raw(`SELECT id, has_records FROM scans ORDER BY id COLLATE "C"`);
const blobs = () => raw(`SELECT id, findings FROM scans ORDER BY id COLLATE "C"`);

/** The meta keys the two one-time backfills set, and the per-category records the findings rebuild keeps.
 *  `resetDb()` keeps `meta`, so each test here says which of the two are set, and none is left set after it. */
const BACKFILL_MARKERS = ['findings-backfilled-v1', 'snapshots-backfilled-v1'];
async function setBackfilled(keys: string[]): Promise<void> {
  await raw(`DELETE FROM meta WHERE key IN ('${BACKFILL_MARKERS.join("', '")}') OR key LIKE 'findings-backfilled-v1:%'`);
  for (const key of keys) await raw(`INSERT INTO meta (key, value) VALUES ('${key}', '1')`);
}

/** The database as the previous release left it. */
async function previousReleaseDatabase(): Promise<void> {
  await dbReady;
  await resetDb();
  await bootstrapPg(pgDb!);
  await raw(`DROP TABLE scan_findings`);
  await raw(`ALTER TABLE scans DROP COLUMN has_records`);
  await setBackfilled([]);
}

/**
 * A stand-in for the database whose matching statement fails the way Postgres fails one: `SELECT 1/0` runs
 * on the very connection (outer transaction or savepoint) the bootstrap meant to read on, so that
 * transaction is aborted unless the read had a savepoint. A JavaScript throw would not abort anything.
 * `hits` counts how often the match fired, so a test cannot pass because it never did.
 */
type Connection = {
  execute(query: SQL): Promise<unknown>;
  transaction(fn: (inner: Connection) => Promise<unknown>, ...rest: unknown[]): Promise<unknown>;
};

function failingRead(matches: (text: string, params: unknown[]) => boolean) {
  const dialect = new PgDialect();
  const counter = { hits: 0 };
  const wrap = (target: Connection): Connection => new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj);
      if (prop === 'execute') {
        return (query: SQL) => {
          const { sql: text, params } = dialect.sqlToQuery(query);
          if (!matches(text, params)) return obj.execute(query);
          counter.hits += 1;
          return obj.execute(sql.raw('SELECT 1/0'));
        };
      }
      if (prop === 'transaction') {
        return (fn: (inner: Connection) => Promise<unknown>, ...rest: unknown[]) =>
          obj.transaction((inner) => fn(wrap(inner)), ...rest);
      }
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
  return { db: wrap(pgDb as unknown as Connection) as unknown as NonNullable<typeof pgDb>, counter };
}

const tableExists = async (name: string) => (await raw(`SELECT to_regclass('public.${name}') AS t`))[0].t !== null;

describe.skipIf(dbKind !== 'pg')('bootstrapPg stores scans as scan_findings records (issue #216)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    // A test that failed after dropping the table or the column must not leave the next suite without them.
    await raw(`DROP TRIGGER IF EXISTS refuse_poison ON scan_findings`).catch(() => {});
    await raw(`DROP FUNCTION IF EXISTS refuse_poison()`);
    await bootstrapPg(pgDb!);
    await resetDb();
    await setBackfilled([]);
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

  it('empties every converted scan\'s blob once both backfills have run, keeps every record, and a second boot changes nothing', async () => {
    await previousReleaseDatabase();
    await insertScan('pg-scan-1', [blobFinding('vm-1', { rows: [{ n: 1 }, { n: 2 }] }), blobFinding('vm-2')], '2026-01-01T00:00:00.000Z');
    await insertScan('pg-scan-broken', '{not json', '2026-01-02T00:00:00.000Z');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await blobs();

    // Either marker unset: the scans convert and keep their blobs.
    for (const keys of [[], ['findings-backfilled-v1'], ['snapshots-backfilled-v1']]) {
      await setBackfilled(keys);
      await bootstrapPg(pgDb!);
      expect(await blobs(), `markers: ${keys.join(', ')}`).toEqual(before);
    }
    const records = await raw(`SELECT * FROM scan_findings ORDER BY scan_id COLLATE "C", fingerprint COLLATE "C"`);
    expect(records).toHaveLength(2);

    await setBackfilled(BACKFILL_MARKERS);
    await bootstrapPg(pgDb!);

    // The scan that cannot convert keeps its blob, since it is all that scan has.
    expect(await blobs()).toEqual([{ id: 'pg-scan-1', findings: '[]' }, { id: 'pg-scan-broken', findings: '{not json' }]);
    expect(await markers()).toEqual([{ id: 'pg-scan-1', has_records: 1 }, { id: 'pg-scan-broken', has_records: 0 }]);
    expect(await raw(`SELECT * FROM scan_findings ORDER BY scan_id COLLATE "C", fingerprint COLLATE "C"`)).toEqual(records);

    const scansAfter = await raw(`SELECT * FROM scans ORDER BY id COLLATE "C"`);
    await bootstrapPg(pgDb!);
    expect(await raw(`SELECT * FROM scans ORDER BY id COLLATE "C"`)).toEqual(scansAfter);
    expect(await raw(`SELECT * FROM scan_findings ORDER BY scan_id COLLATE "C", fingerprint COLLATE "C"`)).toEqual(records);
  });

  it('keeps every other upgrade step when the list of pending scans cannot be read, and converts the scans on the next boot', async () => {
    await previousReleaseDatabase();
    await insertScan('pg-scan-1', [blobFinding('vm-1')], '2026-01-01T00:00:00.000Z');
    await insertScan('pg-scan-2', [blobFinding('vm-2'), blobFinding('vm-3')], '2026-01-02T00:00:00.000Z');
    const before = await blobs();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, counter } = failingRead(text => text === SCAN_COPY_READ_PENDING);

    await expect(bootstrapPg(db)).resolves.toBeUndefined();

    expect(counter.hits).toBe(1);
    expect(error.mock.calls.map(call => String(call[0]))).toContain('[bootstrap] could not convert stored scans into records:');
    // The DDL of this boot recreated the table and the column, so they exist only if the boot committed.
    expect(await tableExists('scan_findings')).toBe(true);
    expect(await markers()).toEqual([{ id: 'pg-scan-1', has_records: 0 }, { id: 'pg-scan-2', has_records: 0 }]);
    expect(await blobs()).toEqual(before);
    expect(await recordsOf('pg-scan-1')).toEqual([]);
    expect(await recordsOf('pg-scan-2')).toEqual([]);

    await bootstrapPg(pgDb!);

    expect(await recordsOf('pg-scan-1')).toHaveLength(1);
    expect(await recordsOf('pg-scan-2')).toHaveLength(2);
    expect(await markers()).toEqual([{ id: 'pg-scan-1', has_records: 1 }, { id: 'pg-scan-2', has_records: 1 }]);
  });

  it('costs only one scan when its stored findings cannot be read, and converts it on the next boot', async () => {
    await previousReleaseDatabase();
    await insertScan('pg-scan-a', [blobFinding('vm-1')], '2026-01-01T00:00:00.000Z');
    await insertScan('pg-scan-b', [blobFinding('vm-2'), blobFinding('vm-3')], '2026-01-02T00:00:00.000Z');
    await insertScan('pg-scan-c', [blobFinding('vm-4')], '2026-01-03T00:00:00.000Z');
    const before = await blobs();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, counter } = failingRead((text, params) => text === 'SELECT findings FROM scans WHERE id = $1' && params[0] === 'pg-scan-b');

    await expect(bootstrapPg(db)).resolves.toBeUndefined();

    expect(counter.hits).toBe(1);
    expect(error.mock.calls.map(call => call.map(String).join(' ')).join('\n')).toContain('pg-scan-b');
    expect(await tableExists('scan_findings')).toBe(true);
    expect(await recordsOf('pg-scan-a')).toHaveLength(1);
    expect(await recordsOf('pg-scan-c')).toHaveLength(1);
    expect(await recordsOf('pg-scan-b')).toEqual([]);
    expect(await markers()).toEqual([{ id: 'pg-scan-a', has_records: 1 }, { id: 'pg-scan-b', has_records: 0 }, { id: 'pg-scan-c', has_records: 1 }]);
    expect(await blobs()).toEqual(before);

    await bootstrapPg(pgDb!);

    expect(await recordsOf('pg-scan-b')).toHaveLength(2);
    expect(await markers()).toEqual([{ id: 'pg-scan-a', has_records: 1 }, { id: 'pg-scan-b', has_records: 1 }, { id: 'pg-scan-c', has_records: 1 }]);
  });
});

/**
 * Issue #235: a category whose finding history cannot be rebuilt keeps its stored findings and is tried
 * again on every boot, and the done marker is set only once every category is rebuilt. The failure is
 * injected through the stored data: a blob that is not JSON fails the read before anything is replayed,
 * and a `null` entry fails the replay at the newest scan, after the older ones were already replayed. A
 * boot is `bootstrapPg()` and then `backfillFindings()` on the live database, as instrumentation.ts runs them.
 * The snapshots marker is set by hand: backfillSnapshots() stops on the same blobs, which is its own,
 * already correct, failure.
 */
describe.skipIf(dbKind !== 'pg')('a finding history rebuild that fails for one category (issue #235)', () => {
  const FINDINGS_MARKER = 'findings-backfilled-v1';
  const SEC_RULE = 'pg-scan-findings-security-rule';
  const BROKEN = { unreadable: '{not json', 'part way': '[null]' } as const;
  // Relative to today: finding events older than their retention window are deleted as they are written.
  const midnight = new Date().setUTCHours(0, 0, 0, 0);
  const day = (n: number) => new Date(midnight - (10 - n) * 86_400_000).toISOString();
  const security = (name: string) => blobFinding(name, { module: 'security', category: 'security', ruleId: SEC_RULE });
  const REPAIRED = (): unknown[] => [security('sec-1'), security('sec-3')];

  afterEach(async () => {
    vi.restoreAllMocks();
    await bootstrapPg(pgDb!);
    await resetDb();
    await setBackfilled([]);
  });

  /** Two categories of history; the newest security scan holds `newestSecurityBlob`. */
  async function twoCategories(newestSecurityBlob: unknown): Promise<void> {
    await previousReleaseDatabase();
    await insertScan('pg-r1', [blobFinding('vm-1'), blobFinding('vm-2')], day(1));
    await insertScan('pg-r2', [blobFinding('vm-1')], day(2));
    await insertScan('pg-s1', [security('sec-1'), security('sec-2')], day(1), 'security');
    await insertScan('pg-s2', [security('sec-1')], day(2), 'security');
    await insertScan('pg-s3', newestSecurityBlob, day(3), 'security');
    await setBackfilled(['snapshots-backfilled-v1']);
  }

  const state = async () => ({
    metaKeys: (await raw(`SELECT key FROM meta WHERE key LIKE 'findings-backfilled-v1%' ORDER BY key COLLATE "C"`)).map(r => r.key),
    findings: await raw(`SELECT category, resource_name, status, first_seen_at, last_seen_at, resolved_at, times_seen
      FROM findings ORDER BY category COLLATE "C", resource_name COLLATE "C"`),
    events: await raw(`SELECT category, fingerprint, type, occurred_at FROM finding_events
      ORDER BY category COLLATE "C", fingerprint COLLATE "C", occurred_at COLLATE "C", type COLLATE "C"`),
    blobs: await blobs(),
  });

  async function start() {
    await bootstrapPg(pgDb!);
    await backfillFindings();
    return state();
  }

  const repair = () => raw(`UPDATE scans SET findings = '${JSON.stringify(REPAIRED())}' WHERE id = 'pg-s3'`);

  describe.each(Object.entries(BROKEN))('when a blob is %s', (_name, brokenBlob) => {
    it('rebuilds every other category, keeps the stored findings, and tries the failed one again on every boot', async () => {
      await twoCategories(brokenBlob);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const first = await start();

      expect(first.findings).toEqual([
        { category: 'reliability', resource_name: 'vm-1', status: 'active', first_seen_at: day(1), last_seen_at: day(2), resolved_at: null, times_seen: 3 },
        { category: 'reliability', resource_name: 'vm-2', status: 'fixed', first_seen_at: day(1), last_seen_at: day(1), resolved_at: day(2), times_seen: 1 },
      ]);
      expect(first.events.map(e => [e.category, e.type, e.occurred_at])).toEqual([['reliability', 'resolved', day(2)]]);
      expect(first.metaKeys).toEqual([`${FINDINGS_MARKER}:category:reliability`]);
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/'security'.*tried again on the next start.*stored findings are kept/);

      // The boot after it empties nothing: every converted scan keeps its blob, security's included.
      log.mockClear();
      const second = await start();
      expect(second.blobs).toEqual(first.blobs);
      expect(second.blobs.filter(b => b.findings === '[]')).toEqual([]);
      expect((await markers()).filter(m => m.has_records === 1).map(m => m.id)).toEqual(['pg-r1', 'pg-r2', 'pg-s1', 'pg-s2']);

      // Still failing: the category is logged and tried again, and reliability is not replayed.
      expect(second.metaKeys).toEqual(first.metaKeys);
      expect(second.findings).toEqual(first.findings);
      expect(second.events).toEqual(first.events);
      expect(log.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/'security'/);
    });

    it('rebuilds the failed category on a later boot exactly as a run that never failed, and the boot after empties the blobs', async () => {
      await twoCategories(REPAIRED());
      const control = await start();

      await twoCategories(brokenBlob);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const afterFailure = await start();
      await repair();
      const retried = await start();

      expect(retried.findings).toEqual(control.findings);
      expect(retried.events).toEqual(control.events);
      expect(retried.findings.filter(f => f.category === 'security')).toEqual([
        { category: 'security', resource_name: 'sec-1', status: 'active', first_seen_at: day(1), last_seen_at: day(3), resolved_at: null, times_seen: 4 },
        { category: 'security', resource_name: 'sec-2', status: 'fixed', first_seen_at: day(1), last_seen_at: day(1), resolved_at: day(2), times_seen: 1 },
        { category: 'security', resource_name: 'sec-3', status: 'active', first_seen_at: day(3), last_seen_at: day(3), resolved_at: null, times_seen: 2 },
      ]);
      expect(retried.events.filter(e => e.category === 'security').map(e => [e.type, e.occurred_at])).toEqual([['created', day(3)]]);
      // The category that was rebuilt before is untouched by the retry.
      expect(retried.findings.filter(f => f.category === 'reliability')).toEqual(afterFailure.findings);
      expect(retried.events.filter(e => e.category === 'reliability')).toEqual(afterFailure.events);
      expect(retried.metaKeys).toEqual([FINDINGS_MARKER, `${FINDINGS_MARKER}:category:reliability`, `${FINDINGS_MARKER}:category:security`]);

      // Every category is rebuilt, so the next boot empties each converted scan's blob and keeps the records.
      const records = await raw(`SELECT * FROM scan_findings ORDER BY scan_id COLLATE "C", fingerprint COLLATE "C"`);
      const last = await start();
      expect(last.blobs).toEqual(['pg-r1', 'pg-r2', 'pg-s1', 'pg-s2', 'pg-s3'].map(id => ({ id, findings: '[]' })));
      expect(last.findings).toEqual(retried.findings);
      expect(await raw(`SELECT * FROM scan_findings ORDER BY scan_id COLLATE "C", fingerprint COLLATE "C"`)).toEqual(records);
    });
  });
});
