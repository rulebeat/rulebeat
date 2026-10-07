import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { listRuleVersions } from '@/lib/rules';

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  try {
    const history = await listRuleVersions(decodeURIComponent(id));
    if (!history) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(history);
  } catch (err) {
    return serverError('Could not load rule versions', err);
  }
}
