/**
 * Issue #192: the upgrade that adds `findings.evidence_rows` is additive. Everything already stored
 * reads back exactly as it was, the new column is empty, and nothing is rewritten: a finding stored
 * before rows existed reads as one row made from its evidence until its next scan stores the rows.
 * Migrations swallow their own errors, so these tests read the content back rather than trusting
 * that nothing threw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { SHAPES } from '../fixtures/db-shapes';
import { runMigrations } from '@/lib/db/migrate';

const RULE = '9a4e7c31-5b2d-4e8f-8c6a-1d3f5b7a9c20';
const SUB = '00000000-0000-0000-0000-000000000000';
const RESOURCE = `/subscriptions/${SUB}/resourceGroups/rg/providers/microsoft.compute/virtualmachines/vm-1`;
const FINGERPRINT = 'abcdef0123456789';
const EVIDENCE = '{"retirement":"Basic tier"}';

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
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const findings = await import('@/lib/db/findings');
  const suppressions = await import('@/lib/suppressions');
  return { listFindings: findings.listFindings, loadSuppressions: suppressions.loadSuppressions };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

describe('upgrading to a database with stored rows', () => {
  it('keeps a pre-rows finding with its evidence, age and suppression, and reads it back as one row', async () => {
    const sample = makeSample('current');
    let db = open(sample.file);
    runMigrations(db);
    db.exec(`ALTER TABLE findings DROP COLUMN evidence_rows;`);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type)
      VALUES (?, 'VM retirements', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]',
        'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom')
    `).run(RULE);
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, status, first_seen_at, last_seen_at, times_seen)
      VALUES (?, ?, 'reliability', 'medium', 'state', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 'VM retirements', ?,
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 9)
    `).run(FINGERPRINT, RULE, RESOURCE, SUB, EVIDENCE);
    db.prepare(`
      INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
      VALUES ('sup-1', ?, ?, 'Accepted risk', '2026-02-01T00:00:00.000Z')
    `).run(FINGERPRINT, RESOURCE);
    expect(all(db, `PRAGMA table_info(findings)`).some(c => c.name === 'evidence_rows')).toBe(false);
    db.close();

    const product = await startProductOn(sample.file);

    const found = (await product.listFindings()).filter(f => f.fingerprint === FINGERPRINT);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      status: 'active',
      firstSeenAt: '2026-01-02T03:04:05.000Z',
      timesSeen: 9,
      evidence: { retirement: 'Basic tier' },
      rows: [{ retirement: 'Basic tier' }],
    });
    const suppressions = await product.loadSuppressions();
    expect(suppressions.filter(s => s.fingerprint === FINGERPRINT)).toEqual([
      expect.objectContaining({ id: 'sup-1', reason: 'Accepted risk' }),
    ]);

    // Nothing was rewritten: the column exists and stays empty until the finding's next scan.
    db = sqlite = open(sample.file);
    expect(all(db, `SELECT evidence_rows FROM findings WHERE rule_id = ?`, RULE)).toEqual([{ evidence_rows: null }]);
  });

  it('keeps stored rows across a restart', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    let db = open(sample.file);
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, evidence_rows, status, first_seen_at, last_seen_at, times_seen)
      VALUES (?, ?, 'reliability', 'medium', 'state', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 't', ?, ?,
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 2)
    `).run(FINGERPRINT, RULE, RESOURCE, SUB, EVIDENCE, '[{"retirement":"Basic tier"},{"retirement":"TLS 1.0"}]');
    db.close();

    upgradeInProcess(sample);

    db = sqlite = open(sample.file);
    expect(all(db, `SELECT evidence_rows, times_seen FROM findings WHERE rule_id = ?`, RULE)).toEqual([
      { evidence_rows: '[{"retirement":"Basic tier"},{"retirement":"TLS 1.0"}]', times_seen: 2 },
    ]);
  });

  it.each(SHAPES)('a %s database gains the column, empty, and every stored finding keeps a null rows column', shape => {
    const sample = makeSample(shape);
    upgradeInProcess(sample);
    const db = sqlite = open(sample.file);
    expect(all(db, `PRAGMA table_info(findings)`).map(c => c.name)).toContain('evidence_rows');
    expect(all(db, `SELECT fingerprint FROM findings WHERE evidence_rows IS NOT NULL`)).toEqual([]);
  });
});
