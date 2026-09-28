import type { TenantContext } from '@rulebeat/core';
import { createTenantContext } from './azure-credential';
import type { ScanLogContext } from './server-logger';
import { isDemoMode } from './demo';

/**
 * The tenant a scan runs against when its caller did not inject one: the real Azure tenant, or in
 * a Demo the synthetic one the Demo was generated from (lib/demo/live-context.ts). Only the scan
 * path uses this. Everything else that talks to Azure (query preview, schemas, diagnostics) keeps
 * calling createTenantContext(), which refuses in a Demo with the Demo's own message.
 */
export async function createScanContext(logContext?: ScanLogContext): Promise<TenantContext> {
  if (await isDemoMode()) {
    const { createLiveDemoContext } = await import('./demo/live-context');
    return createLiveDemoContext();
  }
  return createTenantContext(logContext);
}
