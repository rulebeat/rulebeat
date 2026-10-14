import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { createTenantContext } from '@/lib/azure-credential';
import { writeAudit } from '@/lib/db/audit';
import { getPersonalRule, listPersonalRuleResults, replacePersonalRuleResults } from '@/lib/db/personal-rules';
import { serializeCoveredScope } from '@/lib/covered-scope-view';
import { labelCoveredScope } from '@/lib/run-scope';
import { limitedContext, planPersonalRun, runPersonalRule } from '@/lib/personal-rule-run';
import { NOT_FOUND } from '@/lib/personal-rule-request';

/**
 * Run now. The run is the author's alone and limited to what they hold today: it goes straight to
 * the core engine, never through a scan, and its results replace the rule's stored latest results.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('rules:personal');
  if (actor instanceof NextResponse) return actor;

  const id = decodeURIComponent((await params).id);
  const rule = await getPersonalRule(id, actor.id);
  if (!rule) return NOT_FOUND();

  const plan = planPersonalRun(rule, actor.access);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 403 });

  try {
    const ctx = limitedContext(await createTenantContext(actor.access), actor.access);
    const { status, results } = await runPersonalRule(rule, ctx);
    const ranAt = new Date().toISOString();
    const stored = await replacePersonalRuleResults(id, actor.id, {
      status, ranAt, coveredScope: serializeCoveredScope(plan.covered), results,
    });
    if (!stored) return NOT_FOUND();

    const covered = labelCoveredScope(plan.covered, actor.access).map(entry => entry.label).join(', ');
    await writeAudit({
      actor,
      action: 'personal_rule.run',
      entityType: 'personal_rule',
      entityId: id,
      summary: `Ran the Personal rule "${rule.name}" over ${covered}`,
      details: { status, findings: results.length },
    });

    return NextResponse.json({
      rule: await getPersonalRule(id, actor.id),
      results: await listPersonalRuleResults(id, actor.id),
    });
  } catch (err) {
    return azureError('Could not run the Personal rule', err);
  }
}
