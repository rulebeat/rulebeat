import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getDashboard, updateDashboard, deleteDashboard, setDefaultDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { markedDashboard } from '@/lib/outside-access';
import { mayAct } from '@/lib/rbac';
import { sameJson } from '@/lib/dashboard-config-validation';
import type { Dashboard, DashboardConfig } from '@/lib/types';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const d = await getDashboard(id);
  if (!d) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(markedDashboard(actor.access, d));
}

/** The fields of a Save the audit entry may name. Names only, never what they held. */
const AUDITED_FIELDS = ['widgets', 'name', 'description', 'autoRefresh'] as const;
type AuditedField = typeof AUDITED_FIELDS[number];

function changedFields(before: Dashboard, after: Dashboard): AuditedField[] {
  const differs: Record<AuditedField, boolean> = {
    widgets: !sameJson(before.config.widgets, after.config.widgets),
    name: before.name !== after.name,
    description: (before.description ?? '') !== (after.description ?? ''),
    autoRefresh: (before.config.autoRefresh ?? 0) !== (after.config.autoRefresh ?? 0),
  };
  return AUDITED_FIELDS.filter(field => differs[field]);
}

interface PutBody { name?: unknown; description?: unknown; config?: DashboardConfig; isDefault?: boolean; revision?: unknown }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: which action the change needs
  // depends on the dashboard, which is checked next. The 409 body below goes only to someone who got past that.
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const before = await getDashboard(id);
  if (!before) return Response.json({ error: 'Not found' }, { status: 404 });
  // A row with no owner is Shared whatever its visibility says, so it stays install-wide (and `updateDashboard` names it so).
  const isPersonal = before.visibility === 'personal' && before.ownerId !== null;
  if (isPersonal) {
    // A Personal dashboard is its owner's alone: anyone else, an Admin included, is answered as if it did not exist.
    if (before.ownerId !== actor.id) return Response.json({ error: 'Not found' }, { status: 404 });
  } else if (!mayAct(actor.access, 'dashboards:write')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await parseJsonBody<PutBody>(req);
  if (body instanceof NextResponse) return body;
  if ((body.name !== undefined && typeof body.name !== 'string') || (body.description !== undefined && typeof body.description !== 'string')) {
    return Response.json({ error: 'name and description must be text.' }, { status: 400 });
  }
  const { name, description, config } = body as { name?: string; description?: string; config?: DashboardConfig };

  if (body.isDefault && isPersonal) {
    return Response.json({ error: 'Only a Shared dashboard can be the default.' }, { status: 400 });
  }

  let current = before;
  if (name !== undefined || description !== undefined || config !== undefined) {
    if (!Number.isInteger(body.revision)) {
      return Response.json({ error: 'revision is required.', reason: 'revision-required' }, { status: 400 });
    }
    const result = await updateDashboard(id, { name, description, config }, { revision: body.revision as number, actorId: actor.id });
    if (!result.ok) {
      switch (result.reason) {
        case 'not-found':
          return Response.json({ error: 'Not found' }, { status: 404 });
        case 'empty-name':
          return Response.json({ error: 'Name cannot be empty.', reason: 'empty-name' }, { status: 400 });
        case 'revision-conflict':
          return Response.json({
            error: 'This dashboard was changed by someone else after you opened it.',
            reason: 'revision-conflict',
            editor: result.lastEdit.editor,
            at: result.lastEdit.at,
          }, { status: 409 });
        case 'invalid-config':
          return Response.json({ error: result.message, reason: 'invalid-config' }, { status: 400 });
        case 'name-taken':
          return Response.json({ error: dashboardNameTakenMessage((name ?? '').trim()), reason: 'name-taken' }, { status: 409 });
      }
    }
    current = result.dashboard;

    // One entry per Save, naming the fields it changed. A save that changes none of them (the filter
    // bar persists its own state through here) is not a Save worth an entry.
    const changed = changedFields(before, current);
    if (changed.length > 0) {
      const label = isPersonal ? 'a Personal dashboard' : changed.includes('name') ? 'a dashboard' : `dashboard "${current.name}"`;
      await writeAudit({
        actor,
        action: 'dashboard.update',
        entityType: 'dashboard',
        entityId: id,
        summary: `Changed ${label}: ${changed.join(', ')}`,
        details: { changed },
      });
    }
  }

  if (body.isDefault) {
    const ok = await setDefaultDashboard(id, actor.id);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
    current = (await getDashboard(id)) ?? current;
  }

  return Response.json(markedDashboard(actor.access, current));
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('dashboards:write');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const before = await getDashboard(id);
  const ok = await deleteDashboard(id, actor.id);
  if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });

  await writeAudit({
    actor,
    action: 'dashboard.delete',
    entityType: 'dashboard',
    entityId: id,
    summary: `Deleted dashboard "${before?.name ?? id}"`,
  });

  return new Response(null, { status: 204 });
}
