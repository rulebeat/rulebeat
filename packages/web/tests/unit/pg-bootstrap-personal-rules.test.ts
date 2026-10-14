/**
 * Issue #280: a Postgres database bootstrapped before the Personal rule tables existed gains them on
 * the next boot, and a Personal rule with its stored results written afterwards is read back unchanged
 * by the repository the app reads with. Postgres only by nature; skipped on the default SQLite run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { dbKind } from '@/lib/db/backend';
import { dbReady, pgDb } from '@/lib/db/client';
import { bootstrapPg } from '@/lib/db/pg/bootstrap';
import { createPersonalRule, getPersonalRule, listPersonalRuleResults, replacePersonalRuleResults } from '@/lib/db/personal-rules';
import { createUser } from '@/lib/db/users';
import { resetDb } from '../helpers/db';

describe.skipIf(dbKind !== 'pg')('bootstrapPg adds the Personal rule tables to an existing database (issue #280)', () => {
  afterEach(async () => { await resetDb(); });

  it('creates the tables on a database without them and keeps a rule and its results across a re-bootstrap', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    await pgDb!.execute(sql.raw('DROP TABLE personal_rule_results'));
    await pgDb!.execute(sql.raw('DROP TABLE personal_rules'));

    await bootstrapPg(pgDb!);
    const author = await createUser({ email: 'author@example.com', role: 'editor' });
    if ('error' in author) throw new Error(author.error);
    const made = await createPersonalRule(author.user.id, {
      name: 'My VM check', description: '', category: 'reliability', severity: 'medium', queryBackend: 'resource-graph', kind: 'state',
      scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id',
    });
    await replacePersonalRuleResults(made.id, author.user.id, {
      status: 'success', ranAt: '2026-01-02T03:04:05.000Z', coveredScope: '[]',
      results: [{ resourceId: '/subscriptions/x/resourceGroups/rg/a', resourceName: 'a', severity: 'medium', title: 'check', rows: [{ id: 'a' }] }],
    });

    const before = await getPersonalRule(made.id, author.user.id);
    expect(before).toMatchObject({ name: 'My VM check', lastRunStatus: 'success' });

    await bootstrapPg(pgDb!);
    expect(await getPersonalRule(made.id, author.user.id)).toEqual(before);
    expect(await listPersonalRuleResults(made.id, author.user.id)).toHaveLength(1);
  });

  it('adds source_rule_id to a personal_rules table without it, keeping its rules and results (issue #281)', async () => {
    await dbReady;
    await resetDb();
    await bootstrapPg(pgDb!);
    const author = await createUser({ email: 'author@example.com', role: 'editor' });
    if ('error' in author) throw new Error(author.error);
    const made = await createPersonalRule(author.user.id, {
      name: 'My VM check', description: '', category: 'reliability', severity: 'medium', queryBackend: 'resource-graph', kind: 'state',
      scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id',
    });
    await replacePersonalRuleResults(made.id, author.user.id, {
      status: 'success', ranAt: '2026-01-02T03:04:05.000Z', coveredScope: '[]',
      results: [{ resourceId: '/subscriptions/x/resourceGroups/rg/a', resourceName: 'a', severity: 'medium', title: 'check', rows: [{ id: 'a' }] }],
    });
    const before = await getPersonalRule(made.id, author.user.id);
    await pgDb!.execute(sql.raw('ALTER TABLE personal_rules DROP COLUMN source_rule_id'));

    await bootstrapPg(pgDb!);
    const columns = await pgDb!.execute(sql.raw(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'personal_rules' AND column_name = 'source_rule_id'`));
    expect(columns.rows).toHaveLength(1);
    expect(await getPersonalRule(made.id, author.user.id)).toEqual(before);
    expect(await listPersonalRuleResults(made.id, author.user.id)).toHaveLength(1);
  });
});
