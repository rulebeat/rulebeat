/**
 * #281: the scope a copy of a shared rule starts with. Pure: no database. The contract is that the stored
 * scope holds only what the author holds, in the held casing, and that a Run of the copy is never refused
 * for naming nothing the author holds.
 */
import { describe, expect, it } from 'vitest';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';
import type { Role } from '@/lib/rbac';
import { copyScopeFor, planPersonalRun } from '@/lib/personal-rule-run';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SUB_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const SUB_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const MG = '/providers/Microsoft.Management/managementGroups/';

function accessOf(...held: Array<[string, Role]>): Access {
  return buildAccess(held.map(([path, role]) => ({ tenantId: TENANT, scope: parseScope(path)!, role })), 'manual');
}

describe('copyScopeFor', () => {
  it('keeps the entries the author holds and drops the rest', () => {
    const access = accessOf([`/subscriptions/${SUB_A}`, 'editor']);
    expect(copyScopeFor({ level: 'subscription', subscriptions: [SUB_A, SUB_B] }, access))
      .toEqual({ level: 'subscription', subscriptions: [SUB_A], managementGroups: [] });
  });

  it('matches ignoring case and stores the held casing', () => {
    const access = accessOf([`/subscriptions/${SUB_A}`, 'editor']);
    const scope = copyScopeFor({ level: 'subscription', subscriptions: [SUB_A.toUpperCase()] }, access);
    expect(scope.subscriptions).toEqual([SUB_A]);
  });

  it('does the same for management groups', () => {
    const access = accessOf([`${MG}mg-held`, 'editor']);
    expect(copyScopeFor({ level: 'managementGroup', managementGroups: ['MG-HELD', 'mg-other'] }, access))
      .toEqual({ level: 'managementGroup', subscriptions: [], managementGroups: ['mg-held'] });
  });

  it('does not expand a held management group into the subscriptions under it', () => {
    const access = accessOf([`${MG}mg-held`, 'editor']);
    expect(copyScopeFor({ level: 'subscription', subscriptions: [SUB_A] }, access).subscriptions).toEqual([]);
  });

  it('keeps the source scope as it is for Everything', () => {
    const source = { level: 'subscription' as const, subscriptions: [SUB_A, SUB_B], managementGroups: ['mg-example'] };
    expect(copyScopeFor(source, everythingAccess('editor', 'manual'))).toEqual(source);
  });

  it('leaves an absent list absent for Everything', () => {
    expect(copyScopeFor({ level: 'subscription' }, everythingAccess('editor', 'manual'))).toEqual({ level: 'subscription' });
  });

  it('stores empty lists when the source names nothing, never the author\'s access', () => {
    const access = accessOf([`/subscriptions/${SUB_A}`, 'editor']);
    expect(copyScopeFor({ level: 'subscription' }, access)).toEqual({ level: 'subscription', subscriptions: [], managementGroups: [] });
  });

  it('stores empty lists when nothing overlaps', () => {
    const access = accessOf([`/subscriptions/${SUB_A}`, 'editor']);
    expect(copyScopeFor({ level: 'subscription', subscriptions: [SUB_B] }, access))
      .toEqual({ level: 'subscription', subscriptions: [], managementGroups: [] });
  });

  it('does not count a subscription held only as a Viewer', () => {
    const access = accessOf([`/subscriptions/${SUB_A}`, 'viewer'], [`/subscriptions/${SUB_B}`, 'editor']);
    expect(copyScopeFor({ level: 'subscription', subscriptions: [SUB_A, SUB_B] }, access).subscriptions).toEqual([SUB_B]);
  });

  it('keeps the level and never stores outsideAccess', () => {
    const access = accessOf([`/subscriptions/${SUB_A}`, 'editor']);
    const source = { level: 'resourceGroup' as const, subscriptions: [SUB_A], outsideAccess: 4 } as Parameters<typeof copyScopeFor>[0];
    const scope = copyScopeFor(source, access);
    expect(scope.level).toBe('resourceGroup');
    expect(scope).not.toHaveProperty('outsideAccess');
  });

  it('gives a scope a Run is never refused for, whatever the source named', () => {
    const access = accessOf([`/subscriptions/${SUB_A}`, 'editor']);
    for (const subscriptions of [[SUB_A, SUB_B], [SUB_B], []]) {
      const scope = copyScopeFor({ level: 'subscription', subscriptions }, access);
      expect(planPersonalRun({ queryBackend: 'resource-graph', scope }, access).ok).toBe(true);
    }
  });
});
