/**
 * Issue #280: the upgrade that adds `personal_rules` and `personal_rule_results` is additive. An
 * install from before them keeps its rules and its users, the new tables start empty, and a Personal
 * rule with its stored results survives a restart unchanged. Migrations swallow their own errors, so
 * these tests read the content back through the repositories the app reads with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';
import type { PersonalRuleDefinition } from '@/lib/db/personal-rules';

const RULE = '9a4e7c31-5b2d-4e8f-8c6a-1d3f5b7a9c21';
const KQL = 'resources | project id, name, type, location, resourceGroup, subscriptionId';

const DEFINITION: PersonalRuleDefinition = {
  name: 'My VM check',
  description: 'mine',
  category: 'reliability',
  severity: 'medium',
  queryBackend: 'resource-graph',
  kind: 'state',
  scope: { level: 'subscription' },
  resourceTypes: [],
  conditions: [],
  rawKql: KQL,
};

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

async function startProductOn(file: string) {
  vi.resetModules();
  // A SQLite upgrade test: the Postgres CI job must not point the product at its database instead.
  vi.stubEnv('RULEBEAT_DATABASE_URL', '');
  vi.stubEnv('RULEBEAT_DATABASE_URL_FILE', '');
  vi.stubEnv('RULEBEAT_DB_PATH', file);
  const client = await import('@/lib/db/client');
  closeProductDb = () => client.rawSqlite?.close();
  const personal = await import('@/lib/db/personal-rules');
  const users = await import('@/lib/db/users');
  return { personal, users, stop: () => { client.rawSqlite?.close(); closeProductDb = undefined; } };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];

describe('upgrading to a database with Personal rules', () => {
  it('keeps the shared rules and users an earlier install held, and starts the new tables empty', async () => {
    const sample = makeSample('current');
    const db = open(sample.file);
    runMigrations(db);
    db.exec(`DROP TABLE personal_rule_results; DROP TABLE personal_rules;`);
    db.prepare(`
      INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type)
      VALUES (?, 'VM retirements', 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]', ?, 'custom')
    `).run(RULE, KQL);
    const usersBefore = all(db, `SELECT id, email, role FROM users ORDER BY id`);
    expect(all(db, `SELECT name FROM sqlite_master WHERE name LIKE 'personal_rule%'`)).toEqual([]);
    db.close();

    const product = await startProductOn(sample.file);
    const author = await product.users.createUser({ email: 'author@example.com', role: 'editor' });
    if ('error' in author) throw new Error(author.error);
    expect(await product.personal.listPersonalRules(author.user.id)).toEqual([]);
    product.stop();

    sqlite = open(sample.file);
    expect(all(sqlite, `SELECT name, raw_kql FROM rules WHERE id = ?`, RULE)).toEqual([{ name: 'VM retirements', raw_kql: KQL }]);
    expect(all(sqlite, `SELECT id, email, role FROM users WHERE email <> 'author@example.com' ORDER BY id`)).toEqual(usersBefore);
    expect(all(sqlite, `SELECT COUNT(*) AS n FROM personal_rule_results`)).toEqual([{ n: 0 }]);
  });

  it('keeps a Personal rule and its latest results across a restart', async () => {
    const sample = makeSample('current');
    const first = await startProductOn(sample.file);
    const author = await first.users.createUser({ email: 'author@example.com', role: 'editor' });
    if ('error' in author) throw new Error(author.error);
    const made = await first.personal.createPersonalRule(author.user.id, DEFINITION);
    await first.personal.replacePersonalRuleResults(made.id, author.user.id, {
      status: 'success',
      ranAt: '2026-01-02T03:04:05.000Z',
      coveredScope: '[{"tenantId":"t","path":"/subscriptions/x"}]',
      results: [{ resourceId: '/subscriptions/x/resourceGroups/rg/a', resourceName: 'a', severity: 'medium', title: 'check', rows: [{ id: 'a' }] }],
    });
    first.stop();

    const second = await startProductOn(sample.file);
    const rule = await second.personal.getPersonalRule(made.id, author.user.id);
    expect(rule).toMatchObject({
      name: 'My VM check', rawKql: KQL, ownerId: author.user.id, lastRunAt: '2026-01-02T03:04:05.000Z', lastRunStatus: 'success',
      lastRunCoveredScope: '[{"tenantId":"t","path":"/subscriptions/x"}]',
    });
    const results = await second.personal.listPersonalRuleResults(made.id, author.user.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ resourceId: '/subscriptions/x/resourceGroups/rg/a', resourceName: 'a', rows: [{ id: 'a' }] });
  });
});
