import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { hierarchyResponse } from '@/lib/management-group-response';

export const dynamic = 'force-dynamic';

/**
 * RuleBeat's copy of the management group tree and how its last refresh went, for the Admin choosing
 * someone's Scopes. Admin-only: it lists the groups and subscriptions of the tenant, which a person may
 * not be allowed to see. It reads the copy and never asks Azure.
 */
export async function GET() {
  const actor = await requireRole('users:manage', { readOnly: true });
  if (actor instanceof NextResponse) return actor;

  try {
    return NextResponse.json(await hierarchyResponse());
  } catch (err) {
    return serverError('Could not read the management group tree', err);
  }
}
