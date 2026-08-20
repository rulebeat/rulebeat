import { db } from './client';
import { scheduleNotificationChannels, notificationChannels } from './schema';
import { eq, inArray } from 'drizzle-orm';
import { rowToStoredChannel, type StoredNotificationChannel } from './notification-channels';
import type { Severity } from '@/lib/types';

export interface ScheduleChannelLink {
  channelId: string;
  minSeverity: Severity;
  categoryIds: string[] | null;    // null = all categories
  subscriptionIds: string[] | null; // null = all subscriptions
}

/** Returns the notification links configured for a schedule. */
export function listLinksForSchedule(scheduleId: string): ScheduleChannelLink[] {
  return db.select().from(scheduleNotificationChannels)
    .where(eq(scheduleNotificationChannels.scheduleId, scheduleId))
    .all()
    .map(row => ({
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
export function setLinksForSchedule(scheduleId: string, links: ScheduleChannelLink[]): void {
  db.transaction(tx => {
    tx.delete(scheduleNotificationChannels)
      .where(eq(scheduleNotificationChannels.scheduleId, scheduleId))
      .run();

    if (links.length > 0) {
      tx.insert(scheduleNotificationChannels).values(
        links.map(l => ({
          scheduleId,
          channelId: l.channelId,
          minSeverity: l.minSeverity,
          categoryIds: l.categoryIds ? JSON.stringify(l.categoryIds) : null,
          subscriptionIds: l.subscriptionIds ? JSON.stringify(l.subscriptionIds) : null,
        })),
      ).run();
    }
  });
}

/** Removes all notification links for a schedule. Called by deleteSchedule(). */
export function deleteLinksForSchedule(scheduleId: string): void {
  db.delete(scheduleNotificationChannels)
    .where(eq(scheduleNotificationChannels.scheduleId, scheduleId))
    .run();
}

/**
 * Returns the resolved channels (with decrypted URLs/passwords) assigned to a schedule, each
 * carrying its per-schedule minSeverity and scope. Used by the dispatcher.
 */
export function getChannelsForSchedule(
  scheduleId: string,
): Array<StoredNotificationChannel & { minSeverity: Severity; categoryIds: string[] | null; subscriptionIds: string[] | null }> {
  if (!scheduleId) return [];

  const links = listLinksForSchedule(scheduleId);
  if (links.length === 0) return [];

  const channelIds = links.map(l => l.channelId);
  const rows = db.select().from(notificationChannels)
    .where(inArray(notificationChannels.id, channelIds))
    .all();

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
