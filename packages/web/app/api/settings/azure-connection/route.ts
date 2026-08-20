import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import {
  deleteAzureCredential,
  markAzureCredentialVerified,
  saveAzureCredential,
} from '@/lib/db/azure-credentials';
import {
  credentialFromClientSecret,
  getAzureConnectionStatus,
  verifyAzureCredential,
} from '@/lib/azure-credential';

/**
 * The Azure connection an admin configures in the UI.
 *
 * Admin-only on every verb, reads included: the response names the tenant and the app registration
 * RuleBeat scans with, which is deployment configuration rather than findings data.
 *
 * The client secret travels in exactly one direction. It is accepted here, encrypted before it
 * touches the database, and never returned by any handler — `AzureCredentialSummary` has no field
 * for it, so there is nothing to forget to strip.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  return NextResponse.json(getAzureConnectionStatus());
}

export async function PUT(req: Request) {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  const status = getAzureConnectionStatus();
  if (status.managedByEnv) {
    // Saving would appear to work and then change nothing, since env wins at resolution time.
    return NextResponse.json({
      error: 'Azure credentials are set by this deployment’s environment variables. '
        + 'Change them there, or remove them to manage the connection here.',
    }, { status: 409 });
  }

  let body: { name?: string; tenantId?: string; clientId?: string; clientSecret?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const tenantId = body.tenantId?.trim() ?? '';
  const clientId = body.clientId?.trim() ?? '';
  const clientSecret = body.clientSecret ?? '';

  if (!GUID.test(tenantId)) {
    return NextResponse.json({ error: 'Tenant ID must be a GUID.' }, { status: 400 });
  }
  if (!GUID.test(clientId)) {
    return NextResponse.json({ error: 'Client ID must be a GUID.' }, { status: 400 });
  }
  if (!clientSecret.trim()) {
    return NextResponse.json({ error: 'Client secret is required.' }, { status: 400 });
  }

  // Verify before persisting. A credential that has never worked is the worst state to leave an
  // install in: nothing surfaces the problem until a scheduled scan quietly returns nothing.
  const verification = await verifyAzureCredential(
    credentialFromClientSecret(tenantId, clientId, clientSecret),
  );
  if (!verification.ok) {
    return NextResponse.json({ error: verification.error }, { status: 400 });
  }

  try {
    const saved = saveAzureCredential({
      name: body.name,
      tenantId,
      clientId,
      clientSecret,
      createdBy: actor.email,
    });
    markAzureCredentialVerified(saved.id, verification.subscriptionCount);

    writeAudit({
      actor,
      action: 'azure_connection.save',
      entityType: 'azure_connection',
      entityId: saved.id,
      summary: `Connected Azure tenant ${tenantId} (${verification.subscriptionCount} subscriptions visible)`,
      // Field names and counts only — the secret and its length are both absent by design.
      details: { fields: ['tenantId', 'clientId', 'clientSecret'], subscriptionCount: verification.subscriptionCount },
    });

    return NextResponse.json(getAzureConnectionStatus());
  } catch (err) {
    return serverError('Failed to save the Azure connection', err);
  }
}

export async function DELETE() {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  const status = getAzureConnectionStatus();
  if (!status.stored) {
    return NextResponse.json({ error: 'There is no stored Azure connection to remove.' }, { status: 404 });
  }

  try {
    deleteAzureCredential(status.stored.id);
    writeAudit({
      actor,
      action: 'azure_connection.delete',
      entityType: 'azure_connection',
      entityId: status.stored.id,
      summary: `Removed the stored Azure connection for tenant ${status.stored.tenantId}`,
    });
    return NextResponse.json(getAzureConnectionStatus());
  } catch (err) {
    return serverError('Failed to remove the Azure connection', err);
  }
}
