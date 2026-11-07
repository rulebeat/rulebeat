import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getDashboard, updateDashboard, deleteDashboard, setDefaultDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { markedDashboard } from '@/lib/outside-access';
import { guardItem } from '@/lib/item-access';
import { mayAct } from '@/lib/rbac';
import { sameJson } from '@/lib/dashboard-config-validation';
import type { Dashboard, DashboardConfig } from '@/lib/types';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const d = await getDashboard(id);
  const refused = guardItem(actor, 'dashboard', d, 'open');
  if (refused || !d) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
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
  // depends on the dashboard's owner and visibility, which guardItem() checks next. The 409 body below goes only to someone who got past that.
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const before = await getDashboard(id);
  const refused = guardItem(actor, 'dashboard', before, 'change');
  if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });

  const body = await parseJsonBody<PutBody>(req);
  if (body instanceof NextResponse) return body;
  if ((body.name !== undefined && typeof body.name !== 'string') || (body.description !== undefined && typeof body.description !== 'string')) {
    return Response.json({ error: 'name and description must be text.' }, { status: 400 });
  }
  const { name, description, config } = body as { name?: string; description?: string; config?: DashboardConfig };

  if (body.isDefault) {
    // The Install default is a curation call (ADR 0012): an Admin or an Editor on Everything, and a Shared dashboard.
    if (!mayAct(actor.access, 'dashboards:manage')) return Response.json({ error: 'Forbidden' }, { status: 403 });
    if (before.visibility !== 'shared') return Response.json({ error: 'Only a Shared dashboard can be the Install default.' }, { status: 400 });
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
      const label = before.visibility === 'personal' ? 'a Personal dashboard' : changed.includes('name') ? 'a dashboard' : `dashboard "${current.name}"`;
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
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const before = await getDashboard(id);
  const refused = guardItem(actor, 'dashboard', before, 'change');
  if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
  const ok = await deleteDashboard(id);
  if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });

  await writeAudit({
    actor,
    action: 'dashboard.delete',
    entityType: 'dashboard',
    entityId: id,
    summary: before.visibility === 'personal' ? 'Deleted a Personal dashboard' : `Deleted dashboard "${before.name}"`,
  });

  return new Response(null, { status: 204 });
}
