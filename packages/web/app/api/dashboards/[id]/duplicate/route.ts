import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { duplicateDashboard } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('dashboards:write');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const copy = await duplicateDashboard(id);
  if (!copy) return Response.json({ error: 'Not found' }, { status: 404 });

  await writeAudit({
    actor,
    action: 'dashboard.duplicate',
    entityType: 'dashboard',
    entityId: copy.id,
    summary: `Duplicated dashboard "${copy.name}"`,
    details: { copiedFrom: id },
  });

  return Response.json(copy, { status: 201 });
}
