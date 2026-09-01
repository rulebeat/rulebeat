import { eq, desc } from 'drizzle-orm';
import { db } from './client';
import { notificationDeliveries, deliveriesInsertionOrder } from './tables';
import { many, run } from './exec';

/**
 * History behind notificationChannels' single-value lastNotifiedAt/lastError columns — one row per
 * delivery attempt sequence (a channel's final outcome for a single run, after retries are
 * exhausted). Modeled on schedule-runs.ts's pattern: plain TEXT ids, no SQL-level FK, prune-after-
 * insert cap.
 *
 * occurredAt is millisecond-resolution, so two deliveries dispatched back-to-back (e.g. a schedule
 * fanning out to several channels at once) can land the same timestamp — ORDER BY occurredAt DESC
 * alone leaves their relative order unspecified. Every ordered query below breaks that tie with
 * `deliveriesInsertionOrder` (SQLite's implicit rowid, Postgres's `seq` bigserial — both monotonic
 * on insert), so "newest first" stays true even under a tie instead of depending on the query
 * planner's incidental tie-break.
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
    ok: row.ok,
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

export async function recordDelivery(input: RecordDeliveryInput): Promise<void> {
  await run(db.insert(notificationDeliveries).values({
    id: globalThis.crypto.randomUUID(),
    channelId: input.channelId,
    scheduleId: input.scheduleId,
    runId: input.runId,
    occurredAt: new Date().toISOString(),
    ok: input.ok,
    attempts: input.attempts,
    httpStatus: input.httpStatus ?? null,
    error: input.error ?? null,
    findingsCount: input.findingsCount,
  }));

  await pruneOldDeliveries(input.channelId);
}

export async function listDeliveriesForChannel(channelId: string, limit = 20): Promise<NotificationDelivery[]> {
  const rows = await many(
    db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.channelId, channelId))
      .orderBy(desc(notificationDeliveries.occurredAt), desc(deliveriesInsertionOrder))
      .limit(limit),
  );
  return rows.map(rowToDelivery);
}

export async function deleteDeliveriesForChannel(channelId: string): Promise<void> {
  await run(db.delete(notificationDeliveries).where(eq(notificationDeliveries.channelId, channelId)));
}

async function pruneOldDeliveries(channelId: string): Promise<void> {
  const rows = await many(
    db.select({ id: notificationDeliveries.id }).from(notificationDeliveries)
      .where(eq(notificationDeliveries.channelId, channelId))
      .orderBy(desc(notificationDeliveries.occurredAt), desc(deliveriesInsertionOrder)),
  );

  const toDelete = rows.slice(MAX_DELIVERIES_PER_CHANNEL);
  for (const row of toDelete) {
    await run(db.delete(notificationDeliveries).where(eq(notificationDeliveries.id, row.id)));
  }
}
