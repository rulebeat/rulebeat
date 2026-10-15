/**
 * #272: what the Access page's Scope picker does to the list it edits. Pure, so no rendering: a Scope is
 * held once whatever its casing, taking the Role the person-level select names, and a list read from a
 * person's access leaves out what cannot be saved.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, parseScope, type ManualGrant } from '@/lib/access-model';
import {
  alsoLinkedNote, canInvite, canInviteMirrored, canPreviewMirror, canUseSignInAccount, EDIT_STOPS_MIRROR_NOTE, previewHeading, replacesManualNote,
  addGrant, coveringGrant, demotedWithoutAccessMessage, demoteToMirrored, describeScopePath, editSaveRequest, filterTree, GROUPS_LOAD_FAILED_MESSAGE, grantsOfAccess, heldAt, heldRows, NO_SUBSCRIPTIONS_MESSAGE, nothingMatchedMessage, offerStatus,
  managementGroupPathLabel, resourceGroupScopePath, resourceGroupsHeld, roleLocked, searchResourceGroups, searchScopes, setEveryRole,
  setGrantRole, shownRole, subscriptionScopePath, tickScope, toggleGrant,
} from '@/lib/access-picker';
import type { AppUserWithAccess } from '@/lib/access';

import {
  describeMirrorStatus, describeOrigin, describeOrigins, MIRROR_FAILED_MESSAGE, mirrorError, NEVER_MIRRORED, parseOrigins, serializeOrigins,
} from '@/lib/access-mirror-model';

const SUB = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-00000000000b';

describe('building and toggling Scopes', () => {
  it('builds the paths the server parses back', () => {
    expect(parseScope(subscriptionScopePath(SUB))?.kind).toBe('subscription');
    expect(parseScope(resourceGroupScopePath(SUB, 'rg-one'))?.kind).toBe('resourceGroup');
  });

  it('holds a Scope at the given Role, and drops it when toggled again, whatever the casing', () => {
    const path = subscriptionScopePath(SUB);
    const held = toggleGrant([], path, 'editor');
    expect(held).toEqual([{ scope: path, role: 'editor' }]);
    expect(heldAt(held, path.toUpperCase())).toBeDefined();
    expect(toggleGrant(held, path.toUpperCase(), 'viewer')).toEqual([]);
  });

  it('sets the Role at one Scope and at every Scope', () => {
    const list: ManualGrant[] = [{ scope: '/', role: 'viewer' }, { scope: '@directory', role: 'viewer' }];
    expect(setGrantRole(list, '@DIRECTORY', 'editor')).toEqual([{ scope: '/', role: 'viewer' }, { scope: '@directory', role: 'editor' }]);
    expect(setEveryRole(list, 'editor').map(g => g.role)).toEqual(['editor', 'editor']);
  });
});

describe('reading a person\'s access into the picker', () => {
  it('keeps each Scope with its Role, a management group included, so an Edit saved unchanged removes nothing', () => {
    const access = buildAccess([
      { tenantId: 't', scope: parseScope(subscriptionScopePath(SUB))!, role: 'viewer' },
      { tenantId: 't', scope: parseScope('/providers/Microsoft.Management/managementGroups/mg')!, role: 'viewer' },
      { tenantId: 't', scope: parseScope('@directory')!, role: 'editor' },
    ], 'manual');
    expect(grantsOfAccess(access)).toEqual([
      { scope: subscriptionScopePath(SUB), role: 'viewer' },
      { scope: '/providers/Microsoft.Management/managementGroups/mg', role: 'viewer' },
      { scope: '@directory', role: 'editor' },
    ]);
  });

  it('finds the resource groups held in one subscription', () => {
    const list: ManualGrant[] = [
      { scope: resourceGroupScopePath(SUB, 'rg-one'), role: 'viewer' },
      { scope: resourceGroupScopePath(SUB.toUpperCase(), 'rg-two'), role: 'viewer' },
      { scope: resourceGroupScopePath(OTHER, 'rg-one'), role: 'editor' },
      { scope: subscriptionScopePath(OTHER), role: 'viewer' },
      { scope: '/', role: 'viewer' },
    ];
    expect(resourceGroupsHeld(list, SUB)).toEqual(['rg-one', 'rg-two']);
    expect(resourceGroupsHeld(list, OTHER)).toEqual(['rg-one']);
  });
});

describe('naming a Scope', () => {
  it('names each kind, using a subscription\'s display name when it is known', () => {
    const names = { [SUB]: 'Production' };
    expect(describeScopePath('/')).toBe('Everything');
    expect(describeScopePath('@directory')).toBe('Directory');
    expect(describeScopePath(subscriptionScopePath(SUB), names)).toBe('Production');
    expect(describeScopePath(subscriptionScopePath(OTHER), names)).toBe(OTHER);
    expect(describeScopePath(resourceGroupScopePath(SUB, 'rg-one'), names)).toBe('rg-one in Production');
  });
});

describe('who can be invited', () => {
  it('needs an email and at least one Scope', () => {
    const one: ManualGrant[] = [{ scope: '/', role: 'viewer' }];
    expect(canInvite('a@example.com', one)).toBe(true);
    expect(canInvite('a@example.com', [])).toBe(false);
    expect(canInvite('  ', one)).toBe(false);
  });
});

describe('the searchable picker (#307)', () => {
  const ROOT = 'tenant-root';
  const MG_PATH = (id: string) => `/providers/Microsoft.Management/managementGroups/${id}`;
  const SUB_PATH = subscriptionScopePath(SUB);
  const SANDBOX = '00000000-0000-0000-0000-00000000000c';
  const node = (id: string, name: string, parentId: string | null, kind: 'managementGroup' | 'subscription' = 'managementGroup') => ({ id, kind, name, parentId });
  const nodes = [
    node(ROOT, 'Tenant Root Group', null),
    node('mg-enterprise', 'Enterprise', ROOT),
    node('mg-prod', 'Production', 'mg-enterprise'),
    node('mg-other', 'Other', ROOT),
    node(SUB, 'Prod subscription', 'mg-prod', 'subscription'),
    node(OTHER, 'Loose subscription', 'mg-other', 'subscription'),
  ];
  const catalogue = { nodes, subscriptions: [{ id: SUB, name: 'Production workloads' }, { id: SANDBOX, name: 'Sandbox' }] };

  describe('searchScopes', () => {
    it('finds management groups and subscriptions by display name, in any casing', () => {
      expect(searchScopes('ENTERPRISE', catalogue).map(c => c.id)).toEqual(['mg-enterprise']);
      expect(searchScopes('sand', catalogue).map(c => [c.kind, c.name])).toEqual([['subscription', 'Sandbox']]);
    });

    it('finds them by id, a subscription by its id in any casing', () => {
      expect(searchScopes('mg-prod', catalogue).map(c => c.id)).toEqual(['mg-prod']);
      expect(searchScopes(SANDBOX.toUpperCase(), catalogue).map(c => c.path)).toEqual([subscriptionScopePath(SANDBOX)]);
    });

    it('lists groups before subscriptions, and a subscription both lists know once, under the name Azure gave it', () => {
      const found = searchScopes('prod', catalogue);
      expect(found.map(c => [c.kind, c.name])).toEqual([['managementGroup', 'Production'], ['subscription', 'Production workloads']]);
      expect(found[0]!.path).toBe(MG_PATH('mg-prod'));
    });

    it('matches nothing for a blank query and for a query nothing contains', () => {
      expect(searchScopes('', catalogue)).toEqual([]);
      expect(searchScopes('   ', catalogue)).toEqual([]);
      expect(searchScopes('no-such-name', catalogue)).toEqual([]);
    });

    it('searches what has loaded: no tree, or no subscription list, is not an error', () => {
      expect(searchScopes('sand', { nodes: null, subscriptions: catalogue.subscriptions }).map(c => c.name)).toEqual(['Sandbox']);
      expect(searchScopes('enterprise', { nodes: catalogue.nodes, subscriptions: null }).map(c => c.name)).toEqual(['Enterprise']);
    });
  });

  describe('the empty states of Add access', () => {
    it('says why in three different sentences: nothing matched, groups could not load, no subscriptions', () => {
      const matched = nothingMatchedMessage('zzz');
      expect(matched).toContain('“zzz”');
      expect(new Set([matched, GROUPS_LOAD_FAILED_MESSAGE, NO_SUBSCRIPTIONS_MESSAGE]).size).toBe(3);
      expect(GROUPS_LOAD_FAILED_MESSAGE).toContain('could not be loaded');
      expect(NO_SUBSCRIPTIONS_MESSAGE).toContain('No subscriptions were found');
      expect(matched).not.toContain('could not be loaded');
      expect(matched).not.toContain('were found');
    });
  });

  describe('filterTree', () => {
    it('keeps each match with every group above it, and nothing else', () => {
      const names = (found: { id: string }[]) => found.map(n => n.id).sort();
      expect(names(filterTree(nodes, 'Production'))).toEqual(['mg-enterprise', 'mg-prod', ROOT]);
      expect(names(filterTree(nodes, 'loose'))).toEqual(['mg-other', OTHER, ROOT].sort());
    });

    it('matches by id in any casing, and a subscription is kept under its group', () => {
      const names = filterTree(nodes, SUB.toUpperCase()).map(n => n.id).sort();
      expect(names).toEqual(['mg-enterprise', 'mg-prod', ROOT, SUB].sort());
    });

    it('keeps the whole tree for a blank filter and nothing for one that matches nothing', () => {
      expect(filterTree(nodes, '  ')).toHaveLength(nodes.length);
      expect(filterTree(nodes, 'no-such-name')).toEqual([]);
    });
  });

  describe('shownRole', () => {
    it('shows the pending Role while the demote panel is open on that person, and the stored Role otherwise', () => {
      const admin = { id: 'u-1', role: 'admin' };
      expect(shownRole(admin, { id: 'u-1', role: 'editor' })).toBe('editor');
      expect(shownRole(admin, { id: 'u-2', role: 'editor' })).toBe('admin');
      expect(shownRole(admin, null)).toBe('admin');
    });
  });

  describe('searchResourceGroups', () => {
    it('keeps the resource groups that contain the query, in any casing, and all of them for a blank one', () => {
      const names = ['rg-web', 'RG-data', 'shared'];
      expect(searchResourceGroups(names, 'RG-')).toEqual(['RG-data', 'rg-web']);
      expect(searchResourceGroups(names, '')).toEqual(['RG-data', 'rg-web', 'shared']);
      expect(searchResourceGroups(names, 'zzz')).toEqual([]);
    });
  });

  describe('managementGroupPathLabel', () => {
    it('reads root first, joined by an arrow', () => {
      expect(managementGroupPathLabel(nodes, 'mg-enterprise')).toBe('Tenant Root Group › Enterprise');
      expect(managementGroupPathLabel(nodes, 'mg-prod')).toBe('Tenant Root Group › Enterprise › Production');
      expect(managementGroupPathLabel(nodes, ROOT)).toBe('Tenant Root Group');
    });

    it('keeps a deep path short, and is just the id for a group the tree lacks', () => {
      const deep = [node('a', 'A', null), node('b', 'B', 'a'), node('c', 'C', 'b'), node('d', 'D', 'c'), node('e', 'E', 'd')];
      expect(managementGroupPathLabel(deep, 'e')).toBe('A › … › D › E');
      expect(managementGroupPathLabel(nodes, 'mg-gone')).toBe('mg-gone');
    });

    it('ends on a tree that loops', () => {
      const loop = [node('x', 'X', 'y'), node('y', 'Y', 'x')];
      expect(managementGroupPathLabel(loop, 'x')).toBe('Y › X');
    });
  });

  describe('coveringGrant', () => {
    const RG_PATH = resourceGroupScopePath(SUB, 'rg-one');
    const cover = (held: ManualGrant[], path: string, role: 'viewer' | 'editor' = 'viewer') => coveringGrant(held, nodes, path, role)?.scope ?? null;

    it('has Everything cover every Scope, the Directory included', () => {
      const held: ManualGrant[] = [{ scope: '/', role: 'viewer' }];
      for (const path of [MG_PATH('mg-prod'), SUB_PATH, RG_PATH, '@directory']) expect(cover(held, path), path).toBe('/');
    });

    it('has a management group cover the groups below it, the subscriptions under them and their resource groups', () => {
      const held: ManualGrant[] = [{ scope: MG_PATH('mg-enterprise'), role: 'viewer' }];
      expect(cover(held, MG_PATH('mg-prod'))).toBe(MG_PATH('mg-enterprise'));
      expect(cover(held, SUB_PATH)).toBe(MG_PATH('mg-enterprise'));
      expect(cover(held, RG_PATH)).toBe(MG_PATH('mg-enterprise'));
    });

    it('has a management group cover nothing above it, beside it, or the Directory', () => {
      const held: ManualGrant[] = [{ scope: MG_PATH('mg-prod'), role: 'viewer' }];
      expect(cover(held, MG_PATH('mg-enterprise'))).toBeNull();
      expect(cover(held, MG_PATH('mg-other'))).toBeNull();
      expect(cover(held, subscriptionScopePath(OTHER))).toBeNull();
      expect(cover(held, '@directory')).toBeNull();
      expect(cover(held, '/')).toBeNull();
    });

    it('has a subscription cover its resource groups and no other', () => {
      const held: ManualGrant[] = [{ scope: SUB_PATH.toUpperCase(), role: 'viewer' }];
      expect(cover(held, RG_PATH)).toBe(SUB_PATH.toUpperCase());
      expect(cover(held, resourceGroupScopePath(OTHER, 'rg-one'))).toBeNull();
      expect(cover(held, subscriptionScopePath(OTHER))).toBeNull();
    });

    it('covers the Directory by Everything alone', () => {
      expect(cover([{ scope: MG_PATH(ROOT), role: 'editor' }, { scope: SUB_PATH, role: 'editor' }], '@directory')).toBeNull();
      expect(cover([{ scope: '/', role: 'viewer' }], '@directory')).toBe('/');
    });

    it('covers a Scope only at the same or a higher Role, Editor above Viewer', () => {
      const viewerGroup: ManualGrant[] = [{ scope: MG_PATH('mg-enterprise'), role: 'viewer' }];
      const editorGroup: ManualGrant[] = [{ scope: MG_PATH('mg-enterprise'), role: 'editor' }];
      expect(cover(viewerGroup, SUB_PATH, 'viewer')).not.toBeNull();
      expect(cover(editorGroup, SUB_PATH, 'viewer')).not.toBeNull();
      expect(cover(editorGroup, SUB_PATH, 'editor')).not.toBeNull();
      // An Editor on a subscription while a Viewer on a group above it is a real addition.
      expect(cover(viewerGroup, SUB_PATH, 'editor')).toBeNull();
    });

    it('counts the same Scope, in any casing, as covered', () => {
      expect(cover([{ scope: SUB_PATH.toUpperCase(), role: 'editor' }], SUB_PATH)).toBe(SUB_PATH.toUpperCase());
    });

    it('finds nothing in a tree that does not hold the group or the subscription', () => {
      expect(coveringGrant([{ scope: MG_PATH('mg-prod'), role: 'viewer' }], [], SUB_PATH, 'viewer')).toBeNull();
    });
  });

  describe('adding a Scope that is already held', () => {
    it('leaves a Scope held at a lower Role in the list, with its Role, instead of toggling it off', () => {
      const held: ManualGrant[] = [{ scope: SUB_PATH, role: 'viewer' }, { scope: '/', role: 'viewer' }];
      expect(addGrant(held, SUB_PATH, 'editor')).toEqual(held);
      expect(addGrant(held, SUB_PATH.toUpperCase(), 'viewer')).toEqual(held);
      expect(addGrant(held, '/', 'editor')).toEqual(held);
    });

    it('adds a Scope that is not held, at the Role given', () => {
      expect(addGrant([], SUB_PATH, 'editor')).toEqual([{ scope: SUB_PATH, role: 'editor' }]);
    });

    it('says a held Scope is held, at its own Role, even when the person is higher; and says what covers a covered one', () => {
      const held: ManualGrant[] = [{ scope: SUB_PATH, role: 'viewer' }, { scope: MG_PATH('mg-other'), role: 'viewer' }];
      expect(offerStatus(held, nodes, SUB_PATH, 'editor')).toBe('Held at Viewer');
      expect(offerStatus(held, nodes, subscriptionScopePath(OTHER), 'viewer', { 'mg-other': 'Other' })).toBe('Covered by Management group Other');
      // An Editor addition under a Viewer group is real: nothing blocks it.
      expect(offerStatus(held, nodes, subscriptionScopePath(OTHER), 'editor')).toBeNull();
      expect(offerStatus([], nodes, SUB_PATH, 'viewer')).toBeNull();
    });
  });

  describe('ticking a Scope in the tree (#311)', () => {
    it('adds the Scope at the Role given, and drops every held Scope it covers', () => {
      const held: ManualGrant[] = [
        { scope: SUB_PATH, role: 'viewer' },
        { scope: MG_PATH('mg-prod'), role: 'viewer' },
        { scope: subscriptionScopePath(OTHER), role: 'viewer' },
        { scope: '@directory', role: 'viewer' },
      ];
      expect(tickScope(held, nodes, MG_PATH('mg-enterprise'), 'viewer')).toEqual([
        { scope: subscriptionScopePath(OTHER), role: 'viewer' },
        { scope: '@directory', role: 'viewer' },
        { scope: MG_PATH('mg-enterprise'), role: 'viewer' },
      ]);
    });

    it('drops the resource groups of a subscription when the subscription is ticked', () => {
      const held: ManualGrant[] = [{ scope: resourceGroupScopePath(SUB, 'rg-one'), role: 'editor' }];
      expect(tickScope(held, nodes, SUB_PATH, 'editor')).toEqual([{ scope: SUB_PATH, role: 'editor' }]);
    });

    it('replaces the whole list with Everything when Everything is ticked', () => {
      const held: ManualGrant[] = [{ scope: SUB_PATH, role: 'viewer' }, { scope: '@directory', role: 'viewer' }];
      expect(tickScope(held, nodes, '/', 'viewer')).toEqual([{ scope: '/', role: 'viewer' }]);
    });

    it('leaves the list as it is when the Scope is already held, in any casing', () => {
      const held: ManualGrant[] = [{ scope: SUB_PATH, role: 'viewer' }];
      expect(tickScope(held, nodes, SUB_PATH.toUpperCase(), 'editor')).toEqual(held);
    });
  });

  describe('roleLocked', () => {
    it('locks a Scope held at the person\'s Role, and unlocks it when the Admin asks for a different one', () => {
      const grant: ManualGrant = { scope: SUB_PATH, role: 'viewer' };
      expect(roleLocked(grant, 'viewer', new Set())).toBe(true);
      expect(roleLocked(grant, 'viewer', new Set([SUB_PATH.toLowerCase()]))).toBe(false);
    });

    it('loads a Scope saved at another Role unlocked, so its Role is shown as it is', () => {
      expect(roleLocked({ scope: SUB_PATH, role: 'editor' }, 'viewer', new Set())).toBe(false);
    });
  });

  describe('heldRows', () => {
    it('lists every held Scope with its kind, name, short path and Role, in the list\'s own order', () => {
      const held: ManualGrant[] = [
        { scope: MG_PATH('mg-prod'), role: 'viewer' },
        { scope: SUB_PATH, role: 'editor' },
        { scope: resourceGroupScopePath(SUB, 'rg-one'), role: 'viewer' },
        { scope: '@directory', role: 'viewer' },
        { scope: '/', role: 'viewer' },
      ];
      expect(heldRows(held, catalogue).map(r => [r.kind, r.label, r.detail, r.role])).toEqual([
        ['managementGroup', 'Production', 'Tenant Root Group › Enterprise › Production', 'viewer'],
        ['subscription', 'Production workloads', SUB, 'editor'],
        ['resourceGroup', 'rg-one', 'in Production workloads', 'viewer'],
        ['directory', 'Directory', expect.stringContaining('Entra ID'), 'viewer'],
        ['everything', 'Everything', expect.stringContaining('Every subscription'), 'viewer'],
      ]);
    });

    it('keeps a held management group the tree no longer has, marked as not in it', () => {
      const held: ManualGrant[] = [{ scope: MG_PATH('mg-gone'), role: 'editor' }, { scope: MG_PATH('mg-prod'), role: 'viewer' }];
      const rows = heldRows(held, catalogue);
      expect(rows.map(r => [r.label, r.missing])).toEqual([['mg-gone', true], ['Production', false]]);
      expect(rows[0]!.detail).toMatch(/Not in the tree/);
    });

    it('does not call a group missing while the tree has not loaded', () => {
      const [row] = heldRows([{ scope: MG_PATH('mg-prod'), role: 'viewer' }], { nodes: null, subscriptions: null });
      expect(row).toMatchObject({ label: 'mg-prod', missing: false });
    });

    it('names a subscription by its id when no list gave a name', () => {
      const [row] = heldRows([{ scope: subscriptionScopePath(OTHER), role: 'viewer' }], { nodes: [], subscriptions: [] });
      expect(row).toMatchObject({ label: OTHER, detail: null });
    });
  });

  describe('an Edit that changed nothing', () => {
    const access = buildAccess([
      { tenantId: 't', scope: parseScope(MG_PATH('mg-gone'))!, role: 'editor' },
      { tenantId: 't', scope: parseScope(SUB_PATH)!, role: 'viewer' },
    ], 'manual');

    it('lists the group missing from the tree, so the list it starts from is the list it would save', () => {
      const initial = grantsOfAccess(access);
      expect(heldRows(initial, catalogue).map(r => r.path)).toEqual(initial.map(g => g.scope));
    });

    it('sends nothing for an unchanged Manual list, whatever the order or casing', () => {
      const initial = grantsOfAccess(access);
      expect(editSaveRequest(initial, initial, 'manual')).toBeNull();
      expect(editSaveRequest(initial, [...initial].reverse().map(g => ({ ...g, scope: g.scope.toUpperCase() })), 'manual')).toBeNull();
    });

    it('sends the list once a Scope, a Role or the length differs', () => {
      const initial = grantsOfAccess(access);
      expect(editSaveRequest(initial, initial.slice(1), 'manual')).toEqual(initial.slice(1));
      expect(editSaveRequest(initial, setGrantRole(initial, SUB_PATH, 'editor'), 'manual')).toHaveLength(2);
      expect(editSaveRequest(initial, [...initial, { scope: '@directory', role: 'viewer' }], 'manual')).toHaveLength(3);
    });

    it('always sends for a mirrored person, since saving is what turns them manual', () => {
      const initial = grantsOfAccess(access);
      expect(editSaveRequest(initial, initial, 'mirrored')).toEqual(initial);
    });
  });

  describe('demoteToMirrored', () => {
    const OBJECT = '00000000-0000-0000-0000-0000000000c1';
    const answer = (ok: boolean, body: unknown) => ({ ok, json: async () => body });
    const user = { id: 'u-1', email: 'second@example.com', role: 'editor' } as unknown as AppUserWithAccess;
    const mirrored = { ...user, accessSource: 'mirrored' } as unknown as AppUserWithAccess;

    it('demotes with no Scopes first, then mirrors, and never sends Everything', async () => {
      const calls: [string, string, unknown][] = [];
      const result = await demoteToMirrored({ userId: 'u-1', role: 'editor', objectId: OBJECT }, async (url, init) => {
        calls.push([init.method, url, JSON.parse(init.body)]);
        return answer(true, calls.length === 1 ? user : mirrored);
      });
      expect(calls).toEqual([
        ['PUT', '/api/users/u-1', { role: 'editor', access: [] }],
        ['PUT', '/api/users/u-1/mirror', { objectId: OBJECT, role: 'editor' }],
      ]);
      expect(result).toEqual({ ok: true, user: mirrored });
    });

    it('stops at a failed demote without trying to mirror', async () => {
      const urls: string[] = [];
      const result = await demoteToMirrored({ userId: 'u-1', role: 'viewer', objectId: OBJECT }, async url => {
        urls.push(url);
        return answer(false, { error: 'This is the only admin.' });
      });
      expect(urls).toEqual(['/api/users/u-1']);
      expect(result).toEqual({ ok: false, stage: 'demote', error: 'This is the only admin.' });
    });

    it('hands back the demoted row when the mirror fails, so the page can show who holds nothing', async () => {
      let n = 0;
      const result = await demoteToMirrored({ userId: 'u-1', role: 'editor', objectId: OBJECT }, async () =>
        (++n === 1 ? answer(true, user) : answer(false, { error: 'Azure is not connected.' })));
      expect(result).toEqual({ ok: false, stage: 'mirror', error: 'Azure is not connected.', user });
    });

    it('skips the demote on a retry, since a second demote of a non-Admin that carries access is refused', async () => {
      const urls: string[] = [];
      const result = await demoteToMirrored({ userId: 'u-1', role: 'editor', objectId: OBJECT, demoted: user }, async url => {
        urls.push(url);
        return answer(true, mirrored);
      });
      expect(urls).toEqual(['/api/users/u-1/mirror']);
      expect(result.ok).toBe(true);
    });

    it('reports a request that could not be sent as a failure of that step', async () => {
      const result = await demoteToMirrored({ userId: 'u-1', role: 'editor', objectId: OBJECT }, async () => { throw new Error('offline'); });
      expect(result).toEqual({ ok: false, stage: 'demote', error: 'Could not reach the RuleBeat server.' });
    });
  });

  it('says in plain words that the person was demoted and holds no access', () => {
    const text = demotedWithoutAccessMessage('second@example.com', 'editor', 'Azure is not connected');
    expect(text).toContain('second@example.com was demoted to Editor and now holds no access');
    expect(text).toContain('not saved: Azure is not connected. Try again');
  });

  it('names a management group by its display name when it has one, whatever the casing', () => {
    const path = '/providers/Microsoft.Management/managementGroups/mg-a';
    expect(describeScopePath(path)).toBe('Management group mg-a');
    expect(describeScopePath(path, { 'mg-a': 'Alpha' })).toBe('Management group Alpha');
    expect(describeScopePath(path.replace('mg-a', 'MG-A'), { 'mg-a': 'Alpha' })).toBe('Management group Alpha');
  });
});

describe('Mirrored access in the picker (#278)', () => {
  const OBJECT_ID = '00000000-0000-0000-0000-0000000000c1';

  describe('canUseSignInAccount', () => {
    it('is offered for a person with an oid when the sign-in tenant is the Azure tenant', () => {
      expect(canUseSignInAccount({ oid: OBJECT_ID, role: 'viewer' }, true)).toBe(true);
      expect(canUseSignInAccount({ oid: OBJECT_ID, role: 'editor' }, true)).toBe(true);
    });

    it('is not offered when the sign-in tenant is another tenant, or no oid is held, or the person is an Admin', () => {
      expect(canUseSignInAccount({ oid: OBJECT_ID, role: 'viewer' }, false)).toBe(false);
      expect(canUseSignInAccount({ oid: null, role: 'viewer' }, true)).toBe(false);
      expect(canUseSignInAccount({ oid: '', role: 'viewer' }, true)).toBe(false);
      expect(canUseSignInAccount({ oid: OBJECT_ID, role: 'admin' }, true)).toBe(false);
    });
  });

  describe('canPreviewMirror', () => {
    it('takes an object id and refuses anything else, so Save stays disabled until one is typed', () => {
      expect(canPreviewMirror(OBJECT_ID)).toBe(true);
      expect(canPreviewMirror(`  ${OBJECT_ID.toUpperCase()}  `)).toBe(true);
      for (const typed of ['', ' ', 'not-a-guid', `${OBJECT_ID}0`, OBJECT_ID.slice(1)]) expect(canPreviewMirror(typed), typed).toBe(false);
    });
  });

  describe('canInviteMirrored', () => {
    it('needs an email and a preview of the very account in the field', () => {
      expect(canInviteMirrored('a@example.com', OBJECT_ID, OBJECT_ID)).toBe(true);
      expect(canInviteMirrored('a@example.com', ` ${OBJECT_ID} `, OBJECT_ID)).toBe(true);
      expect(canInviteMirrored('a@example.com', OBJECT_ID, null)).toBe(false);
      expect(canInviteMirrored(' ', OBJECT_ID, OBJECT_ID)).toBe(false);
      expect(canInviteMirrored('a@example.com', 'not-a-guid', 'not-a-guid')).toBe(false);
      expect(canInviteMirrored('a@example.com', OBJECT_ID, OBJECT_ID.replace(/.$/, '9'))).toBe(false);
    });
  });

  describe('previewHeading', () => {
    it('says the account holds no role assignments RuleBeat can see, and that the person would see no findings', () => {
      expect(previewHeading([], 'person@example.com'))
        .toBe('This account holds no role assignments RuleBeat can see, so person@example.com would see no findings.');
    });

    it('counts the Scopes the person would get', () => {
      const scope = { scope: '/subscriptions/x', origins: [] };
      expect(previewHeading([scope], 'person@example.com')).toBe('person@example.com would get 1 Scope.');
      expect(previewHeading([scope, scope], 'person@example.com')).toBe('person@example.com would get 2 Scopes.');
    });
  });

  describe('replacesManualNote', () => {
    const grant = { tenantId: '', scope: { kind: 'everything' as const, path: '/' }, role: 'viewer' as const };

    it('says the Manual Scopes will be replaced when the person holds some', () => {
      expect(replacesManualNote({ grants: [grant], source: 'manual' })).toBe('Their 1 Manual Scope will be replaced.');
      expect(replacesManualNote({ grants: [grant, grant], source: 'manual' })).toBe('Their 2 Manual Scopes will be replaced.');
    });

    it('says nothing for a person with no Scope, or whose Scopes are mirrored', () => {
      expect(replacesManualNote({ grants: [], source: 'manual' })).toBeNull();
      expect(replacesManualNote({ grants: [grant], source: 'mirrored' })).toBeNull();
    });
  });

  describe('alsoLinkedNote', () => {
    it('names who else is linked to the account, and says nothing when no one is', () => {
      expect(alsoLinkedNote([])).toBeNull();
      expect(alsoLinkedNote([{ email: 'a@example.com' }])).toMatch(/^a@example\.com is already linked to this account/);
      expect(alsoLinkedNote([{ email: 'a@example.com' }, { email: 'b@example.com' }])).toMatch(/^a@example\.com, b@example\.com are already linked/);
    });
  });

  it('tells an Admin editing a mirrored person that saving stops the mirror', () => {
    expect(EDIT_STOPS_MIRROR_NOTE).toMatch(/stops the mirror/);
    expect(EDIT_STOPS_MIRROR_NOTE).toMatch(/Manual access/);
  });
});

describe('what the Access page says about a mirror (#278)', () => {
  const format = (iso: string): string => `<${iso}>`;
  const OK_AT = '2026-06-02T00:00:00.000Z';
  const FAIL_AT = '2026-06-03T00:00:00.000Z';

  it('says when the last refresh worked', () => {
    expect(describeMirrorStatus({ lastSuccessAt: OK_AT, lastAttemptAt: OK_AT, error: null }, format)).toBe(`Last refreshed <${OK_AT}>.`);
  });

  it('says it has not been refreshed yet, in words that point at Refresh', () => {
    expect(describeMirrorStatus(NEVER_MIRRORED, format)).toMatch(/Not refreshed yet\. Use Refresh/);
  });

  it('says a failed refresh failed, when it was tried, why in a stable sentence, and that the Scopes shown are the last ones that loaded', () => {
    const text = describeMirrorStatus({ lastSuccessAt: OK_AT, lastAttemptAt: FAIL_AT, error: mirrorError('failed') }, format);
    expect(text).toContain(`The last refresh failed on <${FAIL_AT}>.`);
    expect(text).toContain(MIRROR_FAILED_MESSAGE);
    expect(text).toContain(`The Scopes shown are the last ones that loaded, on <${OK_AT}>.`);
  });

  it('says no Scopes have loaded when the first refresh failed', () => {
    const text = describeMirrorStatus({ lastSuccessAt: null, lastAttemptAt: FAIL_AT, error: mirrorError('throttled') }, format);
    expect(text).toContain('No Scopes have loaded yet.');
    expect(text).toContain('slow down');
  });

  it('names the Azure role for a Scope, and says "through a group" or "eligible" only where recorded', () => {
    const plain = { roleName: 'Reader', throughGroup: false, eligible: false };
    expect(describeOrigin(plain)).toBe('Reader');
    expect(describeOrigin({ ...plain, throughGroup: true })).toBe('Reader (through a group)');
    expect(describeOrigin({ ...plain, eligible: true })).toBe('Reader (eligible)');
    expect(describeOrigin({ ...plain, throughGroup: true, eligible: true })).toBe('Reader (through a group, eligible)');
    expect(describeOrigins([plain, { roleName: 'Owner', throughGroup: true, eligible: false }])).toBe('Reader, Owner (through a group)');
  });

  it('reads stored origins back, and reads anything that is not the shape written as none', () => {
    const origins = [{ roleName: 'Reader', throughGroup: true, eligible: false }];
    expect(parseOrigins(serializeOrigins(origins))).toEqual(origins);
    expect(serializeOrigins([])).toBeNull();
    expect(serializeOrigins(undefined)).toBeNull();
    for (const raw of [null, undefined, '', 'not json', '{}', '[1, "x", {"roleName": 3}]']) expect(parseOrigins(raw), String(raw)).toEqual([]);
  });

  it('turns every stable code into a message that names no tenant, subscription or account', () => {
    for (const code of ['azure_not_configured', 'throttled', 'failed'] as const) {
      const { message } = mirrorError(code);
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toMatch(/0000|\/subscriptions/);
    }
  });
});
