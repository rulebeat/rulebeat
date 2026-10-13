/**
 * #272: what the Access page's Scope picker does to the list it edits. Pure, so no rendering: a Scope is
 * held once whatever its casing, taking the Role the person-level select names, and a list read from a
 * person's access leaves out what cannot be saved.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, parseScope, type ManualGrant } from '@/lib/access-model';
import {
  canInvite, describeScopePath, grantsOfAccess, heldAt, resourceGroupScopePath, resourceGroupsHeld, setEveryRole, setGrantRole,
  subscriptionScopePath, subscriptionsNamed, toggleGrant,
} from '@/lib/access-picker';

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
  it('keeps each Scope with its Role and leaves out a management group, which cannot be saved yet', () => {
    const access = buildAccess([
      { tenantId: 't', scope: parseScope(subscriptionScopePath(SUB))!, role: 'viewer' },
      { tenantId: 't', scope: parseScope('/providers/Microsoft.Management/managementGroups/mg')!, role: 'viewer' },
      { tenantId: 't', scope: parseScope('@directory')!, role: 'editor' },
    ], 'manual');
    expect(grantsOfAccess(access)).toEqual([
      { scope: subscriptionScopePath(SUB), role: 'viewer' }, { scope: '@directory', role: 'editor' },
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
