/**
 * #274: which stored filter values sit outside a person's access, and the words that follow from it.
 * Pure functions, so every Scope kind is covered here and the routes only need to prove they call it.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, NO_ACCESS, parseScope, type Access } from '@/lib/access-model';
import {
  filterOutsideDimension, isOutsideAccess, markDashboardConfig, markedDashboard, markedSavedView, markOutsideAccess,
  markSavedViewQuery, outsideAwareLabel, OUTSIDE_ACCESS_LABEL, widgetAccessReason, withOutsideOptions,
} from '@/lib/outside-access';
import type { DashboardConfig } from '@/lib/types';

const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const SUB_THREE = '00000000-0000-0000-0000-00000000000c';
const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';

const holding = (paths: string[], expansion?: { groups: string[]; subscriptions: string[] }): Access =>
  buildAccess(
    paths.map(path => ({ tenantId: 't', scope: parseScope(path)!, role: 'viewer' as const })),
    'manual',
    expansion ? [{ tenantId: 't', path: GROUP, role: 'viewer', ...expansion }] : [],
  );

const NOTHING = { subscriptions: [], resourceGroups: [] };

describe('markOutsideAccess', () => {
  it('marks nothing for Everything', () => {
    expect(markOutsideAccess(everythingAccess('editor'), { subscriptions: [SUB_TWO, 'directory'], resourceGroups: ['rg-x'] })).toEqual(NOTHING);
  });

  it('marks every subscription and resource group for a person who holds no Scope', () => {
    expect(markOutsideAccess(NO_ACCESS, { subscriptions: [SUB_ONE], resourceGroups: ['rg-one'] }))
      .toEqual({ subscriptions: [SUB_ONE], resourceGroups: ['rg-one'] });
  });

  it('leaves a subscription Scope unmarked and marks another subscription', () => {
    const access = holding([`/subscriptions/${SUB_ONE}`]);
    expect(markOutsideAccess(access, { subscriptions: [SUB_ONE, SUB_TWO] }).subscriptions).toEqual([SUB_TWO]);
  });

  it('treats a subscription holding one of their resource groups as inside', () => {
    const access = holding([`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);
    expect(markOutsideAccess(access, { subscriptions: [SUB_ONE, SUB_TWO] }).subscriptions).toEqual([SUB_TWO]);
  });

  it('covers a subscription under a management group at any depth, and not one outside it', () => {
    const access = holding([GROUP], { groups: ['mg-example', 'mg-child'], subscriptions: [SUB_ONE, SUB_TWO] });
    expect(markOutsideAccess(access, { subscriptions: [SUB_ONE, SUB_TWO, SUB_THREE] }).subscriptions).toEqual([SUB_THREE]);
  });

  it('marks a management group Scope the tree does not expand', () => {
    expect(markOutsideAccess(holding([GROUP]), { subscriptions: [SUB_ONE] }).subscriptions).toEqual([SUB_ONE]);
  });

  it('marks the reserved Directory value unless the person holds the Directory Scope', () => {
    expect(markOutsideAccess(holding([`/subscriptions/${SUB_ONE}`]), { subscriptions: ['directory'] }).subscriptions).toEqual(['directory']);
    expect(markOutsideAccess(holding(['@directory']), { subscriptions: ['directory', 'DIRECTORY'] }).subscriptions).toEqual([]);
  });

  it('marks a Directory only person\'s subscription and resource group values', () => {
    expect(markOutsideAccess(holding(['@directory']), { subscriptions: [SUB_ONE], resourceGroups: ['rg-one'] }))
      .toEqual({ subscriptions: [SUB_ONE], resourceGroups: ['rg-one'] });
  });

  it('marks a resource group name unless the person holds a resource group Scope of that name', () => {
    const access = holding([`/subscriptions/${SUB_ONE}/resourceGroups/rg-one`]);
    expect(markOutsideAccess(access, { resourceGroups: ['rg-one', 'rg-two'] }).resourceGroups).toEqual(['rg-two']);
  });

  it('marks no resource group name for a person who holds a whole subscription', () => {
    const access = holding([`/subscriptions/${SUB_ONE}`]);
    expect(markOutsideAccess(access, { resourceGroups: ['rg-one', 'rg-anything'] }).resourceGroups).toEqual([]);
  });

  it('marks no resource group name for a management group Viewer whose group holds a subscription', () => {
    const access = holding([GROUP], { groups: ['mg-example'], subscriptions: [SUB_ONE] });
    expect(markOutsideAccess(access, { resourceGroups: ['rg-anything'] }).resourceGroups).toEqual([]);
  });

  it('ignores case in the comparison and keeps the stored casing in the mark', () => {
    const access = holding([`/SUBSCRIPTIONS/${SUB_ONE.toUpperCase()}/RESOURCEGROUPS/RG-ONE`]);
    expect(markOutsideAccess(access, { subscriptions: [SUB_ONE, SUB_TWO.toUpperCase()], resourceGroups: ['Rg-One', 'Rg-Two'] }))
      .toEqual({ subscriptions: [SUB_TWO.toUpperCase()], resourceGroups: ['Rg-Two'] });
  });

  it('lists each marked value once', () => {
    expect(markOutsideAccess(NO_ACCESS, { subscriptions: [SUB_ONE, SUB_ONE] }).subscriptions).toEqual([SUB_ONE]);
  });
});

describe('marking what a saved view and a dashboard store', () => {
  const oneSub = holding([`/subscriptions/${SUB_ONE}`]);

  it('marks a saved view\'s subscription filter and returns the stored query unchanged', () => {
    const view = { id: 'v', query: `subscription=${SUB_TWO}&severity=high` };
    expect(markedSavedView(oneSub, view)).toEqual({ ...view, outsideAccess: { subscriptions: [SUB_TWO], resourceGroups: [] } });
  });

  it('never marks a category, tag, severity or rule filter', () => {
    const query = 'category=security&tag=x&severity=high&rule=matrix-rule';
    expect(markSavedViewQuery(NO_ACCESS, query)).toEqual(NOTHING);
  });

  it('marks a saved view\'s resource group filter', () => {
    expect(markSavedViewQuery(NO_ACCESS, 'rg=rg-two').resourceGroups).toEqual(['rg-two']);
  });

  const config: DashboardConfig = {
    filters: { subscriptions: [SUB_TWO] },
    widgets: [{ id: 'w', type: 'stat-card', layout: { x: 0, y: 0, w: 1, h: 1 }, config: { resourceGroups: ['rg-two'], subscriptions: [SUB_ONE] } }],
  } as unknown as DashboardConfig;

  it('marks the dashboard filter and every widget override, and returns the config unchanged', () => {
    const dashboard = { id: 'd', config };
    const result = markedDashboard(oneSub, dashboard);
    expect(result.outsideAccess).toEqual({ subscriptions: [SUB_TWO], resourceGroups: [] });
    expect(result.config).toBe(config);
    expect(markDashboardConfig(NO_ACCESS, config)).toEqual({ subscriptions: [SUB_TWO, SUB_ONE], resourceGroups: ['rg-two'] });
  });

  it('marks nothing on a dashboard with no filter, and nothing for Everything', () => {
    expect(markDashboardConfig(NO_ACCESS, { widgets: [] } as unknown as DashboardConfig)).toEqual(NOTHING);
    expect(markDashboardConfig(everythingAccess('admin'), config)).toEqual(NOTHING);
  });
});

describe('what a mark reads as', () => {
  const marks = { subscriptions: [SUB_TWO], resourceGroups: ['rg-two'] };

  it('looks a value up without regard to case', () => {
    expect(isOutsideAccess(marks, 'subscription', SUB_TWO.toUpperCase())).toBe(true);
    expect(isOutsideAccess(marks, 'subscription', SUB_ONE)).toBe(false);
    expect(isOutsideAccess(undefined, 'resourceGroup', 'rg-two')).toBe(false);
  });

  it('reads "Outside your access" for a marked value, with neither its id nor its name', () => {
    expect(outsideAwareLabel(marks, 'subscription', SUB_TWO, () => 'Subscription Two')).toBe(OUTSIDE_ACCESS_LABEL);
    expect(outsideAwareLabel(marks, 'subscription', SUB_ONE, () => 'Subscription One')).toBe('Subscription One');
  });

  it('keeps a marked value selectable so it can be cleared', () => {
    const options = withOutsideOptions([{ value: SUB_ONE, label: 'One' }], [SUB_TWO, SUB_ONE], marks, 'subscription');
    expect(options).toEqual([{ value: SUB_ONE, label: 'One' }, { value: SUB_TWO, label: OUTSIDE_ACCESS_LABEL }]);
    expect(withOutsideOptions([], [SUB_TWO], undefined, 'subscription')).toEqual([]);
  });
});

describe('which empty state a filter leads to', () => {
  const marks = { subscriptions: [SUB_TWO], resourceGroups: ['rg-two'] };

  it('names access when every subscription value is marked, or every resource group value is', () => {
    expect(filterOutsideDimension({ subscriptions: [SUB_TWO] }, marks)).toBe('subscription');
    expect(filterOutsideDimension({ resourceGroups: ['rg-two'] }, marks)).toBe('resourceGroup');
  });

  it('does not when one value is inside, or when the filter names nothing', () => {
    expect(filterOutsideDimension({ subscriptions: [SUB_TWO, SUB_ONE] }, marks)).toBeNull();
    expect(filterOutsideDimension({ subscriptions: [] }, marks)).toBeNull();
    expect(filterOutsideDimension({}, marks)).toBeNull();
    expect(filterOutsideDimension({ subscriptions: [SUB_TWO] }, undefined)).toBeNull();
  });

  it('gives a widget an access reason and no other widget one', () => {
    expect(widgetAccessReason({ subscriptions: [SUB_TWO] }, marks)?.title).toBe(OUTSIDE_ACCESS_LABEL);
    expect(widgetAccessReason({ subscriptions: [SUB_TWO] }, marks)?.detail).toContain('subscriptions');
    expect(widgetAccessReason({ resourceGroups: ['rg-two'] }, marks)?.detail).toContain('resource groups');
    expect(widgetAccessReason({ subscriptions: [SUB_ONE] }, marks)).toBeNull();
  });
});
