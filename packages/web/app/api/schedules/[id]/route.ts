import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getSchedule, updateSchedule, deleteSchedule, type ScheduleBody } from '@/lib/db/schedules';
import { writeAudit, changedFields } from '@/lib/db/audit';
import { listLinksForSchedule, setLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { getChannelSummary } from '@/lib/db/notification-channels';
import type { Severity } from '@/lib/types';

const SEVERITIES = new Set<Severity>(['critical', 'high', 'medium', 'low', 'info']);

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const schedule = getSchedule(id);
  if (!schedule) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ...schedule, notificationLinks: listLinksForSchedule(id) });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('schedules:write');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const body = await parseJsonBody<ScheduleBody & {
    notificationLinks?: Array<{ channelId: string; minSeverity: string; categoryIds?: string[] | null; subscriptionIds?: string[] | null }>;
  }>(req);
  if (body instanceof NextResponse) return body;
  const before = getSchedule(id);

  // Validate notification links if provided
  const rawLinks = body.notificationLinks;
  if (rawLinks !== undefined) {
    for (const link of rawLinks) {
      if (!link.channelId || !(await getChannelSummary(link.channelId))) {
        return NextResponse.json({ error: `Notification channel not found: ${link.channelId}` }, { status: 400 });
      }
      if (!SEVERITIES.has(link.minSeverity as Severity)) {
        return NextResponse.json({ error: `Invalid severity: ${link.minSeverity}` }, { status: 400 });
      }
    }
  }

  const result = updateSchedule(id, body);
  if (result === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  if (rawLinks !== undefined) {
    setLinksForSchedule(id, rawLinks.map(l => ({
      channelId: l.channelId,
      minSeverity: l.minSeverity as Severity,
      categoryIds: l.categoryIds ?? null,
      subscriptionIds: l.subscriptionIds ?? null,
    })));
  }

  writeAudit({
    actor,
    action: 'schedule.update',
    entityType: 'schedule',
    entityId: id,
    summary: `Updated schedule "${result.schedule.name}"`,
    details: {
      ...(before ? { changed: changedFields(before, result.schedule) } : {}),
      ...(rawLinks !== undefined && { notificationChannelIds: rawLinks.map(l => l.channelId) }),
    },
  });

  return NextResponse.json({ ...result.schedule, notificationLinks: listLinksForSchedule(id) });
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('schedules:write');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const before = getSchedule(id);
  const deleted = deleteSchedule(id);
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  writeAudit({
    actor,
    action: 'schedule.delete',
    entityType: 'schedule',
    entityId: id,
    summary: `Deleted schedule "${before?.name ?? id}"`,
  });

  return NextResponse.json({ success: true });
}
