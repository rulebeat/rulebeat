import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { loadSuppressions, saveSuppressions } from '@/lib/suppressions';
import { writeAudit } from '@/lib/db/audit';

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('suppressions:write');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const all = await loadSuppressions();
  const target = all.find(s => s.id === id);
  const filtered = all.filter(s => s.id !== id);
  if (filtered.length === all.length) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  await saveSuppressions(filtered);

  await writeAudit({
    actor,
    action: 'suppression.delete',
    entityType: 'suppression',
    entityId: id,
    summary: `Removed the suppression on ${target?.resourceId || 'a resource'}`,
    details: target ? { fingerprint: target.fingerprint } : undefined,
  });

  return new NextResponse(null, { status: 204 });
}
