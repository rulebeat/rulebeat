import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { listRuleVersions } from '@/lib/rules';
import { narrowRuleScope } from '@/lib/rule-scope-access';

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
    // The shipped definitions of a built-in name no subscription, but this route answers for any rule id, and
    // a custom rule's current definition carries its scope: narrow it the way the rule itself is.
    return NextResponse.json({
      ...history,
      currentDefinition: narrowRuleScope(history.currentDefinition, actor.access),
      versions: history.versions.map(v => ({ ...v, definition: narrowRuleScope(v.definition, actor.access) })),
    });
  } catch (err) {
    return serverError('Could not load rule versions', err);
  }
}
