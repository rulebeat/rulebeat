import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import {
  deleteLogAnalyticsWorkspace,
  markLogAnalyticsWorkspaceVerified,
  saveLogAnalyticsWorkspace,
} from '@/lib/db/log-analytics-workspace';
import {
  getLogAnalyticsWorkspaceStatus,
  verifyLogAnalyticsWorkspace,
} from '@/lib/log-analytics-workspace';
import { AzureNotConfiguredError, getAzureCredential } from '@/lib/azure-credential';

/**
 * The default Log Analytics workspace `queryBackend: 'log-analytics'` rules run against (spec 035).
 *
 * Admin-only on every verb, same as the Azure connection route it mirrors. Unlike that route there is
 * no secret to protect here — a workspace query is authorized by the Azure credential already
 * configured elsewhere, so this endpoint only ever handles a workspace id.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  return NextResponse.json(await getLogAnalyticsWorkspaceStatus());
}

export async function PUT(req: Request) {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  const status = await getLogAnalyticsWorkspaceStatus();
  if (status.managedByEnv) {
    // Saving would appear to work and then change nothing, since env wins at resolution time.
    return NextResponse.json({
      error: 'The Log Analytics workspace is set by this deployment’s environment variables. '
        + 'Change it there, or remove it to manage the workspace here.',
    }, { status: 409 });
  }

  let body: { name?: string; workspaceId?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const workspaceId = body.workspaceId?.trim() ?? '';
  if (!GUID.test(workspaceId)) {
    return NextResponse.json({ error: 'Workspace ID must be a GUID.' }, { status: 400 });
  }

  // Verify before persisting. A saved workspace id that has never actually answered a query is the
  // worst state to leave an install in, same reasoning as the Azure connection route.
  let verification;
  try {
    verification = await verifyLogAnalyticsWorkspace(await getAzureCredential(), workspaceId);
  } catch (err) {
    if (err instanceof AzureNotConfiguredError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return serverError('Failed to verify the Log Analytics workspace', err);
  }
  if (!verification.ok) {
    return NextResponse.json({ error: verification.error }, { status: 400 });
  }

  try {
    const saved = await saveLogAnalyticsWorkspace({
      name: body.name,
      workspaceId,
      createdBy: actor.email,
    });
    await markLogAnalyticsWorkspaceVerified(saved.id);

    await writeAudit({
      actor,
      action: 'log_analytics_workspace.save',
      entityType: 'log_analytics_workspace',
      entityId: saved.id,
      summary: `Configured Log Analytics workspace ${workspaceId}`,
      details: { fields: ['workspaceId'] },
    });

    return NextResponse.json(await getLogAnalyticsWorkspaceStatus());
  } catch (err) {
    return serverError('Failed to save the Log Analytics workspace', err);
  }
}

export async function DELETE() {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  const status = await getLogAnalyticsWorkspaceStatus();
  if (!status.stored) {
    return NextResponse.json({ error: 'There is no stored Log Analytics workspace to remove.' }, { status: 404 });
  }

  try {
    await deleteLogAnalyticsWorkspace(status.stored.id);
    await writeAudit({
      actor,
      action: 'log_analytics_workspace.delete',
      entityType: 'log_analytics_workspace',
      entityId: status.stored.id,
      summary: `Removed the stored Log Analytics workspace ${status.stored.workspaceId}`,
    });
    return NextResponse.json(await getLogAnalyticsWorkspaceStatus());
  } catch (err) {
    return serverError('Failed to remove the Log Analytics workspace', err);
  }
}
