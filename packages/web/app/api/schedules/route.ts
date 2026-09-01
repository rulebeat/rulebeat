import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { listSchedules, createSchedule, type ScheduleBody } from '@/lib/db/schedules';
import { getLatestRun } from '@/lib/schedule-runs';
import { writeAudit } from '@/lib/db/audit';
import { listLinksForSchedule, setLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { getChannelSummary } from '@/lib/db/notification-channels';
import type { Severity } from '@/lib/types';

const SEVERITIES = new Set<Severity>(['critical', 'high', 'medium', 'low', 'info']);

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const schedules = listSchedules().map(s => ({
    ...s,
    lastRun: getLatestRun(s.id),
    notificationLinks: listLinksForSchedule(s.id),
  }));
  return NextResponse.json(schedules);
}

export async function POST(req: Request) {
  const actor = await requireRole('schedules:write');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<ScheduleBody & {
    notificationLinks?: Array<{ channelId: string; minSeverity: string; categoryIds?: string[] | null; subscriptionIds?: string[] | null }>;
  }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.name?.trim()) return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
  if (!body.targetType) return NextResponse.json({ error: 'Target type is required.' }, { status: 400 });
  if (!body.recurrenceType) return NextResponse.json({ error: 'Recurrence type is required.' }, { status: 400 });
  if (!body.startAt) return NextResponse.json({ error: 'Start date/time is required.' }, { status: 400 });

  // Validate notification links if provided
  const rawLinks = body.notificationLinks ?? [];
  for (const link of rawLinks) {
    if (!link.channelId || !(await getChannelSummary(link.channelId))) {
      return NextResponse.json({ error: `Notification channel not found: ${link.channelId}` }, { status: 400 });
    }
    if (!SEVERITIES.has(link.minSeverity as Severity)) {
      return NextResponse.json({ error: `Invalid severity: ${link.minSeverity}` }, { status: 400 });
    }
  }

  const result = createSchedule({
    name: body.name,
    targetType: body.targetType,
    targetValues: body.targetValues ?? [],
    recurrenceType: body.recurrenceType,
    interval: body.interval ?? 1,
    daysOfWeek: body.daysOfWeek ?? null,
    dayOfMonth: body.dayOfMonth ?? null,
    startAt: body.startAt,
    endType: body.endType ?? 'never',
    endDate: body.endDate ?? null,
    enabled: body.enabled,
  });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  if (rawLinks.length > 0) {
    setLinksForSchedule(result.schedule.id, rawLinks.map(l => ({
      channelId: l.channelId,
      minSeverity: l.minSeverity as Severity,
      categoryIds: l.categoryIds ?? null,
      subscriptionIds: l.subscriptionIds ?? null,
    })));
  }

  writeAudit({
    actor,
    action: 'schedule.create',
    entityType: 'schedule',
    entityId: result.schedule.id,
    summary: `Created schedule "${result.schedule.name}"`,
    details: {
      targetType: result.schedule.targetType,
      recurrenceType: result.schedule.recurrenceType,
      enabled: result.schedule.enabled,
      ...(rawLinks.length > 0 && { notificationChannelIds: rawLinks.map(l => l.channelId) }),
    },
  });

  return NextResponse.json({
    ...result.schedule,
    notificationLinks: listLinksForSchedule(result.schedule.id),
  }, { status: 201 });
}
