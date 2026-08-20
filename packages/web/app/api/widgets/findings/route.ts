import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { parseWidgetFiltersFromSearchParams } from '@/lib/dashboard-filters';

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20'), 200);
  const filters = parseWidgetFiltersFromSearchParams(searchParams);

  const all = queryActiveFindings(filters);
  // Recent findings feed: newest-first by when each finding first appeared.
  all.sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime());

  return Response.json(all.slice(0, limit));
}
