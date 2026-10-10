/**
 * A fake Azure: a `TenantContext` that answers from rows it is handed instead of from a tenant.
 *
 * `TenantContext.queryARG`, `graphGet` and `queryLogs` are the only doors any rule query goes
 * through, and `runRules()`, `runGraphRules()` and `runCategoryScan()` all accept the context as a
 * parameter, so the whole scan pipeline runs end to end with no Azure account, no credentials and
 * no network. Two callers: the test suite (through `tests/helpers/fake-azure.ts`) and the Demo
 * generator (`./fake-context.ts`), which is why it lives in product code and ships in the image.
 *
 * Deliberately not a mocking-library mock. It returns real rows through the real code path.
 */
import type { LogFields, QueryScope, TenantContext } from '@rulebeat/core';
import { LogAnalyticsNotConfiguredError } from '@rulebeat/core';
import type { TokenCredential } from '@azure/identity';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_SUBSCRIPTION_ID = '11111111-1111-1111-1111-111111111111';

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

export interface FakeOptions {
  /**
   * Rows to return. Either one fixed array for every query, or a function that decides based on
   * the KQL — use the function form when a test needs the identity-enrichment follow-up query
   * (`| where id in~ (...)`) to answer differently from the rule's own query.
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

/** A credential that throws if anything actually tries to use it. Nothing on a fake tenant should. */
const unusableCredential: TokenCredential = {
  getToken() {
    throw new Error('Something tried to fetch a real Azure token from a fake tenant. Nothing here should need one.');
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
    tenantId: opts.tenantId ?? DEFAULT_TENANT_ID,
    subscriptionIds: opts.subscriptionIds ?? [DEFAULT_SUBSCRIPTION_ID],
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
