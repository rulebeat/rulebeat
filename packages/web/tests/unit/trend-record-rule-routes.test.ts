/**
 * A failed trend record write fails the rule action (ADR 0012): the route answers through `serverError()` with
 * its stable message, and the rule, its findings and the record are as they were. The record write is made to
 * fail at the trend-record module's recount, the one function every rule write calls; everything else is the
 * real route, repository and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type { Rule } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { many, run } from '@/lib/db/exec';
import { findings as findingsTable, trendRuleFacts } from '@/lib/db/tables';
import { createUser } from '@/lib/db/users';
import { createRule, loadRule, loadRules } from '@/lib/rules';
import { clearRules, resetDb } from '../helpers/db';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: async () => { throw new Error('not configured in this test file'); },
}));

const record = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/db/trend-record', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db/trend-record')>('@/lib/db/trend-record');
  return {
    ...actual,
    recountTrend: (...args: Parameters<typeof actual.recountTrend>) =>
      record.fail ? Promise.reject(new Error('tenant 00000000-aaaa record write failed')) : actual.recountTrend(...args),
  };
});

const rulesRoute = await import('@/app/api/rules/route');
const itemRoute = await import('@/app/api/rules/[id]/route');
const duplicateRoute = await import('@/app/api/rules/[id]/duplicate/route');
const bulkRoute = await import('@/app/api/rules/bulk/route');
const clearRoute = await import('@/app/api/rules/[id]/findings/route');

const KQL = 'resources | where type == "microsoft.compute/virtualmachines"';
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body?: unknown) => new Request('http://localhost/api/rules', {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

let counter = 0;
function ruleBody(over: Partial<Rule> = {}): Omit<Rule, 'id'> {
  return {
    name: `route rule ${++counter} ${Math.random().toString(36).slice(2)}`, description: 'a test rule', category: 'security', severity: 'medium',
    enabled: true, type: 'custom', scope: { level: 'subscription' }, resourceTypes: ['microsoft.compute/virtualmachines'], conditions: [],
    rawKql: KQL, ...over,
  };
}

async function existingRule(over: Partial<Rule> = {}): Promise<Rule> {
  const rule = { id: globalThis.crypto.randomUUID(), ...ruleBody(over) };
  const created = await createRule(rule);
  if (!created.ok) throw new Error('could not create');
  return created.rule;
}

/** The stable answer, with nothing of the error that caused it. */
async function expectServerError(res: Response, operation: string): Promise<void> {
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: `${operation}. Check the RuleBeat server logs for details.` });
}

const factCount = async () => (await many(db.select().from(trendRuleFacts).orderBy(asc(trendRuleFacts.seq)))).length;

beforeEach(async () => {
  await resetDb();
  await clearRules();
  record.fail = false;
  mockAuth.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const created = await createUser({ email: 'admin@example.com', role: 'admin' });
  if ('error' in created) throw new Error(created.error);
  mockAuth.mockResolvedValue({ user: { uid: created.user.id } });
});

describe('a rule route whose record write fails', () => {
  it('creates no rule', async () => {
    const body = ruleBody();
    record.fail = true;

    await expectServerError(await rulesRoute.POST(json('POST', body)), 'Could not create the rule');

    expect((await loadRules()).filter(r => r.name === body.name)).toEqual([]);
  });

  it('leaves the rule unchanged on an edit', async () => {
    const rule = await existingRule();
    const before = await factCount();
    record.fail = true;

    await expectServerError(await itemRoute.PUT(json('PUT', ruleBody({ name: rule.name, severity: 'critical', enabled: false })), idParams(rule.id)), 'Could not update the rule');

    expect(await loadRule(rule.id)).toEqual(rule);
    expect(await factCount()).toBe(before);
  });

  it('keeps the rule and its findings on a delete', async () => {
    const rule = await existingRule();
    await run(db.insert(findingsTable).values({
      fingerprint: 'fp-route-1', ruleId: rule.id, category: 'security', severity: 'high', kind: 'state', subscriptionId: 'sub-1',
      placement: 'resource', title: 't', status: 'active', firstSeenAt: '2026-03-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z',
    }));
    record.fail = true;

    await expectServerError(await itemRoute.DELETE(json('DELETE'), idParams(rule.id)), 'Could not delete the rule');

    expect(await loadRule(rule.id)).toEqual(rule);
    expect(await many(db.select().from(findingsTable).where(eq(findingsTable.ruleId, rule.id)))).toHaveLength(1);
  });

  it('adds no copy on a duplicate', async () => {
    const rule = await existingRule();
    record.fail = true;

    await expectServerError(await duplicateRoute.POST(json('POST'), idParams(rule.id)), 'Could not duplicate the rule');

    expect(await loadRules()).toHaveLength(1);
  });

  it('keeps the findings on a clear', async () => {
    const rule = await existingRule();
    await run(db.insert(findingsTable).values({
      fingerprint: 'fp-route-2', ruleId: rule.id, category: 'security', severity: 'high', kind: 'state', subscriptionId: 'sub-1',
      placement: 'resource', title: 't', status: 'active', firstSeenAt: '2026-03-01T00:00:00.000Z', lastSeenAt: '2026-03-01T00:00:00.000Z',
    }));
    record.fail = true;

    await expectServerError(await clearRoute.DELETE(json('DELETE'), idParams(rule.id)), 'Could not clear the rule\'s findings');

    expect(await many(db.select().from(findingsTable).where(eq(findingsTable.ruleId, rule.id)))).toHaveLength(1);
  });

  it('undoes both lists of a bulk toggle', async () => {
    const off = await existingRule({ enabled: false });
    const on = await existingRule({ enabled: true });
    record.fail = true;

    await expectServerError(await bulkRoute.PATCH(json('PATCH', { enable: [off.id], disable: [on.id] })), 'Could not update the rules');

    expect((await loadRule(off.id))!.enabled).toBe(false);
    expect((await loadRule(on.id))!.enabled).toBe(true);
  });

  it('answers as before once the record write works again', async () => {
    const rule = await existingRule();
    record.fail = true;
    await itemRoute.PUT(json('PUT', ruleBody({ name: rule.name, severity: 'critical' })), idParams(rule.id));
    record.fail = false;

    const res = await itemRoute.PUT(json('PUT', ruleBody({ name: rule.name, severity: 'critical' })), idParams(rule.id));

    expect(res.status).toBe(200);
    expect((await loadRule(rule.id))!.severity).toBe('critical');
  });
});
