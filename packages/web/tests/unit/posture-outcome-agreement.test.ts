/**
 * Live posture and the Rules tab read a rule's Outcome through the same function (#402), so the passing count
 * behind a posture number is exactly the list `outcome=passing` opens, at every Scope. Driven over the real
 * repositories with the rules, scans and findings of one small estate. Every id is fake.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { EVERYTHING_ACCESS } from '../helpers/access';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import type { WidgetFilters } from '@/lib/dashboard-filters';
import { saveRules, setRulesEnabled, setRulesLastRunStatus } from '@/lib/rules';
import { saveScanResult } from '@/lib/scan-history';
import { EVERYTHING_COVERED } from '@/lib/run-scope';
import { computeWidgetSummary as summarise } from '@/lib/dashboard-data';
import { getSnapshots, upsertDailySnapshot } from '@/lib/db/snapshots';
import { listRulesTab } from '@/lib/rules-tab-list';
import { EMPTY_RULES_QUERY } from '@/lib/rules-tab-query';
import { emptySeverityCounts } from '@/lib/severity';
import type { Rule } from '@rulebeat/core';
import type { Finding } from '@/lib/types';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const CATEGORY = 'security';
const T1 = '2026-06-01T01:00:00.000Z';

const ruleOf = (id: string): Rule => ({
  id, name: id, description: 'a test rule', category: CATEGORY, severity: 'medium', enabled: true, type: 'custom',
  scope: { level: 'subscription' }, resourceTypes: [], conditions: [], rawKql: 'resources | project id',
}) as unknown as Rule;

const findingIn = (ruleId: string, subscriptionId: string): Finding =>
  syntheticFinding(`vm-${ruleId}-${subscriptionId.slice(-1)}`, [{ zone: 'a' }], { ruleId, category: CATEGORY, subscriptionId, resourceGroup: 'rg-one' });

/** A finished scan of Everything that reached A and B and ran the rules named. */
async function scan(ranRuleIds: string[], findings: Finding[]): Promise<void> {
  await saveScanResult(CATEGORY, {
    id: 'scan-1', module: CATEGORY, startedAt: T1, finishedAt: T1, durationMs: 1000, subscriptionsScanned: [SUB_A, SUB_B],
    findings, counts: { ...emptySeverityCounts(), medium: findings.length }, totalRules: ranRuleIds.length, triggeredBy: 'manual',
    coverage: 'complete', incompleteRules: [],
  }, { id: 'scan-1', coveredScope: EVERYTHING_COVERED, ranRuleIds });
  await storeScan(findings, { scanId: 'scan-1', category: CATEGORY, finishedAt: T1, ranRuleIds });
}

const WINDOW = { mode: 'relative', days: 7 } as const;
const computeWidgetSummary = (filters: Omit<WidgetFilters, 'dateWindow'>) => summarise({ ...filters, dateWindow: WINDOW }, 7, EVERYTHING_ACCESS);

const passingList = async (subscriptions: string[]) =>
  (await listRulesTab({ ...EMPTY_RULES_QUERY, subscriptions, outcome: 'passing' }, EVERYTHING_ACCESS)).entries.map(e => e.id).sort();

describe('live posture counts passing as the Rules tab does', () => {
  beforeEach(async () => {
    await resetDb();
    // rule-1 fails in A and is clean in B. rule-2 is clean. rule-3 reports a successful last run, yet the only scan
    // came before it was switched on, so no scan has proven it. rule-4 was proven, then switched off and on again.
    await saveRules(['rule-1', 'rule-2', 'rule-3', 'rule-4'].map(ruleOf));
    await scan(['rule-1', 'rule-2', 'rule-4'], [findingIn('rule-1', SUB_A)]);
    await setRulesLastRunStatus(['rule-1', 'rule-2', 'rule-3', 'rule-4'], 'success', T1);
    await setRulesEnabled(['rule-4'], false);
    await setRulesEnabled(['rule-4'], true);
  });

  it('agrees with the list for no Scope', async () => {
    const { current } = await computeWidgetSummary({});
    expect(await passingList([])).toEqual(['rule-2']);
    expect(current.passingRules).toBe(1);
    expect(current.unknownRules).toBe(2);
    expect(current.totalRules).toBe(4);
  });

  it('agrees with the list under one subscription', async () => {
    const { current } = await computeWidgetSummary({ subscriptions: [SUB_B] });
    expect(await passingList([SUB_B])).toEqual(['rule-1', 'rule-2']);
    expect(current.passingRules).toBe(2);
    expect(current.unknownRules).toBe(2);
  });

  it('agrees with the list for each subscription row', async () => {
    const { perSubscription } = await computeWidgetSummary({});
    expect(perSubscription.find(s => s.subscriptionId === SUB_A)?.passingRules).toBe((await passingList([SUB_A])).length);
  });

  it('writes the same passing count into the daily snapshot', async () => {
    await upsertDailySnapshot(CATEGORY);
    const [aggregate] = (await getSnapshots(EVERYTHING_ACCESS, { categories: [CATEGORY], subscriptionId: '' }));
    expect(aggregate!.passingRules).toBe((await passingList([])).length);
    expect(aggregate!.unknownRules).toBe(2);
    const [inA] = await getSnapshots(EVERYTHING_ACCESS, { categories: [CATEGORY], subscriptionId: SUB_A });
    expect(inA!.passingRules).toBe((await passingList([SUB_A])).length);
  });
});

async function computeWidgetSubscriptions() {
  return computeWidgetSummary({});
}
