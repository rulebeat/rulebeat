/**
 * Which finished scan covers a Scope (#402): the one definition the Rules tab's Outcome and live posture
 * share. A subscription or resource group is covered by a scan that scanned the subscription, a management
 * group by a scan whose covered Scope is at or under it or that scanned a subscription under it (by the
 * stored tree), the Directory by a scan whose covered Scope includes it, and Everything by any scan.
 */
import { describe, expect, it } from 'vitest';
import { parseScope, type Scope } from '@/lib/access-model';
import { EVERYTHING_COVERED, type CoveredEntry } from '@/lib/run-scope';
import { newestCoveringScan, scanCovers, type CoverageScan } from '@/lib/scan-coverage';
import type { HierarchyNode } from '@/lib/management-group-tree';

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const SUB_C = '00000000-0000-0000-0000-00000000000c';

// root > mg-parent > mg-child > SUB_A, mg-parent > SUB_B; SUB_C hangs off another group.
const TREE: HierarchyNode[] = [
  { tenantId: TENANT, kind: 'managementGroup', id: 'mg-root', name: 'Root', parentId: null },
  { tenantId: TENANT, kind: 'managementGroup', id: 'mg-parent', name: 'Parent', parentId: 'mg-root' },
  { tenantId: TENANT, kind: 'managementGroup', id: 'mg-child', name: 'Child', parentId: 'mg-parent' },
  { tenantId: TENANT, kind: 'managementGroup', id: 'mg-other', name: 'Other', parentId: 'mg-root' },
  { tenantId: TENANT, kind: 'subscription', id: SUB_A, name: 'A', parentId: 'mg-child' },
  { tenantId: TENANT, kind: 'subscription', id: SUB_B, name: 'B', parentId: 'mg-parent' },
  { tenantId: TENANT, kind: 'subscription', id: SUB_C, name: 'C', parentId: 'mg-other' },
];

const scope = (path: string): Scope => parseScope(path)!;
const SUBSCRIPTION = (id: string) => scope(`/subscriptions/${id}`);
const GROUP = (id: string) => scope(`/providers/Microsoft.Management/managementGroups/${id}`);
const DIRECTORY = scope('@directory');
const EVERYTHING = scope('/');
const entry = (path: string): CoveredEntry => ({ tenantId: TENANT, path });

function scanOf(over: Partial<CoverageScan> = {}): CoverageScan {
  return { finishedAt: '2026-06-01T01:00:00.000Z', subscriptionsScanned: [], coveredScope: EVERYTHING_COVERED, ...over };
}

describe('scanCovers: a subscription or resource group', () => {
  it('is covered by a scan that scanned the subscription, in any casing', () => {
    const scan = scanOf({ subscriptionsScanned: [SUB_A.toUpperCase()] });
    expect(scanCovers(scan, SUBSCRIPTION(SUB_A), TREE)).toBe(true);
    expect(scanCovers(scan, SUBSCRIPTION(SUB_B), TREE)).toBe(false);
  });

  it('covers a resource group by the subscription it sits in', () => {
    const scan = scanOf({ subscriptionsScanned: [SUB_A] });
    expect(scanCovers(scan, scope(`/subscriptions/${SUB_A}/resourceGroups/rg-one`), TREE)).toBe(true);
    expect(scanCovers(scan, scope(`/subscriptions/${SUB_B}/resourceGroups/rg-one`), TREE)).toBe(false);
  });

  it('is not covered by a scan that scanned nothing, whatever its covered Scope says', () => {
    expect(scanCovers(scanOf({ subscriptionsScanned: [] }), SUBSCRIPTION(SUB_A), TREE)).toBe(false);
  });
});

describe('scanCovers: a management group', () => {
  const group = GROUP('mg-parent');

  it('is covered by a scan whose covered Scope is that group', () => {
    expect(scanCovers(scanOf({ coveredScope: [entry(group.path)] }), group, TREE)).toBe(true);
  });

  it('is covered by a scan whose covered Scope is a group, subscription or resource group under it', () => {
    expect(scanCovers(scanOf({ coveredScope: [entry(GROUP('mg-child').path)] }), group, TREE)).toBe(true);
    expect(scanCovers(scanOf({ coveredScope: [entry(SUBSCRIPTION(SUB_A).path)] }), group, TREE)).toBe(true);
    expect(scanCovers(scanOf({ coveredScope: [entry(`/subscriptions/${SUB_B}/resourceGroups/rg-one`)] }), group, TREE)).toBe(true);
  });

  it('is not covered by a scan whose covered Scope is a group above it, or somewhere else in the tree', () => {
    expect(scanCovers(scanOf({ coveredScope: [entry(GROUP('mg-root').path)] }), group, TREE)).toBe(false);
    expect(scanCovers(scanOf({ coveredScope: [entry(GROUP('mg-other').path)] }), group, TREE)).toBe(false);
    expect(scanCovers(scanOf({ coveredScope: [entry(SUBSCRIPTION(SUB_C).path)] }), group, TREE)).toBe(false);
  });

  it('is covered by a scan that scanned a subscription under it, at any depth, per the stored tree', () => {
    expect(scanCovers(scanOf({ subscriptionsScanned: [SUB_A] }), group, TREE)).toBe(true);
    expect(scanCovers(scanOf({ subscriptionsScanned: [SUB_B] }), group, TREE)).toBe(true);
    expect(scanCovers(scanOf({ subscriptionsScanned: [SUB_C] }), group, TREE)).toBe(false);
  });

  it('is not covered when the tree does not hold the group', () => {
    expect(scanCovers(scanOf({ subscriptionsScanned: [SUB_A] }), GROUP('mg-unknown'), TREE)).toBe(false);
    expect(scanCovers(scanOf({ subscriptionsScanned: [SUB_A] }), group, [])).toBe(false);
  });
});

describe('scanCovers: the Directory and Everything', () => {
  it('covers the Directory when the covered Scope includes it', () => {
    expect(scanCovers(scanOf({ coveredScope: [entry('@directory')] }), DIRECTORY, TREE)).toBe(true);
    expect(scanCovers(scanOf({ coveredScope: [entry(SUBSCRIPTION(SUB_A).path), entry('@directory')] }), DIRECTORY, TREE)).toBe(true);
  });

  it('reads Everything in the covered Scope as including the Directory', () => {
    expect(scanCovers(scanOf({ coveredScope: EVERYTHING_COVERED }), DIRECTORY, TREE)).toBe(true);
  });

  it('does not cover the Directory for a scan of subscriptions only', () => {
    expect(scanCovers(scanOf({ coveredScope: [entry(SUBSCRIPTION(SUB_A).path)], subscriptionsScanned: [SUB_A] }), DIRECTORY, TREE)).toBe(false);
  });

  it('covers Everything with any finished scan, however narrow', () => {
    expect(scanCovers(scanOf({ coveredScope: [entry(SUBSCRIPTION(SUB_A).path)], subscriptionsScanned: [SUB_A] }), EVERYTHING, TREE)).toBe(true);
    expect(scanCovers(scanOf({ subscriptionsScanned: [] }), EVERYTHING, TREE)).toBe(true);
  });
});

describe('newestCoveringScan', () => {
  it('returns the newest scan that covers the Scope, skipping a newer one that does not', () => {
    const old = scanOf({ finishedAt: '2026-06-01T01:00:00.000Z', subscriptionsScanned: [SUB_A] });
    const newer = scanOf({ finishedAt: '2026-06-02T01:00:00.000Z', subscriptionsScanned: [SUB_A, SUB_B] });
    const newest = scanOf({ finishedAt: '2026-06-03T01:00:00.000Z', subscriptionsScanned: [SUB_B] });
    expect(newestCoveringScan([old, newest, newer], SUBSCRIPTION(SUB_A), TREE)).toBe(newer);
    expect(newestCoveringScan([old, newest, newer], SUBSCRIPTION(SUB_B), TREE)).toBe(newest);
    expect(newestCoveringScan([old, newest, newer], SUBSCRIPTION(SUB_C), TREE)).toBeUndefined();
  });
});
