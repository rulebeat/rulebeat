/**
 * #311: the one scope tree the Access page, the Management groups card and the rule form draw. Pure, so no
 * rendering: which rows show for what is open and what is searched, what a search or a held Scope opens, what a
 * tick covers, and how each source becomes tree nodes.
 */
import { describe, expect, it } from 'vitest';
import {
  anyMatch, coveredBy, hierarchyItems, pathsTo, pathsToMatches, ruleScopeItems, ruleScopeKey, topLevelKeys, treeRows,
  type ScopeTreeItem,
} from '@/lib/scope-tree';
import { managementGroupScopePath, subscriptionScopePath } from '@/lib/access-picker';
import { group, subscription } from '../helpers/fake-hierarchy';
import { GROUPS_FAILED_NOTE, NO_GROUPS_NOTE, pickerItems } from '@/app/(app)/access/scope-picker';

const SUB = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-00000000000b';

const TREE: ScopeTreeItem[] = [
  {
    key: 'root', kind: 'managementGroup', name: 'Tenant Root Group', detail: 'root-id',
    children: [
      {
        key: 'prod', kind: 'managementGroup', name: 'Production', detail: 'mg-prod',
        children: [{ key: 'sub-a', kind: 'subscription', name: 'Payments', detail: SUB, lazy: true, children: [] }],
      },
      { key: 'sand', kind: 'subscription', name: 'Sandbox', detail: OTHER },
    ],
  },
  { key: 'dir', kind: 'directory', name: 'Directory' },
];

const shown = (expanded: string[], query = '') =>
  treeRows(TREE, new Set(expanded), query).map(r => `${'  '.repeat(r.depth)}${r.item.key}${r.expandable ? (r.expanded ? ' -' : ' +') : ''}`);

describe('treeRows', () => {
  it('shows only the top level until a node is opened, and marks what can open', () => {
    expect(shown([])).toEqual(['root +', 'dir']);
  });

  it('shows the children of every open node, one level deeper', () => {
    expect(shown(['root'])).toEqual(['root -', '  prod +', '  sand', 'dir']);
    expect(shown(['root', 'prod'])).toEqual(['root -', '  prod -', '    sub-a +', '  sand', 'dir']);
  });

  it('keeps a closed node closed whatever is open beneath it', () => {
    expect(shown(['prod'])).toEqual(['root +', 'dir']);
  });

  it('counts a lazy node as one that can open before its children have loaded', () => {
    expect(shown(['root', 'prod', 'sub-a'])).toContain('    sub-a -');
  });

  it('keeps a match and the nodes above it, by name or detail in any casing', () => {
    expect(shown(['root', 'prod'], 'PAY')).toEqual(['root -', '  prod -', '    sub-a +']);
    expect(shown(['root'], OTHER.toUpperCase())).toEqual(['root -', '  sand']);
  });

  it('filters nothing beneath a node that matches, so opening a matched group shows all of it', () => {
    expect(shown(['root'], 'tenant root')).toEqual(['root -', '  prod +', '  sand']);
  });

  it('shows nothing for a search that matches nothing, and anyMatch says so', () => {
    expect(shown(['root', 'prod'], 'no-such-name')).toEqual([]);
    expect(anyMatch(TREE, 'no-such-name')).toBe(false);
    expect(anyMatch(TREE, 'sandbox')).toBe(true);
    expect(anyMatch(TREE, '  ')).toBe(true);
  });
});

describe('what a tree opens by itself', () => {
  it('opens the path to every match of a search, and nothing for a blank one', () => {
    expect(pathsToMatches(TREE, 'payments').sort()).toEqual(['prod', 'root']);
    expect(pathsToMatches(TREE, ' ')).toEqual([]);
  });

  it('opens the parents of each held key, in any casing, and not the key itself', () => {
    expect(pathsTo(TREE, ['SUB-A']).sort()).toEqual(['prod', 'root']);
    expect(pathsTo(TREE, ['sand'])).toEqual(['root']);
    expect(pathsTo(TREE, ['dir', 'no-such-key'])).toEqual([]);
  });

  it('starts one level open at the top-level keys', () => {
    expect(topLevelKeys(TREE)).toEqual(['root', 'dir']);
  });
});

describe('coveredBy', () => {
  it('names the highest ticked node above every node beneath it', () => {
    const ticked = new Set(['root', 'prod']);
    const cover = coveredBy(TREE, key => ticked.has(key));
    expect(cover.get('prod')).toBe('Tenant Root Group');
    expect(cover.get('sub-a')).toBe('Tenant Root Group');
    expect(cover.get('sand')).toBe('Tenant Root Group');
  });

  it('covers nothing beside or above a ticked node, nor the node itself', () => {
    const cover = coveredBy(TREE, key => key === 'prod');
    expect([...cover.entries()]).toEqual([['sub-a', 'Production']]);
  });
});

describe('the sources of the tree', () => {
  it('nests the management group tree by Scope path, groups first and each by name', () => {
    const items = hierarchyItems([
      group('root', 'Tenant Root Group', null),
      subscription(SUB, 'Payments', 'root'),
      group('mg-z', 'Zulu', 'root'),
      group('mg-a', 'Alpha', 'root'),
      subscription(OTHER, 'Sandbox', 'mg-a'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: managementGroupScopePath('root'), kind: 'managementGroup', name: 'Tenant Root Group', detail: 'root' });
    expect(items[0]!.children!.map(c => c.name)).toEqual(['Alpha', 'Zulu', 'Payments']);
    expect(items[0]!.children![0]!.children).toEqual([
      { key: subscriptionScopePath(OTHER), kind: 'subscription', name: 'Sandbox', detail: OTHER },
    ]);
    expect(items[0]!.children![2]).toMatchObject({ key: subscriptionScopePath(SUB), kind: 'subscription' });
  });

  it('keys the rule form tree by kind and bare id, with no children list on a leaf', () => {
    const items = ruleScopeItems([
      { id: 'mg-a', name: 'Alpha', type: 'managementGroup', children: [{ id: SUB, name: 'Payments', type: 'subscription' }] },
      { id: OTHER, name: 'Sandbox', type: 'subscription', children: [] },
    ]);
    expect(items).toEqual([
      {
        key: ruleScopeKey('managementGroup', 'mg-a'), kind: 'managementGroup', name: 'Alpha', detail: 'mg-a',
        children: [{ key: `subscription:${SUB}`, kind: 'subscription', name: 'Payments', detail: SUB }],
      },
      { key: `subscription:${OTHER}`, kind: 'subscription', name: 'Sandbox', detail: OTHER },
    ]);
  });
});

describe('the Access page tree (pickerItems)', () => {
  const nodes = [group('root', 'Tenant Root Group', null), subscription(SUB, 'Payments', 'root')];
  const catalogue = { nodes, subscriptions: [{ id: SUB, name: 'Payments' }, { id: OTHER, name: 'Sandbox' }] };
  const rgPath = (sub: string, name: string) => `${subscriptionScopePath(sub)}/resourceGroups/${name}`;

  it('starts with the Directory, then the management group tree, then each subscription the tree does not place', () => {
    const items = pickerItems(catalogue, {}, []);
    expect(items.map(i => [i.kind, i.name])).toEqual([['directory', 'Directory'], ['managementGroup', 'Tenant Root Group'], ['subscription', 'Sandbox']]);
    expect(items[0]!.key).toBe('@directory');
    expect(items[1]!.children!.map(c => c.key)).toEqual([subscriptionScopePath(SUB)]);
  });

  it('lets every subscription open to resource groups it has not read yet', () => {
    const sandbox = pickerItems(catalogue, {}, [])[2]!;
    expect(sandbox).toMatchObject({ lazy: true, children: [] });
    expect(sandbox.note).toBeUndefined();
  });

  it('lists a resource group already held before the subscription is read, so its tick is never hidden', () => {
    const sandbox = pickerItems(catalogue, {}, [{ scope: rgPath(OTHER, 'rg-held'), role: 'viewer' }])[2]!;
    expect(sandbox.children).toEqual([{ key: rgPath(OTHER, 'rg-held'), kind: 'resourceGroup', name: 'rg-held' }]);
  });

  it('lists the resource groups read, a held one once whatever its casing, and says why there are none', () => {
    const read = pickerItems(catalogue, { [OTHER]: { status: 'ready', names: ['rg-a', 'rg-held'] } }, [{ scope: rgPath(OTHER, 'RG-HELD'), role: 'viewer' }])[2]!;
    expect(read.children!.map(c => c.name)).toEqual(['rg-a', 'rg-held']);
    expect(pickerItems(catalogue, { [OTHER]: { status: 'loading' } }, [])[2]!.note).toBe('Loading resource groups');
    expect(pickerItems(catalogue, { [OTHER]: { status: 'error' } }, [])[2]!.note).toBe(GROUPS_FAILED_NOTE);
    expect(pickerItems(catalogue, { [OTHER]: { status: 'ready', names: [] } }, [])[2]!.note).toBe(NO_GROUPS_NOTE);
  });

  it('still lists the Directory and every subscription when the management group tree did not load', () => {
    const items = pickerItems({ nodes: null, subscriptions: catalogue.subscriptions }, {}, []);
    expect(items.map(i => i.name)).toEqual(['Directory', 'Payments', 'Sandbox']);
  });
});
