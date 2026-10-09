/**
 * computeFingerprint() now lowercases the resource id, so every fingerprint stored under the old
 * case-sensitive formula for an id with an uppercase letter is one no scan will compute again. The
 * upgrade has to carry findings, their events, suppressions and pending notification lists across,
 * and merge the pairs the casing bug already split, without losing a finding's age.
 *
 * The contract, as in db-migrations-integrity.test.ts's TS-25: after the upgrade, every stored
 * fingerprint is what the next scan computes for that rule and resource.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { computeFingerprint, computeLegacyFingerprint } from '@rulebeat/core/finding';
import { dbReady, pgDb } from '@/lib/db/client';
import { runMigrations } from '@/lib/db/migrate';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { FINGERPRINT_CASE_MARKER } from '@/lib/db/fingerprint-rekey';
import { makeSample, open } from '../fixtures/upgrade';

const RULE = '6b1f8c2e-4d3a-4f6b-9c1e-7a2d5e8f0b13';
const SUB = '00000000-0000-0000-0000-000000000000';
const vm = (rg: string, name = 'vm-1') => `/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}`;

let sqlite: Database.Database | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

/** A database exactly as a release before the formula change left it: today's schema, no marker,
 *  and whatever rows the test seeds with legacy fingerprints. */
function preUpgradeDatabase(seed: (db: Database.Database) => void): Database.Database {
  const sample = makeSample('current');
  const db = open(sample.file);
  runMigrations(db);
  db.prepare(`DELETE FROM meta WHERE key = ?`).run(FINGERPRINT_CASE_MARKER);
  db.prepare(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type)
    VALUES (?, 'VMs without backup', 'test', 'security', 'high', 1, '{"level":"subscription"}', '[]', '[]', 'custom')
  `).run(RULE);
  seed(db);
  return db;
}

function insertFinding(db: Database.Database, f: {
  fingerprint: string; resourceId: string; status?: string; firstSeenAt: string; lastSeenAt: string;
  resolvedAt?: string | null; timesSeen: number; evidence?: string;
}): void {
  db.prepare(`
    INSERT INTO findings (fingerprint, rule_id, category, severity, resource_id, resource_type, resource_name,
      subscription_id, title, evidence, status, first_seen_at, last_seen_at, resolved_at, times_seen)
    VALUES (?, ?, 'security', 'high', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 'VMs without backup', ?, ?, ?, ?, ?, ?)
  `).run(f.fingerprint, RULE, f.resourceId, SUB, f.evidence ?? '{}', f.status ?? 'active', f.firstSeenAt, f.lastSeenAt, f.resolvedAt ?? null, f.timesSeen);
}

function insertEvent(db: Database.Database, id: string, fingerprint: string, type: string, occurredAt: string): void {
  db.prepare(`
    INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at)
    VALUES (?, ?, ?, 'security', ?, ?, ?)
  `).run(id, fingerprint, RULE, `scan-${id}`, type, occurredAt);
}

function insertSuppression(db: Database.Database, id: string, fingerprint: string, resourceId: string): void {
  db.prepare(`
    INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
    VALUES (?, ?, ?, 'Accepted risk', '2026-08-15T08:00:00.000Z')
  `).run(id, fingerprint, resourceId);
}

const rows = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

describe('upgrading fingerprints onto the case-insensitive formula', () => {
  it('moves a mixed-case finding, its events and its suppression, keeping its age', () => {
    const id = vm('RG-APP');
    const legacy = computeLegacyFingerprint(RULE, id);
    sqlite = preUpgradeDatabase(db => {
      insertFinding(db, { fingerprint: legacy, resourceId: id, firstSeenAt: '2026-06-01T08:00:00.000Z', lastSeenAt: '2026-09-01T08:00:00.000Z', timesSeen: 12 });
      insertEvent(db, 'e1', legacy, 'created', '2026-06-01T08:00:00.000Z');
      insertSuppression(db, 's1', legacy, id);
    });
    expect(legacy, 'fixture must actually differ under the new formula').not.toBe(computeFingerprint(RULE, id));

    runMigrations(sqlite);

    const next = computeFingerprint(RULE, id);
    const findings = rows(sqlite, `SELECT * FROM findings`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fingerprint: next, resource_id: id, first_seen_at: '2026-06-01T08:00:00.000Z', times_seen: 12, status: 'active' });
    expect(rows(sqlite, `SELECT fingerprint FROM finding_events`)).toEqual([{ fingerprint: next }]);
    expect(rows(sqlite, `SELECT fingerprint FROM suppressions`), 'the suppression would stop suppressing').toEqual([{ fingerprint: next }]);
  });

  it('merges a pair the casing bug split into one finding with its true age and all its history', () => {
    const upper = vm('RG-APP');
    const lower = vm('rg-app');
    const fpUpper = computeLegacyFingerprint(RULE, upper);
    const fpLower = computeLegacyFingerprint(RULE, lower);
    sqlite = preUpgradeDatabase(db => {
      // Seen since June as RG-APP, then resolved by the scan that returned it as rg-app.
      insertFinding(db, { fingerprint: fpUpper, resourceId: upper, status: 'fixed', firstSeenAt: '2026-06-01T08:00:00.000Z', lastSeenAt: '2026-09-01T08:00:00.000Z', resolvedAt: '2026-09-02T08:00:00.000Z', timesSeen: 10, evidence: '{"old":true}' });
      insertFinding(db, { fingerprint: fpLower, resourceId: lower, status: 'active', firstSeenAt: '2026-09-02T08:00:00.000Z', lastSeenAt: '2026-09-03T08:00:00.000Z', timesSeen: 2, evidence: '{"new":true}' });
      insertEvent(db, 'e1', fpUpper, 'created', '2026-06-01T08:00:00.000Z');
      insertEvent(db, 'e2', fpUpper, 'resolved', '2026-09-02T08:00:00.000Z');
      insertEvent(db, 'e3', fpLower, 'created', '2026-09-02T08:00:00.000Z');
      insertSuppression(db, 's1', fpUpper, upper);
    });

    runMigrations(sqlite);

    const next = computeFingerprint(RULE, lower);
    expect(computeFingerprint(RULE, upper)).toBe(next);
    const findings = rows(sqlite, `SELECT * FROM findings`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      fingerprint: next,
      status: 'active',
      resolved_at: null,
      resource_id: lower,
      evidence: '{"new":true}',
      last_seen_at: '2026-09-03T08:00:00.000Z',
      first_seen_at: '2026-06-01T08:00:00.000Z',
      times_seen: 12,
    });
    expect(rows(sqlite, `SELECT id, fingerprint FROM finding_events ORDER BY id`)).toEqual([
      { id: 'e1', fingerprint: next }, { id: 'e2', fingerprint: next }, { id: 'e3', fingerprint: next },
    ]);
    expect(rows(sqlite, `SELECT fingerprint FROM suppressions`)).toEqual([{ fingerprint: next }]);
  });

  it('keeps a finding\'s stored rows with the row that survives a rekey or a merge', () => {
    const upper = vm('RG-APP');
    const lower = vm('rg-app');
    const fpUpper = computeLegacyFingerprint(RULE, upper);
    const fpLower = computeLegacyFingerprint(RULE, lower);
    const newRows = '[{"owner":"a"},{"owner":"b"}]';
    sqlite = preUpgradeDatabase(db => {
      insertFinding(db, { fingerprint: fpUpper, resourceId: upper, status: 'fixed', firstSeenAt: '2026-06-01T08:00:00.000Z', lastSeenAt: '2026-09-01T08:00:00.000Z', resolvedAt: '2026-09-02T08:00:00.000Z', timesSeen: 10, evidence: '{"owner":"old"}' });
      insertFinding(db, { fingerprint: fpLower, resourceId: lower, status: 'active', firstSeenAt: '2026-09-02T08:00:00.000Z', lastSeenAt: '2026-09-03T08:00:00.000Z', timesSeen: 2, evidence: '{"owner":"a"}' });
      db.prepare(`UPDATE findings SET evidence_rows = ? WHERE fingerprint = ?`).run('[{"owner":"old"}]', fpUpper);
      db.prepare(`UPDATE findings SET evidence_rows = ? WHERE fingerprint = ?`).run(newRows, fpLower);
    });

    runMigrations(sqlite);

    expect(rows(sqlite, `SELECT fingerprint, evidence_rows FROM findings`)).toEqual([
      { fingerprint: computeFingerprint(RULE, lower), evidence_rows: newRows },
    ]);
  });

  it('moves a suppression whose finding row is gone by recognising its rule exactly', () => {
    const id = vm('RG-APP');
    sqlite = preUpgradeDatabase(db => insertSuppression(db, 's1', computeLegacyFingerprint(RULE, id), id));

    runMigrations(sqlite);

    expect(rows(sqlite, `SELECT fingerprint FROM suppressions`)).toEqual([{ fingerprint: computeFingerprint(RULE, id) }]);
  });

  it('rewrites a pending run\'s new-finding list so its notification still finds the findings', () => {
    const id = vm('RG-APP');
    const legacy = computeLegacyFingerprint(RULE, id);
    sqlite = preUpgradeDatabase(db => {
      insertFinding(db, { fingerprint: legacy, resourceId: id, firstSeenAt: '2026-09-01T08:00:00.000Z', lastSeenAt: '2026-09-01T08:00:00.000Z', timesSeen: 1 });
      db.prepare(`
        INSERT INTO schedule_runs (id, schedule_id, started_at, status, categories, new_finding_fingerprints, notify_status)
        VALUES ('r1', 'sch-1', '2026-09-01T08:00:00.000Z', 'success', '["security"]', ?, 'pending')
      `).run(JSON.stringify([legacy, 'untouched-fp']));
    });

    runMigrations(sqlite);

    const run = rows(sqlite, `SELECT new_finding_fingerprints FROM schedule_runs WHERE id = 'r1'`)[0]!;
    expect(JSON.parse(String(run.new_finding_fingerprints))).toEqual([computeFingerprint(RULE, id), 'untouched-fp']);
  });

  it('leaves a row alone when its stored fingerprint is not the legacy one for its rule and resource', () => {
    const id = vm('RG-APP');
    sqlite = preUpgradeDatabase(db => {
      insertFinding(db, { fingerprint: 'not-derived-here', resourceId: id, firstSeenAt: '2026-09-01T08:00:00.000Z', lastSeenAt: '2026-09-01T08:00:00.000Z', timesSeen: 1 });
    });

    runMigrations(sqlite);

    expect(rows(sqlite, `SELECT fingerprint FROM findings`)).toEqual([{ fingerprint: 'not-derived-here' }]);
  });

  it('a rule renamed in the same upgrade still lands its findings and suppressions on the new formula', () => {
    // A database old enough to carry both a built-in rule's pre-UUID slug and case-sensitive
    // fingerprints. The rename remap must recognise the legacy value, or the finding is re-pointed
    // at the new rule id with a fingerprint derived from neither.
    const OLD_ID = 'builtin::orphan-unattached-disk';
    const NEW_ID = '7a25444f-90c1-4c4e-b6dc-3076a857dfa8';
    const id = `/subscriptions/${SUB}/resourceGroups/RG-APP/providers/Microsoft.Compute/disks/disk-1`;
    const legacy = computeLegacyFingerprint(OLD_ID, id);
    sqlite = preUpgradeDatabase(db => {
      db.prepare(`
        INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type)
        VALUES (?, 'Unattached disks', 'test', 'cost', 'low', 1, '{"level":"subscription"}', '[]', '[]', 'builtin')
      `).run(OLD_ID);
      db.prepare(`
        INSERT INTO findings (fingerprint, rule_id, category, severity, resource_id, subscription_id, title, first_seen_at, last_seen_at, times_seen)
        VALUES (?, ?, 'cost', 'low', ?, ?, 'Unattached disks', '2026-06-01T08:00:00.000Z', '2026-09-01T08:00:00.000Z', 4)
      `).run(legacy, OLD_ID, id, SUB);
      insertSuppression(db, 's1', legacy, id);
    });

    runMigrations(sqlite);

    const next = computeFingerprint(NEW_ID, id);
    expect(rows(sqlite, `SELECT fingerprint, rule_id, first_seen_at FROM findings`)).toEqual([
      { fingerprint: next, rule_id: NEW_ID, first_seen_at: '2026-06-01T08:00:00.000Z' },
    ]);
    expect(rows(sqlite, `SELECT fingerprint FROM suppressions`)).toEqual([{ fingerprint: next }]);
  });

  it('runs once: a second start changes nothing', () => {
    const id = vm('RG-APP');
    const legacy = computeLegacyFingerprint(RULE, id);
    sqlite = preUpgradeDatabase(db => {
      insertFinding(db, { fingerprint: legacy, resourceId: id, firstSeenAt: '2026-06-01T08:00:00.000Z', lastSeenAt: '2026-09-01T08:00:00.000Z', timesSeen: 12 });
      insertEvent(db, 'e1', legacy, 'created', '2026-06-01T08:00:00.000Z');
      insertSuppression(db, 's1', legacy, id);
    });
    runMigrations(sqlite);
    const snapshot = () => ({
      findings: rows(sqlite!, `SELECT * FROM findings`),
      events: rows(sqlite!, `SELECT * FROM finding_events`),
      suppressions: rows(sqlite!, `SELECT * FROM suppressions`),
    });
    const afterFirst = snapshot();

    runMigrations(sqlite);

    expect(snapshot()).toEqual(afterFirst);
    expect(rows(sqlite, `SELECT key FROM meta WHERE key = ?`, FINGERPRINT_CASE_MARKER)).toHaveLength(1);
  });
});

// Postgres installs since 0.7.0 hold legacy fingerprints too, and never run migrate.ts: the same
// plan runs from bootstrapPg(). This proves the statements bind and apply there, not just plan.
describe.runIf(process.env.RULEBEAT_TEST_PG_URL)('upgrading fingerprints on Postgres', () => {
  it('bootstrapPg merges a split pair and carries its events, suppression and run list across', async () => {
    await dbReady;
    const pg = pgDb!;
    const q = async (text: string) => (await pg.execute(sql.raw(text))).rows as Record<string, unknown>[];
    const upper = vm('RG-PG', 'vm-pg');
    const lower = vm('rg-pg', 'vm-pg');
    const fpUpper = computeLegacyFingerprint(RULE, upper);
    const fpLower = computeLegacyFingerprint(RULE, lower);
    const next = computeFingerprint(RULE, lower);
    const finding = (fp: string, rid: string, status: string, first: string, last: string, times: number) => sql`
      INSERT INTO findings (fingerprint, rule_id, category, severity, resource_id, subscription_id, title,
        status, first_seen_at, last_seen_at, times_seen)
      VALUES (${fp}, ${RULE}, 'security', 'high', ${rid}, ${SUB}, 'VMs without backup', ${status}, ${first}, ${last}, ${times})`;

    await pg.execute(sql`DELETE FROM meta WHERE key = ${FINGERPRINT_CASE_MARKER}`);
    await pg.execute(finding(fpUpper, upper, 'fixed', '2026-06-01T08:00:00.000Z', '2026-09-01T08:00:00.000Z', 10));
    await pg.execute(finding(fpLower, lower, 'active', '2026-09-02T08:00:00.000Z', '2026-09-03T08:00:00.000Z', 2));
    await pg.execute(sql`
      INSERT INTO finding_events (id, fingerprint, rule_id, category, scan_id, type, occurred_at) VALUES
        ('pg-e1', ${fpUpper}, ${RULE}, 'security', 'scan-1', 'created', '2026-06-01T08:00:00.000Z'),
        ('pg-e2', ${fpLower}, ${RULE}, 'security', 'scan-2', 'created', '2026-09-02T08:00:00.000Z')`);
    await pg.execute(sql`
      INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
      VALUES ('pg-s1', ${fpUpper}, ${upper}, 'Accepted risk', '2026-08-15T08:00:00.000Z')`);
    await pg.execute(sql`
      INSERT INTO schedule_runs (id, schedule_id, started_at, status, categories, new_finding_fingerprints, notify_status)
      VALUES ('pg-r1', 'sch-1', '2026-09-03T08:00:00.000Z', 'success', '["security"]', ${JSON.stringify([fpLower])}, 'pending')`);

    try {
      await bootstrapPg(pg);

      const findings = await q(`SELECT fingerprint, status, first_seen_at, times_seen, resource_id FROM findings WHERE rule_id = '${RULE}'`);
      expect(findings).toEqual([{ fingerprint: next, status: 'active', first_seen_at: '2026-06-01T08:00:00.000Z', times_seen: 12, resource_id: lower }]);
      expect(await q(`SELECT fingerprint FROM finding_events WHERE id IN ('pg-e1', 'pg-e2')`)).toEqual([{ fingerprint: next }, { fingerprint: next }]);
      expect(await q(`SELECT fingerprint FROM suppressions WHERE id = 'pg-s1'`)).toEqual([{ fingerprint: next }]);
      const [run] = await q(`SELECT new_finding_fingerprints FROM schedule_runs WHERE id = 'pg-r1'`);
      expect(JSON.parse(String(run!.new_finding_fingerprints))).toEqual([next]);
      expect(await q(`SELECT key FROM meta WHERE key = '${FINGERPRINT_CASE_MARKER}'`)).toHaveLength(1);
    } finally {
      await pg.execute(sql`DELETE FROM findings WHERE rule_id = ${RULE}`);
      await pg.execute(sql`DELETE FROM finding_events WHERE id IN ('pg-e1', 'pg-e2')`);
      await pg.execute(sql`DELETE FROM suppressions WHERE id = 'pg-s1'`);
      await pg.execute(sql`DELETE FROM schedule_runs WHERE id = 'pg-r1'`);
    }
  });
});
