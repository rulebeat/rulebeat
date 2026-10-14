import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { copyPersonalRuleToLibrary } from '@/lib/db/library-requests';
import { definitionOfPersonalRule, getPersonalRule } from '@/lib/db/personal-rules';
import { categoryError, copyToLibraryBlockedReason } from '@/lib/library-request-view';
import { NOT_FOUND } from '@/lib/personal-rule-request';
import { ruleNameTakenError } from '@/lib/rules';

type Params = { params: Promise<{ id: string }> };

/**
 * A reviewer copies their own Personal rule straight into the library, with no request. The person has
 * to own the rule (anyone else's reads as missing) and to be able to write the library, which a scoped
 * Editor cannot. The new rule has its own id, starts disabled, and the Personal rule remembers it.
 */
export async function POST(_req: Request, { params }: Params) {
  const actor = await requireRole('rules:personal');
  if (actor instanceof NextResponse) return actor;

  const id = decodeURIComponent((await params).id);
  const rule = await getPersonalRule(id, actor.id);
  if (!rule) return NOT_FOUND();

  const blocked = copyToLibraryBlockedReason(actor.access);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 403 });

  try {
    const missingCategory = await categoryError(definitionOfPersonalRule(rule).category);
    if (missingCategory) return NextResponse.json({ error: missingCategory }, { status: 400 });

    const result = await copyPersonalRuleToLibrary(rule);
    if (!result.ok) return NextResponse.json(ruleNameTakenError(rule.name), { status: 409 });

    await writeAudit({
      actor,
      action: 'personal_rule.library_copy',
      entityType: 'personal_rule',
      entityId: rule.id,
      summary: `Copied the Personal rule "${rule.name}" to the library`,
      details: { libraryRuleId: result.rule.id, backend: result.rule.queryBackend },
    });
    return NextResponse.json(result.rule, { status: 201 });
  } catch (err) {
    return serverError('Could not copy the rule to the library', err);
  }
}
