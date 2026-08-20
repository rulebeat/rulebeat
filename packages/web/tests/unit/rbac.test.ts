/**
 * TS-04 · Permission enforcement — the `can(role, action)` half.
 *
 * This is written as an exhaustive table rather than a handful of spot checks on purpose. A spot
 * check proves a permission was granted; only the full grid proves nothing *extra* was granted.
 * Adding a new action without deciding which roles get it will fail here, which is the point.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_ACTIONS as MODEL_ALL_ACTIONS, can, isRole, ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS,
  type Action, type Role,
} from '@/lib/rbac';

/** The authorization model, restated independently of the implementation. */
const EXPECTED: Record<Role, Action[]> = {
  // account:self (manage your own password) sits outside the read/write ladder — every real role
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
    'schemas:refresh',
    'categories:write',
    'users:manage',
    'audit:read',
    'azure:manage',
    'auth:manage',
    'notifications:manage',
  ],
};

const ALL_ACTIONS = [...new Set(Object.values(EXPECTED).flat())].sort();

it('EXPECTED accounts for every action the real permission model defines', () => {
  // Closes the gap structurally: azure:manage was missing from this table's admin row for a
  // while and nothing caught it, because ALL_ACTIONS above is derived from EXPECTED rather than
  // from the model. Comparing against lib/rbac's own exported list means a new action added there
  // without updating this table now fails immediately instead of silently granting nothing.
  expect(ALL_ACTIONS).toEqual([...MODEL_ALL_ACTIONS].sort());
});

describe('TS-04 · the role → action grid', () => {
  it('04-00 · covers every role the product defines', () => {
    expect([...ROLES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  // One test per role/action pair — 36 assertions, each individually named, so a failure says
  // exactly which permission moved rather than "the matrix changed".
  for (const role of Object.keys(EXPECTED) as Role[]) {
    describe(role, () => {
      for (const action of ALL_ACTIONS) {
        const allowed = EXPECTED[role].includes(action);
        it(`${allowed ? 'may' : 'may NOT'} ${action}`, () => {
          expect(can(role, action)).toBe(allowed);
        });
      }
    });
  }
});

describe('TS-04 · role escalation is impossible through the model itself', () => {
  it('04-01 · a viewer may only read and manage their own password', () => {
    const granted = ALL_ACTIONS.filter(a => can('viewer', a));
    expect(granted.sort()).toEqual(['account:self', 'read']);
  });

  it('04-11 · an editor may not manage categories, users or the audit log', () => {
    expect(can('editor', 'categories:write')).toBe(false);
    expect(can('editor', 'users:manage')).toBe(false);
    expect(can('editor', 'audit:read')).toBe(false);
  });

  it('every editor permission is also an admin permission', () => {
    for (const action of EXPECTED.editor) expect(can('admin', action)).toBe(true);
  });

  it('every viewer permission is also an editor permission', () => {
    for (const action of EXPECTED.viewer) expect(can('editor', action)).toBe(true);
  });

  it('an unknown role is granted nothing, rather than defaulting to a real role', () => {
    for (const action of ALL_ACTIONS) {
      expect(can('superuser' as Role, action)).toBe(false);
      expect(can('' as Role, action)).toBe(false);
    }
  });

  it('an unknown action is refused for every role, including admin', () => {
    for (const role of ROLES) {
      expect(can(role, 'billing:write' as Action)).toBe(false);
    }
  });
});

describe('isRole', () => {
  it('accepts exactly the three real roles', () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
  });

  it('rejects anything else, including near-misses and non-strings', () => {
    for (const value of ['Admin', 'ADMIN', 'owner', '', ' viewer', null, undefined, 0, 1, {}, []]) {
      expect(isRole(value)).toBe(false);
    }
  });
});

describe('every role is presentable in the UI', () => {
  it('has a label and a description', () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });
});
