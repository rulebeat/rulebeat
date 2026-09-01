import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { loadSuppressions, saveSuppressions } from '@/lib/suppressions';
import { writeAudit } from '@/lib/db/audit';
import type { Suppression } from '@/lib/types';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await loadSuppressions());
}

export async function POST(req: Request) {
  const actor = await requireRole('suppressions:write');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<Pick<Suppression, 'fingerprint' | 'resourceId' | 'reason' | 'expiresAt'>>(req);
  if (body instanceof NextResponse) return body;
  if (!body.fingerprint || !body.reason) {
    return NextResponse.json({ error: 'fingerprint and reason are required' }, { status: 400 });
  }

  const suppression: Suppression = {
    id: globalThis.crypto.randomUUID(),
    fingerprint: body.fingerprint,
    resourceId: body.resourceId,
    reason: body.reason,
    suppressedAt: new Date().toISOString(),
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
  };

  const all = await loadSuppressions();
  all.push(suppression);
  await saveSuppressions(all);

  // Suppression is the most consequential action in the product — it makes a real risk disappear
  // from the dashboard — so the reason and expiry are recorded alongside the actor.
  await writeAudit({
    actor,
    action: 'suppression.create',
    entityType: 'suppression',
    entityId: suppression.id,
    summary: `Suppressed a finding on ${suppression.resourceId || 'an unnamed resource'}`,
    details: {
      reason: suppression.reason,
      expiresAt: suppression.expiresAt ?? 'never',
      fingerprint: suppression.fingerprint,
    },
  });

  return NextResponse.json(suppression, { status: 201 });
}
