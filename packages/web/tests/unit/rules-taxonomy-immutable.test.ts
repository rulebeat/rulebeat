/**
 * Spec 029 — PUT /api/rules/[id] must never let queryBackend/kind change via edit, even for a
 * custom rule and even when the request body explicitly asks for different values. Those fields
 * are decided once, at creation, and are otherwise immutable — see the "Preserve type/pack/taxonomy"
 * block in app/api/rules/[id]/route.ts. Built-in rules take an entirely separate, earlier code path
 * that never reaches this block at all (only enabled/tags are editable), so this suite exercises a
 * custom rule specifically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { loadRules, saveRules } from '@/lib/rules';
import type { LogAnalyticsQuery, Rule } from '@rulebeat/core';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));
// No rawKql appears in any PUT body below, so the identity probe branch is never entered — this
// mock exists only to prove that, by failing loudly if it ever were.
vi.mock('@/lib/azure-credential', () => ({
  createTenantContext: () => Promise.reject(new Error('should not be called — no rawKql in this test\'s PUT bodies')),
}));

const { PUT } = await import('@/app/api/rules/[id]/route');

const RULE_ID = 'taxonomy-immutable-test';

function putRequest(body: unknown): Request {
  return new Request('http://localhost/api/rules/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function signInAsEditor(): Promise<void> {
  const result = await createUser({ email: 'editor@example.com', role: 'editor' });
  if ('error' in result) throw new Error(result.error);
  await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

// await resetDb() deliberately leaves the rules table alone (it's seeded baseline, not per-test mutable
// state — see tests/helpers/db.ts), so a RULE_ID row inserted by an earlier test in this file
// survives into the next one. Filter it out before inserting the fixture, or a later
// beforeEach hits a UNIQUE constraint on the id when await saveRules() re-inserts everything.
async function seedExistingRule(rule: Rule = existingRule()): Promise<void> {
  await saveRules([...(await loadRules()).filter(r => r.id !== RULE_ID), rule]);
}

// Spec 036 made a body's logsQuery mandatory on any PUT to an existing log-analytics rule (this
// fixture's chosen "non-default backend" example) — every body below needs one or the route 400s
// before ever reaching the taxonomy-immutability logic under test here.
const EXISTING_LOGS_QUERY: LogAnalyticsQuery = { kql: 'SigninLogs | where ResultType != 0', timeWindowDays: 30 };

function existingRule(): Rule {
  return {
    id: RULE_ID,
    name: 'existing custom rule with a non-default taxonomy',
    description: 'a test rule',
    category: 'identity',
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: [],
    conditions: [],
    queryBackend: 'log-analytics',
    kind: 'activity',
    logsQuery: EXISTING_LOGS_QUERY,
  };
}

describe('PUT /api/rules/[id] cannot change queryBackend/kind (spec 029)', () => {
  beforeEach(async () => {
    await resetDb();
    mockAuth.mockReset();
    await signInAsEditor();
    await seedExistingRule();
  });

  it("keeps the existing rule's queryBackend and kind even when the request body asks for different values", async () => {
    const body = {
      id: RULE_ID,
      name: 'renamed but taxonomy should stay pinned',
      description: 'edited',
      category: 'identity',
      severity: 'high',
      enabled: true,
      type: 'custom',
      scope: { level: 'subscription' },
      resourceTypes: [],
      conditions: [],
      queryBackend: 'resource-graph',
      kind: 'state',
      logsQuery: EXISTING_LOGS_QUERY,
    };

    const res = await PUT(putRequest(body), { params: Promise.resolve({ id: RULE_ID }) });
    expect(res.status).toBe(200);

    const saved = (await loadRules()).find(r => r.id === RULE_ID);
    expect(saved?.queryBackend).toBe('log-analytics');
    expect(saved?.kind).toBe('activity');
    // the rest of the edit did go through — this isn't a rejected save, just a pinned taxonomy
    expect(saved?.name).toBe('renamed but taxonomy should stay pinned');
    expect(saved?.severity).toBe('high');
  });
});
