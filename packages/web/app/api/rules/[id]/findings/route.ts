import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { loadRules } from '@/lib/rules';
import { deleteFindingsForRule } from '@/lib/db/findings';
import { writeAudit } from '@/lib/db/audit';

/**
 * Clears every finding a rule has ever produced, active and fixed, along with their events, and
 * leaves the rule itself in place (issue #98). This is the way out when a rule turns out to have
 * been wrong after it already fired: disabling it stops future scans, but `syncScanFindings()`
 * only resolves findings for rules that actually ran, so a disabled rule's findings would
 * otherwise stay active in the posture number for good.
 *
 * Deliberately no `type === 'builtin'` check. `DELETE /api/rules/[id]` refuses built-ins and keeps
 * doing so; this route exists precisely so a built-in rule's findings can be cleared without
 * deleting the rule. Same `rules:delete` action as rule deletion, since that action already reaches
 * this primitive for custom rules and both roles that hold it are the ones meant to have this.
 *
 * Clearing an enabled rule is allowed: the next scan that runs it recreates whatever still matches
 * and notifies about it as new. The Rules tab says so before asking for confirmation; the route
 * only records `enabled` in the audit entry so the log shows what the operator was warned about.
 */
export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('rules:delete');
  if (actor instanceof NextResponse) return actor;

  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const rule = (await loadRules()).find(r => r.id === id);
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const deleted = await deleteFindingsForRule(id);

  await writeAudit({
    actor,
    action: 'rule.clear_findings',
    entityType: 'rule',
    entityId: id,
    summary: `Cleared ${deleted} finding${deleted === 1 ? '' : 's'} for rule "${rule.name}"`,
    details: { deleted, category: rule.category, ruleType: rule.type, enabled: rule.enabled },
  });

  return NextResponse.json({ ruleId: id, deleted });
}
