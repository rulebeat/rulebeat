import { NextResponse } from 'next/server';
import type { Rule } from '@rulebeat/core';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { azureError } from '@/lib/api-error';
import { createTenantContext } from '@/lib/azure-credential';
import { writeAudit } from '@/lib/db/audit';
import { createPersonalRule, listPersonalRules } from '@/lib/db/personal-rules';
import { limitedContext } from '@/lib/personal-rule-run';
import { PERSONAL_BACKENDS, definitionOf, refuseWrite } from '@/lib/personal-rule-request';
import { validateRuleDefinition } from '@/lib/rule-definition-validation';

/** The caller's own Personal rules, and nobody else's. */
export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await listPersonalRules(actor.id));
}

export async function POST(req: Request) {
  const actor = await requireRole('rules:personal');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<Partial<Rule>>(req);
  if (body instanceof NextResponse) return body;

  const queryBackend = body.queryBackend ?? 'resource-graph';
  const refused = refuseWrite(actor.access, queryBackend);
  if (refused) return refused;

  try {
    const checked = await validateRuleDefinition(body, queryBackend, {
      createContext: async () => limitedContext(await createTenantContext(actor.access), actor.access),
      allowedBackends: PERSONAL_BACKENDS,
    });
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

    const rule = await createPersonalRule(actor.id, definitionOf(body, queryBackend));
    await writeAudit({
      actor,
      action: 'personal_rule.create',
      entityType: 'personal_rule',
      entityId: rule.id,
      summary: `Created the Personal rule "${rule.name}"`,
      details: { backend: rule.queryBackend, severity: rule.severity },
    });
    return NextResponse.json(rule, { status: 201 });
  } catch (err) {
    return azureError('Could not save the Personal rule', err);
  }
}
