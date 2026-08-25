import { NextResponse } from 'next/server';
import type { TenantContext } from '@rulebeat/core';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { createTenantContext, getAzureConnectionStatus } from '@/lib/azure-credential';
import { credentialFailedPreflight, runPreflight } from '@/lib/preflight';

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

  // Building the context is where a bad credential actually surfaces — createTenantContext()
  // resolves the credential and its subscription list, and runPreflight() below only ever probes
  // with a context that already exists. So this failure gets the per-check treatment too: a 200
  // whose credential check failed, not a wholesale 500 that hides the one answer the person on the
  // onboarding step came for. "Nothing configured at all" stays the actionable 503 the setup
  // screen already understands.
  let ctx: TenantContext;
  const start = Date.now();
  try {
    ctx = await createTenantContext();
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'azure_not_configured') {
      return azureError('Failed to run preflight checks', err);
    }
    return NextResponse.json(credentialFailedPreflight(err, Date.now() - start));
  }

  try {
    const status = getAzureConnectionStatus();
    const result = await runPreflight({ ctx, clientId: status.clientId ?? undefined });
    return NextResponse.json(result);
  } catch (err) {
    return azureError('Failed to run preflight checks', err);
  }
}
