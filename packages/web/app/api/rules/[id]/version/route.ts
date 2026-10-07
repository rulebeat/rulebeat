import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { ruleNameTakenError, switchRuleVersion } from '@/lib/rules';
import { writeAudit } from '@/lib/db/audit';
import { changedFields } from '@/lib/changed-fields';
import { versionLabel } from '@/lib/rule-version-preview';

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('rules:version');
  if (actor instanceof NextResponse) return actor;
  const body = await parseJsonBody<unknown>(req);
  if (body instanceof NextResponse) return body;
  if (!body || typeof body !== 'object' || !('version' in body)
    || typeof body.version !== 'string' || !body.version.trim()) {
    return NextResponse.json({ error: 'Choose a recorded rule version.' }, { status: 400 });
  }
  const { id } = await params;
  try {
    const result = await switchRuleVersion(decodeURIComponent(id), body.version);
    if (!result.ok) {
      if (result.reason === 'name-taken') {
        return NextResponse.json(ruleNameTakenError(result.conflictingName), { status: 409 });
      }
      if (result.reason === 'custom-rule') {
        return NextResponse.json({ error: 'A Custom rule has no Rule versions to switch.' }, { status: 400 });
      }
      return NextResponse.json({
        error: result.reason === 'unknown-version' ? 'Rule version not found.' : 'Not found',
      }, { status: 404 });
    }
    if (result.oldVersion !== result.rule.version) {
      await writeAudit({
        actor, action: 'rule.version', entityType: 'rule', entityId: result.rule.id,
        summary: `Switched built-in rule "${result.rule.name}" from ${versionLabel(result.oldVersion)} to ${versionLabel(result.rule.version)}`,
        details: { changed: changedFields(result.before, result.after) },
      });
    }
    return NextResponse.json(result.rule);
  } catch (err) {
    return serverError('Could not switch rule version', err);
  }
}
