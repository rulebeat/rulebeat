import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { duplicateRule } from '@/lib/rules';
import { writeAudit } from '@/lib/db/audit';

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('rules:write');
  if (actor instanceof NextResponse) return actor;

  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const copy = await duplicateRule(id);
  if (!copy) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await writeAudit({
    actor,
    action: 'rule.duplicate',
    entityType: 'rule',
    entityId: copy.id,
    summary: `Duplicated rule "${copy.name}"`,
    details: { copiedFrom: id },
  });

  return NextResponse.json(copy, { status: 201 });
}
