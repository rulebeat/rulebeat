import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { ownAccessOf } from '@/lib/access';

/** The signed-in person's own access: their Role, where it came from, and each Scope they hold. Read-only, and never another person's. */
export async function GET() {
  const actor = await requireRole('account:self', { readOnly: true });
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(ownAccessOf(actor, actor.access));
}
