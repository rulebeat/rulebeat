/**
 * A fake Azure for tests.
 *
 * `TenantContext.queryARG` and `TenantContext.graphGet` are the only two doors any rule query goes
 * through (resource-graph and microsoft-graph rules respectively, spec 032), and `runRules()`,
 * `runGraphRules()` and `await runCategoryScan()` all accept the context as a parameter. That means the
 * whole scan pipeline can be exercised end to end with no Azure account, no credentials and no
 * network: hand it one of these instead of the real thing. `queryLogs` (spec 035) joins them as a
 * third door, used so far only by `lib/preflight.ts`'s Log Analytics check — no rule engine reads it
 * yet (that's spec 036).
 *
 * Deliberately not a mocking-library mock. This returns real rows through the real code path, so a
 * test failure means the scan logic is wrong — not that a mock's expectations drifted.
 */
import type { LogFields, QueryScope, TenantContext } from '@rulebeat/core';
import { LogAnalyticsNotConfiguredError } from '@rulebeat/core';
import type { TokenCredential } from '@azure/identity';

export const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const TEST_SUB_A = '11111111-1111-1111-1111-111111111111';
export const TEST_SUB_B = '22222222-2222-2222-2222-222222222222';

export interface RecordedQuery {
  kql: string;
  scope?: QueryScope;
}

export interface FakeTenantContext extends TenantContext {
  /** Every query the code under test issued, in order. */
  queries: RecordedQuery[];
  /** Every Graph path the code under test requested, in order. */
  graphRequests: string[];
  /** Every KQL string passed to `queryLogs`, in order. */
  logsQueries: string[];
  /** Everything written via `ctx.log`. */
  logs: string[];
  /** The structured `fields` argument from every `ctx.log` call, alongside `logs`' message text. */
  logFields: LogFields[];
}

interface FakeOptions {
  /**
   * Rows to return. Either one fixed array for every query, or a function that decides based on
   * the KQL — use the function form when a test needs the identity-enrichment follow-up query
   * (`| where id in (...)`) to answer differently from the rule's own query.
   */
  rows?: Record<string, unknown>[] | ((kql: string, scope?: QueryScope) => Record<string, unknown>[]);
  /** When set, every query rejects with this error — for testing the failure paths. */
  failWith?: Error;
  /**
   * Rows to return from `graphGet(path)` — the door every microsoft-graph rule goes through
   * (`runGraphRules()`, packages/core/src/engine/graph-runner.ts). Same fixed-or-function shape
   * as `rows`.
   */
  graphRows?: Record<string, unknown>[] | ((path: string) => Record<string, unknown>[]);
  /** When set, every graphGet call rejects with this error. */
  graphFailWith?: Error;
  /**
   * Rows to return from `queryLogs(kql)`. Same fixed-or-function shape as `rows`. Leaving this unset
   * (the default) means "no workspace configured" — `queryLogs` rejects with
   * `LogAnalyticsNotConfiguredError`, matching what a real context built with no
   * `logAnalyticsWorkspaceId` does — so a test only needs to opt in when it actually cares about
   * Log Analytics.
   */
  logsRows?: Record<string, unknown>[] | ((kql: string) => Record<string, unknown>[]);
  /** When set, every queryLogs call rejects with this error instead of the not-configured default —
   *  for testing the "configured but failing" path, distinct from "never configured". */
  logsFailWith?: Error;
  /**
   * `TenantContext.graphGet` is required by its type — every real context built by
   * `await createTenantContext()` implements it unconditionally (spec 032). Set this to omit it from the
   * fake anyway, for the one test that needs to prove `runGraphRules()`'s "this tenant context has
   * no Graph access configured" guard fires for a context that violates its own type at runtime.
   */
  omitGraphGet?: boolean;
  subscriptionIds?: string[];
  tenantId?: string;
}

/** A credential that throws if anything actually tries to use it. Nothing in a test should. */
const unusableCredential: TokenCredential = {
  getToken() {
    throw new Error('A test tried to fetch a real Azure token. Nothing here should need one.');
  },
};

export function fakeTenantContext(opts: FakeOptions = {}): FakeTenantContext {
  const queries: RecordedQuery[] = [];
  const graphRequests: string[] = [];
  const logsQueries: string[] = [];
  const logs: string[] = [];
  const logFields: LogFields[] = [];

  // TenantContext.graphGet is required (no `?`) as of spec 032, so the object literal below must
  // include it unconditionally — TypeScript checks a literal against its declared type at
  // construction, not after a later conditional assignment. omitGraphGet still needs to produce a
  // context with no graphGet *at runtime* (to exercise runGraphRules()'s own guard for that case),
  // so that one option is the one deliberate, commented violation of the type via a cast.
  const realGraphGet = async <TValue = Record<string, unknown>>(path: string): Promise<TValue[]> => {
    graphRequests.push(path);
    if (opts.graphFailWith) throw opts.graphFailWith;
    const rows = typeof opts.graphRows === 'function' ? opts.graphRows(path) : (opts.graphRows ?? []);
    return rows as TValue[];
  };

  const ctx: FakeTenantContext = {
    tenantId: opts.tenantId ?? TEST_TENANT_ID,
    subscriptionIds: opts.subscriptionIds ?? [TEST_SUB_A],
    credential: unusableCredential,
    queries,
    graphRequests,
    logsQueries,
    logs,
    logFields,
    async queryARG<TRow = Record<string, unknown>>(kql: string, scope?: QueryScope): Promise<TRow[]> {
      queries.push({ kql, scope });
      if (opts.failWith) throw opts.failWith;
      const rows = typeof opts.rows === 'function' ? opts.rows(kql, scope) : (opts.rows ?? []);
      return rows as TRow[];
    },
    graphGet: opts.omitGraphGet ? (undefined as unknown as TenantContext['graphGet']) : realGraphGet,
    async queryLogs<TRow = Record<string, unknown>>(kql: string): Promise<TRow[]> {
      logsQueries.push(kql);
      if (opts.logsFailWith) throw opts.logsFailWith;
      if (opts.logsRows === undefined) throw new LogAnalyticsNotConfiguredError();
      const rows = typeof opts.logsRows === 'function' ? opts.logsRows(kql) : opts.logsRows;
      return rows as TRow[];
    },
    log(message: string, fields?: LogFields) {
      logs.push(message);
      if (fields) logFields.push(fields);
    },
  };

  return ctx;
}

/** A realistic ARG row for a VM, so tests aren't asserting against invented shapes. */
export function argRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const name = String(overrides.name ?? 'vm-test-01');
  const sub = String(overrides.subscriptionId ?? TEST_SUB_A);
  const rg = String(overrides.resourceGroup ?? 'rg-test');
  return {
    id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}`,
    name,
    type: 'microsoft.compute/virtualmachines',
    location: 'westeurope',
    resourceGroup: rg,
    subscriptionId: sub,
    ...overrides,
  };
}
