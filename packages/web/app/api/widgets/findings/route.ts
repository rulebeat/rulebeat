import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { resolveWidgetRead, respondWithHeldBack } from '@/lib/widget-reads';
import { countsInFindingTotals } from '@/lib/finding-kinds';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20'), 200);
  const read = await resolveWidgetRead(actor, searchParams);
  if (read instanceof NextResponse) return read;

  const all = (await queryActiveFindings(read.filters, actor.access)).filter(countsInFindingTotals);
  // Recent findings feed: newest-first by when each finding first appeared.
  all.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime());

  return respondWithHeldBack(all.slice(0, limit), read.heldBack, read.savedView);
}
