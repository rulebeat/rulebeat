import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { duplicateDashboard, getDashboard } from '@/lib/db/dashboards';
import { guardItem } from '@/lib/item-access';
import { writeAudit } from '@/lib/db/audit';
import { markedDashboard } from '@/lib/outside-access';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  // The copy is the person's own Personal dashboard, so they need only be able to open the source.
  const refused = guardItem(actor, 'dashboard', await getDashboard(id), 'open');
  if (refused) return refused;
  const copy = await duplicateDashboard(id, actor.id);
  if (!copy) return Response.json({ error: 'Not found' }, { status: 404 });

  await writeAudit({
    actor,
    action: 'dashboard.duplicate',
    entityType: 'dashboard',
    entityId: copy.id,
    summary: 'Created a Personal dashboard by duplicating one',
    details: { copiedFrom: id },
  });

  return Response.json(markedDashboard(actor.access, copy), { status: 201 });
}
