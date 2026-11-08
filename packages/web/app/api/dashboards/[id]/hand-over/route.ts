import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { parseJsonBody } from '@/lib/api-body';
import { getDashboard, transferDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { markedDashboard } from '@/lib/outside-access';
import { guardItem } from '@/lib/item-access';
import { ownerLabel } from '@/lib/item-access-model';
import { handOverCandidates } from '@/lib/hand-over-candidates';
import { NOT_ELIGIBLE_TO_OWN, staleStateMessage } from '@/lib/item-sharing';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: handing over needs the Write action
  // on their own item or the Manage action on any Shared one, which guardItem() checks next.
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getDashboard(id);
    const refused = guardItem(actor, 'dashboard', before, 'hand-over');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    if (before.visibility !== 'shared') return Response.json({ error: staleStateMessage('dashboard') }, { status: 409 });

    // Eligibility is asked again here, from the same list the picker was given, never taken from the page.
    const body = await parseJsonBody<{ userId?: unknown } | null>(request);
    if (body instanceof NextResponse) return body;
    const chosen = typeof body?.userId === 'string'
      ? (await handOverCandidates('dashboard', before.owner?.id ?? null)).find(c => c.id === body.userId)
      : undefined;
    if (!chosen) return Response.json({ error: NOT_ELIGIBLE_TO_OWN }, { status: 400 });

    const result = await transferDashboard(id, before.owner?.id ?? null, chosen.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      const error = result.reason === 'name-taken' ? dashboardNameTakenMessage(before.name) : staleStateMessage('dashboard');
      return Response.json({ error }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'dashboard.hand_over',
      entityType: 'dashboard',
      entityId: id,
      summary: `Handed over dashboard "${before.name}" from ${before.owner ? ownerLabel(before.owner) : 'no owner'} to ${chosen.displayName}`,
    });
    return Response.json(markedDashboard(actor.access, result.dashboard));
  } catch (err) {
    return serverError('Could not hand over the dashboard', err);
  }
}
