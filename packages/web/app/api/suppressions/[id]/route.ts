import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { removeSuppression } from '@/lib/suppressions';
import { writeAudit } from '@/lib/db/audit';

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('suppressions:write');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const target = await removeSuppression(id);
  if (!target) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await writeAudit({
    actor,
    action: 'suppression.delete',
    entityType: 'suppression',
    entityId: id,
    summary: `Removed the suppression on ${target?.resourceId || 'a resource'}`,
    details: { fingerprint: target.fingerprint },
  });

  return new NextResponse(null, { status: 204 });
}
