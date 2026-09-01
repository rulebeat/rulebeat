import { sql, type SQL } from 'drizzle-orm';
import { dbKind } from './backend';
import * as sqlite from './schema';
import * as pg from './schema.pg';

/**
 * Runtime selection of the active dialect's table objects, statically typed as the SQLite twin.
 *
 * better-sqlite3 and Postgres are two different Drizzle dialects: `sqliteTable` and `pgTable`
 * objects are not interchangeable at runtime, but the shared query operators (`eq`, `and`,
 * `desc`, `sql`) and the builder surface (`select`/`insert`/`update`/`delete`,
 * `onConflictDoUpdate`) are identical. Repositories therefore write ONE query body against the
 * SQLite twin's static types and import their tables from here; at runtime the object is
 * whichever dialect's table the process actually opened. The `as` cast below is the single
 * deliberate lie in the dual-backend design, confined to this file, and it is safe exactly
 * because `schema.pg.ts` is column-for-column identical to `schema.ts` (same names, same
 * nullability, same text/integer storage shapes).
 *
 * Only repositories already ported to the async dual-backend style import from here. Everything
 * else still imports `./schema` directly and stays SQLite-only until the Phase 2 sweep.
 */
function pick<K extends keyof typeof sqlite & keyof typeof pg>(name: K): (typeof sqlite)[K] {
  return (dbKind === 'pg' ? pg[name] : sqlite[name]) as unknown as (typeof sqlite)[K];
}

export const rules = pick('rules');
export const scans = pick('scans');
export const suppressions = pick('suppressions');
export const schemaCache = pick('schemaCache');
export const resourceTypesCache = pick('resourceTypesCache');
export const dashboards = pick('dashboards');
export const categories = pick('categories');
export const schedules = pick('schedules');
export const meta = pick('meta');
export const users = pick('users');
export const azureCredentials = pick('azureCredentials');
export const logAnalyticsWorkspaces = pick('logAnalyticsWorkspaces');
export const localAccounts = pick('localAccounts');
export const ssoProviders = pick('ssoProviders');
export const auditLog = pick('auditLog');
export const findings = pick('findings');
export const findingEvents = pick('findingEvents');
export const postureSnapshots = pick('postureSnapshots');
export const notificationChannels = pick('notificationChannels');
export const scheduleNotificationChannels = pick('scheduleNotificationChannels');
export const scheduleRuns = pick('scheduleRuns');
export const notificationDeliveries = pick('notificationDeliveries');
export const savedQueries = pick('savedQueries');
export const queryRuns = pick('queryRuns');

/**
 * Insertion-order tiebreaks, for ORDER BY clauses that must stay stable when rapid inserts share
 * a millisecond timestamp. SQLite uses its implicit rowid (monotonic on insert, no schema
 * change); Postgres has no rowid, so the pg twins of these three tables carry an explicit `seq`
 * bigserial instead.
 */
export const deliveriesInsertionOrder: SQL =
  dbKind === 'pg' ? sql`${pg.notificationDeliveries.seq}` : sql`rowid`;
export const savedQueriesInsertionOrder: SQL =
  dbKind === 'pg' ? sql`${pg.savedQueries.seq}` : sql`rowid`;
export const queryRunsInsertionOrder: SQL =
  dbKind === 'pg' ? sql`${pg.queryRuns.seq}` : sql`rowid`;
