/**
 * The history behind notificationChannels' single-value lastNotifiedAt/lastError columns — one row
 * per delivery attempt sequence. Modeled on schedule-runs.ts's prune-after-insert pattern.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteDeliveriesForChannel, listDeliveriesForChannel, recordDelivery,
} from '@/lib/db/notification-deliveries';
import { createChannel, deleteChannel } from '@/lib/db/notification-channels';

describe('notification-deliveries repository', () => {
  let channelId: string;

  function makeChannel(name = 'Test channel'): string {
    return createChannel({ name, type: 'webhook', url: 'https://example.test/hook' }).id;
  }

  afterEach(() => {
    if (channelId) deleteChannel(channelId); // idempotent — a test may have already deleted it
  });

  it('records a delivery and lists history newest-first', () => {
    channelId = makeChannel();
    recordDelivery({ channelId, scheduleId: 's1', runId: 'r1', ok: true, attempts: 1, httpStatus: 200, findingsCount: 3 });
    recordDelivery({ channelId, scheduleId: 's1', runId: 'r2', ok: false, attempts: 3, httpStatus: 500, error: 'HTTP 500', findingsCount: 1 });

    const history = listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ runId: 'r2', ok: false, attempts: 3, httpStatus: 500, error: 'HTTP 500', findingsCount: 1 });
    expect(history[1]).toMatchObject({ runId: 'r1', ok: true, attempts: 1, httpStatus: 200, error: null, findingsCount: 3 });
  });

  it('lists newest-first even when two deliveries land the same millisecond occurredAt', () => {
    // occurredAt is millisecond-resolution (Date#toISOString), so two rapid inserts can tie — this
    // freezes the clock to force that tie deterministically instead of hoping real-clock timing
    // reproduces it (see the rowid tiebreak note atop lib/db/notification-deliveries.ts).
    channelId = makeChannel();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      recordDelivery({ channelId, scheduleId: 's1', runId: 'r1', ok: true, attempts: 1, httpStatus: 200, findingsCount: 3 });
      recordDelivery({ channelId, scheduleId: 's1', runId: 'r2', ok: false, attempts: 3, httpStatus: 500, error: 'HTTP 500', findingsCount: 1 });
    } finally {
      vi.useRealTimers();
    }

    const history = listDeliveriesForChannel(channelId);
    expect(history).toHaveLength(2);
    expect(history[0].occurredAt).toBe(history[1].occurredAt); // confirms the tie was actually forced
    expect(history[0]).toMatchObject({ runId: 'r2' });
    expect(history[1]).toMatchObject({ runId: 'r1' });
  });

  it('caps history at 50 rows per channel', () => {
    channelId = makeChannel();
    for (let i = 0; i < 55; i++) {
      recordDelivery({ channelId, scheduleId: 's1', runId: `r${i}`, ok: true, attempts: 1, findingsCount: 0 });
    }

    // Rapid successive inserts can land the same millisecond occurredAt; pruning breaks that tie via
    // rowid (lib/db/notification-deliveries.ts), so the cap still discards the oldest-by-insertion-
    // order rows even then — this test only asserts the count, not which five ids were pruned.
    const history = listDeliveriesForChannel(channelId, 100);
    expect(history).toHaveLength(50);
  });

  it('deleteDeliveriesForChannel removes history for that channel only', () => {
    channelId = makeChannel();
    const otherId = makeChannel('Other channel');
    try {
      recordDelivery({ channelId, scheduleId: 's1', runId: 'r1', ok: true, attempts: 1, findingsCount: 0 });
      recordDelivery({ channelId: otherId, scheduleId: 's1', runId: 'r2', ok: true, attempts: 1, findingsCount: 0 });

      deleteDeliveriesForChannel(channelId);

      expect(listDeliveriesForChannel(channelId)).toHaveLength(0);
      expect(listDeliveriesForChannel(otherId)).toHaveLength(1);
    } finally {
      deleteChannel(otherId);
    }
  });

  it('deleting a channel cascades its delivery history', () => {
    channelId = makeChannel();
    recordDelivery({ channelId, scheduleId: 's1', runId: 'r1', ok: true, attempts: 1, findingsCount: 0 });

    deleteChannel(channelId);

    expect(listDeliveriesForChannel(channelId)).toHaveLength(0);
  });
});
