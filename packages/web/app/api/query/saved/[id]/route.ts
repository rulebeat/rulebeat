import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { writeAudit } from '@/lib/db/audit';
import { deleteSavedQuery, getSavedQuery } from '@/lib/db/saved-queries';

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);

  // getSavedQuery() returns null identically for "doesn't exist" and "exists but is a private query
  // owned by someone else" — never a 403, so existence can't be probed either way.
  const saved = getSavedQuery(id, actor.id);
  if (!saved) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(saved);
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);

  // Same 404-not-403 reasoning as GET — deleteSavedQuery() itself only allows the owner to delete
  // (visibility controls read access, not write access), and reports failure uniformly.
  const existing = getSavedQuery(id, actor.id);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const ok = deleteSavedQuery(id, actor.id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  writeAudit({
    actor,
    action: 'query.delete',
    entityType: 'query',
    entityId: id,
    summary: `Deleted a ${existing.queryBackend} query "${existing.name}"`,
  });

  return NextResponse.json({ success: true });
}
