/**
 * Issue #282: a Postgres database bootstrapped before Library requests existed gains the `library_requests`
 * table, `personal_rules.library_rule_id` and `rules.library_request_id` on the next boot, and what it already
 * held (a Personal rule, a request with its snapshot) is read back unchanged. Postgres only by nature;
 * skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { approveLibraryRequest, createLibraryRequest, getLibraryRequest } from '@/lib/db/library-requests';
import { createPersonalRule, getPersonalRule } from '@/lib/db/personal-rules';
import { createUser } from '@/lib/db/users';
import { loadRule } from '@/lib/rules';
import { resetDb } from '../helpers/db';

const columnsOf = async (table: string): Promise<string[]> => {
  const res = await pgDb!.execute(sql.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`));
  return (res.rows as { column_name: string }[]).map(r => r.column_name);
};

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds Library requests to an existing database (issue #282)', () => {
  afterEach(async () => { await resetDb(); });

  it('creates the table and both columns on a database without them, keeping a Personal rule and a rule it had', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    const author = await createUser({ email: 'author@example.com', role: 'editor' });
    if ('error' in author) throw new Error(author.error);
    const made = await createPersonalRule(author.user.id, {
      name: 'Pg library request rule', description: '', category: 'reliability', severity: 'medium', queryBackend: 'resource-graph', kind: 'state',
      scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id',
    });
    const before = await getPersonalRule(made.id, author.user.id);

    await pgDb!.execute(sql.raw('DROP TABLE library_requests'));
    await pgDb!.execute(sql.raw('ALTER TABLE personal_rules DROP COLUMN library_rule_id'));
    await pgDb!.execute(sql.raw('ALTER TABLE rules DROP COLUMN library_request_id'));

    await bootstrapPg(pgDb!);
    expect(await columnsOf('library_requests')).toEqual(expect.arrayContaining([
      'id', 'personal_rule_id', 'author_id', 'definition', 'status', 'created_at', 'reviewed_by', 'reviewed_at',
      'rejection_reason', 'resubmits_request_id', 'library_rule_id',
    ]));
    expect(await columnsOf('personal_rules')).toContain('library_rule_id');
    expect(await columnsOf('rules')).toContain('library_request_id');
    expect(await getPersonalRule(made.id, author.user.id)).toEqual(before);
  });

  it('adds the update-request target columns to a database without them, keeping a request and its snapshot (#283)', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    const author = await createUser({ email: 'author@example.com', role: 'editor' });
    if ('error' in author) throw new Error(author.error);
    const made = await createPersonalRule(author.user.id, {
      name: 'Pg target column rule', description: '', category: 'reliability', severity: 'medium', queryBackend: 'resource-graph', kind: 'state',
      scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id',
    });
    const sent = await createLibraryRequest(made, author.user.id);
    if (!sent.ok) throw new Error(sent.reason);
    const before = await getLibraryRequest(sent.request.id);

    await pgDb!.execute(sql.raw('ALTER TABLE library_requests DROP COLUMN target_rule_id'));
    await pgDb!.execute(sql.raw('ALTER TABLE library_requests DROP COLUMN target_definition'));
    await bootstrapPg(pgDb!);

    expect(await columnsOf('library_requests')).toEqual(expect.arrayContaining(['target_rule_id', 'target_definition']));
    expect(await getLibraryRequest(sent.request.id)).toEqual(before);
  });

  it('sends, approves and reads back a request on Postgres, in one transaction', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    const author = await createUser({ email: 'author@example.com', role: 'editor' });
    const reviewer = await createUser({ email: 'reviewer@example.com', role: 'admin' });
    if ('error' in author || 'error' in reviewer) throw new Error('could not create users');
    const personal = await createPersonalRule(author.user.id, {
      name: 'Pg approved rule', description: '', category: 'reliability', severity: 'medium', queryBackend: 'resource-graph', kind: 'state',
      scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id',
    });

    const sent = await createLibraryRequest(personal, author.user.id);
    if (!sent.ok) throw new Error(sent.reason);
    const approved = await approveLibraryRequest(sent.request.id, reviewer.user.id, {});
    if (!approved.ok) throw new Error(approved.reason);

    expect(await getLibraryRequest(sent.request.id)).toMatchObject({ status: 'approved', libraryRuleId: approved.rule.id });
    expect(await loadRule(approved.rule.id)).toMatchObject({ name: 'Pg approved rule', libraryRequestId: sent.request.id });
    expect((await getPersonalRule(personal.id, author.user.id))!.libraryRuleId).toBe(approved.rule.id);
  });
});
