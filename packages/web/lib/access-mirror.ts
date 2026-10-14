import { RoleAssignmentsClient, RoleAssignmentsThrottledError } from '@rulebeat/core';
import { getArmCredential, getArmTenantId } from '@/lib/arm';
import { recordMirrorFailure, recordMirrorRefresh, type AppUser } from '@/lib/db/users';
import {
  mirrorError, scopeOfAzurePath, scopesFromAssignments,
  type MirrorError, type MirrorErrorCode, type MirroredScope, type NamedAssignment, type ReadAssignment,
} from '@/lib/access-mirror-model';

/**
 * What the mirror reads Azure through: the scopes the credential can see, and the role assignments and PIM
 * eligibility of one account at each. It is `RoleAssignmentsClient`'s own shape, so a test hands in a fake
 * that answers from plain data, and a read that needs a credential is built in one place below.
 */
export type RoleAssignmentReader = Pick<RoleAssignmentsClient, 'listScopes' | 'listActive' | 'listEligible' | 'roleName'>;

/** The reader RuleBeat uses: its own Reader credential, resolved by `lib/azure-credential.ts` and never built here. */
export async function readerFromArm(): Promise<RoleAssignmentReader> {
  return new RoleAssignmentsClient(await getArmCredential());
}

export interface MirrorDeps {
  /** Defaults to `readerFromArm()`. */
  read?: RoleAssignmentReader;
  /** The clock a refresh is stamped with. */
  now?: () => Date;
  /** How a throttled read waits before it asks again. */
  wait?: (ms: number) => Promise<void>;
}

export type MirrorResult =
  | { ok: true; tenantId: string; objectId: string; scopes: MirroredScope[] }
  | { ok: false; error: MirrorError };

/** The most times one read is tried when Azure keeps throttling it. */
export const MAX_READ_ATTEMPTS = 4;
/** A `Retry-After` longer than this is not waited out in a request: the refresh fails as throttled and the next one tries again. */
export const MAX_RETRY_WAIT_MS = 60_000;
/** How many scopes are read at once. */
const READ_CONCURRENCY = 4;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function isThrottled(err: unknown): err is RoleAssignmentsThrottledError {
  return err instanceof RoleAssignmentsThrottledError
    || (err instanceof Error && err.name === 'RoleAssignmentsThrottledError' && typeof (err as { retryAfterMs?: unknown }).retryAfterMs === 'number');
}

function failureCode(err: unknown): MirrorErrorCode {
  if (err instanceof Error && (err as { code?: string }).code === 'azure_not_configured') return 'azure_not_configured';
  return isThrottled(err) ? 'throttled' : 'failed';
}

/**
 * Runs one read, and when Azure throttles it waits as long as it asked and tries again, up to
 * `MAX_READ_ATTEMPTS` tries. A delay longer than `MAX_RETRY_WAIT_MS` is not waited for. Any other error is
 * thrown at once.
 */
async function withBackoff<T>(call: () => Promise<T>, wait: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!isThrottled(err) || attempt >= MAX_READ_ATTEMPTS || err.retryAfterMs > MAX_RETRY_WAIT_MS) throw err;
      await wait(err.retryAfterMs);
    }
  }
}

/** Runs `fn` over every item, at most `limit` at a time, keeping the order. The first failure stops the rest from starting. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]!);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const UNNAMED_ROLE = 'Unnamed role';

async function readScopes(read: RoleAssignmentReader, objectId: string, wait: (ms: number) => Promise<void>): Promise<MirroredScope[]> {
  const visible = await withBackoff(() => read.listScopes(), wait);
  const places = [...visible.subscriptions, ...visible.managementGroups];

  // Once per subscription and once per management group, active and eligible each, merged by `scopesFromAssignments`.
  const perPlace = await mapLimit(places, READ_CONCURRENCY, async place => {
    const active = await withBackoff(() => read.listActive(place, objectId), wait);
    const eligible = await withBackoff(() => read.listEligible(place, objectId), wait);
    return [
      ...active.map(a => ({ ...a, eligible: false })),
      ...eligible.map(a => ({ ...a, eligible: true })),
    ];
  });

  // An assignment that gives no Scope (the root path, a subscription level resource) needs no role name.
  const usable: (ReadAssignment & { eligible: boolean })[] = perPlace.flat().filter(a => scopeOfAzurePath(a.scope) !== null);
  const roleIds = [...new Set(usable.map(a => a.roleDefinitionId.toLowerCase()))];
  const idByLower = new Map(usable.map(a => [a.roleDefinitionId.toLowerCase(), a.roleDefinitionId]));
  const names = new Map<string, string>();
  await mapLimit(roleIds, READ_CONCURRENCY, async lower => {
    names.set(lower, (await withBackoff(() => read.roleName(idByLower.get(lower)!), wait)) ?? UNNAMED_ROLE);
  });

  const named: NamedAssignment[] = usable.map(a => ({
    scope: a.scope,
    roleName: names.get(a.roleDefinitionId.toLowerCase()) ?? UNNAMED_ROLE,
    eligible: a.eligible,
    principalType: a.principalType,
    memberType: a.memberType,
  }));
  return scopesFromAssignments(named);
}

/**
 * Reads one Linked account's Azure role assignments, active and PIM-eligible, and turns them into Scopes
 * with their origins. The tenant id on the result is the one RuleBeat is connected to, resolved here and
 * never taken from a request. Never throws: a read that fails is a failed result with a stable code, and
 * the error itself goes to the server log only. A read that succeeds with nothing is `ok` with no Scopes.
 */
export async function mirrorAccount(objectId: string, deps: MirrorDeps = {}): Promise<MirrorResult> {
  try {
    const tenantId = await getArmTenantId();
    const read = deps.read ?? await readerFromArm();
    const scopes = await readScopes(read, objectId, deps.wait ?? sleep);
    return { ok: true, tenantId, objectId, scopes };
  } catch (err) {
    const code = failureCode(err);
    if (code !== 'azure_not_configured') console.error('[RuleBeat] Reading the role assignments of a Linked account failed:', err);
    return { ok: false, error: mirrorError(code) };
  }
}

/** How a refresh of one person ended. `stale` means the person changed while it ran, so nothing was written. */
export type RefreshResult =
  | { ok: true; stale: boolean }
  | { ok: false; stale: boolean; error: MirrorError };

/**
 * Refreshes one mirrored person: reads their Linked account again, and on success replaces their Scopes and
 * origins, on a failure keeps them and records the attempt with a code. Either write happens only if the person
 * is still mirrored to the same account, so a refresh that outlived a hand-made change can never undo it.
 * Never throws.
 */
export async function refreshMirroredUser(user: AppUser, deps: MirrorDeps = {}): Promise<RefreshResult> {
  const objectId = user.linkedAccount?.objectId;
  if (!objectId) return { ok: false, stale: true, error: mirrorError('failed') };
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const result = await mirrorAccount(objectId, deps);
  try {
    if (result.ok) {
      const written = await recordMirrorRefresh(user.id, { objectId, tenantId: result.tenantId, scopes: result.scopes, at });
      return { ok: true, stale: written === 'stale' };
    }
    const written = await recordMirrorFailure(user.id, { objectId, code: result.error.code, at });
    return { ok: false, stale: written === 'stale', error: result.error };
  } catch (err) {
    console.error('[RuleBeat] Could not record a Linked account refresh:', err);
    return { ok: false, stale: false, error: mirrorError('failed') };
  }
}
