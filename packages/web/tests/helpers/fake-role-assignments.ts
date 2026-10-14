/**
 * A fake Azure role assignments reader for tests (#278): plain data and a reader over it, in place of ARM.
 * The data can be changed between refreshes, which is how a test removes a role in Azure, and the reader can be
 * made to throw or to throttle, which is how a test fails a refresh or makes it back off. It holds deny
 * assignments too, so a test can prove the mirror neither subtracts nor adds a Scope for one. Every id is fake.
 */
import { RoleAssignmentsThrottledError } from '@rulebeat/core';
import type { RoleAssignmentReader } from '@/lib/access-mirror';

export const MIRROR_TENANT = '00000000-0000-0000-0000-0000000000f0';
export const ACCOUNT = '00000000-0000-0000-0000-0000000000c1';
export const OTHER_ACCOUNT = '00000000-0000-0000-0000-0000000000c2';

export const SUB_A = '/subscriptions/00000000-0000-0000-0000-00000000000a';
export const SUB_B = '/subscriptions/00000000-0000-0000-0000-00000000000b';
export const MG_EXAMPLE = '/providers/Microsoft.Management/managementGroups/mg-example';
export const MG_ROOT = `/providers/Microsoft.Management/managementGroups/${MIRROR_TENANT}`;

const DEFINITION_PREFIX = '/providers/Microsoft.Authorization/roleDefinitions/';

/** One role assignment Azure holds, active unless `eligible`. */
export interface FakeAssignment {
  objectId: string;
  /** The scope the role is held at: a management group, a subscription, a resource group, a resource, or `/`. */
  scope: string;
  /** The role's display name. */
  role: string;
  principalType?: string;
  memberType?: string;
  eligible?: boolean;
}

/** One deny assignment Azure holds. The mirror never reads these. */
export interface FakeDeny {
  objectId: string;
  scope: string;
}

export interface FakeCall {
  method: 'listScopes' | 'listActive' | 'listEligible' | 'roleName' | 'listDenyAssignments';
  place?: string;
  objectId?: string;
}

export interface FakeRoleAssignments {
  /** The subscription scope paths the credential lists. */
  subscriptions: string[];
  /** The management group scope paths the credential lists. */
  managementGroups: string[];
  assignments: FakeAssignment[];
  denies: FakeDeny[];
  /** When set, every read throws it. */
  failWith: Error | null;
  /** The next `times` reads throw a throttled error asking for `retryAfterMs`. */
  throttle: { times: number; retryAfterMs: number } | null;
  /** Every read made, in order. */
  calls: FakeCall[];
  read: RoleAssignmentReader;
}

const lower = (s: string): string => s.toLowerCase();

/**
 * Whether an assignment at `scope` is one ARM returns when asked at `place`: the same scope, a scope beneath it
 * (a resource group or resource), or one above it (a management group or the root, which a subscription inherits).
 */
function relates(place: string, scope: string): boolean {
  const p = lower(place);
  const s = lower(scope);
  if (s === p || s.startsWith(`${p}/`)) return true;
  return s === '/' || s.startsWith('/providers/microsoft.management/');
}

export function fakeRoleAssignments(init: Partial<Pick<FakeRoleAssignments, 'subscriptions' | 'managementGroups' | 'assignments' | 'denies'>> = {}): FakeRoleAssignments {
  const fake: FakeRoleAssignments = {
    subscriptions: init.subscriptions ?? [SUB_A, SUB_B],
    managementGroups: init.managementGroups ?? [MG_ROOT, MG_EXAMPLE],
    assignments: init.assignments ?? [],
    denies: init.denies ?? [],
    failWith: null,
    throttle: null,
    calls: [],
    read: undefined as unknown as RoleAssignmentReader,
  };

  const enter = (call: FakeCall): void => {
    fake.calls.push(call);
    if (fake.failWith) throw fake.failWith;
    if (fake.throttle && fake.throttle.times > 0) {
      fake.throttle.times -= 1;
      throw new RoleAssignmentsThrottledError(fake.throttle.retryAfterMs);
    }
  };

  const answer = (place: string, objectId: string, eligible: boolean) =>
    fake.assignments
      .filter(a => lower(a.objectId) === lower(objectId) && Boolean(a.eligible) === eligible && relates(place, a.scope))
      .map(a => ({
        scope: a.scope,
        roleDefinitionId: `${DEFINITION_PREFIX}${encodeURIComponent(a.role)}`,
        principalType: a.principalType ?? 'User',
        memberType: a.memberType ?? null,
      }));

  const reader = {
    listScopes: async () => {
      enter({ method: 'listScopes' });
      return { subscriptions: [...fake.subscriptions], managementGroups: [...fake.managementGroups] };
    },
    listActive: async (place: string, objectId: string) => {
      enter({ method: 'listActive', place, objectId });
      return answer(place, objectId, false);
    },
    listEligible: async (place: string, objectId: string) => {
      enter({ method: 'listEligible', place, objectId });
      return answer(place, objectId, true);
    },
    roleName: async (roleDefinitionId: string) => {
      enter({ method: 'roleName' });
      return decodeURIComponent(roleDefinitionId.slice(roleDefinitionId.lastIndexOf('/') + 1));
    },
    /** Not part of the reader the mirror takes: a mirror that asked for denies would have to reach for this. */
    listDenyAssignments: async (place: string, objectId: string) => {
      enter({ method: 'listDenyAssignments', place, objectId });
      return fake.denies.filter(d => lower(d.objectId) === lower(objectId) && relates(place, d.scope));
    },
  };
  fake.read = reader as unknown as RoleAssignmentReader;
  return fake;
}

/** The calls of one kind, as `place` values, in order. */
export function placesCalled(fake: FakeRoleAssignments, method: FakeCall['method']): string[] {
  return fake.calls.filter(c => c.method === method).map(c => c.place ?? '');
}
