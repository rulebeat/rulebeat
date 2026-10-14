/**
 * #272: what the Access page's Scope picker does to the list it edits. Pure, so no rendering: a Scope is
 * held once whatever its casing, taking the Role the person-level select names, and a list read from a
 * person's access leaves out what cannot be saved.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, parseScope, type ManualGrant } from '@/lib/access-model';
import {
  alsoLinkedNote, canInvite, canInviteMirrored, canPreviewMirror, canUseSignInAccount, EDIT_STOPS_MIRROR_NOTE, previewHeading, replacesManualNote,
  describeScopePath, grantsOfAccess, heldAt, resourceGroupScopePath, resourceGroupsHeld, setEveryRole, setGrantRole,
  pickerGroups, subscriptionScopePath, subscriptionsNamed, toggleGrant,
} from '@/lib/access-picker';

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

  it('finds the resource groups held in one subscription and the subscriptions a list names', () => {
    const list: ManualGrant[] = [
      { scope: resourceGroupScopePath(SUB, 'rg-one'), role: 'viewer' },
      { scope: resourceGroupScopePath(SUB.toUpperCase(), 'rg-two'), role: 'viewer' },
      { scope: resourceGroupScopePath(OTHER, 'rg-one'), role: 'editor' },
      { scope: subscriptionScopePath(OTHER), role: 'viewer' },
      { scope: '/', role: 'viewer' },
    ];
    expect(resourceGroupsHeld(list, SUB)).toEqual(['rg-one', 'rg-two']);
    expect(resourceGroupsHeld(list, OTHER)).toEqual(['rg-one']);
    expect(subscriptionsNamed(list)).toEqual([SUB, OTHER]);
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

describe('the management groups the picker lists (#273)', () => {
  const T = 'tenant-one';
  const node = (id: string, name: string, parentId: string | null, kind: 'managementGroup' | 'subscription' = 'managementGroup') => ({ id, kind, name, parentId });
  const loaded = { lastSuccessAt: '2026-06-02T00:00:00.000Z', lastAttemptAt: '2026-06-02T00:00:00.000Z', error: null };
  const view = {
    nodes: [node(T, 'Root', null), node('mg-b', 'Beta', T), node('mg-a', 'Alpha', T), node('mg-a-child', 'Under alpha', 'mg-a'), node('sub-1', 'One', 'mg-a', 'subscription')],
    status: loaded,
  };

  it('lists every management group in tree order with its depth, and no subscription', () => {
    const { groups, reason } = pickerGroups(view, []);
    expect(groups.map(g => [g.id, g.name, g.depth, g.missing])).toEqual([
      [T, 'Root', 0, false], ['mg-a', 'Alpha', 1, false], ['mg-a-child', 'Under alpha', 2, false], ['mg-b', 'Beta', 1, false],
    ]);
    expect(groups[1]!.path).toBe('/providers/Microsoft.Management/managementGroups/mg-a');
    expect(reason).toBeNull();
  });

  it('lists a held group the tree does not have after the others, so it can be removed', () => {
    const held: ManualGrant[] = [
      { scope: '/providers/Microsoft.Management/managementGroups/mg-gone', role: 'editor' },
      { scope: '/providers/Microsoft.Management/managementGroups/MG-A', role: 'viewer' },
      { scope: '/subscriptions/00000000-0000-0000-0000-00000000000a', role: 'viewer' },
    ];
    const { groups } = pickerGroups(view, held);
    expect(groups.map(g => [g.id, g.missing])).toEqual([
      [T, false], ['mg-a', false], ['mg-a-child', false], ['mg-b', false], ['mg-gone', true],
    ]);
    expect(groups.at(-1)!.path).toBe(held[0]!.scope);
  });

  it('lists a held group when there is no tree at all, and still says why the tree is empty', () => {
    const held: ManualGrant[] = [{ scope: '/providers/Microsoft.Management/managementGroups/mg-gone', role: 'viewer' }];
    const { groups, reason } = pickerGroups({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: null, error: null } }, held);
    expect(groups.map(g => [g.id, g.missing])).toEqual([['mg-gone', true]]);
    expect(reason).toMatch(/has not been loaded yet/);
  });

  it('says why it lists none: never refreshed, the last refresh failed, or Azure is not connected', () => {
    const reasons = [
      pickerGroups({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: null, error: null } }, []).reason,
      pickerGroups({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: 'A', error: { code: 'failed', message: 'x' } } }, []).reason,
      pickerGroups({ nodes: [], status: { lastSuccessAt: null, lastAttemptAt: 'A', error: { code: 'azure_not_configured', message: 'x' } } }, []).reason,
    ];
    expect(reasons.every(r => typeof r === 'string' && r.length > 0)).toBe(true);
    expect(new Set(reasons).size).toBe(3);
  });

  it('names a management group by its display name when it has one', () => {
    const path = '/providers/Microsoft.Management/managementGroups/mg-a';
    expect(describeScopePath(path)).toBe('Management group mg-a');
    expect(describeScopePath(path, { 'mg-a': 'Alpha' })).toBe('Management group Alpha');
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
