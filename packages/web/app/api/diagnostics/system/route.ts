import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { getSystemDiagnostics } from '@/lib/diagnostics';

/**
 * Local system health checks — scheduler liveness and schema-cache age. Instant reads (no network
 * calls), so the diagnostics page can paint this section immediately while the slower Azure preflight
 * check loads. Admin-only: same gate as the preflight route, both under `diagnostics/`.
 */
export async function GET() {
  const actor = await requireRole('azure:manage');
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(getSystemDiagnostics());
}
