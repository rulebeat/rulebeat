import { eq, desc, sql } from 'drizzle-orm';
import { db } from './client';
import { notificationDeliveries } from './schema';

/**
 * History behind notificationChannels' single-value lastNotifiedAt/lastError columns — one row per
 * delivery attempt sequence (a channel's final outcome for a single run, after retries are
 * exhausted). Modeled on schedule-runs.ts's pattern: plain TEXT ids, no SQL-level FK, prune-after-
 * insert cap.
 *
 * occurredAt is millisecond-resolution, so two deliveries dispatched back-to-back (e.g. a schedule
 * fanning out to several channels at once) can land the same timestamp — ORDER BY occurredAt DESC
 * alone leaves their relative order unspecified. Every ordered query below breaks that tie with
 * SQLite's implicit rowid, which is monotonic on insert, so "newest first" stays true even under a
 * tie instead of depending on the query planner's incidental tie-break.
 */

const MAX_DELIVERIES_PER_CHANNEL = 50;

export interface NotificationDelivery {
  id: string;
  channelId: string;
  scheduleId: string;
  runId: string;
  occurredAt: string;
  ok: boolean;
  attempts: number;
  httpStatus: number | null;
  error: string | null;
  findingsCount: number;
}

type Row = typeof notificationDeliveries.$inferSelect;

function rowToDelivery(row: Row): NotificationDelivery {
  return {
    id: row.id,
    channelId: row.channelId,
    scheduleId: row.scheduleId,
    runId: row.runId,
    occurredAt: row.occurredAt,
    ok: row.ok === 1,
    attempts: row.attempts,
    httpStatus: row.httpStatus,
    error: row.error,
    findingsCount: row.findingsCount,
  };
}

export interface RecordDeliveryInput {
  channelId: string;
  scheduleId: string;
  runId: string;
  ok: boolean;
  attempts: number;
  httpStatus?: number | null;
  error?: string | null;
  findingsCount: number;
}

export function recordDelivery(input: RecordDeliveryInput): void {
  db.insert(notificationDeliveries).values({
    id: globalThis.crypto.randomUUID(),
    channelId: input.channelId,
    scheduleId: input.scheduleId,
    runId: input.runId,
    occurredAt: new Date().toISOString(),
    ok: input.ok ? 1 : 0,
    attempts: input.attempts,
    httpStatus: input.httpStatus ?? null,
    error: input.error ?? null,
    findingsCount: input.findingsCount,
  }).run();

  pruneOldDeliveries(input.channelId);
}

export function listDeliveriesForChannel(channelId: string, limit = 20): NotificationDelivery[] {
  return db.select().from(notificationDeliveries)
    .where(eq(notificationDeliveries.channelId, channelId))
    .orderBy(desc(notificationDeliveries.occurredAt), desc(sql`rowid`))
    .limit(limit)
    .all()
    .map(rowToDelivery);
}

export function deleteDeliveriesForChannel(channelId: string): void {
  db.delete(notificationDeliveries).where(eq(notificationDeliveries.channelId, channelId)).run();
}

function pruneOldDeliveries(channelId: string): void {
  const rows = db.select({ id: notificationDeliveries.id }).from(notificationDeliveries)
    .where(eq(notificationDeliveries.channelId, channelId))
    .orderBy(desc(notificationDeliveries.occurredAt), desc(sql`rowid`))
    .all();

  const toDelete = rows.slice(MAX_DELIVERIES_PER_CHANNEL);
  for (const row of toDelete) {
    db.delete(notificationDeliveries).where(eq(notificationDeliveries.id, row.id)).run();
  }
}
