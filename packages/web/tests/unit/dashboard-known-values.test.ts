/**
 * What the dashboard bar checks a value against (ADR 0013). Subscriptions come from RuleBeat's own copy of
 * the management group tree, so a subscription that left the tree is called gone for someone holding
 * Everything. Before the tree has ever been read, nothing is known, so nothing is called gone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { loadKnownValues } from '@/lib/dashboard-known-values';
import { buildBarState } from '@/lib/dashboard-bar';
import { dashboardAddress, type DashboardFilters } from '@/lib/finding-view';
import { fakeHierarchy, group, refreshFrom, subscription, HIERARCHY_TENANT as TENANT } from '../helpers/fake-hierarchy';
import { EVERYTHING_ACCESS } from '../helpers/access';

const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';

const SAVED: DashboardFilters = {
  category: [], subscription: [SUB_A, SUB_B], resourceGroup: [], tags: [], rule: [], severity: [],
  window: { mode: 'relative', days: 30 },
};

beforeEach(async () => { await resetDb(); });

describe('the subscriptions the bar knows', () => {
  it('are none before the tree has been read, so nothing is called gone', async () => {
    expect((await loadKnownValues()).subscription).toBeUndefined();
  });

  it('are the subscriptions in the stored tree', async () => {
    await refreshFrom(fakeHierarchy([group(TENANT, 'Root', null), subscription(SUB_A, 'A', TENANT)]));
    expect([...(await loadKnownValues()).subscription!]).toEqual([SUB_A]);
  });

  it('let the bar name a subscription that left the tree, for Everything only', async () => {
    await refreshFrom(fakeHierarchy([group(TENANT, 'Root', null), subscription(SUB_A, 'A', TENANT)]));
    const { state } = buildBarState({
      revision: 1, saved: SAVED, changes: dashboardAddress(SAVED).read(new URLSearchParams('')),
      access: EVERYTHING_ACCESS, widgets: [], known: await loadKnownValues(),
    });
    expect(state.dimensions.subscription.vanished).toEqual([{ value: SUB_B, label: SUB_B, note: 'No longer exists' }]);
  });
});
