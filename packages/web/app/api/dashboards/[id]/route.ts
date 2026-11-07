import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getDashboard, updateDashboard, deleteDashboardAs, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { markedDashboard } from '@/lib/outside-access';
import { guardItem } from '@/lib/item-access';
import { mayAct } from '@/lib/rbac';
import { INSTALL_DEFAULT_REASON } from '@/lib/write-controls';
import { getMyDefault } from '@/lib/db/default-dashboard';
import { changedDashboardFields } from '@/lib/dashboard-edit-fields';
import type { DashboardConfig } from '@/lib/types';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const d = await getDashboard(id);
  const refused = guardItem(actor, 'dashboard', d, 'open');
  if (refused || !d) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(markedDashboard(actor.access, await withMyDefault(actor.id, d)));
}

// The screens replace their copy of the dashboard with every answer, so each one says whether it is the person's My default.
async function withMyDefault<T extends { id: string }>(userId: string, d: T): Promise<T & { isMyDefault: boolean }> {
  return { ...d, isMyDefault: (await getMyDefault(userId)).dashboardId === d.id };
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: which action the change needs
  // depends on the dashboard's owner and visibility, which guardItem() checks next.
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const before = await getDashboard(id);
  const refused = guardItem(actor, 'dashboard', before, 'change');
  if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
  const body = await parseJsonBody<{ name?: string; description?: string; config?: DashboardConfig; isDefault?: unknown }>(req);
  if (body instanceof NextResponse) return body;

  // The Install default is chosen through its own route (PUT /api/dashboards/install-default), never by a save.
  if (body.isDefault !== undefined) {
    return Response.json({ error: 'The Install default is chosen at /api/dashboards/install-default, not in a dashboard save.' }, { status: 400 });
  }

  if (body.name === undefined && body.description === undefined && body.config === undefined) {
    return Response.json(markedDashboard(actor.access, await withMyDefault(actor.id, before)));
  }

  const result = await updateDashboard(id, body);
  if (!result.ok) {
    if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
    const error = result.reason === 'empty-name' ? 'Name cannot be empty.' : dashboardNameTakenMessage((body.name ?? '').trim());
    return Response.json({ error }, { status: 409 });
  }

  // A Personal dashboard is logged by id and kind only, and only for a rename: every widget drag and resize
  // also lands here as a `config` save, and logging those would bury every meaningful entry under layout
  // noise. A Shared dashboard is everyone's, so each save that changed something writes one entry with the
  // changed field names (never their values).
  if (before.visibility === 'personal') {
    const renamed = (
      (body.name !== undefined && body.name !== before.name) ||
      (body.description !== undefined && body.description !== before.description)
    );
    if (renamed) {
      await writeAudit({
        actor,
        action: 'dashboard.rename',
        entityType: 'dashboard',
        entityId: id,
        summary: 'Renamed a Personal dashboard',
      });
    }
  } else {
    const changed = changedDashboardFields(before, result.dashboard);
    if (changed.length > 0) {
      const renamedOnly = changed.length === 1 && changed[0] === 'name';
      await writeAudit({
        actor,
        action: renamedOnly ? 'dashboard.rename' : 'dashboard.update',
        entityType: 'dashboard',
        entityId: id,
        summary: renamedOnly
          ? `Renamed dashboard "${before.name}" to "${result.dashboard.name}"`
          : `Updated dashboard "${before.name}"`,
        details: { fields: changed },
      });
    }
  }

  return Response.json(markedDashboard(actor.access, await withMyDefault(actor.id, result.dashboard)));
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const before = await getDashboard(id);
  const refused = guardItem(actor, 'dashboard', before, 'change');
  if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
  // Whether it is the Install default is read again inside the delete, so a dashboard chosen after the read above is still protected and audited.
  const deleted = await deleteDashboardAs(id, mayAct(actor.access, 'dashboards:manage'));
  if (!deleted.ok) {
    return deleted.reason === 'install-default'
      ? Response.json({ error: INSTALL_DEFAULT_REASON }, { status: 403 })
      : Response.json({ error: 'Not found' }, { status: 404 });
  }

  await writeAudit({
    actor,
    action: 'dashboard.delete',
    entityType: 'dashboard',
    entityId: id,
    summary: before.visibility === 'personal' ? 'Deleted a Personal dashboard' : `Deleted dashboard "${before.name}"`,
  });
  if (deleted.wasInstallDefault) {
    await writeAudit({
      actor,
      action: 'dashboard.install_default',
      entityType: 'dashboard',
      entityId: id,
      summary: `Deleted the Install default "${before.name}", so the install has no default`,
    });
  }

  return new Response(null, { status: 204 });
}
