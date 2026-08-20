import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { bumpSessionEpoch, getUser } from '@/lib/db/users';
import { clearPassword, getLocalAccount, setPassword } from '@/lib/db/local-accounts';
import { hashPassword } from '@/lib/password';
import { validatePasswordStrength } from '@/lib/password-policy';

/**
 * Admin-managed local passwords — the break-glass this install can hand a colleague, or use to
 * recover a locked-out account, without touching SSO at all.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const target = getUser(id);
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: { password?: string } = {};
  try {
    body = await req.json() as typeof body;
  } catch {
    /* an empty body means "generate one" */
  }

  const hadAccount = !!getLocalAccount(id);
  const generated = !body.password;
  // A generated password is a random 16-char base64url string — always well past the 15-char
  // floor and never a real word, so it trivially clears the same validator an admin-typed one has
  // to. Running both through one path rather than skipping the check for the generated case keeps
  // there being exactly one place the policy is enforced.
  const password = body.password ?? randomBytes(12).toString('base64url');
  const strength = validatePasswordStrength(password);
  if (!strength.ok) {
    return NextResponse.json({ error: strength.error }, { status: 400 });
  }

  try {
    // Forced on every admin-set password — whoever actually knows the new value has to prove
    // that by choosing their own on next sign-in, same as the first-boot owner account.
    setPassword(id, await hashPassword(password), { mustChangePassword: true });
    bumpSessionEpoch(id);

    writeAudit({
      actor,
      action: hadAccount ? 'user.password_reset' : 'user.password_set',
      entityType: 'local_account',
      entityId: id,
      summary: hadAccount
        ? `${actor.email} reset the password for ${target.email}`
        : `${actor.email} set a local password for ${target.email}`,
    });

    return NextResponse.json({ ok: true, generatedPassword: generated ? password : undefined });
  } catch (err) {
    return serverError('Failed to set the password', err);
  }
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const target = getUser(id);
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (!getLocalAccount(id)) {
    return NextResponse.json({ error: 'This user has no local password to remove.' }, { status: 404 });
  }

  try {
    clearPassword(id);
    bumpSessionEpoch(id);
    writeAudit({
      actor,
      action: 'user.password_removed',
      entityType: 'local_account',
      entityId: id,
      summary: `${actor.email} removed the local password for ${target.email}`,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError('Failed to remove the password', err);
  }
}
