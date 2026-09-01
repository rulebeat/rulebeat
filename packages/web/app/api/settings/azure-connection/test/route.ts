import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import {
  AzureNotConfiguredError,
  credentialFromClientSecret,
  resolveAzureCredential,
  verifyAzureCredential,
} from '@/lib/azure-credential';

/**
 * "Test connection" — proves a credential reaches Azure and can see subscriptions.
 *
 * Two modes, deliberately:
 *  - with credentials in the body, it tests what the admin has typed but not yet saved;
 *  - with an empty body, it tests whatever is *currently* resolved, which is the only way to check
 *    a managed identity or an environment-variable credential, neither of which can be typed into
 *    a form.
 *
 * The result is audited (as an event, without values) because a failed connection test is the first
 * thing worth seeing when someone reports "scans stopped returning anything".
 */
export async function POST(req: Request) {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  let body: { tenantId?: string; clientId?: string; clientSecret?: string } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    /* empty body is the "test what's live" mode */
  }

  try {
    const typed = body.tenantId?.trim() && body.clientId?.trim() && body.clientSecret;
    const { credential, source } = typed
      ? {
          credential: credentialFromClientSecret(
            body.tenantId!.trim(), body.clientId!.trim(), body.clientSecret!,
          ),
          source: 'entered' as const,
        }
      : await resolveAzureCredential();

    const result = await verifyAzureCredential(credential);

    await writeAudit({
      actor,
      action: 'azure_connection.test',
      entityType: 'azure_connection',
      summary: result.ok
        ? `Tested the Azure connection. Reached ${result.subscriptionCount} subscriptions`
        : 'Tested the Azure connection. Failed',
      details: { source, ok: result.ok },
    });

    return result.ok
      ? NextResponse.json({ ok: true, subscriptionCount: result.subscriptionCount, source })
      : NextResponse.json({ ok: false, error: result.error, source }, { status: 400 });
  } catch (err) {
    if (err instanceof AzureNotConfiguredError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    return serverError('Failed to test the Azure connection', err);
  }
}
