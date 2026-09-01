import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { listCategories, createCategory } from '@/lib/db/categories';
import { writeAudit } from '@/lib/db/audit';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await listCategories());
}

export async function POST(req: Request) {
  const actor = await requireRole('categories:write');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ label?: string; color?: string; icon?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.label?.trim()) return NextResponse.json({ error: 'Label is required.' }, { status: 400 });

  const result = await createCategory({ label: body.label, color: body.color, icon: body.icon });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  await writeAudit({
    actor,
    action: 'category.create',
    entityType: 'category',
    entityId: result.category.id,
    summary: `Created category "${result.category.label}"`,
  });

  return NextResponse.json(result.category, { status: 201 });
}
