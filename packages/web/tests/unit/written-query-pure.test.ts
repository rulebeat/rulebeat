/**
 * #277: the pure decision behind every written-query route. The route tests in
 * `written-query-access.test.ts` are the contract; these pin the edges the routes do not each reach.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import type { Role } from '@/lib/rbac';
import {
  heldQueryScopes, mayQueryDirectory, mayQueryWorkspace, mayWriteQueries, needsWorkspaceLookup, queryScopeLimit,
  resourceGraphScope, writesNoQueries, NEEDS_SUBSCRIPTION_MESSAGE,
} from '@/lib/written-query';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SUB = 'aaaaaaaa-0000-0000-0000-00000000000a';
const OTHER = 'bbbbbbbb-0000-0000-0000-00000000000b';

function accessOf(...held: Array<[string, Role]>): Access {
  return buildAccess(held.map(([path, role]) => ({ tenantId: TENANT, scope: parseScope(path)!, role })), 'manual');
}

describe('heldQueryScopes', () => {
  it('lists held subscriptions and management groups once each, in their stored casing', () => {
    const access = accessOf(
      [`/subscriptions/${SUB}`, 'editor'], [`/subscriptions/${SUB.toUpperCase()}`, 'editor'],
      ['/providers/Microsoft.Management/managementGroups/mg-example', 'editor'],
    );
    expect(heldQueryScopes(access)).toEqual({ subscriptions: [SUB], managementGroups: ['mg-example'] });
  });

  it('leaves out a resource group, the Directory, and anything held only as a Viewer', () => {
    const access = accessOf(
      [`/subscriptions/${OTHER}`, 'viewer'], [`/subscriptions/${SUB}/resourceGroups/rg-one`, 'editor'], ['@directory', 'editor'],
    );
    expect(heldQueryScopes(access)).toEqual({ subscriptions: [], managementGroups: [] });
  });
});

describe('who writes no queries', () => {
  it('is a person with only resource groups, or nothing, and nobody holding a subscription, a management group, the Directory or Everything', () => {
    expect(writesNoQueries(accessOf([`/subscriptions/${SUB}/resourceGroups/rg-one`, 'editor']))).toBe(true);
    expect(writesNoQueries(accessOf())).toBe(true);
    expect(writesNoQueries(accessOf([`/subscriptions/${SUB}`, 'editor']))).toBe(false);
    expect(writesNoQueries(accessOf(['@directory', 'editor']))).toBe(false);
    expect(writesNoQueries(everythingAccess('editor', 'manual'))).toBe(false);
  });

  it('refuses with the subscription message', () => {
    expect(mayWriteQueries(accessOf())).toEqual({ ok: false, error: NEEDS_SUBSCRIPTION_MESSAGE });
  });
});

describe('queryScopeLimit', () => {
  it('is null for Everything and what is held for anyone else', () => {
    expect(queryScopeLimit(everythingAccess('editor', 'manual'))).toBeNull();
    expect(queryScopeLimit(accessOf([`/subscriptions/${SUB}`, 'editor']))).toEqual({ subscriptions: [SUB], managementGroups: [] });
  });
});

describe('resourceGraphScope', () => {
  const access = accessOf([`/subscriptions/${SUB}`, 'editor']);

  it('hands an Everything request back untouched, absent staying absent', () => {
    const everything = everythingAccess('editor', 'manual');
    expect(resourceGraphScope(everything, undefined)).toEqual({ ok: true, scope: undefined });
    const requested = { subscriptions: [OTHER] };
    expect(resourceGraphScope(everything, requested)).toEqual({ ok: true, scope: requested });
  });

  it('never returns an empty scope', () => {
    for (const requested of [undefined, {}, { subscriptions: [] }, { subscriptions: [SUB] }]) {
      const out = resourceGraphScope(access, requested);
      expect(out).toEqual({ ok: true, scope: { subscriptions: [SUB] } });
    }
    expect(resourceGraphScope(access, { subscriptions: [OTHER] }).ok).toBe(false);
  });

  it('refuses a person who holds only the Directory, since there is nothing to send', () => {
    expect(resourceGraphScope(accessOf(['@directory', 'editor']), undefined)).toEqual({ ok: false, error: NEEDS_SUBSCRIPTION_MESSAGE });
  });
});

describe('the Directory and the workspace', () => {
  it('needs the Directory for Microsoft Graph', () => {
    expect(mayQueryDirectory(accessOf(['@directory', 'editor'])).ok).toBe(true);
    expect(mayQueryDirectory(accessOf([`/subscriptions/${SUB}`, 'editor'])).ok).toBe(false);
  });

  it('looks the workspace up for everyone but Everything, and covers a resource group by its subscription', () => {
    expect(needsWorkspaceLookup(everythingAccess('editor', 'manual'))).toBe(false);
    const access = accessOf([`/subscriptions/${SUB}`, 'editor']);
    expect(needsWorkspaceLookup(access)).toBe(true);
    expect(mayQueryWorkspace(access, { subscriptionId: SUB, resourceGroup: 'rg-one' }).ok).toBe(true);
    expect(mayQueryWorkspace(access, { subscriptionId: OTHER, resourceGroup: 'rg-one' }).ok).toBe(false);
    expect(mayQueryWorkspace(access, null).ok).toBe(false);
  });
});
