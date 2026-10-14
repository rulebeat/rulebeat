import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { countOpenLibraryRequests, listOpenLibraryRequests } from '@/lib/db/library-requests';
import { requestSummary } from '@/lib/library-request-view';

/**
 * The open Library requests and how many there are. Reviewers only: `rules:write` is install-wide, so a
 * Viewer and an Editor on less than Everything are refused with 403.
 */
export async function GET() {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  const open = await listOpenLibraryRequests();
  return NextResponse.json({
    count: await countOpenLibraryRequests(),
    requests: await Promise.all(open.map(requestSummary)),
  });
}
