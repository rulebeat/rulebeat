/**
 * What the server decides a posture widget says about its limits, and sends with the summary: the
 * note that applies to the viewer, the rule-scoped note, the measure under a Severity filter, and why
 * there is nothing to count (no access, then no rule that looks at what they hold, then the filter).
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFingerprint } from '@rulebeat/core';
import { db } from '@/lib/db/client';
import { run as execRun } from '@/lib/db/exec';
import { rules as rulesTable } from '@/lib/db/tables';
import { syncScanFindings } from '@/lib/db/findings';
import { computeWidgetSummary } from '@/lib/dashboard-data';
import { NO_ACCESS, buildAccess, type ScopeGrant } from '@/lib/access-model';
import { EVERYONE_LINE, postureEmptyReason, postureLimitNote } from '@/lib/widget-limits';
import type { Finding, RuleScope, Severity } from '@/lib/types';
import { clearRules, resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';

const CATEGORY = 'security';
const window = { mode: 'relative', days: 7 } as const;

async function insertRule(id: string, over: { enabled?: boolean; scope?: RuleScope; tags?: string[]; lastRunStatus?: string } = {}): Promise<void> {
  await execRun(db.insert(rulesTable).values({
    id, name: id, description: 'test rule', category: CATEGORY, severity: 'medium',
    tags: over.tags ? JSON.stringify(over.tags) : null,
    enabled: over.enabled ?? true,
    scope: JSON.stringify(over.scope ?? { level: 'subscription' }),
    resourceTypes: JSON.stringify([]), conditions: JSON.stringify([]),
    rawKql: 'resources | where type == "microsoft.compute/virtualmachines"',
    type: 'custom', lastRunStatus: over.lastRunStatus ?? 'success', kind: 'state', queryBackend: 'resource-graph',
  }));
}

function finding(ruleId: string, severity: Severity = 'medium'): Finding {
  const resourceId = '/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm-1';
  return {
    module: CATEGORY, ruleId, fingerprint: computeFingerprint(ruleId, resourceId), severity, category: CATEGORY,
    resourceId, resourceType: 'microsoft.compute/virtualmachines', resourceName: 'vm-1', subscriptionId: 'sub-1', resourceGroup: 'rg1',
    title: 't', description: 'd', evidence: {}, recommendation: 'r', remediationSteps: [], detectedAt: new Date().toISOString(),
  };
}

const sub = (id: string): ScopeGrant => ({ tenantId: 't', scope: { kind: 'subscription', path: `/subscriptions/${id}` }, role: 'viewer' });
const heldSub1 = buildAccess([sub('sub-1')], 'manual');

beforeEach(async () => {
  await resetDb();
  await clearRules();
});

describe('the limit note on a posture widget', () => {
  it('is the everyone line for Everything', async () => {
    await insertRule('r1');
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, EVERYTHING_ACCESS);
    expect(summary.postureNotes).toEqual([EVERYONE_LINE]);
  });

  it('has W1 in place of the first sentence for anyone below Everything', async () => {
    await insertRule('r1');
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, heldSub1);
    expect(summary.postureNotes).toEqual([postureLimitNote(false)]);
    expect(summary.postureNotes[0]).not.toContain(EVERYONE_LINE.split('. ')[0]);
  });
});

describe('the note on a rule-scoped widget', () => {
  beforeEach(async () => {
    await insertRule('counted');
    await insertRule('disabled', { enabled: false });
  });

  it('counts the selected rules that are disabled, gone, or look at nothing the viewer holds', async () => {
    await insertRule('elsewhere', { scope: { level: 'subscription', subscriptions: ['sub-9'] } });
    const summary = await computeWidgetSummary(
      { ruleIds: ['counted', 'disabled', 'no-such-rule', 'elsewhere'], dateWindow: window }, heldSub1,
    );
    expect(summary.postureNotes).toContain(
      '3 selected rules are not counted because they are disabled, no longer exist, or look at nothing you hold',
    );
  });

  it('says none is counted when every selected rule is left out, and drops the note once one is counted', async () => {
    const none = await computeWidgetSummary({ ruleIds: ['disabled', 'no-such-rule'], dateWindow: window }, EVERYTHING_ACCESS);
    expect(none.postureNotes).toContain('None of the selected rules is counted');

    const some = await computeWidgetSummary({ ruleIds: ['counted'], dateWindow: window }, EVERYTHING_ACCESS);
    expect(some.postureNotes.join('\n')).not.toContain('selected rule');
  });

  it('does not call a selected rule uncounted when a dashboard filter leaves it out', async () => {
    await insertRule('plain');
    const byTag = await computeWidgetSummary({ ruleIds: ['plain'], tags: ['prod'], dateWindow: window }, EVERYTHING_ACCESS);
    expect(byTag.postureNotes).toEqual([EVERYONE_LINE]);

    const byCategory = await computeWidgetSummary({ ruleIds: ['plain'], categories: ['other-category'], dateWindow: window }, EVERYTHING_ACCESS);
    expect(byCategory.postureNotes).toEqual([EVERYONE_LINE]);

    const byScope = await computeWidgetSummary({ ruleIds: ['plain'], subscriptions: ['sub-9'], dateWindow: window }, EVERYTHING_ACCESS);
    expect(byScope.postureNotes).toEqual([EVERYONE_LINE]);
  });

  it('does not call a selected Activity rule uncounted', async () => {
    await insertRule('activity');
    await execRun(db.update(rulesTable).set({ kind: 'activity' }).where(eq(rulesTable.id, 'activity')));
    const summary = await computeWidgetSummary({ ruleIds: ['activity'], dateWindow: window }, EVERYTHING_ACCESS);
    expect(summary.postureNotes.join('\n')).not.toContain('selected rule');
  });

  it('adds nothing without a rule selection', async () => {
    const summary = await computeWidgetSummary({ dateWindow: window }, EVERYTHING_ACCESS);
    expect(summary.postureNotes).toEqual([EVERYONE_LINE]);
  });
});

describe('the measure under a Severity filter', () => {
  it('names the picked severities, and is absent without the filter', async () => {
    await insertRule('r1');
    const filtered = await computeWidgetSummary({ severities: ['critical', 'high'], dateWindow: window }, EVERYTHING_ACCESS);
    expect(filtered.measure).toBe('Rules with no Critical or High finding');

    const plain = await computeWidgetSummary({ dateWindow: window }, EVERYTHING_ACCESS);
    expect(plain.measure).toBeNull();
  });
});

describe('why there is nothing to count', () => {
  it('is nothing when a rule is counted', async () => {
    await insertRule('r1');
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, EVERYTHING_ACCESS);
    expect(summary.current.totalRules).toBe(1);
    expect(summary.emptyReason).toBeNull();
  });

  it('puts no access first, even when rules exist and a filter is set', async () => {
    await insertRule('r1');
    const summary = await computeWidgetSummary({ tags: ['nothing'], dateWindow: window }, NO_ACCESS);
    expect(summary.emptyReason).toEqual(postureEmptyReason('no-access'));
  });

  it('says no rule looks at what the viewer holds when every enabled rule looks elsewhere', async () => {
    await insertRule('r1', { scope: { level: 'subscription', subscriptions: ['sub-9'] } });
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, heldSub1);
    expect(summary.emptyReason).toEqual(postureEmptyReason('no-rules-here'));
  });

  it('says there are no enabled rules to someone on Everything when none is enabled', async () => {
    await insertRule('r1', { enabled: false });
    const summary = await computeWidgetSummary({ categories: [CATEGORY], dateWindow: window }, EVERYTHING_ACCESS);
    expect(summary.emptyReason).toEqual(postureEmptyReason('no-enabled-rules'));
  });

  it('says the filter left nothing when rules the viewer holds exist but the filter excludes them', async () => {
    await insertRule('r1', { tags: ['pci'] });
    const summary = await computeWidgetSummary({ tags: ['other'], dateWindow: window }, heldSub1);
    expect(summary.emptyReason).toEqual(postureEmptyReason('filter-left-nothing'));
  });
});

describe('each category in the summary', () => {
  it('carries its unknown count and, with no counted rule, the short label for the viewer', async () => {
    await insertRule('proven');
    await insertRule('never-run', { lastRunStatus: 'failed' });
    await insertRule('has-finding');
    await syncScanFindings({
      scanId: 's1', category: CATEGORY, ranRuleIds: ['proven', 'never-run', 'has-finding'],
      findings: [finding('has-finding')], finishedAt: new Date().toISOString(),
    });

    const everything = await computeWidgetSummary({ dateWindow: window }, EVERYTHING_ACCESS);
    const security = everything.perCategory.find(c => c.category === CATEGORY)!;
    expect(security).toMatchObject({ passing: 1, total: 3, unknown: 1, emptyLabel: null });
    const empty = everything.perCategory.find(c => c.total === 0)!;
    expect(empty.emptyLabel).toBe('No enabled rules');

    const scoped = await computeWidgetSummary({ dateWindow: window }, buildAccess([sub('sub-9')], 'manual'));
    const hidden = scoped.perCategory.find(c => c.category === CATEGORY)!;
    expect(hidden.total).toBe(3);
    expect(scoped.perCategory.find(c => c.total === 0)!.emptyLabel).toBe('No rules here look at anything you hold');
  });
});
