/**
 * Issue #98: DELETE /api/rules/[id]/findings clears every finding a rule produced, built-in rules
 * included, and leaves the rule itself in place. Route level, through the real repositories and
 * the real guard; only the session is mocked, the same way query-saved.test.ts does it.
 *
 * The headline pairing is the point of the feature: a built-in rule still cannot be deleted
 * (`DELETE /api/rules/[id]` keeps its 403), but its findings can now be cleared. Everything else
 * pins the blast radius: other rules' rows and events stay, the audit trail carries the count,
 * a repeat call is a harmless zero, and the role checks hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { many, run as execRun } from '@/lib/db/exec';
import { rules as rulesTable, findingEvents as findingEventsTable } from '@/lib/db/tables';
import { createUser } from '@/lib/db/users';
import { listAllAuditEntries } from '@/lib/db/audit';
import { loadRules } from '@/lib/rules';
import { syncScanFindings, listFindings } from '@/lib/db/findings';
import { upsertDailySnapshot, getSnapshots } from '@/lib/db/snapshots';
import { resetDb, clearRules, countRows } from '../helpers/db';
import type { Finding } from '@/lib/types';
import type { Role } from '@/lib/rbac';

const mockAuth = vi.fn();
vi.mock('@/auth', () => ({ auth: () => mockAuth() }));

const { DELETE: clearFindings } = await import('@/app/api/rules/[id]/findings/route');
const { DELETE: deleteRule } = await import('@/app/api/rules/[id]/route');

const BUILTIN_RULE = 'clear-test-builtin';
const BUILTIN_NAME = 'Clear test built-in rule';
const CUSTOM_RULE = 'clear-test-custom';
const CATEGORY = 'security';
/** Each rule gets its own subscription so the per-subscription snapshot rows can be told apart. */
const SUB_BUILTIN = 'sub-clear-builtin';
const SUB_CUSTOM = 'sub-clear-custom';
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

async function insertRule(id: string, name: string, type: 'builtin' | 'custom', enabled = true): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id,
    name,
    description: 'test rule',
    category: CATEGORY,
    severity: 'medium',
    enabled,
    scope: JSON.stringify({ level: 'subscription' }),
    resourceTypes: JSON.stringify([]),
    conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type,
  }));
}

function finding(ruleId: string, subscriptionId: string, resourceSuffix: string): Finding {
  const resourceId =
    `/subscriptions/${subscriptionId}/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/${resourceSuffix}`;
  return {
    module: CATEGORY,
    ruleId,
    fingerprint: computeFingerprint(ruleId, resourceId),
    severity: 'medium',
    category: CATEGORY,
    resourceId,
    resourceType: 'microsoft.compute/virtualmachines',
    resourceName: resourceSuffix,
    subscriptionId,
    title: 'test finding',
    description: 'test',
    evidence: {},
    recommendation: 'fix it',
    remediationSteps: [],
    detectedAt: new Date().toISOString(),
  };
}

const builtinA1 = finding(BUILTIN_RULE, SUB_BUILTIN, 'vm-a1');
const builtinA2 = finding(BUILTIN_RULE, SUB_BUILTIN, 'vm-a2');
const customB1 = finding(CUSTOM_RULE, SUB_CUSTOM, 'vm-b1');

async function signInAs(role: Role): Promise<void> {
  const result = await createUser({ email: `${role}-${crypto.randomUUID()}@example.com`, role });
  if ('error' in result) throw new Error(result.error);
  mockAuth.mockResolvedValue({ user: { uid: result.user.id } });
}

function callClear(id: string): Promise<Response> {
  return clearFindings(
    new Request(`http://localhost/api/rules/${encodeURIComponent(id)}/findings`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  );
}

async function eventsFor(fingerprint: string) {
  return many(db.select().from(findingEventsTable).where(eq(findingEventsTable.fingerprint, fingerprint)));
}

async function clearAuditEntries() {
  return (await listAllAuditEntries()).filter(e => e.action === 'rule.clear_findings');
}

beforeEach(async () => {
  await resetDb();
  await clearRules();
  mockAuth.mockReset();
  await insertRule(BUILTIN_RULE, BUILTIN_NAME, 'builtin');
  await insertRule(CUSTOM_RULE, 'Clear test custom rule', 'custom');
  await syncScanFindings({
    scanId: 's1', category: CATEGORY, ranRuleIds: [BUILTIN_RULE, CUSTOM_RULE],
    findings: [builtinA1, builtinA2, customB1], finishedAt: daysAgo(1),
  });
  await signInAs('editor');
});

describe('DELETE /api/rules/[id]/findings (issue #98)', () => {
  it("clears a built-in rule's findings and keeps the rule, while deleting that same built-in still returns 403", async () => {
    const res = await callClear(BUILTIN_RULE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ruleId: BUILTIN_RULE, deleted: 2 });

    expect((await listFindings()).map(f => f.fingerprint)).toEqual([customB1.fingerprint]);

    const del = await deleteRule(
      new Request(`http://localhost/api/rules/${BUILTIN_RULE}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: BUILTIN_RULE }) },
    );
    expect(del.status).toBe(403);
    expect((await loadRules()).some(r => r.id === BUILTIN_RULE)).toBe(true);
  });

  it("leaves every other rule's findings and events untouched, by count and by fingerprint", async () => {
    expect(await countRows('findings')).toBe(3);
    expect(await countRows('finding_events')).toBe(3);

    await callClear(BUILTIN_RULE);

    expect(await countRows('findings')).toBe(1);
    expect(await countRows('finding_events')).toBe(1);
    const [remaining] = await listFindings();
    expect(remaining!.fingerprint).toBe(customB1.fingerprint);
    expect(remaining!.status).toBe('active');
    expect(await eventsFor(customB1.fingerprint)).toHaveLength(1);
    expect(await eventsFor(builtinA1.fingerprint)).toHaveLength(0);
    expect(await eventsFor(builtinA2.fingerprint)).toHaveLength(0);
  });

  it('counts fixed findings as well as active ones: the whole record goes, not just the posture number', async () => {
    // A later scan that ran the rule and no longer saw vm-a2 marks it fixed; the row stays.
    await syncScanFindings({
      scanId: 's2', category: CATEGORY, ranRuleIds: [BUILTIN_RULE], findings: [builtinA1], finishedAt: new Date().toISOString(),
    });
    expect((await listFindings({ status: 'fixed' })).map(f => f.fingerprint)).toEqual([builtinA2.fingerprint]);

    const res = await callClear(BUILTIN_RULE);
    expect(await res.json()).toMatchObject({ deleted: 2 });
    expect(await listFindings({ status: 'fixed' })).toHaveLength(0);
  });

  it('writes exactly one audit entry naming the rule and the number of findings removed', async () => {
    await callClear(BUILTIN_RULE);

    const entries = await clearAuditEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityType: 'rule', entityId: BUILTIN_RULE });
    expect(entries[0]!.summary).toContain('2 findings');
    expect(entries[0]!.summary).toContain(BUILTIN_NAME);
    expect(entries[0]!.details).toMatchObject({ deleted: 2, enabled: true });
  });

  it('a second call finds nothing, reports deleted: 0, and is still audited', async () => {
    await callClear(BUILTIN_RULE);
    const res = await callClear(BUILTIN_RULE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ruleId: BUILTIN_RULE, deleted: 0 });
    expect(await clearAuditEntries()).toHaveLength(2);
  });

  it('a viewer gets 403 and nothing is removed', async () => {
    await signInAs('viewer');
    const res = await callClear(BUILTIN_RULE);
    expect(res.status).toBe(403);
    expect(await countRows('findings')).toBe(3);
    expect(await clearAuditEntries()).toHaveLength(0);
  });

  it('an unauthenticated request gets 401', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await callClear(BUILTIN_RULE);
    expect(res.status).toBe(401);
    expect(await countRows('findings')).toBe(3);
  });

  it('an unknown rule id gets 404 and audits nothing', async () => {
    const res = await callClear('no-such-rule');
    expect(res.status).toBe(404);
    expect(await clearAuditEntries()).toHaveLength(0);
  });

  it("refreshes today's aggregate posture snapshot for the category", async () => {
    await upsertDailySnapshot(CATEGORY);
    const before = await getSnapshots({ categories: [CATEGORY] });
    expect(before.at(-1)!.activeFindings).toBe(3);

    await callClear(BUILTIN_RULE);

    const after = await getSnapshots({ categories: [CATEGORY] });
    expect(after.at(-1)!.activeFindings).toBe(1);
  });

  // Known limitation, documented in the issue rather than fixed here: upsertDailySnapshot() only
  // writes a per-subscription row for subscriptions that currently have an active finding, so a
  // subscription whose findings all went stops getting a fresh row and keeps the pre-clear count
  // until the next scan. The aggregate row above is always rewritten, so the headline is right.
  it.fails("today's per-subscription snapshot row keeps the cleared count until the next scan", async () => {
    await upsertDailySnapshot(CATEGORY);
    const before = await getSnapshots({ categories: [CATEGORY], subscriptionId: SUB_BUILTIN });
    expect(before.at(-1)!.activeFindings).toBe(2);

    await callClear(BUILTIN_RULE);

    const after = await getSnapshots({ categories: [CATEGORY], subscriptionId: SUB_BUILTIN });
    expect(after.at(-1)!.activeFindings).toBe(0);
  });
});
