import { db } from './client';
import { scheduleNotificationChannels, notificationChannels } from './tables';
import { eq, inArray } from 'drizzle-orm';
import { many, run, inTransaction } from './exec';
import { rowToStoredChannel, type StoredNotificationChannel } from './notification-channels';
import type { Severity } from '@/lib/types';

export interface ScheduleChannelLink {
  channelId: string;
  minSeverity: Severity;
  categoryIds: string[] | null;    // null = all categories
  subscriptionIds: string[] | null; // null = all subscriptions
}

/** Returns the notification links configured for a schedule. */
export async function listLinksForSchedule(scheduleId: string): Promise<ScheduleChannelLink[]> {
  const rows = await many(
    db.select().from(scheduleNotificationChannels)
      .where(eq(scheduleNotificationChannels.scheduleId, scheduleId)),
  );
  return rows.map(row => ({
    channelId: row.channelId,
    minSeverity: row.minSeverity as Severity,
    categoryIds: row.categoryIds ? JSON.parse(row.categoryIds) as string[] : null,
    subscriptionIds: row.subscriptionIds ? JSON.parse(row.subscriptionIds) as string[] : null,
  }));
}

/**
 * Atomically replaces all notification links for a schedule.
 * Called on every schedule save — passing an empty array clears all links.
 */
export async function setLinksForSchedule(scheduleId: string, links: ScheduleChannelLink[]): Promise<void> {
  await inTransaction(async (tx) => {
    await run(
      tx.delete(scheduleNotificationChannels)
        .where(eq(scheduleNotificationChannels.scheduleId, scheduleId)),
    );

    if (links.length > 0) {
      await run(tx.insert(scheduleNotificationChannels).values(
        links.map(l => ({
          scheduleId,
          channelId: l.channelId,
          minSeverity: l.minSeverity,
          categoryIds: l.categoryIds ? JSON.stringify(l.categoryIds) : null,
          subscriptionIds: l.subscriptionIds ? JSON.stringify(l.subscriptionIds) : null,
        })),
      ));
    }
  });
}

/** Removes all notification links for a schedule. Called by deleteSchedule(). */
export async function deleteLinksForSchedule(scheduleId: string): Promise<void> {
  await run(
    db.delete(scheduleNotificationChannels)
      .where(eq(scheduleNotificationChannels.scheduleId, scheduleId)),
  );
}

/**
 * Returns the resolved channels (with decrypted URLs/passwords) assigned to a schedule, each
 * carrying its per-schedule minSeverity and scope. Used by the dispatcher.
 */
export async function getChannelsForSchedule(
  scheduleId: string,
): Promise<Array<StoredNotificationChannel & { minSeverity: Severity; categoryIds: string[] | null; subscriptionIds: string[] | null }>> {
  if (!scheduleId) return [];

  const links = await listLinksForSchedule(scheduleId);
  if (links.length === 0) return [];

  const channelIds = links.map(l => l.channelId);
  const rows = await many(
    db.select().from(notificationChannels)
      .where(inArray(notificationChannels.id, channelIds)),
  );

  const linkById = new Map(links.map(l => [l.channelId, l]));

  return rows
    .map(row => {
      const stored = rowToStoredChannel(row);
      if (!stored) return null;
      const link = linkById.get(stored.id);
      if (!link) return null;
      return {
        ...stored,
        minSeverity: link.minSeverity,
        categoryIds: link.categoryIds,
        subscriptionIds: link.subscriptionIds,
      };
    })
    .filter((c): c is StoredNotificationChannel & { minSeverity: Severity; categoryIds: string[] | null; subscriptionIds: string[] | null } => c !== null);
}
