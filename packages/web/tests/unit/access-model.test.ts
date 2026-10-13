/**
 * #269: the Scope parser and the Access value. Pure, so no database: a stored path reads into a kind,
 * a resource-level path is refused, case is ignored in comparison and kept in storage, and the label
 * the Access page shows is built in one place.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAccess, describeAccess, everythingAccess, parseScope, sameScopePath, scopeCovers,
  DIRECTORY_SCOPE_PATH, EVERYTHING_SCOPE_PATH, EVERYTHING_TENANT_ID,
} from '@/lib/access-model';

const SUB = '/subscriptions/00000000-0000-0000-0000-000000000000';
const MG = '/providers/Microsoft.Management/managementGroups/mg-platform';

describe('parseScope', () => {
  it('reads each kind of Scope', () => {
    expect(parseScope('/')).toEqual({ kind: 'everything', path: '/' });
    expect(parseScope(DIRECTORY_SCOPE_PATH)).toEqual({ kind: 'directory', path: DIRECTORY_SCOPE_PATH });
    expect(parseScope(MG)?.kind).toBe('managementGroup');
    expect(parseScope(SUB)?.kind).toBe('subscription');
    expect(parseScope(`${SUB}/resourceGroups/rg-app`)?.kind).toBe('resourceGroup');
  });

  it('keeps the casing it was given', () => {
    expect(parseScope(`${SUB}/RESOURCEGROUPS/RG-App`)).toEqual({ kind: 'resourceGroup', path: `${SUB}/RESOURCEGROUPS/RG-App` });
    expect(parseScope('/SUBSCRIPTIONS/ABC')?.path).toBe('/SUBSCRIPTIONS/ABC');
  });

  it('reads the same kind whatever the casing', () => {
    expect(parseScope(MG.toLowerCase())?.kind).toBe('managementGroup');
    expect(parseScope(`${SUB}/resourcegroups/RG`)?.kind).toBe('resourceGroup');
  });

  it('refuses a resource-level path, because the smallest Scope is a resource group', () => {
    expect(parseScope(`${SUB}/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm-1`)).toBeNull();
  });

  it('refuses anything else', () => {
    for (const bad of ['', ' ', '//', `${SUB}/`, '/subscriptions', '/subscriptions//resourceGroups/x', 'subscriptions/abc',
      '/providers/Microsoft.Foo/things/t1', '@elsewhere', null, undefined, 5, {}]) {
      expect(parseScope(bad), String(bad)).toBeNull();
    }
  });

  it('keeps the Directory marker from ever being an ARM path', () => {
    expect(DIRECTORY_SCOPE_PATH.startsWith('/')).toBe(false);
    expect(EVERYTHING_SCOPE_PATH).toBe('/');
    expect(EVERYTHING_TENANT_ID).toBe('');
  });
});

describe('sameScopePath', () => {
  it('compares paths without regard to case', () => {
    expect(sameScopePath(SUB, SUB.toUpperCase())).toBe(true);
    expect(sameScopePath(SUB, `${SUB}x`)).toBe(false);
  });
});

describe('buildAccess and everythingAccess', () => {
  it('sets the Everything and Directory flags from the grants', () => {
    const grants = [
      { tenantId: '', scope: parseScope('/')!, role: 'viewer' as const },
      { tenantId: 't', scope: parseScope(DIRECTORY_SCOPE_PATH)!, role: 'viewer' as const },
    ];
    expect(buildAccess(grants, 'manual')).toMatchObject({ everything: true, directory: true, source: 'manual' });
    expect(buildAccess([grants[1]!], 'mirrored')).toMatchObject({ everything: false, directory: true, source: 'mirrored' });
    expect(buildAccess([], 'manual')).toMatchObject({ everything: false, directory: false, grants: [] });
  });

  it('builds Everything with the empty tenant id', () => {
    const access = everythingAccess('editor', 'manual');
    expect(access.grants).toEqual([{ tenantId: '', scope: { kind: 'everything', path: '/' }, role: 'editor' }]);
    expect(access).toMatchObject({ everything: true, directory: false, source: 'manual' });
  });
});

describe('scopeCovers', () => {
  it('lets Everything cover any placement and a subscription cover its own resource groups', () => {
    const rg = parseScope(`${SUB}/resourceGroups/rg-app`)!;
    expect(scopeCovers(parseScope('/')!, rg)).toBe(true);
    expect(scopeCovers(parseScope(SUB)!, rg)).toBe(true);
    expect(scopeCovers(parseScope(SUB.toUpperCase())!, rg)).toBe(true);
    expect(scopeCovers(parseScope('/subscriptions/11111111-1111-1111-1111-111111111111')!, rg)).toBe(false);
    expect(scopeCovers(rg, parseScope(SUB)!)).toBe(false);
    expect(scopeCovers(parseScope(DIRECTORY_SCOPE_PATH)!, rg)).toBe(false);
  });
});

describe('describeAccess', () => {
  it('reads "Everything, manual" for a Viewer or Editor on Everything', () => {
    expect(describeAccess(everythingAccess('viewer', 'manual'))).toBe('Everything, manual');
    expect(describeAccess(everythingAccess('editor', 'manual'))).toBe('Everything, manual');
  });

  it('reads "Everything" for an Admin, who has no source', () => {
    expect(describeAccess(everythingAccess('admin'))).toBe('Everything');
  });

  it('gives a person with no Scope a short non-blank label', () => {
    expect(describeAccess(buildAccess([], 'manual'))).toBe('No access, manual');
    expect(describeAccess(buildAccess([], null))).toBe('No access');
  });

  it('counts the Scopes of a person who is narrower than Everything', () => {
    const one = buildAccess([{ tenantId: 't', scope: parseScope(SUB)!, role: 'editor' }], 'manual');
    expect(describeAccess(one)).toBe('1 scope, manual');
    const two = buildAccess([...one.grants, { tenantId: 't', scope: parseScope(MG)!, role: 'viewer' }], 'mirrored');
    expect(describeAccess(two)).toBe('2 scopes, mirrored');
  });
});
