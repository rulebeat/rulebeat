/**
 * Issue #282: the upgrade that adds `library_requests`, `personal_rules.library_rule_id` and
 * `rules.library_request_id` is additive. An install from before them keeps its rules with their KQL, its
 * Personal rules and its users, and a rule id renamed by the migration takes the two columns that point at it
 * along. Migrations swallow their own errors, so each test reads the content back, not just that it ran.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSample, open } from '../fixtures/upgrade';
import { runMigrations } from '@/lib/db/migrate';
import type { PersonalRuleDefinition } from '@/lib/db/personal-rules';

const RULE = '9a4e7c31-5b2d-4e8f-8c6a-1d3f5b7a9c21';
const KQL = 'resources | project id, name, type, location, resourceGroup, subscriptionId';

// One of the fixed renames in the migration (builtin::orphan-unattached-disk), and the id it becomes.
const OLD_ID = 'builtin::orphan-unattached-disk';
const NEW_ID = '7a25444f-90c1-4c4e-b6dc-3076a857dfa8';

const DEFINITION: PersonalRuleDefinition = {
  name: 'Sent to the library',
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
  return {
    personal: await import('@/lib/db/personal-rules'),
    requests: await import('@/lib/db/library-requests'),
    users: await import('@/lib/db/users'),
    rules: await import('@/lib/rules'),
    stop: () => { client.rawSqlite?.close(); closeProductDb = undefined; },
  };
}

const all = (db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];
const columns = (db: Database.Database, table: string) => all(db, `PRAGMA table_info(${table})`).map(c => c.name);

function insertRule(db: Database.Database, id: string, name: string) {
  db.prepare(`
    INSERT INTO rules (id, name, description, category, severity, enabled, scope, resource_types, conditions, raw_kql, type)
    VALUES (?, ?, 'test', 'reliability', 'medium', 1, '{"level":"subscription"}', '[]', '[]', ?, 'custom')
  `).run(id, name, KQL);
}

function insertPersonalRule(db: Database.Database, id: string, ownerId: string, extra: { libraryRuleId?: string } = {}) {
  const hasColumn = columns(db, 'personal_rules').includes('library_rule_id');
  db.prepare(`
    INSERT INTO personal_rules (id, owner_id, name, description, category, severity, scope, resource_types, conditions, raw_kql, query_backend, kind, created_at, updated_at${hasColumn ? ', library_rule_id' : ''})
    VALUES (?, ?, 'Personal VM check', 'mine', 'reliability', 'medium', '{"level":"subscription"}', '[]', '[]', ?, 'resource-graph', 'state', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'${hasColumn ? ', ?' : ''})
  `).run(...[id, ownerId, KQL, ...(hasColumn ? [extra.libraryRuleId ?? null] : [])]);
}

describe('upgrading to a database with Library requests', () => {
  it('adds the table and both columns to an install from before them, keeping its rules, Personal rules and users', async () => {
    const sample = makeSample('current');
    const db = open(sample.file);
    runMigrations(db);
    db.exec(`DROP TABLE library_requests; ALTER TABLE personal_rules DROP COLUMN library_rule_id; ALTER TABLE rules DROP COLUMN library_request_id;`);
    db.prepare(`INSERT INTO users (id, email, role, created_at) VALUES ('author-1', 'author@example.com', 'editor', '2026-01-01T00:00:00.000Z')`).run();
    insertRule(db, RULE, 'VM retirements');
    insertPersonalRule(db, 'personal-1', 'author-1');
    const usersBefore = all(db, `SELECT id, email, role FROM users ORDER BY id`);
    const personalBefore = all(db, `SELECT * FROM personal_rules`);
    expect(all(db, `SELECT name FROM sqlite_master WHERE name = 'library_requests'`)).toEqual([]);
    expect(columns(db, 'rules')).not.toContain('library_request_id');
    expect(columns(db, 'personal_rules')).not.toContain('library_rule_id');

    runMigrations(db);

    expect(columns(db, 'library_requests')).toEqual([
      'id', 'personal_rule_id', 'author_id', 'definition', 'status', 'created_at', 'reviewed_by', 'reviewed_at',
      'rejection_reason', 'resubmits_request_id', 'library_rule_id',
    ]);
    expect(columns(db, 'rules')).toContain('library_request_id');
    expect(columns(db, 'personal_rules')).toContain('library_rule_id');
    expect(all(db, `SELECT name, raw_kql, library_request_id FROM rules WHERE id = ?`, RULE)).toEqual([{ name: 'VM retirements', raw_kql: KQL, library_request_id: null }]);
    expect(all(db, `SELECT id, email, role FROM users ORDER BY id`)).toEqual(usersBefore);
    const personalAfter = all(db, `SELECT * FROM personal_rules`);
    expect(personalAfter).toEqual(personalBefore.map(row => ({ ...row, library_rule_id: null })));
    expect(all(db, `SELECT COUNT(*) AS n FROM library_requests`)).toEqual([{ n: 0 }]);
    db.close();
  });

  it('keeps a request with its snapshot and a rule it created across a restart', async () => {
    const sample = makeSample('current');
    const first = await startProductOn(sample.file);
    const author = await first.users.createUser({ email: 'author@example.com', role: 'editor' });
    const reviewer = await first.users.createUser({ email: 'reviewer@example.com', role: 'admin' });
    if ('error' in author || 'error' in reviewer) throw new Error('could not create users');
    const personal = await first.personal.createPersonalRule(author.user.id, DEFINITION);
    const sent = await first.requests.createLibraryRequest(personal, author.user.id);
    if (!sent.ok) throw new Error(sent.reason);
    const approved = await first.requests.approveLibraryRequest(sent.request.id, reviewer.user.id, { enabled: true });
    if (!approved.ok) throw new Error(approved.reason);
    first.stop();

    const second = await startProductOn(sample.file);
    expect(await second.requests.getLibraryRequest(sent.request.id)).toMatchObject({
      status: 'approved', reviewedBy: reviewer.user.id, libraryRuleId: approved.rule.id, definition: { name: 'Sent to the library', rawKql: KQL },
    });
    expect(await second.rules.loadRule(approved.rule.id)).toMatchObject({ name: 'Sent to the library', rawKql: KQL, libraryRequestId: sent.request.id, enabled: true });
    expect((await second.personal.getPersonalRule(personal.id, author.user.id))!.libraryRuleId).toBe(approved.rule.id);
  });
});

describe('renaming a rule id through the migration', () => {
  it('rewrites the library rule on a Personal rule and on a request, and leaves the others as they were', async () => {
    const sample = makeSample('current');
    const db = open(sample.file);
    runMigrations(db);
    db.prepare(`DELETE FROM rules WHERE id IN (?, ?)`).run(OLD_ID, NEW_ID);
    insertRule(db, OLD_ID, 'Old-format rule');
    insertPersonalRule(db, 'personal-renamed', 'author-1', { libraryRuleId: OLD_ID });
    insertPersonalRule(db, 'personal-kept', 'author-1', { libraryRuleId: RULE });
    db.prepare(`
      INSERT INTO library_requests (id, personal_rule_id, author_id, definition, status, created_at, library_rule_id)
      VALUES ('request-renamed', 'personal-renamed', 'author-1', '{}', 'approved', '2026-01-01T00:00:00.000Z', ?),
             ('request-kept', 'personal-kept', 'author-1', '{}', 'approved', '2026-01-01T00:00:00.000Z', ?)
    `).run(OLD_ID, RULE);

    runMigrations(db);

    expect(all(db, `SELECT id, library_rule_id FROM personal_rules ORDER BY id`)).toEqual([
      { id: 'personal-kept', library_rule_id: RULE },
      { id: 'personal-renamed', library_rule_id: NEW_ID },
    ]);
    expect(all(db, `SELECT id, library_rule_id FROM library_requests ORDER BY id`)).toEqual([
      { id: 'request-kept', library_rule_id: RULE },
      { id: 'request-renamed', library_rule_id: NEW_ID },
    ]);
    expect(all(db, `SELECT name FROM rules WHERE id = ?`, NEW_ID)).toEqual([{ name: 'Old-format rule' }]);
    db.close();
  });

  it('rewrites a pointer to an old id even when the rule it names is already gone', async () => {
    const sample = makeSample('current');
    const db = open(sample.file);
    runMigrations(db);
    db.prepare(`DELETE FROM rules WHERE id = ?`).run(OLD_ID);
    insertPersonalRule(db, 'personal-orphan', 'author-1', { libraryRuleId: OLD_ID });

    runMigrations(db);

    expect(all(db, `SELECT library_rule_id FROM personal_rules WHERE id = 'personal-orphan'`)).toEqual([{ library_rule_id: NEW_ID }]);
    db.close();
  });
});
