import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { listAuditEntries, countAuditEntries } from '@/lib/db/audit';

export async function GET(req: Request) {
  const actor = await requireRole('audit:read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get('limit') ?? 50);
  const offset = Number(searchParams.get('offset') ?? 0);

  return NextResponse.json({
    entries: await listAuditEntries({
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    }),
    total: await countAuditEntries(),
  });
}
