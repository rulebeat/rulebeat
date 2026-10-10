/**
 * ADR 0007: grouping by subscription. The database holds subscription ids and nothing else about a
 * subscription (its display name is read live from Azure, in the browser), so the server lists the
 * groups in subscription id order and labels each with its id. The explorer then shows each group
 * under its name, but it cannot reorder a page of groups it was sent, so the order on screen is the id
 * order and not the name order. These two subscriptions are ordered one way by id and the other way by
 * any name that would be given to them ("Zulu" for the first, "Alpha" for the second).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';
import { emptyView, type View } from '@/lib/finding-view';
import { queryGroup, queryView } from '@/lib/db/finding-views';

const FIRST = '11111111-1111-1111-1111-111111111111'; // would be named "Zulu"
const SECOND = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; // would be named "Alpha"
const RULE = 'sub-groups-rule';

beforeAll(async () => {
  await resetDb();
  await storeScan([
    syntheticFinding('vm-a', [{ n: 1 }], { ruleId: RULE, subscriptionId: SECOND }),
    syntheticFinding('vm-b', [{ n: 2 }], { ruleId: RULE, subscriptionId: FIRST }),
    syntheticFinding('vm-c', [{ n: 3 }], { ruleId: RULE, subscriptionId: FIRST }),
  ], { scanId: 'sub-groups-scan', finishedAt: new Date().toISOString() });
});

const grouped = (patch: Partial<View> = {}): View => ({ ...emptyView(), groupBy: ['subscription'], ...patch });
const query = { tab: 'results' as const, showSuppressed: false };

describe('groups by subscription', () => {
  it('come in subscription id order, each labelled with its id', async () => {
    const response = await queryView(grouped(), query);
    expect(response.grouped?.groups.map(g => [g.value, g.label, g.resourceCount])).toEqual([
      [FIRST, FIRST, 2],
      [SECOND, SECOND, 1],
    ]);
  });

  it('reverse with the group sort, still by id', async () => {
    const response = await queryView(grouped({ groupSort: { by: 'value', dir: 'desc' } }), query);
    expect(response.grouped?.groups.map(g => g.value)).toEqual([SECOND, FIRST]);
  });

  it('hold the findings of each subscription when opened', async () => {
    const opened = await queryGroup(grouped(), { ...query, groupPath: [FIRST], groupPage: 1 });
    expect(opened.items.map(i => i.finding.resourceName).sort()).toEqual(['vm-b', 'vm-c']);
  });
});
