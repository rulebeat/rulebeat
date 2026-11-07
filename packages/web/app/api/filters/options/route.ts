import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { readFilterOptions } from '@/lib/db/filter-options';

export const dynamic = 'force-dynamic';

/**
 * The options the shared filter component offers, in one answer (#388): categories, Rule sources, tags,
 * severities, every rule on the install, the Scope tree the caller holds and where the findings they see are
 * placed. It reads RuleBeat's own copy of the management group tree and never asks Azure.
 */
export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  try {
    return Response.json(await readFilterOptions(actor.access));
  } catch (err) {
    return serverError('Could not load the filter options', err);
  }
}
