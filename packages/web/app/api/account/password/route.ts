import { NextResponse } from 'next/server';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { getLocalAccount, setPassword } from '@/lib/db/local-accounts';
import { bumpSessionEpoch } from '@/lib/db/users';
import { hashPassword, verifyPassword } from '@/lib/password';
import { validatePasswordStrength } from '@/lib/password-policy';

/**
 * Self-service password change — `account:self`, granted to every role. The current password is
 * required unless the account is still on its forced-change flag (the first-boot owner, or one an
 * admin just reset), since demanding a password the user was never told defeats the reset.
 */
export async function POST(req: Request) {
  const actor = await requireRole('account:self');
  if (actor instanceof NextResponse) return actor;

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const newPassword = body.newPassword ?? '';
  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) {
    return NextResponse.json({ error: strength.error }, { status: 400 });
  }

  const account = getLocalAccount(actor.id);
  if (!account) {
    return NextResponse.json({ error: 'This account has no local password to change.' }, { status: 400 });
  }

  if (!account.mustChangePassword) {
    const currentPassword = body.currentPassword ?? '';
    const valid = !!currentPassword && await verifyPassword(currentPassword, account.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 });
    }
  }

  try {
    setPassword(actor.id, await hashPassword(newPassword), { mustChangePassword: false });
    // Invalidates the actor's own current token too — change-password-client.tsx redirects to
    // /signin rather than attempting to keep this session alive, which is the point (spec 020).
    bumpSessionEpoch(actor.id);

    // Best-effort: the file only exists on an install that just bootstrapped its owner account,
    // and its only purpose was to hand over this exact password.
    const dbPath = process.env.RULEBEAT_DB_PATH;
    const dataDir = dbPath && dbPath !== ':memory:' ? dirname(dbPath) : join(process.cwd(), 'data');
    const passwordFile = join(dataDir, 'initial-password.txt');
    try {
      if (existsSync(passwordFile)) unlinkSync(passwordFile);
    } catch {
      /* best effort */
    }

    writeAudit({
      actor,
      action: 'user.password_set',
      entityType: 'local_account',
      entityId: actor.id,
      summary: `${actor.email} set a new password`,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return serverError('Failed to change the password', err);
  }
}
