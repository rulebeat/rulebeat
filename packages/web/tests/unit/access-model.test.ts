/**
 * #269: the Scope parser and the Access value. Pure, so no database: a stored path reads into a kind,
 * a resource-level path is refused, case is ignored in comparison and kept in storage, and the label
 * the Access page shows is built in one place.
 */
import { describe, expect, it } from 'vitest';
import {
  grantCovers, type ScopeGrant,
  buildAccess, collapseGrants, describeAccess, everythingAccess, highestRole, MAX_MANUAL_GRANTS, parseManualAccess, parseScope, sameScopePath, scopeCovers,
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

describe('parseManualAccess (#272)', () => {
  const rg = `${SUB}/resourceGroups/rg-app`;

  it('reads a list of Scopes with a Role each', () => {
    const result = parseManualAccess([
      { scope: '/', role: 'viewer' }, { scope: DIRECTORY_SCOPE_PATH, role: 'editor' }, { scope: SUB, role: 'viewer' }, { scope: rg, role: 'editor' },
    ]);
    expect(result).toEqual({ ok: true, grants: [
      { scope: '/', role: 'viewer' }, { scope: DIRECTORY_SCOPE_PATH, role: 'editor' }, { scope: SUB, role: 'viewer' }, { scope: rg, role: 'editor' },
    ] });
  });

  it('carries only a path and a Role: a tenant id in the request is dropped', () => {
    const result = parseManualAccess([{ scope: SUB, role: 'viewer', tenantId: 'other', userId: 'x' }]);
    expect(result).toEqual({ ok: true, grants: [{ scope: SUB, role: 'viewer' }] });
  });

  it('refuses each thing that is not storable, with a message that names no path', () => {
    const refused = (input: unknown) => (parseManualAccess(input) as { ok: false; error: string }).error;
    expect(refused('/')).toBe('Access must be a list of scopes.');
    expect(refused([{ scope: `${rg}/providers/Microsoft.Compute/virtualMachines/vm-1`, role: 'viewer' }]))
      .toBe('A scope must be Everything, the Directory, a management group, a subscription or a resource group.');
    expect(refused([{ scope: 'not a scope', role: 'viewer' }])).toBe('A scope must be Everything, the Directory, a management group, a subscription or a resource group.');
    expect(refused([{ scope: SUB, role: 'admin' }])).toBe('The Admin Role cannot be given at a scope.');
    expect(refused([{ scope: SUB, role: 'owner' }])).toBe('Choose Viewer or Editor for each scope.');
    expect(refused([{ scope: SUB }])).toBe('Each scope needs a path and a Role.');
    expect(refused([null])).toBe('Each scope needs a path and a Role.');
    expect(refused(Array.from({ length: MAX_MANUAL_GRANTS + 1 }, () => ({ scope: '/', role: 'viewer' })))).toMatch(/at most/);
  });

  it('accepts an empty list: that is a person who holds nothing', () => {
    expect(parseManualAccess([])).toEqual({ ok: true, grants: [] });
  });

  it('stores a Scope listed twice, in any casing, once at the higher Role', () => {
    expect(parseManualAccess([{ scope: SUB, role: 'viewer' }, { scope: SUB.toUpperCase(), role: 'editor' }]))
      .toEqual({ ok: true, grants: [{ scope: SUB, role: 'editor' }] });
    expect(parseManualAccess([{ scope: SUB, role: 'editor' }, { scope: SUB.toUpperCase(), role: 'viewer' }]))
      .toEqual({ ok: true, grants: [{ scope: SUB, role: 'editor' }] });
  });
});

describe('highestRole and collapseGrants (#272)', () => {
  it('is an Editor when any Role is, and a Viewer otherwise, including when there is none', () => {
    expect(highestRole([{ role: 'viewer' }, { role: 'editor' }])).toBe('editor');
    expect(highestRole([{ role: 'viewer' }])).toBe('viewer');
    expect(highestRole([])).toBe('viewer');
  });

  it('keeps one entry a Scope and the first casing', () => {
    expect(collapseGrants([{ scope: '/A', role: 'viewer' as const }, { scope: '/a', role: 'editor' as const }, { scope: '/b', role: 'viewer' as const }]))
      .toEqual([{ scope: '/A', role: 'editor' }, { scope: '/b', role: 'viewer' }]);
  });
});

describe('a management group Scope (#273)', () => {
  const T = 'tenant-one';
  const grantOf = (path: string, role: 'viewer' | 'editor' = 'viewer'): ScopeGrant => ({ tenantId: T, scope: parseScope(path)!, role });
  const SUB_IN = '/subscriptions/00000000-0000-0000-0000-00000000000a';
  const expansion = (role: 'viewer' | 'editor' = 'viewer') => ({
    tenantId: T, path: MG, role, groups: ['mg-platform', 'mg-child'], subscriptions: ['00000000-0000-0000-0000-00000000000a'],
  });

  it('is accepted by parseManualAccess, with its path as sent', () => {
    expect(parseManualAccess([{ scope: MG, role: 'editor' }])).toEqual({ ok: true, grants: [{ scope: MG, role: 'editor' }] });
    expect(parseManualAccess([{ scope: MG.toUpperCase().replace('/PROVIDERS', '/providers'), role: 'viewer' }]).ok).toBe(true);
  });

  it('is held once, at the higher Role, when listed twice in different cases', () => {
    const result = parseManualAccess([{ scope: MG, role: 'viewer' }, { scope: MG.toLowerCase(), role: 'editor' }]);
    expect(result).toEqual({ ok: true, grants: [{ scope: MG, role: 'editor' }] });
  });

  it('builds an Access that keeps the stored grant and carries its expansion beside it', () => {
    const access = buildAccess([grantOf(MG)], 'manual', [expansion()]);
    expect(access.grants.map(g => g.scope.path)).toEqual([MG]);
    expect(access.managementGroups).toEqual([expansion()]);
    expect(buildAccess([grantOf(MG)], 'manual').managementGroups).toEqual([]);
    expect(everythingAccess('admin').managementGroups).toEqual([]);
  });

  describe('grantCovers', () => {
    const access = buildAccess([grantOf(MG, 'editor')], 'manual', [expansion('editor')]);
    const covers = (path: string) => grantCovers(access, access.grants[0]!, parseScope(path)!);

    it('covers a subscription under it, a resource group in that subscription, and itself and a group beneath it', () => {
      expect(covers(SUB_IN)).toBe(true);
      expect(covers(`${SUB_IN}/resourceGroups/rg-app`)).toBe(true);
      expect(covers(MG)).toBe(true);
      expect(covers('/providers/Microsoft.Management/managementGroups/mg-child')).toBe(true);
    });

    it('does not cover a subscription outside it, a group above it, the Directory, or Everything', () => {
      expect(covers('/subscriptions/00000000-0000-0000-0000-00000000000b')).toBe(false);
      expect(covers('/providers/Microsoft.Management/managementGroups/mg-above')).toBe(false);
      expect(covers('@directory')).toBe(false);
      expect(covers('/')).toBe(false);
    });

    it('compares ids without regard to case', () => {
      expect(covers('/SUBSCRIPTIONS/00000000-0000-0000-0000-00000000000A/RESOURCEGROUPS/Rg')).toBe(true);
      expect(covers('/providers/microsoft.management/managementgroups/MG-CHILD')).toBe(true);
    });

    it('takes the expansion of this grant and no other: a different Role or tenant is a different grant', () => {
      const other = buildAccess([{ ...grantOf(MG, 'viewer'), tenantId: 'tenant-two' }], 'manual', [expansion('viewer')]);
      expect(grantCovers(other, other.grants[0]!, parseScope(SUB_IN)!)).toBe(false);
    });

    it('still lets every other kind of grant decide by its Scope alone', () => {
      const sub = buildAccess([grantOf(SUB_IN)], 'manual');
      expect(grantCovers(sub, sub.grants[0]!, parseScope(`${SUB_IN}/resourceGroups/rg-app`)!)).toBe(true);
      expect(grantCovers(sub, sub.grants[0]!, parseScope(MG)!)).toBe(false);
    });
  });
});
