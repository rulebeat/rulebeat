/**
 * Issue #142: a rule write touches only that rule's row. `createRule`, `updateRule` and `deleteRule`
 * are the repository's per-rule writes; the old shape (load every rule, change one, delete and
 * reinsert them all) let concurrent edits revert each other and threw away a scan's run status.
 *
 * Repository level, through the real database. The route-level interleavings live in
 * rules-route-concurrent-writes.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import type { Rule } from '@rulebeat/core';
import { dbKind } from '@/lib/db/backend';
import { createRule, updateRule, deleteRule, loadRules, setRulesLastRunStatus } from '@/lib/rules';
import { syncScanFindings, listFindings } from '@/lib/db/findings';
import { createUser } from '@/lib/db/users';
import { setPassword } from '@/lib/db/local-accounts';
import { resetDb, countRows, execRaw } from '../helpers/db';
import type { Finding } from '@/lib/types';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { DELETE: deleteRuleRoute } = await import('@/app/api/rules/[id]/route');

const CATEGORY = 'security';

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: globalThis.crypto.randomUUID(),
    name: 'per-rule write test ' + Math.random().toString(36).slice(2),
    description: 'a test rule',
    category: CATEGORY,
    severity: 'medium',
    enabled: true,
    type: 'custom',
    scope: { level: 'subscription' },
    resourceTypes: ['microsoft.compute/virtualmachines'],
    conditions: [],
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    queryBackend: 'resource-graph',
    kind: 'state',
    ...overrides,
  };
}

function finding(ruleId: string, suffix: string): Finding {
  const subscriptionId = 'sub-per-rule-writes';
  const resourceId =
    `/subscriptions/${subscriptionId}/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${suffix}`;
  return {
    module: CATEGORY,
    ruleId,
    fingerprint: computeFingerprint(ruleId, resourceId),
    severity: 'medium',
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: suffix,
    subscriptionId,
    title: 'test finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
  };
}

async function seedFinding(ruleId: string, suffix: string): Promise<void> {
  await syncScanFindings({
    scanId: 'scan-' + suffix,
    category: CATEGORY,
    ranRuleIds: [ruleId],
    findings: [finding(ruleId, suffix)],
    finishedAt: new Date().toISOString(),
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

describe('createRule', () => {
  it('inserts exactly the given rule and leaves every other row alone', async () => {
    const before = await loadRules();
    const rule = makeRule({ tags: ['alpha'] });

    await createRule(rule);

    const after = await loadRules();
    expect(after).toHaveLength(before.length + 1);
    expect(after.find(r => r.id === rule.id)?.tags).toEqual(['alpha']);
    expect(after.filter(r => r.id !== rule.id)).toEqual(before);
  });
});

describe('updateRule', () => {
  it('changes only the fields given and keeps the rest of the row', async () => {
    const rule = makeRule({ tags: ['keep-me'], description: 'original description' });
    await createRule(rule);

    const result = await updateRule(rule.id, { enabled: false });

    expect(result).toMatchObject({ ok: true, rule: expect.objectContaining({ enabled: false }) });
    const stored = (await loadRules()).find(r => r.id === rule.id)!;
    expect(stored).toEqual({ ...rule, enabled: false });
  });

  it('clears a field the caller sets to undefined explicitly', async () => {
    const rule = makeRule({ tags: ['gone'] });
    await createRule(rule);

    await updateRule(rule.id, { tags: undefined });

    expect((await loadRules()).find(r => r.id === rule.id)?.tags).toBeUndefined();
  });

  it('never writes the scan outcome columns, even if the caller passes them', async () => {
    const rule = makeRule();
    await createRule(rule);
    await setRulesLastRunStatus([rule.id], 'failed', '2026-03-01T00:00:00.000Z');

    // A cast, because the type refuses these keys; the repository must refuse them at runtime too.
    await updateRule(rule.id, {
      name: 'renamed',
      lastRunStatus: 'success',
      lastRunAt: '2020-01-01T00:00:00.000Z',
    } as Partial<Rule>);

    const stored = (await loadRules()).find(r => r.id === rule.id)!;
    expect(stored.name).toBe('renamed');
    expect(stored.lastRunStatus).toBe('failed');
    expect(stored.lastRunAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('keeps a scan status written after the caller read the rule', async () => {
    const a = makeRule();
    const b = makeRule();
    await createRule(a);
    await createRule(b);

    // The caller read both rules before the scan finished, then writes one of them.
    const stale = await loadRules();
    expect(stale.find(r => r.id === b.id)?.lastRunStatus).toBeUndefined();

    await setRulesLastRunStatus([a.id, b.id], 'success', '2026-04-01T00:00:00.000Z');
    await updateRule(a.id, { description: 'edited after the scan' });

    const after = await loadRules();
    expect(after.find(r => r.id === a.id)).toMatchObject({
      description: 'edited after the scan',
      lastRunStatus: 'success',
      lastRunAt: '2026-04-01T00:00:00.000Z',
    });
    expect(after.find(r => r.id === b.id)).toMatchObject({
      lastRunStatus: 'success',
      lastRunAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('keeps the derived kind in step when the queryBackend changes', async () => {
    const rule = makeRule();
    await createRule(rule);

    await updateRule(rule.id, { queryBackend: 'log-analytics' });

    const stored = (await loadRules()).find(r => r.id === rule.id)!;
    expect(stored.queryBackend).toBe('log-analytics');
    expect(stored.kind).toBe('activity');
  });

  it('returns a not-found result for an unknown id and writes nothing', async () => {
    const before = await loadRules();
    expect(await updateRule('no-such-rule', { enabled: false })).toEqual({ ok: false, reason: 'not-found' });
    expect(await loadRules()).toEqual(before);
  });
});

describe('deleteRule', () => {
  it('removes the rule, its findings and its finding events, and no other rule', async () => {
    const doomed = makeRule();
    const survivor = makeRule();
    await createRule(doomed);
    await createRule(survivor);
    await seedFinding(doomed.id, 'vm-doomed');
    await seedFinding(survivor.id, 'vm-survivor');

    expect(await deleteRule(doomed.id)).toBe(true);

    const ids = (await loadRules()).map(r => r.id);
    expect(ids).not.toContain(doomed.id);
    expect(ids).toContain(survivor.id);
    const remaining = await listFindings({});
    expect(remaining.map(f => f.ruleId)).toEqual([survivor.id]);
    expect(await countRows('finding_events')).toBe(1);
  });

  it('returns false for an unknown id', async () => {
    expect(await deleteRule('no-such-rule')).toBe(false);
  });
});

// A trigger is the honest seam for "the second half of the delete fails": it makes the database
// itself refuse the finding_events delete, so nothing in the product is stubbed. SQLite syntax only.
describe.skipIf(dbKind === 'pg')('rule delete is one transaction', () => {
  const TRIGGER = 'fail_finding_events_delete';

  beforeEach(async () => {
    await execRaw(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
  });

  async function withFailingEventDelete<T>(fn: () => Promise<T>): Promise<T> {
    await execRaw(
      `CREATE TRIGGER ${TRIGGER} BEFORE DELETE ON finding_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    try {
      return await fn();
    } finally {
      await execRaw(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
    }
  }

  it('deleteRule leaves the rule and its findings in place when clearing the events fails', async () => {
    const rule = makeRule();
    await createRule(rule);
    await seedFinding(rule.id, 'vm-atomic');
    expect(await countRows('finding_events')).toBe(1);

    await expect(withFailingEventDelete(() => deleteRule(rule.id))).rejects.toThrow();

    expect((await loadRules()).map(r => r.id)).toContain(rule.id);
    expect((await listFindings({})).map(f => f.ruleId)).toEqual([rule.id]);
    expect(await countRows('finding_events')).toBe(1);
  });

  it('DELETE /api/rules/[id] leaves the rule in place when clearing its findings fails', async () => {
    const result = await createUser({ email: 'admin@example.com', role: 'admin' });
    if ('error' in result) throw new Error(result.error);
    await setPassword(result.user.id, 'irrelevant-hash', { mustChangePassword: false });
    mockAuth.mockResolvedValue({ user: { uid: result.user.id } });

    const rule = makeRule();
    await createRule(rule);
    await seedFinding(rule.id, 'vm-route-atomic');

    await withFailingEventDelete(async () => {
      try {
        await deleteRuleRoute(
          new Request('http://localhost/api/rules/x', { method: 'DELETE' }),
          { params: Promise.resolve({ id: rule.id }) },
        );
      } catch { /* the failure is the point; the route may throw or answer 500 */ }
    });

    expect((await loadRules()).map(r => r.id)).toContain(rule.id);
    expect((await listFindings({})).map(f => f.ruleId)).toEqual([rule.id]);
  });
});
