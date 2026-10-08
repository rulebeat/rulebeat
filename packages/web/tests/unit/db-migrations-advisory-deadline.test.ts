/**
 * Issue #177: the upgrade that adds `rules.deadline_field` and `findings.deadline` is additive, so
 * everything already stored has to read back exactly as it was, with the new columns empty, and a
 * restart must not touch what a user has since set. Migrations swallow their own errors, so these
 * tests read the content back rather than trusting that nothing threw.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { SHAPES } from '../fixtures/db-shapes';
import { runMigrations } from '@/lib/db/migrate';
import { SERVICE_RETIREMENTS_RULE_ID } from '../helpers/catalogue';

const RULE = '3c9d5a10-8e2b-4b7a-a1f4-5d6e7f809a11';
const SUB = '00000000-0000-0000-0000-000000000000';
const RESOURCE = `/subscriptions/${SUB}/resourceGroups/rg/providers/microsoft.compute/virtualmachines/vm-1`;
const FINGERPRINT = 'fedcba9876543210';

let sqlite: Database.Database | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

describe('upgrading to a database with Deadline columns', () => {
  it('keeps a pre-Deadline Advisory rule with its KQL, its finding with its age, and its suppression, all with no Deadline', () => {
    const sample = makeSample('current');
    let db = open(sample.file);
    runMigrations(db);
    db.exec(`ALTER TABLE rules DROP COLUMN deadline_field; ALTER TABLE findings DROP COLUMN deadline;`);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type, kind)
      VALUES (?, 'VM size retiring', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]',
        'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom', 'advisory')
    `).run(RULE);
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, status, first_seen_at, last_seen_at, times_seen)
      VALUES (?, ?, 'reliability', 'medium', 'advisory', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 'VM size retiring', '{}',
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 9)
    `).run(FINGERPRINT, RULE, RESOURCE, SUB);
    db.prepare(`
      INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
      VALUES ('sup-1', ?, ?, 'Accepted risk', '2026-02-01T00:00:00.000Z')
    `).run(FINGERPRINT, RESOURCE);
    expect(all(db, `PRAGMA table_info(rules)`).some(c => c.name === 'deadline_field')).toBe(false);
    db.close();

    upgradeInProcess(sample);

    db = sqlite = open(sample.file);
    expect(all(db, `SELECT kind, enabled, raw_kql, deadline_field FROM rules WHERE id = ?`, RULE)).toEqual([
      { kind: 'advisory', enabled: 1, raw_kql: 'resources | project id, name, type, location, resourceGroup, subscriptionId', deadline_field: null },
    ]);
    expect(all(db, `SELECT kind, status, first_seen_at, times_seen, deadline FROM findings WHERE rule_id = ?`, RULE)).toEqual([
      { kind: 'advisory', status: 'active', first_seen_at: '2026-01-02T03:04:05.000Z', times_seen: 9, deadline: null },
    ]);
    expect(all(db, `SELECT reason FROM suppressions WHERE id = 'sup-1'`)).toEqual([{ reason: 'Accepted risk' }]);
  });

  it('keeps a Deadline column and a Deadline across a restart', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    let db = open(sample.file);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type, kind, deadline_field)
      VALUES (?, 'VM size retiring', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]', 'custom', 'advisory', 'retiresOn')
    `).run(RULE);
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, status, first_seen_at, last_seen_at, times_seen, deadline)
      VALUES (?, ?, 'reliability', 'medium', 'advisory', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 't', '{}',
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 2, '2026-09-01T00:00:00.000Z')
    `).run(FINGERPRINT, RULE, RESOURCE, SUB);
    db.close();

    upgradeInProcess(sample);

    db = sqlite = open(sample.file);
    expect(all(db, `SELECT deadline_field FROM rules WHERE id = ?`, RULE)).toEqual([{ deadline_field: 'retiresOn' }]);
    expect(all(db, `SELECT deadline, times_seen FROM findings WHERE rule_id = ?`, RULE)).toEqual([
      { deadline: '2026-09-01T00:00:00.000Z', times_seen: 2 },
    ]);
  });

  it.each(SHAPES)('a %s database gains both columns, empty, and ends with no Deadline column set on any rule', shape => {
    const sample = makeSample(shape);
    upgradeInProcess(sample);
    const db = sqlite = open(sample.file);
    const names = (table: string) => all(db, `PRAGMA table_info(${table})`).map(c => c.name);
    expect(names('rules')).toContain('deadline_field');
    expect(names('findings')).toContain('deadline');
    // Only the Service retirements rule RuleBeat Core ships (issue #181) names a Deadline column.
    expect(all(db, `SELECT id FROM rules WHERE deadline_field IS NOT NULL`)).toEqual([{ id: SERVICE_RETIREMENTS_RULE_ID }]);
    expect(all(db, `SELECT fingerprint FROM findings WHERE deadline IS NOT NULL`)).toEqual([]);
    expect(all(db, `SELECT COUNT(*) AS n FROM rules`)[0].n).toBeGreaterThan(0);
  });
});
