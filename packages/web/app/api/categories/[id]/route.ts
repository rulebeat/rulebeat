import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getCategory, updateCategory, deleteCategory } from '@/lib/db/categories';
import { writeAudit, changedFields } from '@/lib/db/audit';

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const cat = await getCategory(id);
  if (!cat) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(cat);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('categories:write');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const body = await parseJsonBody<{ label?: string; color?: string; icon?: string; sortOrder?: number }>(req);
  if (body instanceof NextResponse) return body;
  const before = await getCategory(id);
  const result = await updateCategory(id, body);
  if (result === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  await writeAudit({
    actor,
    action: 'category.update',
    entityType: 'category',
    entityId: id,
    summary: `Updated category "${result.category.label}"`,
    details: before ? { changed: changedFields(before, body) } : undefined,
  });

  return NextResponse.json(result.category);
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('categories:write');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const before = await getCategory(id);
  const result = await deleteCategory(id);
  if (result === 'notfound') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result === 'builtin') return NextResponse.json({ error: 'Built-in categories cannot be deleted.' }, { status: 403 });

  await writeAudit({
    actor,
    action: 'category.delete',
    entityType: 'category',
    entityId: id,
    summary: `Deleted category "${before?.label ?? id}"`,
  });

  return NextResponse.json({ success: true });
}
