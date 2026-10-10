import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { queryCompare } from '@/lib/db/scan-compare';
import { COMPARE_ERRORS } from '@/lib/compare-response';
import { COMPARE_PARAMS, compareQueryFromParams, parseCompareIds } from '@/lib/compare-query';

/** Two past scans of one category compared, one page of one side (added, fixed or persisted) with the
 *  totals of all three, read from the scans' own records (ADR 0008). The query string is the address's
 *  own (`lib/compare-query.ts`): `compare=<idA>..<idB>`, then the side and the page. */
export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const search = new URL(req.url).searchParams;
  const ids = parseCompareIds(search.get(COMPARE_PARAMS.ids));
  if (!ids) return NextResponse.json(COMPARE_ERRORS['bad-request'].body, { status: COMPARE_ERRORS['bad-request'].status });

  try {
    const answer = await queryCompare(ids[0], ids[1], compareQueryFromParams(search));
    if (answer.status === 'ok') return NextResponse.json(answer.response);
    return NextResponse.json(COMPARE_ERRORS[answer.status].body, { status: COMPARE_ERRORS[answer.status].status });
  } catch (err) {
    return serverError('Could not compare these runs', err);
  }
}
