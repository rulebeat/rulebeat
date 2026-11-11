/**
 * The subscription list the Subscription scorecard shows (and the trend-point writer is to use):
 * the stored tree's subscription nodes, the subscriptions an enabled rule's scope names and the
 * subscriptions that hold an active finding, deduped without regard to case and shown with the tree's
 * name and case.
 */
import { describe, expect, it } from 'vitest';
import { knownSubscriptions } from '@/lib/known-subscriptions';
import type { HierarchyNode } from '@/lib/management-group-tree';

const T = 'tenant-1';
const node = (id: string, name: string, kind: HierarchyNode['kind'] = 'subscription'): HierarchyNode =>
  ({ tenantId: T, kind, id, name, parentId: null });
const rule = (subscriptions: string[] | undefined, enabled = true) =>
  ({ enabled, scope: { level: 'subscription' as const, ...(subscriptions ? { subscriptions } : {}) } });

describe('knownSubscriptions', () => {
  it('lists the tree\'s subscriptions, the ones an enabled rule names and the ones that hold a finding', () => {
    const list = knownSubscriptions({
      hierarchy: [node('sub-tree', 'From the tree'), node('mg-1', 'A group', 'managementGroup')],
      rules: [rule(['sub-rule'])],
      findingSubscriptions: ['sub-finding'],
    });
    expect(list.map(s => s.id).sort()).toEqual(['sub-finding', 'sub-rule', 'sub-tree']);
  });

  it('leaves out what a disabled rule names, a blank id and the Directory', () => {
    const list = knownSubscriptions({
      hierarchy: [],
      rules: [rule(['sub-off'], false), rule(['directory', ' '])],
      findingSubscriptions: ['', 'sub-on'],
    });
    expect(list.map(s => s.id)).toEqual(['sub-on']);
  });

  it('lists a subscription once however many sources and casings name it, with the tree\'s name and case', () => {
    const list = knownSubscriptions({
      hierarchy: [node('Sub-Mixed', 'Mixed Case')],
      rules: [rule(['sub-mixed'])],
      findingSubscriptions: ['SUB-MIXED', 'sub-mixed'],
    });
    expect(list).toEqual([{ key: 'sub-mixed', id: 'Sub-Mixed', name: 'Mixed Case' }]);
  });

  it('has no name for a subscription the tree does not know, and keeps the first casing seen', () => {
    const list = knownSubscriptions({ hierarchy: [], rules: [rule(['Sub-A'])], findingSubscriptions: ['sub-a'] });
    expect(list).toEqual([{ key: 'sub-a', id: 'Sub-A', name: null }]);
  });
});
