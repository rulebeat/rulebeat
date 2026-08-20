import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { getSchedule } from '@/lib/db/schedules';
import { executeSchedule } from '@/lib/scheduler';
import { writeAudit } from '@/lib/db/audit';

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('schedules:write');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const schedule = getSchedule(id);
  if (!schedule) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  writeAudit({
    actor,
    action: 'schedule.run',
    entityType: 'schedule',
    entityId: id,
    summary: `Ran schedule "${schedule.name}" manually`,
  });

  // Scans can take minutes — fire and let the client poll /runs for status instead of blocking.
  void executeSchedule(schedule);
  return NextResponse.json({ started: true }, { status: 202 });
}
