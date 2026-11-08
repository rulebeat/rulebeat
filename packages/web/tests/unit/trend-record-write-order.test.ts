/**
 * The record lock is taken last (ADR 0012, conventions/data.md): the recount of a rule write comes after every
 * other row the same transaction writes. A mock around `recountTrend()` reads, through the transaction it was
 * given, what that transaction has written by the time the record is written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@rulebeat/core';
import { many } from '@/lib/db/exec';
import { libraryRequests, personalRules } from '@/lib/db/tables';
import type { DbHandle } from '@/lib/db/exec';

interface Seen { requestStatuses: string[]; personalLibraryRuleIds: (string | null)[] }
const seen: Seen[] = [];

vi.mock('@/lib/db/trend-record', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/db/trend-record')>();
  return {
    ...original,
    recountTrend: async (tx: DbHandle, opts?: Parameters<typeof original.recountTrend>[1]) => {
      seen.push({
        requestStatuses: (await many(tx.select({ status: libraryRequests.status }).from(libraryRequests))).map(r => r.status),
        personalLibraryRuleIds: (await many(tx.select({ id: personalRules.libraryRuleId }).from(personalRules))).map(r => r.id),
      });
      return original.recountTrend(tx, opts);
    },
  };
});

const { createUser } = await import('@/lib/db/users');
const { createPersonalRule } = await import('@/lib/db/personal-rules');
const { approveLibraryRequest, copyPersonalRuleToLibrary, createLibraryRequest } = await import('@/lib/db/library-requests');
const { clearRules, resetDb } = await import('../helpers/db');
type PersonalRuleDefinition = import('@/lib/db/personal-rules').PersonalRuleDefinition;

const KQL = 'resources | where type =~ "microsoft.compute/virtualmachines" | project id, name, type, location, resourceGroup, subscriptionId';
let counter = 0;
const definition = (): PersonalRuleDefinition => ({
  name: `ordered ${++counter} ${Math.random().toString(36).slice(2)}`, description: 'd', category: 'security', severity: 'high',
  queryBackend: 'resource-graph', kind: 'state', tags: [], scope: { level: 'subscription', subscriptions: ['sub-1'] },
  resourceTypes: [], conditions: [], rawKql: KQL,
});

async function author(): Promise<string> {
  const created = await createUser({ email: `order-${Math.random().toString(36).slice(2)}@example.com`, role: 'admin' });
  if ('error' in created) throw new Error(created.error);
  return created.user.id;
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
  seen.length = 0;
});

describe('the record is written last', () => {
  it('approving a new-rule request closes the request and links the Personal rule before the recount', async () => {
    const authorId = await author();
    const personal = await createPersonalRule(authorId, definition());
    const created = await createLibraryRequest(personal, authorId);
    if (!created.ok) throw new Error('could not send');
    seen.length = 0;

    const approved = await approveLibraryRequest(created.request.id, authorId, {});

    if (!approved.ok) throw new Error('could not approve');
    expect(seen).toHaveLength(1);
    expect(seen[0].requestStatuses).toEqual(['approved']);
    expect(seen[0].personalLibraryRuleIds).toEqual([approved.rule.id]);
  });

  it('approving an update request closes the request before the recount', async () => {
    const authorId = await author();
    const target: Rule = {
      id: globalThis.crypto.randomUUID(), name: `target ${Math.random().toString(36).slice(2)}`, description: 'd', category: 'security',
      severity: 'high', enabled: true, type: 'custom', scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: KQL,
      queryBackend: 'resource-graph', kind: 'state',
    };
    const { createRule } = await import('@/lib/rules');
    await createRule(target);
    const personal = await createPersonalRule(authorId, { ...definition(), name: target.name, severity: 'low' });
    const created = await createLibraryRequest(personal, authorId, undefined, target.id);
    if (!created.ok) throw new Error('could not send');
    seen.length = 0;

    const approved = await approveLibraryRequest(created.request.id, authorId, {});

    expect(approved.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].requestStatuses).toEqual(['approved']);
    expect(seen[0].personalLibraryRuleIds).toEqual([target.id]);
  });

  it('copying a Personal rule into the Library links the Personal rule before the recount', async () => {
    const authorId = await author();
    const personal = await createPersonalRule(authorId, definition());

    const copied = await copyPersonalRuleToLibrary(personal);

    if (!copied.ok) throw new Error('could not copy');
    expect(seen).toHaveLength(1);
    expect(seen[0].personalLibraryRuleIds).toEqual([copied.rule.id]);
  });
});

