/**
 * No sequence of concurrent role changes or deletions may leave the install with zero admins, and
 * `deleteUser()`'s three deletes must be all-or-nothing. Before the fix, `updateUserRole()` and
 * `deleteUser()` each did a read-then-write last-admin check with no transaction around it: two
 * concurrent calls against the only two admins both read "2 admins" and both proceeded, leaving
 * zero. See `lib/db/users.ts` for the `inTransaction()` + row-lock fix.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, execRaw, countRows } from '../helpers/db';
import { dbKind } from '@/lib/db/backend';
import {
  createUser, updateUserRole, deleteUser, countAdmins, getUser, type AppUser,
} from '@/lib/db/users';
import { createSavedQuery, listSavedQueries } from '@/lib/db/saved-queries';
import { recordQueryRun, listQueryRuns } from '@/lib/db/query-runs';
import {
  createPersonalRule, listPersonalRuleResults, listPersonalRules, replacePersonalRuleResults,
  type PersonalRuleDefinition,
} from '@/lib/db/personal-rules';

const PERSONAL_DEFINITION: PersonalRuleDefinition = {
  name: 'Mine',
  description: '',
  category: 'security',
  severity: 'high',
  queryBackend: 'resource-graph',
  kind: 'state',
  scope: { level: 'subscription' },
  resourceTypes: [],
  conditions: [],
  rawKql: 'resources | project id',
};

async function seedPersonalRule(ownerId: string, name = 'Mine') {
  const rule = await createPersonalRule(ownerId, { ...PERSONAL_DEFINITION, name });
  await replacePersonalRuleResults(rule.id, ownerId, {
    status: 'success',
    ranAt: new Date().toISOString(),
    coveredScope: '[]',
    results: [{ resourceId: '/subscriptions/x/rg/a', resourceName: 'a', severity: 'high', title: 't', rows: [{ id: 'a' }] }],
  });
  return rule;
}

async function makeUser(email: string, role: AppUser['role'] = 'viewer'): Promise<AppUser> {
  const result = await createUser({ email, role });
  if ('error' in result) throw new Error(result.error);
  return result.user;
}

beforeEach(async () => {
  await resetDb();
});

describe('updateUserRole: concurrent last-admin demotions', () => {
  it('two concurrent demotions of the only two admins leave exactly one admin, and exactly one call reports the error', async () => {
    const a = await makeUser('race-admin-a@example.com', 'admin');
    const b = await makeUser('race-admin-b@example.com', 'admin');
    expect(await countAdmins()).toBe(2);

    const [resA, resB] = await Promise.all([
      updateUserRole(a.id, 'viewer'),
      updateUserRole(b.id, 'viewer'),
    ]);

    // The guarantee: exactly one admin remains, never zero.
    expect(await countAdmins()).toBe(1);

    const results = [resA, resB];
    const errors = results.filter((r): r is { error: string } => !!r && 'error' in r);
    const successes = results.filter((r): r is { user: AppUser } => !!r && 'user' in r);
    expect(errors).toHaveLength(1);
    expect(successes).toHaveLength(1);
    expect(errors[0].error).toBe('This is the only admin. Promote someone else to admin first.');
  });

  it('a demotion racing a deletion of the other admin still leaves exactly one admin standing', async () => {
    const a = await makeUser('race-mixed-a@example.com', 'admin');
    const b = await makeUser('race-mixed-b@example.com', 'admin');

    const [demote, del] = await Promise.all([
      updateUserRole(a.id, 'viewer'),
      deleteUser(b.id),
    ]);

    expect(await countAdmins()).toBe(1);
    const demoteRefused = demote !== null && 'error' in demote;
    const demoteSucceeded = demote !== null && 'user' in demote;
    const refused = demoteRefused || del === 'last-admin';
    const succeeded = demoteSucceeded || del === true;
    expect(refused).toBe(true);
    expect(succeeded).toBe(true);
  });
});

describe('deleteUser: concurrent last-admin deletions', () => {
  it('two concurrent deletions of the only two admins leave exactly one admin, and exactly one call reports last-admin', async () => {
    const a = await makeUser('race-delete-a@example.com', 'admin');
    const b = await makeUser('race-delete-b@example.com', 'admin');

    const [resA, resB] = await Promise.all([deleteUser(a.id), deleteUser(b.id)]);

    expect(await countAdmins()).toBe(1);
    const results = [resA, resB];
    expect(results.filter(r => r === 'last-admin')).toHaveLength(1);
    expect(results.filter(r => r === true)).toHaveLength(1);
  });
});

describe('deleteUser: atomicity of its three deletes', () => {
  // SQLite only: a BEFORE DELETE trigger is a real database-level fault, not a mock of our own
  // code, and it lets the final DELETE FROM users genuinely fail mid-transaction. Postgres runs
  // through the exact same inTransaction()/rollback path in lib/db/exec.ts, so this still covers
  // the code the Postgres run shares; it just isn't independently re-proven on that dialect here.
  it.skipIf(dbKind !== 'sqlite')(
    'when the final delete fails, the user row and their saved query / run history survive',
    async () => {
      const owner = await makeUser('atomic-victim@example.com', 'viewer');
      await createSavedQuery({
        name: 'doomed query',
        queryBackend: 'resource-graph',
        rawKql: 'Resources | take 1',
        visibility: 'private',
        ownerId: owner.id,
        ownerEmail: owner.email,
      });
      await recordQueryRun({
        queryBackend: 'resource-graph',
        rawKql: 'Resources | take 1',
        count: 1,
        capped: false,
        truncated: false,
        ownerId: owner.id,
      });
      const personal = await seedPersonalRule(owner.id);

      const triggerName = 'trg_block_delete_for_test';
      await execRaw(`
        CREATE TRIGGER ${triggerName}
        BEFORE DELETE ON users
        WHEN OLD.id = '${owner.id}'
        BEGIN
          SELECT RAISE(ABORT, 'induced failure for atomicity test');
        END
      `);

      try {
        await expect(deleteUser(owner.id)).rejects.toThrow();

        // Every row the transaction touched survived the rollback, not just the user.
        expect(await getUser(owner.id)).not.toBeNull();
        expect(await listSavedQueries(owner.id)).toHaveLength(1);
        expect(await listQueryRuns(owner.id)).toHaveLength(1);
        expect(await listPersonalRules(owner.id)).toHaveLength(1);
        expect(await listPersonalRuleResults(personal.id, owner.id)).toHaveLength(1);
      } finally {
        await execRaw(`DROP TRIGGER IF EXISTS ${triggerName}`);
      }
    },
  );
});

describe('deleteUser: Personal rules go with their owner', () => {
  it('removes the owner\'s Personal rules and their results, and no one else\'s', async () => {
    const owner = await makeUser('personal-owner@example.com', 'editor');
    const other = await makeUser('personal-other@example.com', 'editor');
    const ownerRule = await seedPersonalRule(owner.id, 'Owner rule');
    const otherRule = await seedPersonalRule(other.id, 'Other rule');

    expect(await deleteUser(owner.id)).toBe(true);

    expect(await listPersonalRules(owner.id)).toEqual([]);
    expect(await countRows('personal_rules')).toBe(1);
    expect(await countRows('personal_rule_results')).toBe(1);
    expect(await listPersonalRuleResults(ownerRule.id, owner.id)).toEqual([]);
    expect((await listPersonalRules(other.id)).map(r => r.id)).toEqual([otherRule.id]);
    expect(await listPersonalRuleResults(otherRule.id, other.id)).toHaveLength(1);
  });
});
