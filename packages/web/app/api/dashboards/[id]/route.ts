import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getDashboard, updateDashboard, deleteDashboard, setDefaultDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { holdBackDashboards, restoreHeldBackDashboard } from '@/lib/db/held-back';
import { UNSEEN_VALUE_MESSAGE, claimedRevision, openedCopy } from '@/lib/held-back';
import { guardItem } from '@/lib/item-access';
import { mayAct } from '@/lib/rbac';
import { changedDashboardFields } from '@/lib/dashboard-edit-fields';
import type { DashboardConfig } from '@/lib/types';

const STALE_COPY = 'This dashboard changed while you were editing it. Reload it and try again.';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const d = await getDashboard(id);
  const refused = guardItem(actor, 'dashboard', d, 'open');
  if (refused || !d) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
  const [held] = await holdBackDashboards(actor.access, [d]);
  return Response.json(held);
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
  const body = await parseJsonBody<{ name?: string; description?: string; config?: DashboardConfig; isDefault?: boolean; revision?: number }>(req);
  if (body instanceof NextResponse) return body;

  if (body.isDefault) {
    // The Install default is a curation call (ADR 0012): an Admin or an Editor on Everything, and a Shared dashboard.
    if (!mayAct(actor.access, 'dashboards:manage')) return Response.json({ error: 'Forbidden' }, { status: 403 });
    if (before.visibility !== 'shared') return Response.json({ error: 'Only a Shared dashboard can be the Install default.' }, { status: 400 });
    const ok = await setDefaultDashboard(id);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
  }

  if (body.name === undefined && body.description === undefined && body.config === undefined) {
    // isDefault-only request: return the (now-updated) dashboard without touching other fields.
    const updated = await getDashboard(id);
    return Response.json(updated && (await holdBackDashboards(actor.access, [updated]))[0]);
  }

  // The values the copy the person was sent left out go back in before the save, whatever their Access is now.
  // The write is made on the revision of that copy, not the one read just now: a copy the dashboard has moved
  // on from is refused, since it would put back values that are no longer there.
  const revision = claimedRevision(body);
  if (revision !== undefined && revision !== before.revision) return Response.json({ error: STALE_COPY }, { status: 409 });
  const opened = openedCopy(body);
  const restored = body.config === undefined ? null : await restoreHeldBackDashboard(
    actor.access, before, body.config, opened && typeof opened === 'object' ? opened as DashboardConfig : undefined,
  );
  if (restored?.unseen) return Response.json({ error: UNSEEN_VALUE_MESSAGE }, { status: 400 });
  if (revision === undefined && restored?.restored) return Response.json({ error: STALE_COPY }, { status: 409 });
  const result = await updateDashboard(
    id, restored ? { ...body, config: restored.config } : body, revision === undefined ? {} : { ifRevision: revision },
  );
  if (!result.ok) {
    if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
    if (result.reason === 'conflict') return Response.json({ error: STALE_COPY }, { status: 409 });
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

  const [held] = await holdBackDashboards(actor.access, [result.dashboard]);
  return Response.json(held);
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
