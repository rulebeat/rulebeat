import { db } from './client';
import { queryRuns, queryRunsInsertionOrder } from './tables';
import { eq, desc } from 'drizzle-orm';
import { many, run } from './exec';
import type { QueryRun, QueryBackend, RuleScope, GraphQuery, LogAnalyticsQuery } from '@/lib/types';

/**
 * Recent run history for the live query page (spec 037 follow-up). Always fully personal — no
 * visibility split like saved-queries.ts — so deleteUser() removes every row outright. Modeled on
 * notification-deliveries.ts's prune-after-insert pattern: ranAt is millisecond-resolution, so two
 * runs in the same tick can share a timestamp; every ordered query breaks that tie with the
 * insertion-order column (SQLite's implicit rowid, Postgres's seq), which is monotonic on insert.
 */

const MAX_RUNS_PER_OWNER = 20;

type Row = typeof queryRuns.$inferSelect;

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

function rowToQueryRun(row: Row): QueryRun {
  return {
    id: row.id,
    queryBackend: row.queryBackend as QueryBackend,
    scope: parseJson<RuleScope>(row.scope),
    rawKql: row.rawKql ?? undefined,
    graphQuery: parseJson<GraphQuery>(row.graphQuery),
    logsQuery: parseJson<LogAnalyticsQuery>(row.logsQuery),
    count: row.count,
    capped: row.capped,
    truncated: row.truncated,
    savedQueryId: row.savedQueryId ?? undefined,
    ranAt: row.ranAt,
  };
}

export interface RecordQueryRunInput {
  queryBackend: QueryBackend;
  scope?: RuleScope;
  rawKql?: string;
  graphQuery?: GraphQuery;
  logsQuery?: LogAnalyticsQuery;
  count: number;
  capped: boolean;
  truncated: boolean;
  savedQueryId?: string;
  ownerId: string;
}

/**
 * Best-effort, like writeAudit() — a history-table hiccup must never turn an otherwise-successful
 * query response into a 500, so failures are logged and swallowed rather than thrown.
 */
export async function recordQueryRun(input: RecordQueryRunInput): Promise<void> {
  try {
    await run(db.insert(queryRuns).values({
      id: globalThis.crypto.randomUUID(),
      queryBackend: input.queryBackend,
      scope: input.scope ? JSON.stringify(input.scope) : null,
      rawKql: input.rawKql ?? null,
      graphQuery: input.graphQuery ? JSON.stringify(input.graphQuery) : null,
      logsQuery: input.logsQuery ? JSON.stringify(input.logsQuery) : null,
      count: input.count,
      capped: input.capped,
      truncated: input.truncated,
      savedQueryId: input.savedQueryId ?? null,
      ownerId: input.ownerId,
      ranAt: new Date().toISOString(),
    }));

    await pruneOldRuns(input.ownerId);
  } catch (err) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      message: 'query run history write failed',
      error: String(err),
    }));
  }
}

/** Newest first, capped at `limit` — the caller's own runs only, there is no shared history. */
export async function listQueryRuns(ownerId: string, limit = MAX_RUNS_PER_OWNER): Promise<QueryRun[]> {
  const rows = await many(
    db.select().from(queryRuns)
      .where(eq(queryRuns.ownerId, ownerId))
      .orderBy(desc(queryRuns.ranAt), desc(queryRunsInsertionOrder))
      .limit(limit),
  );
  return rows.map(rowToQueryRun);
}

async function pruneOldRuns(ownerId: string): Promise<void> {
  const rows = await many(
    db.select({ id: queryRuns.id }).from(queryRuns)
      .where(eq(queryRuns.ownerId, ownerId))
      .orderBy(desc(queryRuns.ranAt), desc(queryRunsInsertionOrder)),
  );

  const toDelete = rows.slice(MAX_RUNS_PER_OWNER);
  for (const row of toDelete) {
    await run(db.delete(queryRuns).where(eq(queryRuns.id, row.id)));
  }
}
