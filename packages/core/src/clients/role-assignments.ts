import type { TokenCredential } from '@azure/identity';
import { listAccessibleSubscriptions } from '../auth/index.js';
import { AZURE_CALL_TIMEOUT_MS, fetchWithRetry, type FetchRetryOptions } from '../net/fetch-retry.js';

const ARM = 'https://management.azure.com';
const ROLE_ASSIGNMENTS_API_VERSION = '2022-04-01';
const ELIGIBILITY_API_VERSION = '2020-10-01';
const MANAGEMENT_GROUPS_API_VERSION = '2020-05-01';
const ROLE_DEFINITION_API_VERSION = '2022-04-01';

/** The delay a throttled answer gets when ARM sent no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 10_000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thrown when ARM is still answering 429 after `fetchWithRetry` has given up. It carries the delay ARM
 * asked for, so a caller that can afford to wait (the access mirror) backs off by that much instead of
 * guessing.
 */
export class RoleAssignmentsThrottledError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Azure Resource Manager is throttling role assignment reads and asked for ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = 'RoleAssignmentsThrottledError';
  }
}

/** One role assignment, active or PIM-eligible, as far as the mirror reads it. */
export interface ArmRoleAssignment {
  /** The Azure scope the role is held at, as ARM wrote it. */
  scope: string;
  roleDefinitionId: string;
  /** `User`, `Group`, `ForeignGroup`, `ServicePrincipal`, and so on, when ARM says. */
  principalType: string | null;
  /** Eligibility only: `Direct`, `Inherited` or `Group`. */
  memberType: string | null;
}

/** The subscriptions and management groups a credential can see, as ARM scope paths. */
export interface VisibleScopes {
  subscriptions: string[];
  managementGroups: string[];
}

export interface RoleAssignmentsClientOptions {
  /** Test seam: defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Retry budget handed to `fetchWithRetry`. */
  retry?: Pick<FetchRetryOptions, 'maxAttempts' | 'backoffMs' | 'timeoutMs'>;
  /** Test seam: defaults to `listAccessibleSubscriptions`, which goes through the Azure SDK. */
  listSubscriptions?: (credential: TokenCredential) => Promise<string[]>;
}

interface Page<T> {
  value?: T[];
  nextLink?: string;
}

interface RawAssignment {
  properties?: {
    scope?: string;
    roleDefinitionId?: string;
    principalType?: string;
    memberType?: string;
  };
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, dateMs - Date.now());
}

/**
 * The read-only ARM client the access mirror stands on (#278). Every call is a GET, so the Reader
 * credential RuleBeat already scans with is enough: role assignments, PIM eligibility, management
 * groups and role definitions are all covered by Reader's read action. It takes a credential and never builds one,
 * and it makes no deny assignment call and no Microsoft Graph call: a deny assignment is not
 * subtracted, and a group's members are not enumerated, because `assignedTo()` already folds in the
 * groups the account belongs to.
 */
export class RoleAssignmentsClient {
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly retry: NonNullable<RoleAssignmentsClientOptions['retry']>;
  private readonly listSubscriptions: (credential: TokenCredential) => Promise<string[]>;

  constructor(private readonly credential: TokenCredential, options: RoleAssignmentsClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.retry = options.retry ?? {};
    this.listSubscriptions = options.listSubscriptions ?? listAccessibleSubscriptions;
  }

  private async token(): Promise<string> {
    const token = await this.credential.getToken(`${ARM}/.default`, {
      abortSignal: AbortSignal.timeout(AZURE_CALL_TIMEOUT_MS),
    });
    if (!token) throw new Error('Could not acquire an Azure Resource Manager token for the configured credential.');
    return token.token;
  }

  private async get(url: string, token: string): Promise<Response> {
    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      { ...this.retry, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) },
    );
    if (res.status === 429) throw new RoleAssignmentsThrottledError(retryAfterMs(res));
    return res;
  }

  private async getJson<T>(url: string, token: string): Promise<T> {
    const res = await this.get(url, token);
    if (!res.ok) throw new Error(`ARM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }

  private async getAll<T>(firstUrl: string): Promise<T[]> {
    const token = await this.token();
    const items: T[] = [];
    let url: string | undefined = firstUrl;
    while (url) {
      const page: Page<T> = await this.getJson<Page<T>>(url, token);
      items.push(...(page.value ?? []));
      url = page.nextLink || undefined;
    }
    return items;
  }

  /** The subscriptions and the management groups the credential can see. The tenant root group is a management group. */
  async listScopes(): Promise<VisibleScopes> {
    const [subscriptionIds, groups] = await Promise.all([
      this.listSubscriptions(this.credential),
      this.getAll<{ name?: string }>(
        `${ARM}/providers/Microsoft.Management/managementGroups?api-version=${MANAGEMENT_GROUPS_API_VERSION}`,
      ),
    ]);
    return {
      subscriptions: subscriptionIds.map(id => `/subscriptions/${id}`),
      managementGroups: groups.flatMap(g => (g.name ? [`/providers/Microsoft.Management/managementGroups/${g.name}`] : [])),
    };
  }

  private assignments(url: string): Promise<ArmRoleAssignment[]> {
    return this.getAll<RawAssignment>(url).then(rows => rows.flatMap(row => {
      const p = row.properties;
      if (!p?.scope || !p.roleDefinitionId) return [];
      return [{
        scope: p.scope,
        roleDefinitionId: p.roleDefinitionId,
        principalType: p.principalType ?? null,
        memberType: p.memberType ?? null,
      }];
    }));
  }

  private filterFor(objectId: string): string {
    if (!GUID.test(objectId)) throw new Error('A role assignment read needs an object id that is a GUID.');
    return `$filter=assignedTo('${objectId}')`;
  }

  /** The active role assignments that apply to the account at `scope`, its own and the groups it belongs to. */
  async listActive(scope: string, objectId: string): Promise<ArmRoleAssignment[]> {
    return this.assignments(
      `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=${ROLE_ASSIGNMENTS_API_VERSION}&${this.filterFor(objectId)}`,
    );
  }

  /** The PIM eligibility schedule instances that apply to the account at `scope`. */
  async listEligible(scope: string, objectId: string): Promise<ArmRoleAssignment[]> {
    return this.assignments(
      `${ARM}${scope}/providers/Microsoft.Authorization/roleEligibilityScheduleInstances?api-version=${ELIGIBILITY_API_VERSION}&${this.filterFor(objectId)}`,
    );
  }

  /** The display name of a role definition, or null when it no longer exists (a deleted custom role). */
  async roleName(roleDefinitionId: string): Promise<string | null> {
    const token = await this.token();
    const res = await this.get(`${ARM}${roleDefinitionId}?api-version=${ROLE_DEFINITION_API_VERSION}`, token);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ARM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as { properties?: { roleName?: string } };
    return body.properties?.roleName ?? null;
  }
}
