import { db } from './client';
import { savedQueries, savedQueriesInsertionOrder } from './tables';
import { eq, or, desc } from 'drizzle-orm';
import { many, one, run } from './exec';
import type {
  SavedQuery, QueryBackend, QueryVisibility, RuleScope, VisualQuery, GraphQuery, LogAnalyticsQuery,
} from '@/lib/types';

type Row = typeof savedQueries.$inferSelect;

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

function rowToSavedQuery(row: Row): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    queryBackend: row.queryBackend as QueryBackend,
    scope: parseJson<RuleScope>(row.scope),
    visualQuery: parseJson<VisualQuery>(row.visualQuery),
    rawKql: row.rawKql ?? undefined,
    graphQuery: parseJson<GraphQuery>(row.graphQuery),
    logsQuery: parseJson<LogAnalyticsQuery>(row.logsQuery),
    visibility: row.visibility as QueryVisibility,
    ownerId: row.ownerId,
    ownerEmail: row.ownerEmail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt ?? undefined,
  };
}

export interface CreateSavedQueryInput {
  name: string;
  queryBackend: QueryBackend;
  scope?: RuleScope;
  visualQuery?: VisualQuery;
  rawKql?: string;
  graphQuery?: GraphQuery;
  logsQuery?: LogAnalyticsQuery;
  visibility: QueryVisibility;
  ownerId: string;
  ownerEmail: string;
}

export async function createSavedQuery(input: CreateSavedQueryInput): Promise<SavedQuery> {
  const id = globalThis.crypto.randomUUID();
  const now = new Date().toISOString();
  await run(db.insert(savedQueries).values({
    id,
    name: input.name,
    queryBackend: input.queryBackend,
    scope: input.scope ? JSON.stringify(input.scope) : null,
    visualQuery: input.visualQuery ? JSON.stringify(input.visualQuery) : null,
    rawKql: input.rawKql ?? null,
    graphQuery: input.graphQuery ? JSON.stringify(input.graphQuery) : null,
    logsQuery: input.logsQuery ? JSON.stringify(input.logsQuery) : null,
    visibility: input.visibility,
    ownerId: input.ownerId,
    ownerEmail: input.ownerEmail,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
  }));
  return (await getSavedQuery(id, input.ownerId))!;
}

/** Every row visible to `viewerId`: their own (private or shared) plus everyone else's shared ones. */
export async function listSavedQueries(viewerId: string): Promise<SavedQuery[]> {
  const rows = await many(
    db.select().from(savedQueries)
      .where(or(eq(savedQueries.ownerId, viewerId), eq(savedQueries.visibility, 'shared')))
      .orderBy(desc(savedQueries.updatedAt), desc(savedQueriesInsertionOrder)),
  );
  return rows.map(rowToSavedQuery);
}

/**
 * Null both when the row doesn't exist and when it exists but isn't visible to `viewerId` — a
 * private query owned by someone else must read back exactly like a missing one (404), never a 403
 * that would confirm its existence.
 */
export async function getSavedQuery(id: string, viewerId: string): Promise<SavedQuery | null> {
  const row = await one(db.select().from(savedQueries).where(eq(savedQueries.id, id)));
  if (!row) return null;
  if (row.visibility !== 'shared' && row.ownerId !== viewerId) return null;
  return rowToSavedQuery(row);
}

/** Only the owner may delete — 'shared' controls read visibility, not write access. */
export async function deleteSavedQuery(id: string, viewerId: string): Promise<boolean> {
  const row = await one(db.select().from(savedQueries).where(eq(savedQueries.id, id)));
  if (!row || row.ownerId !== viewerId) return false;
  await run(db.delete(savedQueries).where(eq(savedQueries.id, id)));
  return true;
}

/**
 * Best-effort — called after a live run against a previously-saved query. Silently does nothing
 * when the query isn't visible to the caller, so an arbitrary id passed to a run request can't be
 * used to probe for existence or write to a query the caller can't otherwise see.
 */
export async function touchSavedQueryLastRun(id: string, viewerId: string): Promise<void> {
  if (!await getSavedQuery(id, viewerId)) return;
  await run(db.update(savedQueries).set({ lastRunAt: new Date().toISOString() }).where(eq(savedQueries.id, id)));
}
