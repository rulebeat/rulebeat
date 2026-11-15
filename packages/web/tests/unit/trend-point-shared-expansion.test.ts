/**
 * One queued refresh expands each management group once for all of its categories (ADR 0013's bench), and the
 * points it writes are the ones a fresh expansion per category writes. Written through the real queued writer
 * and read back from the stored points; a tree that changes between two categories' reads is not shared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSnapshotsFor, shareTree, type SharedTree } from '@/lib/db/snapshots';
import { clearRules, execRaw, resetDb } from '../helpers/db';
import { fakeHierarchy, group, refreshFrom, subscription } from '../helpers/fake-hierarchy';
import { allPoints, insertRuleRow, storeFindings, syntheticFinding } from '../helpers/trend-writer';
import type { HierarchyNode } from '@/lib/management-group-tree';

const expansions = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/management-group-tree', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/management-group-tree')>();
  return {
    ...actual,
    expandManagementGroups: (...args: Parameters<typeof actual.expandManagementGroups>) => {
      expansions.calls++;
      return actual.expandManagementGroups(...args);
    },
  };
});

const SUBS = ['0a000000-0000-4000-8000-00000000000a', '0b000000-0000-4000-8000-00000000000b', '0c000000-0000-4000-8000-00000000000c'];
const CATEGORIES = ['security', 'cost', 'compliance'];
const NOW = new Date('2026-03-10T12:00:00.000Z');

async function seed() {
  await resetDb();
  await clearRules();
  await refreshFrom(fakeHierarchy([
    group('top', 'Top', null), group('north', 'North', 'top'),
    subscription(SUBS[0]!, 'A', 'north'), subscription(SUBS[1]!, 'B', 'north'), subscription(SUBS[2]!, 'C', 'top'),
  ]));
  for (const category of CATEGORIES) {
    await insertRuleRow({ id: `${category}-top`, category, managementGroups: ['top'] });
    await insertRuleRow({ id: `${category}-north`, category, managementGroups: ['north'], lastRunStatus: 'failed' });
    await insertRuleRow({ id: `${category}-one`, category, subscriptions: [SUBS[2]!] });
    await storeFindings([syntheticFinding(`${category}-vm`, [{ z: 1 }], { ruleId: `${category}-north`, subscriptionId: SUBS[0]!, severity: 'high' })], { category });
  }
  await execRaw('DELETE FROM posture_snapshots'); // the seeding above refreshed today's points; the tests write their own day
}

/** Every stored point, without the time it was written, in a fixed order. */
async function stored() {
  const out = [];
  for (const category of CATEGORIES) {
    for (const { updatedAt: _ignored, ...point } of await allPoints(category)) out.push(point);
  }
  return out.sort((a, b) => `${a.category}|${a.subscriptionId}|${a.date}`.localeCompare(`${b.category}|${b.subscriptionId}|${b.date}`));
}

beforeEach(async () => { await seed(); expansions.calls = 0; });

describe('the expansion shared across the categories of one refresh', () => {
  it('stores the same points as a fresh expansion for every category', async () => {
    await refreshSnapshotsFor(CATEGORIES, NOW); // one queued call: one shared expansion
    const shared = await stored();
    const sharedExpansions = expansions.calls;
    await execRaw('DELETE FROM posture_snapshots');

    expansions.calls = 0;
    for (const category of CATEGORIES) await refreshSnapshotsFor([category], NOW); // a call each: a fresh expansion each
    const fresh = await stored();

    expect(shared.length).toBeGreaterThan(CATEGORIES.length * 2);
    expect(shared).toEqual(fresh);
    expect(shared.some(p => p.totalRules > 0 && p.subscriptionId !== '')).toBe(true);
    // The tree has two groups the rules name; a fresh expansion per category asks again for each.
    expect(expansions.calls).toBeGreaterThan(sharedExpansions);
    expect(sharedExpansions).toBe(expansions.calls / CATEGORIES.length);
  });
});

describe('sharing the tree read between two categories', () => {
  const node = (over: Partial<HierarchyNode> = {}): HierarchyNode => ({ tenantId: 't', kind: 'subscription', id: 's', name: 'S', parentId: 'g', ...over });

  it('hands back the earlier array when the nodes read are the same', () => {
    const shared: SharedTree = { nodes: null };
    const first = shareTree([node()], shared);
    expect(shareTree([node()], shared)).toBe(first);
  });

  it.each([
    ['moved under another group', { parentId: 'h' }],
    ['renamed', { name: 'Other' }],
    ['another id', { id: 't' }],
    ['another tenant', { tenantId: 'u' }],
    ['another kind', { kind: 'managementGroup' as const }],
  ])('reads the tree in full when a node is %s', (_label, change) => {
    const shared: SharedTree = { nodes: null };
    const first = shareTree([node()], shared);
    const second = shareTree([node(change)], shared);
    expect(second).not.toBe(first);
    expect(second[0]).toMatchObject(change);
  });

  it('reads the tree in full when a node is added or removed', () => {
    const shared: SharedTree = { nodes: null };
    const first = shareTree([node()], shared);
    expect(shareTree([node(), node({ id: 'x' })], shared)).not.toBe(first);
    expect(shareTree([node()], shared)).toHaveLength(1);
  });
});
