/**
 * Issue #176: a rule's kind and its findings' kind are stored columns that already exist, so the
 * upgrade that ships Advisories must carry them through untouched. "It ran without throwing"
 * proves nothing here, because migrations swallow their own errors; these tests read the content
 * back: an Advisory rule still Advisory, its finding still an Advisory with its age and its
 * suppression, and every rule from an older database still the kind it was.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open, upgradeInProcess } from '../fixtures/upgrade';
import { SHAPES } from '../fixtures/db-shapes';
import { runMigrations } from '@/lib/db/migrate';

const RULE = '6b1f8c2e-4d3a-4f6b-9c1e-7a2d5e8f0b77';
const SUB = '00000000-0000-0000-0000-000000000000';
const RESOURCE = `/subscriptions/${SUB}/resourceGroups/rg/providers/microsoft.compute/virtualmachines/vm-1`;
const FINGERPRINT = '0123456789abcdef';

let sqlite: Database.Database | undefined;
afterEach(() => { sqlite?.close(); sqlite = undefined; });

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

describe('upgrading with Advisories in the database', () => {
  it('keeps an Advisory rule, its finding with its age, and its suppression', () => {
    const sample = makeSample('current');
    let db = open(sample.file);
    runMigrations(db);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, type, kind)
      VALUES (?, 'VM size retiring', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]', 'custom', 'advisory')
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
    db.close();

    upgradeInProcess(sample);

    db = sqlite = open(sample.file);
    expect(all(db, `SELECT kind, enabled FROM rules WHERE id = ?`, RULE)).toEqual([{ kind: 'advisory', enabled: 1 }]);
    const finding = all(db, `SELECT kind, status, first_seen_at, times_seen FROM findings WHERE rule_id = ?`, RULE);
    expect(finding).toEqual([{ kind: 'advisory', status: 'active', first_seen_at: '2026-01-02T03:04:05.000Z', times_seen: 9 }]);
    expect(all(db, `SELECT reason FROM suppressions WHERE id = 'sup-1'`)).toEqual([{ reason: 'Accepted risk' }]);
  });

  it.each(SHAPES)('a %s database ends up with no Advisory it did not ask for, and a restart changes no rule\'s kind', shape => {
    const sample = makeSample(shape);

    upgradeInProcess(sample);
    let db = open(sample.file);
    const kindsAfterUpgrade = all(db, `SELECT id, kind FROM rules ORDER BY id`);
    db.close();

    upgradeInProcess(sample);
    db = sqlite = open(sample.file);
    expect(kindsAfterUpgrade.length).toBeGreaterThan(0);
    expect(all(db, `SELECT id, kind FROM rules ORDER BY id`)).toEqual(kindsAfterUpgrade);
    expect(all(db, `SELECT id FROM rules WHERE kind = 'advisory'`)).toEqual([]);
  });
});
