import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { createTenantContext, getAzureConnectionStatus } from '@/lib/azure-credential';
import { runPreflight } from '@/lib/preflight';

/**
 * "What can this credential see" — consumed by onboarding step 2 today and the B4 diagnostics page
 * later. Namespaced under diagnostics/ rather than the API root so B4's other checks (schema-cache
 * age, scheduler liveness) get a home too.
 *
 * Admin-only: the result names the tenant and subscription ids this credential can reach, which is
 * deployment configuration rather than findings data.
 */
export async function GET() {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;

  try {
    const ctx = await createTenantContext();
    const status = getAzureConnectionStatus();
    const result = await runPreflight({ ctx, clientId: status.clientId ?? undefined });
    return NextResponse.json(result);
  } catch (err) {
    return azureError('Failed to run preflight checks', err);
  }
}
