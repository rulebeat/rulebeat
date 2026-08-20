import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { probeTenant, resolveSignInConfig } from '@/lib/sign-in-config';

/**
 * "Test sign-in" — a tenant-reachability probe, not a full verification. B1b's design note on
 * this is explicit: a client-credentials-style check can't see the redirect URI, which is the
 * single most common Entra setup failure, so a green tick here must never be confused with "login
 * will work" — that only gets proven by an actual sign-in through the button on /signin.
 *
 * Two modes, same as the Azure connection test route: with a tenant id in the body, it tests what
 * the admin has typed but not yet saved; with an empty body, it tests whatever is currently
 * resolved (env or stored), which is the only way to check an env-managed tenant.
 */
export async function POST(req: Request) {
  const actor = await requireRole('auth:manage');
  if (actor instanceof NextResponse) return actor;

  let body: { tenantId?: string } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    /* empty body is the "test what's live" mode */
  }

  try {
    const typedTenantId = body.tenantId?.trim();
    const tenantId = typedTenantId || resolveSignInConfig()?.tenantId;
    if (!tenantId) {
      return NextResponse.json({ ok: false, error: 'No tenant ID to test. Enter one first.' }, { status: 400 });
    }

    const result = await probeTenant(tenantId);

    writeAudit({
      actor,
      action: 'sign_in_config.test',
      entityType: 'sign_in_config',
      summary: result.ok
        ? `Tested tenant reachability for ${tenantId}. Reachable`
        : `Tested tenant reachability for ${tenantId}. Failed`,
      details: { ok: result.ok },
    });

    return result.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  } catch (err) {
    return serverError('Failed to test sign-in configuration', err);
  }
}
