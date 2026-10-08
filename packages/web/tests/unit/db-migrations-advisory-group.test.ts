/**
 * Issue #178: the upgrade that adds `rules.group_field` and `findings.group_value` is additive, so
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

const RULE = '3c9d5a10-8e2b-4b7a-a1f4-5d6e7f809a12';
const SUB = '00000000-0000-0000-0000-000000000000';
const RESOURCE = `/subscriptions/${SUB}/resourceGroups/rg/providers/microsoft.compute/virtualmachines/vm-1`;
const FINGERPRINT = 'fedcba9876543211';

let sqlite: Database.Database | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

describe('upgrading to a database with Group columns', () => {
  it('keeps a pre-Group Advisory rule with its KQL and Deadline column, its finding with its age and Deadline, and its suppression, all with no group', () => {
    const sample = makeSample('current');
    let db = open(sample.file);
    runMigrations(db);
    db.exec(`ALTER TABLE rules DROP COLUMN group_field; ALTER TABLE findings DROP COLUMN group_value;`);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type, kind, deadline_field)
      VALUES (?, 'VM size retiring', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]',
        'resources | project id, name, type, location, resourceGroup, subscriptionId', 'custom', 'advisory', 'retiresOn')
    `).run(RULE);
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, status, first_seen_at, last_seen_at, times_seen, deadline)
      VALUES (?, ?, 'reliability', 'medium', 'advisory', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 'VM size retiring', '{}',
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 9, '2026-09-01T00:00:00.000Z')
    `).run(FINGERPRINT, RULE, RESOURCE, SUB);
    db.prepare(`
      INSERT INTO suppressions (id, fingerprint, resource_id, reason, suppressed_at)
      VALUES ('sup-1', ?, ?, 'Accepted risk', '2026-02-01T00:00:00.000Z')
    `).run(FINGERPRINT, RESOURCE);
    expect(all(db, `PRAGMA table_info(rules)`).some(c => c.name === 'group_field')).toBe(false);
    expect(all(db, `PRAGMA table_info(findings)`).some(c => c.name === 'group_value')).toBe(false);
    db.close();

    upgradeInProcess(sample);

    db = sqlite = open(sample.file);
    expect(all(db, `SELECT kind, enabled, raw_kql, deadline_field, group_field FROM rules WHERE id = ?`, RULE)).toEqual([
      {
        kind: 'advisory', enabled: 1, raw_kql: 'resources | project id, name, type, location, resourceGroup, subscriptionId',
        deadline_field: 'retiresOn', group_field: null,
      },
    ]);
    expect(all(db, `SELECT kind, status, first_seen_at, times_seen, deadline, group_value FROM findings WHERE rule_id = ?`, RULE)).toEqual([
      {
        kind: 'advisory', status: 'active', first_seen_at: '2026-01-02T03:04:05.000Z', times_seen: 9,
        deadline: '2026-09-01T00:00:00.000Z', group_value: null,
      },
    ]);
    expect(all(db, `SELECT reason FROM suppressions WHERE id = 'sup-1'`)).toEqual([{ reason: 'Accepted risk' }]);
  });

  it('keeps a Group column and a group value across a restart', () => {
    const sample = makeSample('current');
    upgradeInProcess(sample);
    let db = open(sample.file);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type, kind, group_field)
      VALUES (?, 'VM size retiring', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]', 'custom', 'advisory', 'owner')
    `).run(RULE);
    db.prepare(`
      INSERT INTO findings (fingerprint, rule_id, category, severity, kind, resource_id, resource_type, resource_name,
        subscription_id, title, evidence, status, first_seen_at, last_seen_at, times_seen, group_value)
      VALUES (?, ?, 'reliability', 'medium', 'advisory', ?, 'microsoft.compute/virtualmachines', 'vm-1', ?, 't', '{}',
        'active', '2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z', 2, 'platform')
    `).run(FINGERPRINT, RULE, RESOURCE, SUB);
    db.close();

    upgradeInProcess(sample);

    db = sqlite = open(sample.file);
    expect(all(db, `SELECT group_field FROM rules WHERE id = ?`, RULE)).toEqual([{ group_field: 'owner' }]);
    expect(all(db, `SELECT group_value, times_seen FROM findings WHERE rule_id = ?`, RULE)).toEqual([
      { group_value: 'platform', times_seen: 2 },
    ]);
  });

  it.each(SHAPES)('a %s database gains both columns, empty, and ends with no Group column set on any rule', shape => {
    const sample = makeSample(shape);
    upgradeInProcess(sample);
    const db = sqlite = open(sample.file);
    const names = (table: string) => all(db, `PRAGMA table_info(${table})`).map(c => c.name);
    expect(names('rules')).toContain('group_field');
    expect(names('findings')).toContain('group_value');
    // Only the Service retirements rule RuleBeat Core ships (issue #181) names a Group column.
    expect(all(db, `SELECT id FROM rules WHERE group_field IS NOT NULL`)).toEqual([{ id: SERVICE_RETIREMENTS_RULE_ID }]);
    expect(all(db, `SELECT fingerprint FROM findings WHERE group_value IS NOT NULL`)).toEqual([]);
    expect(all(db, `SELECT COUNT(*) AS n FROM rules`)[0].n).toBeGreaterThan(0);
  });
});
