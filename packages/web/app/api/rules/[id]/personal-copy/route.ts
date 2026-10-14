import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { createPersonalRule } from '@/lib/db/personal-rules';
import { PERSONAL_BACKENDS, NOT_FOUND, definitionOf, refuseWrite } from '@/lib/personal-rule-request';
import { LOGS_PAUSED_MESSAGE, copyScopeFor } from '@/lib/personal-rule-run';
import { loadRule } from '@/lib/rules';

type Params = { params: Promise<{ id: string }> };

/**
 * Copies a shared rule, built-in or custom, into the caller's Personal rules (#281). The source
 * definition is already stored and valid, so nothing is sent to Azure. The copy starts with no
 * results, and its scope is cut down to what the caller holds.
 */
export async function POST(_req: Request, { params }: Params) {
  const actor = await requireRole('rules:personal');
  if (actor instanceof NextResponse) return actor;

  const id = decodeURIComponent((await params).id);

  try {
    const source = await loadRule(id);
    if (!source) return NOT_FOUND();

    const backend = source.queryBackend ?? 'resource-graph';
    if (!PERSONAL_BACKENDS.includes(backend)) {
      return NextResponse.json({ error: LOGS_PAUSED_MESSAGE }, { status: 400 });
    }
    const refused = refuseWrite(actor.access, backend);
    if (refused) return refused;

    const definition = definitionOf(
      { ...source, scope: copyScopeFor(source.scope, actor.access) },
      backend,
    );
    const copy = await createPersonalRule(actor.id, definition, source.id);
    await writeAudit({
      actor,
      action: 'personal_rule.copy',
      entityType: 'personal_rule',
      entityId: copy.id,
      summary: `Copied the rule "${source.name}" to the Personal rule "${copy.name}"`,
      details: { sourceRuleId: source.id, backend: copy.queryBackend },
    });
    return NextResponse.json(copy, { status: 201 });
  } catch (err) {
    return azureError('Could not copy the rule to a Personal rule', err);
  }
}
