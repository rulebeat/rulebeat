import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { getSchedule } from '@/lib/db/schedules';
import { listRuns } from '@/lib/schedule-runs';

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  if (!getSchedule(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(listRuns(id, 20));
}
