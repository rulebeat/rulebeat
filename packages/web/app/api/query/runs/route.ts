import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { listQueryRuns } from '@/lib/db/query-runs';

export async function GET() {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  return NextResponse.json(listQueryRuns(actor.id));
}
