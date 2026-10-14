/**
 * TS-04 · Permission enforcement: the `can(role, action)` half.
 *
 * This is written as an exhaustive table rather than a handful of spot checks on purpose. A spot
 * check proves a permission was granted; only the full grid proves nothing *extra* was granted.
 * Adding a new action without deciding which roles get it will fail here, which is the point.
 */
import { describe, expect, it } from 'vitest';
import { expandManagementGroups } from '@/lib/management-group-tree';
import {
  ALL_ACTIONS as MODEL_ALL_ACTIONS, ACTION_CLASS, can, isRole, mayAct, ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS,
  type Action, type Role,
} from '@/lib/rbac';
import { buildAccess, everythingAccess, parseScope, type Access } from '@/lib/access-model';

/** The authorization model, restated independently of the implementation. */
const EXPECTED: Record<Role, Action[]> = {
  // account:self (manage your own password) sits outside the read/write ladder. Every real role
  // gets it, so it's listed on all three rather than folded into 'read'.
  viewer: ['read', 'account:self'],
  editor: [
    'read',
    'account:self',
    'rules:write',
    'rules:delete',
    'rules:validate',
    'scans:run',
    'schedules:write',
    'suppressions:write',
    'dashboards:write',
    'views:write',
    'schemas:refresh',
  ],
  admin: [
    'read',
    'account:self',
    'rules:write',
    'rules:delete',
    'rules:validate',
    'scans:run',
    'schedules:write',
    'suppressions:write',
    'dashboards:write',
    'views:write',
    'schemas:refresh',
    'categories:write',
    'users:manage',
    'audit:read',
    'azure:manage',
    'auth:manage',
    'notifications:manage',
    'rules:version',
  ],
};

const ALL_ACTIONS = [...new Set(Object.values(EXPECTED).flat())].sort();

it('EXPECTED accounts for every action the real permission model defines', async () => {
  // Closes the gap structurally: azure:manage was missing from this table's admin row for a
  // while and nothing caught it, because ALL_ACTIONS above is derived from EXPECTED rather than
  // from the model. Comparing against lib/rbac's own exported list means a new action added there
  // without updating this table now fails immediately instead of silently granting nothing.
  expect(ALL_ACTIONS).toEqual([...MODEL_ALL_ACTIONS].sort());
});

describe('TS-04 · the role → action grid', () => {
  it('04-00 · covers every role the product defines', async () => {
    expect([...ROLES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  // One test per role/action pair: 36 assertions, each individually named, so a failure says
  // exactly which permission moved rather than "the matrix changed".
  for (const role of Object.keys(EXPECTED) as Role[]) {
    describe(role, () => {
      for (const action of ALL_ACTIONS) {
        const allowed = EXPECTED[role].includes(action);
        it(`${allowed ? 'may' : 'may NOT'} ${action}`, async () => {
          expect(can(role, action)).toBe(allowed);
        });
      }
    });
  }
});

describe('TS-04 · role escalation is impossible through the model itself', () => {
  it('04-01 · a viewer may only read and manage their own password', async () => {
    const granted = ALL_ACTIONS.filter(a => can('viewer', a));
    expect(granted.sort()).toEqual(['account:self', 'read']);
  });

  it('04-11 · an editor may not manage categories, users or the audit log', async () => {
    expect(can('editor', 'categories:write')).toBe(false);
    expect(can('editor', 'users:manage')).toBe(false);
    expect(can('editor', 'audit:read')).toBe(false);
  });

  it('every editor permission is also an admin permission', async () => {
    for (const action of EXPECTED.editor) expect(can('admin', action)).toBe(true);
  });

  it('every viewer permission is also an editor permission', async () => {
    for (const action of EXPECTED.viewer) expect(can('editor', action)).toBe(true);
  });

  it('an unknown role is granted nothing, rather than defaulting to a real role', async () => {
    for (const action of ALL_ACTIONS) {
      expect(can('superuser' as Role, action)).toBe(false);
      expect(can('' as Role, action)).toBe(false);
    }
  });

  it('an unknown action is refused for every role, including admin', async () => {
    for (const role of ROLES) {
      expect(can(role, 'billing:write' as Action)).toBe(false);
    }
  });
});

describe('isRole', () => {
  it('accepts exactly the three real roles', async () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
  });

  it('rejects anything else, including near-misses and non-strings', async () => {
    for (const value of ['Admin', 'ADMIN', 'owner', '', ' viewer', null, undefined, 0, 1, {}, []]) {
      expect(isRole(value)).toBe(false);
    }
  });
});

describe('every role is presentable in the UI', () => {
  it('has a label and a description', async () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });
});

describe('action classes (#269)', () => {
  const EXPECTED_CLASS: Record<string, string[]> = {
    'install-administration': ['rules:version', 'categories:write', 'users:manage', 'audit:read', 'azure:manage', 'auth:manage', 'notifications:manage'],
    'install-wide': ['rules:write', 'rules:delete', 'schedules:write', 'dashboards:write', 'views:write', 'schemas:refresh'],
    placed: ['suppressions:write'],
    scoped: ['read', 'rules:validate', 'scans:run'],
    outside: ['account:self'],
  };

  it('gives every action exactly one class, as the model states it', () => {
    for (const [cls, actions] of Object.entries(EXPECTED_CLASS)) {
      for (const action of actions) expect(ACTION_CLASS[action as Action], action).toBe(cls);
    }
    expect(Object.keys(ACTION_CLASS).sort()).toEqual([...MODEL_ALL_ACTIONS].sort());
    expect(Object.values(EXPECTED_CLASS).flat().sort()).toEqual([...MODEL_ALL_ACTIONS].sort());
  });
});

describe('mayAct: may this access do this action (#269)', () => {
  const SUB = '/subscriptions/00000000-0000-0000-0000-000000000000';
  const OTHER_SUB = '/subscriptions/11111111-1111-1111-1111-111111111111';
  const everything = (role: Role): Access => everythingAccess(role, role === 'admin' ? null : 'manual');
  const onSubscription = (role: Role): Access => buildAccess(
    [{ tenantId: '', scope: { kind: 'subscription', path: SUB }, role }], 'manual');
  const none: Access = buildAccess([], 'manual');

  const table: Array<[string, Access, Action, boolean]> = [
    ['admin on Everything', everything('admin'), 'users:manage', true],
    ['editor on Everything', everything('editor'), 'users:manage', false],
    ['viewer on Everything', everything('viewer'), 'users:manage', false],
    ['editor on Everything, install administration', everything('editor'), 'azure:manage', false],
    ['editor on Everything, install-wide', everything('editor'), 'rules:write', true],
    ['viewer on Everything, install-wide', everything('viewer'), 'rules:write', false],
    ['editor on a subscription, install-wide', onSubscription('editor'), 'rules:write', false],
    ['editor on a subscription, schemas', onSubscription('editor'), 'schemas:refresh', false],
    ['editor on a subscription, scoped', onSubscription('editor'), 'scans:run', true],
    ['viewer on a subscription, scoped', onSubscription('viewer'), 'scans:run', false],
    ['editor on a subscription, placed, no placement', onSubscription('editor'), 'suppressions:write', true],
    ['viewer on a subscription, placed', onSubscription('viewer'), 'suppressions:write', false],
    ['editor on a subscription, read', onSubscription('editor'), 'read', true],
    ['no grants, read', none, 'read', true],
    ['no grants, scoped', none, 'scans:run', false],
    ['no grants, install-wide', none, 'rules:write', false],
    ['no grants, own account', none, 'account:self', true],
    ['viewer on Everything, own account', everything('viewer'), 'account:self', true],
  ];
  for (const [name, access, action, expected] of table) {
    it(`${name}: ${action} is ${expected ? 'allowed' : 'refused'}`, () => {
      expect(mayAct(access, action)).toBe(expected);
    });
  }

  it('narrows a placed action to the Scope that contains the placement', () => {
    const access = onSubscription('editor');
    const inside = parseScope(`${SUB}/resourceGroups/rg-app`)!;
    const outside = parseScope(`${OTHER_SUB}/resourceGroups/rg-app`)!;
    expect(mayAct(access, 'suppressions:write', inside)).toBe(true);
    expect(mayAct(access, 'suppressions:write', outside)).toBe(false);
    expect(mayAct(everything('editor'), 'suppressions:write', outside)).toBe(true);
  });

  it('lets a Viewer on a subscription who is an Editor on a resource group inside it act there, and nowhere else in the subscription', () => {
    const access = buildAccess([
      { tenantId: '', scope: parseScope(SUB)!, role: 'viewer' },
      { tenantId: '', scope: parseScope(`${SUB}/resourceGroups/rg-app`)!, role: 'editor' },
    ], 'manual');
    expect(mayAct(access, 'suppressions:write', parseScope(`${SUB}/resourceGroups/rg-app`)!)).toBe(true);
    expect(mayAct(access, 'suppressions:write', parseScope(`${SUB}/resourceGroups/rg-other`)!)).toBe(false);
    expect(mayAct(access, 'suppressions:write', parseScope(SUB)!)).toBe(false);
    expect(mayAct(access, 'suppressions:write', parseScope(`${OTHER_SUB}/resourceGroups/rg-app`)!)).toBe(false);
    // Scoped actions need the Role at any Scope that allows them, so the Editor row is enough.
    expect(mayAct(access, 'scans:run')).toBe(true);
    // Install-wide actions need Everything, whichever Roles are held below it.
    expect(mayAct(access, 'rules:write')).toBe(false);
  });

  it('agrees with can() for every action when the Role is held on Everything', () => {
    for (const role of ROLES) {
      for (const action of MODEL_ALL_ACTIONS) {
        expect(mayAct(everything(role), action), `${role} ${action}`).toBe(can(role, action));
      }
    }
  });
});

describe('mayAct for a management group Scope (#273)', () => {
  const TENANT = '00000000-0000-0000-0000-0000000000f0';
  const GROUP = '/providers/Microsoft.Management/managementGroups/mg-example';
  const SUB_IN = '00000000-0000-0000-0000-00000000000a';
  const SUB_OUT = '00000000-0000-0000-0000-00000000000b';
  const nodes = [
    { tenantId: TENANT, kind: 'managementGroup' as const, id: TENANT, name: 'Root', parentId: null },
    { tenantId: TENANT, kind: 'managementGroup' as const, id: 'mg-example', name: 'Example', parentId: TENANT },
    { tenantId: TENANT, kind: 'managementGroup' as const, id: 'mg-child', name: 'Child', parentId: 'mg-example' },
    { tenantId: TENANT, kind: 'subscription' as const, id: SUB_IN, name: 'In', parentId: 'mg-child' },
    { tenantId: TENANT, kind: 'subscription' as const, id: SUB_OUT, name: 'Out', parentId: TENANT },
  ];
  const holding = (role: Role, tenantId = TENANT): Access => {
    const grants = [{ tenantId, scope: parseScope(GROUP)!, role }];
    return buildAccess(grants, 'manual', expandManagementGroups(grants, nodes));
  };

  it('lets an Editor on a management group act on a subscription, a resource group or a group under it', () => {
    const editor = holding('editor');
    expect(mayAct(editor, 'suppressions:write', parseScope(`/subscriptions/${SUB_IN}`)!)).toBe(true);
    expect(mayAct(editor, 'suppressions:write', parseScope(`/subscriptions/${SUB_IN}/resourceGroups/rg-app`)!)).toBe(true);
    expect(mayAct(editor, 'suppressions:write', parseScope('/providers/Microsoft.Management/managementGroups/mg-child')!)).toBe(true);
    expect(mayAct(editor, 'suppressions:write', parseScope(GROUP)!)).toBe(true);
  });

  it('refuses outside it: another subscription, its resource group, a group above, and a group it does not hold', () => {
    const editor = holding('editor');
    expect(mayAct(editor, 'suppressions:write', parseScope(`/subscriptions/${SUB_OUT}`)!)).toBe(false);
    expect(mayAct(editor, 'suppressions:write', parseScope(`/subscriptions/${SUB_OUT}/resourceGroups/rg-app`)!)).toBe(false);
    expect(mayAct(editor, 'suppressions:write', parseScope(`/providers/Microsoft.Management/managementGroups/${TENANT}`)!)).toBe(false);
    expect(mayAct(editor, 'suppressions:write', parseScope('/providers/Microsoft.Management/managementGroups/mg-beside')!)).toBe(false);
    expect(mayAct(editor, 'suppressions:write', parseScope('@directory')!)).toBe(false);
  });

  it('compares ids without regard to case', () => {
    expect(mayAct(holding('editor'), 'suppressions:write', parseScope(`/SUBSCRIPTIONS/${SUB_IN.toUpperCase()}/resourcegroups/RG-App`)!)).toBe(true);
    expect(mayAct(holding('editor'), 'suppressions:write', parseScope('/providers/microsoft.management/managementgroups/MG-CHILD')!)).toBe(true);
  });

  it('asks for the Role as well as the Scope: a Viewer on the group may not suppress', () => {
    expect(mayAct(holding('viewer'), 'suppressions:write', parseScope(`/subscriptions/${SUB_IN}`)!)).toBe(false);
  });

  it('covers nothing for a grant under another tenant, and nothing install-wide', () => {
    expect(mayAct(holding('editor', 'other-tenant'), 'suppressions:write', parseScope(`/subscriptions/${SUB_IN}`)!)).toBe(false);
    expect(mayAct(holding('editor'), 'rules:write')).toBe(false);
  });

  it('covers nothing for a grant that carries no expansion: it fails closed', () => {
    const bare = buildAccess([{ tenantId: TENANT, scope: parseScope(GROUP)!, role: 'editor' }], 'manual');
    expect(mayAct(bare, 'suppressions:write', parseScope(`/subscriptions/${SUB_IN}`)!)).toBe(false);
    expect(mayAct(bare, 'suppressions:write', parseScope(GROUP)!)).toBe(false);
  });
});
