/**
 * #276: what a run covers. The pure half (`lib/run-scope.ts`): the covered Scope of a runner, the request a
 * rule is sent with, and the in-memory test of "is this finding inside the covered Scope", which has to
 * agree exactly with `accessFilterSql()` for every placement.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, parseScope, type Access, type ManagementGroupExpansion } from '@/lib/access-model';
import {
  coveredAccess, coveredScopeKey, coveredScopeOf, coversDirectory, coversWorkspace, EVERYTHING_COVERED, insideCovered, labelCoveredScope,
  sameCoveredScope, scopeForRule, subscriptionsAskedFor, type RequestScope,
} from '@/lib/run-scope';
import { parseCoveredScope, serializeCoveredScope } from '@/lib/covered-scope-view';
import { OUTSIDE_ACCESS_LABEL } from '@/lib/outside-access';
import type { HierarchyNode } from '@/lib/management-group-tree';
import type { Role } from '@/lib/rbac';
import { listFindings } from '@/lib/db/findings';
import { querySnapshot } from '@/lib/db/scan-snapshots';
import { emptySnapshotQuery } from '@/lib/snapshot-query';
import { saveScanResult } from '@/lib/scan-history';
import { emptySeverityCounts } from '@/lib/severity';
import type { Finding } from '@/lib/types';
import { resetDb } from '../helpers/db';
import { storeScan, syntheticFinding } from '../helpers/synthetic-findings';

const T = 'tenant-1';
const SUB_ONE = '00000000-0000-0000-0000-00000000000a';
const SUB_TWO = '00000000-0000-0000-0000-00000000000b';
const SUB_THREE = '00000000-0000-0000-0000-00000000000c';
const mgPath = (name: string) => `/providers/Microsoft.Management/managementGroups/${name}`;
const rgPath = (sub: string, rg: string) => `/subscriptions/${sub}/resourceGroups/${rg}`;

/** root > mg-top > (mg-mid > (SUB_ONE, mg-leaf > SUB_TWO)), and mg-other > SUB_THREE. */
const NODES: HierarchyNode[] = [
  { tenantId: T, kind: 'managementGroup', id: 'root', name: 'Root', parentId: null },
  { tenantId: T, kind: 'managementGroup', id: 'mg-top', name: 'Top', parentId: 'root' },
  { tenantId: T, kind: 'managementGroup', id: 'mg-mid', name: 'Mid', parentId: 'mg-top' },
  { tenantId: T, kind: 'managementGroup', id: 'mg-leaf', name: 'Leaf', parentId: 'mg-mid' },
  { tenantId: T, kind: 'managementGroup', id: 'mg-other', name: 'Other', parentId: 'root' },
  { tenantId: T, kind: 'subscription', id: SUB_ONE, name: 'One', parentId: 'mg-mid' },
  { tenantId: T, kind: 'subscription', id: SUB_TWO, name: 'Two', parentId: 'mg-leaf' },
  { tenantId: T, kind: 'subscription', id: SUB_THREE, name: 'Three', parentId: 'mg-other' },
];

const expansion = (name: string, role: Role, groups: string[], subscriptions: string[]): ManagementGroupExpansion =>
  ({ tenantId: T, path: mgPath(name), role, groups, subscriptions });

/** An access holding `paths` at `role`, with the management group expansions the tree gives them. */
function holding(role: Role, ...paths: string[]): Access {
  const expansions: Record<string, ManagementGroupExpansion> = {
    'mg-top': expansion('mg-top', role, ['mg-top', 'mg-mid', 'mg-leaf'], [SUB_ONE, SUB_TWO]),
    'mg-mid': expansion('mg-mid', role, ['mg-mid', 'mg-leaf'], [SUB_ONE, SUB_TWO]),
    'mg-leaf': expansion('mg-leaf', role, ['mg-leaf'], [SUB_TWO]),
    'mg-other': expansion('mg-other', role, ['mg-other'], [SUB_THREE]),
  };
  const grants = paths.map(p => ({ tenantId: T, scope: parseScope(p)!, role }));
  // A group the tree does not hold expands to nothing, as the real expansion gives it.
  const held = paths.filter(p => p.startsWith(mgPath(''))).map(p => expansions[p.split('/').pop()!] ?? expansion(p.split('/').pop()!, role, [], []));
  return buildAccess(grants, 'manual', held);
}

const rule = (scope: RequestScope | undefined, access: Access): RequestScope | undefined | null => scopeForRule(scope, coveredAccess(access), NODES);

describe('the covered Scope of a runner', () => {
  it('is Everything for someone who holds it at a Role that runs scans', () => {
    expect(coveredScopeOf(everythingAccess('admin'))).toEqual([{ tenantId: '', path: '/' }]);
    expect(coveredScopeOf(holding('editor', '/'))).toEqual([{ tenantId: '', path: '/' }]);
    expect(coveredScopeOf(holding('viewer', '/'))).toEqual([]);
  });

  it('is each Scope held at a Role that runs scans, and nothing a Viewer holds', () => {
    expect(coveredScopeOf(holding('editor', `/subscriptions/${SUB_ONE}`, mgPath('mg-other')))).toEqual([
      { tenantId: T, path: `/subscriptions/${SUB_ONE}` }, { tenantId: T, path: mgPath('mg-other') },
    ]);
    expect(coveredScopeOf(holding('viewer', `/subscriptions/${SUB_ONE}`))).toEqual([]);
    expect(coveredAccess(holding('viewer', `/subscriptions/${SUB_ONE}`)).grants).toEqual([]);
  });

  it('lists a Scope held twice once, and keeps the Directory', () => {
    const twice = buildAccess([
      { tenantId: T, scope: parseScope(`/subscriptions/${SUB_ONE}`)!, role: 'editor' },
      { tenantId: T, scope: parseScope(`/SUBSCRIPTIONS/${SUB_ONE}`)!, role: 'editor' },
      { tenantId: T, scope: parseScope('@directory')!, role: 'editor' },
    ], 'manual');
    expect(coveredScopeOf(twice).map(e => e.path)).toEqual([`/subscriptions/${SUB_ONE}`, '@directory']);
  });

  it('compares two covered Scopes in any order and any casing, and NULL is Everything', () => {
    const a = [{ tenantId: T, path: `/subscriptions/${SUB_ONE}` }, { tenantId: T, path: mgPath('mg-other') }];
    const b = [{ tenantId: T, path: mgPath('MG-OTHER') }, { tenantId: T, path: `/SUBSCRIPTIONS/${SUB_ONE.toUpperCase()}` }];
    expect(sameCoveredScope(a, b)).toBe(true);
    expect(sameCoveredScope(a, [a[0]!])).toBe(false);
    expect(coveredScopeKey(a)).not.toContain(SUB_TWO);
    expect(sameCoveredScope(parseCoveredScope(null), EVERYTHING_COVERED)).toBe(true);
    expect(sameCoveredScope(parseCoveredScope(serializeCoveredScope(a)), a)).toBe(true);
    expect(sameCoveredScope(parseCoveredScope('not json'), EVERYTHING_COVERED)).toBe(false);
  });

  it('labels an entry the reader\'s access does not reach as outside, and never prints its path', () => {
    const entries = [
      { tenantId: T, path: `/subscriptions/${SUB_ONE}` }, { tenantId: T, path: `/subscriptions/${SUB_TWO}` },
      { tenantId: T, path: '@directory' }, { tenantId: '', path: '/' },
    ];
    const reader = holding('viewer', `/subscriptions/${SUB_ONE}`);
    expect(labelCoveredScope(entries, reader)).toEqual([
      { label: `/subscriptions/${SUB_ONE}`, outside: false },
      { label: OUTSIDE_ACCESS_LABEL, outside: true },
      { label: 'Directory', outside: false },
      { label: 'Everything', outside: false },
    ]);
    expect(JSON.stringify(labelCoveredScope(entries, reader))).not.toContain(SUB_TWO);
    expect(labelCoveredScope(entries, everythingAccess('admin')).map(e => e.outside)).toEqual([false, false, false, false]);
  });
});

describe('the request a rule is sent with', () => {
  it('is the rule\'s own scope, untouched, for Everything', () => {
    const own = { subscriptions: [SUB_THREE], managementGroups: ['whatever'] };
    expect(scopeForRule(own, coveredAccess(everythingAccess('admin')), NODES)).toBe(own);
    expect(scopeForRule(undefined, coveredAccess(everythingAccess('admin')), NODES)).toBeUndefined();
  });

  it('gives a tenant-wide rule the whole subscriptions and management groups held, and the subscriptions holding a resource group', () => {
    const access = holding('editor', `/subscriptions/${SUB_ONE}`, mgPath('mg-other'), rgPath(SUB_TWO, 'rg-a'), rgPath(SUB_ONE, 'rg-b'));
    expect(rule(undefined, access)).toEqual({ subscriptions: [SUB_ONE, SUB_TWO], managementGroups: ['mg-other'] });
    expect(rule({}, access)).toEqual(rule(undefined, access));
  });

  it('gives a rule on a management group above a held subscription that subscription', () => {
    const access = holding('editor', `/subscriptions/${SUB_TWO}`);
    expect(rule({ managementGroups: ['mg-top'] }, access)).toEqual({ subscriptions: [SUB_TWO] });
    expect(rule({ managementGroups: ['mg-leaf'] }, access)).toEqual({ subscriptions: [SUB_TWO] });
    expect(rule({ managementGroups: ['mg-other'] }, access)).toBeNull();
  });

  it('gives a rule on a subscription under a held management group that subscription', () => {
    const access = holding('editor', mgPath('mg-mid'));
    expect(rule({ subscriptions: [SUB_TWO] }, access)).toEqual({ subscriptions: [SUB_TWO] });
    expect(rule({ subscriptions: [SUB_THREE] }, access)).toBeNull();
  });

  it('gives a rule on a group beneath a held group that group, and a rule above it the held group', () => {
    expect(rule({ managementGroups: ['mg-leaf'] }, holding('editor', mgPath('mg-top')))).toEqual({ managementGroups: ['mg-leaf'] });
    expect(rule({ managementGroups: ['mg-top'] }, holding('editor', mgPath('mg-leaf')))).toEqual({ managementGroups: ['mg-leaf'] });
    expect(rule({ managementGroups: ['mg-leaf'] }, holding('editor', mgPath('mg-other')))).toBeNull();
  });

  it('keeps a rule\'s subscription for a runner who holds one of its resource groups', () => {
    const access = holding('editor', rgPath(SUB_ONE, 'rg-a'));
    expect(rule({ subscriptions: [SUB_ONE, SUB_TWO] }, access)).toEqual({ subscriptions: [SUB_ONE] });
    expect(rule({ managementGroups: ['mg-top'] }, access)).toEqual({ subscriptions: [SUB_ONE] });
  });

  it('joins what a rule names on both lists, in the rule\'s own casing', () => {
    const access = holding('editor', `/subscriptions/${SUB_ONE}`, `/subscriptions/${SUB_THREE}`);
    expect(rule({ subscriptions: [SUB_THREE.toUpperCase(), SUB_TWO], managementGroups: ['mg-top'] }, access))
      .toEqual({ subscriptions: [SUB_THREE.toUpperCase(), SUB_ONE] });
  });

  it('does not send a group the tree does not know, nor a Viewer\'s Scope', () => {
    expect(rule(undefined, holding('editor', mgPath('mg-unknown')))).toBeNull();
    expect(rule(undefined, holding('viewer', `/subscriptions/${SUB_ONE}`))).toBeNull();
  });

  it('is never an empty scope, whatever the rule and the runner', () => {
    const accesses = [
      holding('editor'), holding('editor', '@directory'), holding('editor', mgPath('mg-leaf')), holding('editor', rgPath(SUB_THREE, 'x')),
      holding('editor', `/subscriptions/${SUB_ONE}`, mgPath('mg-other')), holding('viewer', `/subscriptions/${SUB_ONE}`),
    ];
    const requests: (RequestScope | undefined)[] = [
      undefined, {}, { subscriptions: [] }, { managementGroups: [] }, { subscriptions: [' '] }, { subscriptions: [SUB_ONE] },
      { subscriptions: [SUB_THREE, SUB_TWO] }, { managementGroups: ['mg-top'] }, { managementGroups: ['mg-other', 'nope'] },
      { subscriptions: [SUB_ONE], managementGroups: ['mg-leaf'] },
    ];
    for (const access of accesses) {
      for (const request of requests) {
        const answer = rule(request, access);
        if (answer === null || answer === undefined) continue;
        expect((answer.subscriptions?.length ?? 0) + (answer.managementGroups?.length ?? 0)).toBeGreaterThan(0);
        expect(answer.subscriptions ?? [1]).not.toEqual([]);
        expect(answer.managementGroups ?? [1]).not.toEqual([]);
      }
    }
  });

  it('lists the subscriptions a set of requests asked for, those under a management group included', () => {
    expect(subscriptionsAskedFor([{ subscriptions: [SUB_THREE] }, { managementGroups: ['mg-mid'] }], NODES).sort()).toEqual([SUB_ONE, SUB_TWO, SUB_THREE].sort());
    expect(subscriptionsAskedFor([], NODES)).toEqual([]);
  });
});

describe('the gates on the Directory and the workspace', () => {
  it('covers the Directory only for Everything or a Directory Scope at a Role that runs scans', () => {
    expect(coversDirectory(coveredAccess(everythingAccess('admin')))).toBe(true);
    expect(coversDirectory(coveredAccess(holding('editor', '@directory')))).toBe(true);
    expect(coversDirectory(coveredAccess(holding('viewer', '@directory')))).toBe(false);
    expect(coversDirectory(coveredAccess(holding('editor', `/subscriptions/${SUB_ONE}`)))).toBe(false);
  });

  it('covers a workspace when a Scope covers its resource group, and never one that could not be placed', () => {
    const where = { subscriptionId: SUB_ONE, resourceGroup: 'rg-ws' };
    expect(coversWorkspace(coveredAccess(holding('editor', `/subscriptions/${SUB_ONE}`)), where)).toBe(true);
    expect(coversWorkspace(coveredAccess(holding('editor', rgPath(SUB_ONE, 'RG-WS'))), where)).toBe(true);
    expect(coversWorkspace(coveredAccess(holding('editor', rgPath(SUB_ONE, 'rg-other'))), where)).toBe(false);
    expect(coversWorkspace(coveredAccess(holding('editor', mgPath('mg-mid'))), where)).toBe(true);
    expect(coversWorkspace(coveredAccess(holding('editor', mgPath('mg-other'))), where)).toBe(false);
    expect(coversWorkspace(coveredAccess(holding('editor', `/subscriptions/${SUB_ONE}`)), null)).toBe(false);
    expect(coversWorkspace(coveredAccess(everythingAccess('admin')), null)).toBe(true);
  });
});

describe('the in-memory test agrees with accessFilterSql for every placement', () => {
  const RULE = 'parity-rule';
  const at = { ruleId: RULE };
  const records: Finding[] = [
    syntheticFinding('res-one-a', [{ a: 1 }], { ...at, subscriptionId: SUB_ONE, resourceGroup: 'rg-a' }),
    syntheticFinding('res-one-b', [{ a: 1 }], { ...at, subscriptionId: SUB_ONE, resourceGroup: 'rg-b' }),
    syntheticFinding('res-two-a', [{ a: 1 }], { ...at, subscriptionId: SUB_TWO, resourceGroup: 'rg-a' }),
    syntheticFinding('res-three-a', [{ a: 1 }], { ...at, subscriptionId: SUB_THREE, resourceGroup: 'RG-A' }),
    syntheticFinding('res-one-shouting', [{ a: 1 }], { ...at, subscriptionId: SUB_ONE.toUpperCase(), resourceGroup: 'RG-A' }),
    syntheticFinding('sub-level-one', [{ a: 1 }], { ...at, placement: 'subscription', subscriptionId: SUB_ONE }),
    syntheticFinding('sub-level-two', [{ a: 1 }], { ...at, placement: 'subscription', subscriptionId: SUB_TWO }),
    syntheticFinding('mg-mid-level', [{ a: 1 }], { ...at, placement: 'management-group', managementGroupId: 'mg-mid' }),
    syntheticFinding('mg-leaf-level', [{ a: 1 }], { ...at, placement: 'management-group', managementGroupId: 'MG-LEAF' }),
    syntheticFinding('mg-other-level', [{ a: 1 }], { ...at, placement: 'management-group', managementGroupId: 'mg-other' }),
    syntheticFinding('directory-app', [{ a: 1 }], { ...at, placement: 'directory' }),
    syntheticFinding('workspace-one-a', [{ a: 1 }], { ...at, placement: 'workspace', subscriptionId: SUB_ONE, resourceGroup: 'rg-a' }),
    syntheticFinding('workspace-two-b', [{ a: 1 }], { ...at, placement: 'workspace', subscriptionId: SUB_TWO, resourceGroup: 'rg-b' }),
    syntheticFinding('unplaceable-thing', [{ a: 1 }], { ...at, placement: 'unplaceable' }),
  ];
  const SCAN = '00000000-0000-0000-0000-0000000000e1';

  const ACCESSES: Record<string, Access> = {
    'Everything': everythingAccess('admin'),
    'one subscription': holding('editor', `/subscriptions/${SUB_ONE}`),
    'one subscription in capitals': holding('editor', `/SUBSCRIPTIONS/${SUB_ONE.toUpperCase()}`),
    'one resource group': holding('editor', rgPath(SUB_ONE, 'rg-a')),
    'a resource group in capitals': holding('editor', rgPath(SUB_THREE, 'rg-A')),
    'a subscription and a resource group in another': holding('editor', `/subscriptions/${SUB_ONE}`, rgPath(SUB_TWO, 'rg-b')),
    'a management group with a group beneath it': holding('editor', mgPath('mg-mid')),
    'the leaf management group': holding('editor', mgPath('mg-leaf')),
    'the other management group': holding('editor', mgPath('mg-other')),
    'a management group the tree does not know': holding('editor', mgPath('mg-unknown')),
    'the Directory': holding('editor', '@directory'),
    'the Directory and a subscription': holding('editor', '@directory', `/subscriptions/${SUB_TWO}`),
    'nothing': holding('editor'),
    'a Viewer\'s Scopes only': holding('viewer', `/subscriptions/${SUB_ONE}`),
  };

  beforeAll(async () => {
    await resetDb();
    await storeScan(records, { scanId: SCAN, finishedAt: '2026-06-01T00:00:00.000Z' });
    await saveScanResult('security', {
      id: SCAN, module: 'security', startedAt: '2026-06-01T00:00:00.000Z', finishedAt: '2026-06-01T00:00:00.000Z', durationMs: 1,
      subscriptionsScanned: [], findings: records, counts: emptySeverityCounts(), totalRules: 1, coverage: 'complete', incompleteRules: [],
    }, { id: SCAN });
  });

  for (const [name, access] of Object.entries(ACCESSES)) {
    it(`${name}: the same findings in memory, in the findings table and in a scan's records`, async () => {
      const covered = coveredAccess(access);
      const inside = insideCovered(covered);
      const inMemory = records.filter(inside).map(f => f.fingerprint).sort();

      // The same Access, narrowed to the Roles that run a scan, read through the SQL filter on each table.
      const inFindings = (await listFindings(covered)).map(f => f.fingerprint).sort();
      const answer = await querySnapshot(SCAN, emptySnapshotQuery(), covered);
      const inRecords = answer.status === 'ok' ? answer.response.items.map(i => i.fingerprint).sort() : [];

      expect(inFindings).toEqual(inMemory);
      expect(inRecords).toEqual(inMemory);
    });
  }

  it('is not vacuous: the accesses reach different findings, and Everything reaches all of them', () => {
    const reached = (name: string) => records.filter(insideCovered(coveredAccess(ACCESSES[name]!))).length;
    expect(reached('Everything')).toBe(records.length);
    expect(reached('one subscription')).toBe(5);
    expect(reached('one resource group')).toBe(3);
    expect(reached('a management group with a group beneath it')).toBe(10);
    expect(reached('nothing')).toBe(0);
    expect(reached('a Viewer\'s Scopes only')).toBe(0);
  });
});
