import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { runManualTarget } from '@/lib/scheduler';
import { writeAudit } from '@/lib/db/audit';
import { listAllRuns } from '@/lib/schedule-runs';
import type { ScheduleTargetType } from '@/lib/db/schedules';

/**
 * Reports the most recent run, for `use-run-progress.ts` to poll. `since` filters out a run that
 * predates the caller's own POST — without it, a scan that finished moments before this page loaded
 * would look like the one this caller just triggered.
 */
export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const since = new URL(req.url).searchParams.get('since');
  const latest = (await listAllRuns(1))[0] ?? null;
  return NextResponse.json({ run: latest && (!since || latest.startedAt >= since) ? latest : null });
}

export async function POST(req: Request) {
  const actor = await requireRole('scans:run');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ targetType?: ScheduleTargetType; targetValues?: string[] }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.targetType) return NextResponse.json({ error: 'targetType is required' }, { status: 400 });
  if (body.targetType !== 'all' && (body.targetValues?.length ?? 0) === 0) {
    return NextResponse.json({ error: 'At least one target is required.' }, { status: 400 });
  }

  const targetValues = body.targetValues ?? [];
  await writeAudit({
    actor,
    action: 'scan.run',
    entityType: 'scan',
    summary: body.targetType === 'all'
      ? 'Started a scan of all categories'
      : `Started a scan of ${targetValues.length} ${body.targetType}`,
    details: { targetType: body.targetType, targetValues },
  });

  // Scans can take a while — fire and let the client poll GET above, same pattern as the
  // schedule "run now" trigger, rather than holding the HTTP request open for the full run.
  // requestedAt is the server clock deliberately: use-run-progress.ts compares it against
  // ScheduleRun.startedAt (also server time), so deriving it in the browser would let clock skew
  // silently drop a real run.
  void runManualTarget({ targetType: body.targetType, targetValues });
  return NextResponse.json({ started: true, requestedAt: new Date().toISOString() }, { status: 202 });
}
