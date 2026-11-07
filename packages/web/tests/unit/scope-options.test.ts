/**
 * #388: the Scope picker's tree. It is the Access page's scope tree limited to what the viewer holds, with the
 * Directory for those who hold it, and the resource groups the findings they see sit in. The words for a pick
 * the latest listing does not know ("Not found in Azure") or could not read (named by id, no mark) are decided
 * here too, so the picker and the dashboard bar cannot word them differently.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, parseScope, type Access, type ScopeGrant } from '@/lib/access-model';
import { expandManagementGroups, type HierarchyNode } from '@/lib/management-group-tree';
import { buildScopeOptions, listedPaths, subscriptionNames } from '@/lib/scope-options';
import { NOT_FOUND_IN_AZURE, scopeChips, type ScopePickState } from '@/lib/filter-states';
import { coveredBy } from '@/lib/scope-tree';

const TENANT = '00000000-0000-0000-0000-0000000000f0';
const SUB_A = '00000000-0000-0000-0000-00000000000a';
const SUB_B = '00000000-0000-0000-0000-00000000000b';
const SUB_C = '00000000-0000-0000-0000-00000000000c';
const group = (id: string, name: string, parentId: string | null): HierarchyNode => ({ tenantId: TENANT, kind: 'managementGroup', id, name, parentId });
const sub = (id: string, name: string, parentId: string): HierarchyNode => ({ tenantId: TENANT, kind: 'subscription', id, name, parentId });
const NODES: HierarchyNode[] = [
  group(TENANT, 'Tenant Root Group', null),
  group('mg-example', 'Example group', TENANT),
  group('mg-child', 'Child group', 'mg-example'),
  sub(SUB_A, 'Sub A', 'mg-example'),
  sub(SUB_B, 'Sub B', 'mg-child'),
  sub(SUB_C, 'Sub C', TENANT),
];
const GROUPS = [
  { subscription: SUB_A, name: 'rg-one' }, { subscription: SUB_A, name: 'rg-two' },
  { subscription: SUB_B, name: 'rg-one' }, { subscription: SUB_C, name: 'rg-three' },
];
const GROUP_PATH = (id: string) => `/providers/Microsoft.Management/managementGroups/${id}`;
const SUB_PATH = (id: string) => `/subscriptions/${id}`;
const LISTED = { lastSuccessAt: '2026-06-01T00:00:00.000Z', lastAttemptAt: '2026-06-01T00:00:00.000Z', error: null };

function holding(...paths: string[]): Access {
  const grants: ScopeGrant[] = paths.map(path => ({ tenantId: TENANT, scope: parseScope(path)!, role: 'viewer' as const }));
  return buildAccess(grants, 'manual', expandManagementGroups(grants, NODES));
}

const shape = (items: { key: string; children?: unknown[] }[]): unknown[] =>
  items.map(i => (i.children?.length ? [i.key, shape(i.children as never)] : i.key));

describe('buildScopeOptions: the held tree', () => {
  it('Everything is shown the whole tree from the tenant root, the Directory first', () => {
    const scopes = buildScopeOptions(everythingAccess('admin'), NODES, LISTED, GROUPS);
    expect(scopes.directory).toBe(true);
    expect(shape(scopes.tree)).toEqual([[GROUP_PATH(TENANT), [
      [GROUP_PATH('mg-example'), [
        [GROUP_PATH('mg-child'), [[SUB_PATH(SUB_B), [`${SUB_PATH(SUB_B)}/resourceGroups/rg-one`]]]],
        [SUB_PATH(SUB_A), [`${SUB_PATH(SUB_A)}/resourceGroups/rg-one`, `${SUB_PATH(SUB_A)}/resourceGroups/rg-two`]],
      ]],
      [SUB_PATH(SUB_C), [`${SUB_PATH(SUB_C)}/resourceGroups/rg-three`]],
    ]]]);
  });

  it('a management group holder sees the group with what sits under it and nothing above or beside it', () => {
    const scopes = buildScopeOptions(holding(GROUP_PATH('mg-child')), NODES, LISTED, GROUPS.filter(g => g.subscription === SUB_B));
    expect(scopes.directory).toBe(false);
    expect(shape(scopes.tree)).toEqual([[GROUP_PATH('mg-child'), [[SUB_PATH(SUB_B), [`${SUB_PATH(SUB_B)}/resourceGroups/rg-one`]]]]]);
    expect(JSON.stringify(scopes)).not.toContain('Tenant Root Group');
    expect(JSON.stringify(scopes)).not.toContain('Sub A');
  });

  it('a subscription holder sees that subscription at the top, with its resource groups', () => {
    const scopes = buildScopeOptions(holding(SUB_PATH(SUB_A)), NODES, LISTED, GROUPS.filter(g => g.subscription === SUB_A));
    expect(shape(scopes.tree)).toEqual([[SUB_PATH(SUB_A), [`${SUB_PATH(SUB_A)}/resourceGroups/rg-one`, `${SUB_PATH(SUB_A)}/resourceGroups/rg-two`]]]);
  });

  it('a resource group holder sees the subscription it sits in, with the group they hold', () => {
    const rg = `${SUB_PATH(SUB_A)}/resourceGroups/rg-one`;
    const scopes = buildScopeOptions(holding(rg), NODES, LISTED, [GROUPS[0]!]);
    expect(shape(scopes.tree)).toEqual([[SUB_PATH(SUB_A), [rg]]]);
  });

  it('keeps a held resource group no finding sits in, so a pick on it is still on the tree', () => {
    const rg = `${SUB_PATH(SUB_A)}/resourceGroups/rg-empty`;
    const scopes = buildScopeOptions(holding(rg), NODES, LISTED, []);
    expect(shape(scopes.tree)).toEqual([[SUB_PATH(SUB_A), [rg]]]);
  });

  it('leaves out a held subscription the stored tree does not have, so the listing can say it was not found', () => {
    const gone = '00000000-0000-0000-0000-0000000000ee';
    const scopes = buildScopeOptions(holding(SUB_PATH(gone), SUB_PATH(SUB_A)), NODES, LISTED, []);
    expect(shape(scopes.tree)).toEqual([SUB_PATH(SUB_A)]);
    expect(listedPaths(scopes.tree).has(SUB_PATH(gone))).toBe(false);
  });

  it('the Directory holder has the Directory and no tree, and a person with no Scope has neither', () => {
    expect(buildScopeOptions(holding('@directory'), NODES, LISTED, GROUPS)).toMatchObject({ directory: true, tree: [] });
    expect(buildScopeOptions(holding(), NODES, LISTED, [])).toMatchObject({ directory: false, tree: [] });
  });

  it('names a node by its display name and carries its id as the detail, like the Access page', () => {
    const [root] = buildScopeOptions(holding(SUB_PATH(SUB_A)), NODES, LISTED, []).tree;
    expect(root).toMatchObject({ key: SUB_PATH(SUB_A), kind: 'subscription', name: 'Sub A', detail: SUB_A });
  });

  it('lets a nested pick read "Covered by" the pick above it', () => {
    const scopes = buildScopeOptions(everythingAccess('admin'), NODES, LISTED, GROUPS);
    const covered = coveredBy(scopes.tree, key => key === GROUP_PATH('mg-example'));
    expect(covered.get(SUB_PATH(SUB_B))).toBe('Example group');
    expect(covered.get(`${SUB_PATH(SUB_A)}/resourceGroups/rg-two`)).toBe('Example group');
    expect(covered.get(SUB_PATH(SUB_C))).toBeUndefined();
  });
});

describe('buildScopeOptions: the latest listing', () => {
  it('is listed after a refresh that worked', () => {
    expect(buildScopeOptions(holding(SUB_PATH(SUB_A)), NODES, LISTED, []).listing).toBe('listed');
  });

  it('is failed when the last refresh failed, and when none has ever worked', () => {
    const error = { code: 'failed' as const, message: 'The management group tree could not be read from Azure.' };
    expect(buildScopeOptions(holding(SUB_PATH(SUB_A)), NODES, { ...LISTED, error }, []).listing).toBe('failed');
    expect(buildScopeOptions(holding(SUB_PATH(SUB_A)), [], { lastSuccessAt: null, lastAttemptAt: null, error: null }, []).listing).toBe('failed');
  });
});

describe('a pick against the listing', () => {
  const held = (value: string, label: string): ScopePickState => ({ value, access: 'held', label });
  const listed = listedPaths(buildScopeOptions(everythingAccess('admin'), NODES, LISTED, GROUPS).tree);
  const GONE = SUB_PATH('00000000-0000-0000-0000-0000000000ee');

  it('marks a held subscription or management group the listing does not know, and names it by its id', () => {
    const chips = scopeChips(
      [held(SUB_PATH(SUB_A), 'Sub A'), held(GONE, '00000000-0000-0000-0000-0000000000ee'), held(GROUP_PATH('mg-gone'), 'mg-gone')],
      { failed: false, known: listed },
    );
    expect(chips.map(c => c.label)).toEqual([
      'Sub A',
      `00000000-0000-0000-0000-0000000000ee (${NOT_FOUND_IN_AZURE})`,
      `mg-gone (${NOT_FOUND_IN_AZURE})`,
    ]);
  });

  it('compares the path without regard to case', () => {
    expect(scopeChips([held(SUB_PATH(SUB_A).toUpperCase(), 'Sub A')], { failed: false, known: listed }).map(c => c.label)).toEqual(['Sub A']);
  });

  it('never marks a resource group or the Directory, which the listing does not enumerate', () => {
    const chips = scopeChips([held(`${SUB_PATH(SUB_A)}/resourceGroups/rg-gone`, 'rg-gone in Sub A'), held('@directory', 'Directory')], { failed: false, known: listed });
    expect(chips.map(c => c.label)).toEqual(['rg-gone in Sub A', 'Directory']);
  });

  it('shows picks by id with no mark when the listing failed', () => {
    const chips = scopeChips([held(SUB_PATH(SUB_A), 'Sub A'), held(GONE, 'x'), held(`${SUB_PATH(SUB_A)}/resourceGroups/rg-one`, 'rg-one in Sub A')], { failed: true, known: new Set() });
    expect(chips.map(c => c.label)).toEqual([SUB_A, '00000000-0000-0000-0000-0000000000ee', `rg-one in ${SUB_A}`]);
  });

  it('says nothing more without a listing, as before', () => {
    expect(scopeChips([held(GONE, 'x')]).map(c => c.label)).toEqual(['x']);
  });
});

describe('subscriptionNames', () => {
  it('maps each subscription on the tree to its display name by id', () => {
    const { tree } = buildScopeOptions(everythingAccess('admin'), NODES, LISTED, GROUPS);
    expect(subscriptionNames(tree)).toEqual({ [SUB_A]: 'Sub A', [SUB_B]: 'Sub B', [SUB_C]: 'Sub C' });
  });
});
