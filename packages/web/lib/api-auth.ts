import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { can, type Action } from '@/lib/rbac';
import { getUser, type AppUser } from '@/lib/db/users';
import { getLocalAccount } from '@/lib/db/local-accounts';
import { isDemoMode, DEMO_VISITOR_ID } from '@/lib/demo';

/**
 * Resolves the signed-in person's local user row (which carries their role).
 *
 * The role is read from SQLite on every call rather than cached on the session token: a local
 * read costs microseconds, and it means a demotion or removal takes effect on the caller's very
 * next request instead of whenever their token happens to refresh.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  const session = await auth();
  const uid = session?.user?.uid;
  if (!uid) {
    // A demo visitor never signs in, so there is no uid to resolve — auth.config.ts's `authorized`
    // callback already let this anonymous GET through. Browse as the generator's seeded viewer row,
    // exactly like any other signed-in viewer downstream (no new authorization mechanism). Gated on
    // the full isDemoMode() (env *and* the database's own demo-mode-v1 stamp), not isDemoEnv()
    // alone — an incompletely-configured demo must fall through to "no user" like any other
    // anonymous request, never silently grant access to whatever demo.db happens to contain.
    return isDemoMode() ? getUser(DEMO_VISITOR_ID) : null;
  }
  const dbUser = getUser(uid);
  if (!dbUser) return null;
  // A token minted before this claim existed carries no epoch at all (`undefined`), which must
  // match a fresh row's default of 0 — otherwise every session in the world goes stale the moment
  // this ships. A real mismatch (some *other* number) means a local-password mutation happened
  // since this token was issued — see spec 020.
  if ((session.user?.epoch ?? 0) !== dbUser.sessionEpoch) return null;
  return dbUser;
}

/**
 * The authorization guard for API routes. Returns the acting user — so handlers get the audit
 * actor for free — or a ready-to-return 401/403, which callers check with `instanceof NextResponse`.
 *
 * Routes name the action they perform (`'rules:write'`), never a role, so the role→action mapping
 * lives in exactly one place: lib/rbac.ts.
 */
export async function requireRole(action: Action): Promise<AppUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Demo mode hard-denies every action but reading — checked ahead of, and independent from, the
  // normal can() lookup below, so the guarantee never rests on the seeded visitor row's stored role
  // staying 'viewer'. (It does stay 'viewer'; this is the belt to that suspenders, and it's what
  // proves the read-only promise even against a row someone tampered with directly in the database.)
  if (isDemoMode() && action !== 'read') {
    return NextResponse.json({ error: 'This is a read-only demo. Nothing here can be changed.' }, { status: 403 });
  }

  if (!can(user.role, action)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Mirrors app/(app)/layout.tsx's page-level redirect: a temporary password (first-boot owner,
  // or an admin reset) must be replaced before anything else is reachable. Without this, the API
  // never enforced it at all — a script using the printed password got permanent full access
  // without ever being forced to rotate off it (RB-QA-017).
  if (action !== 'account:self' && getLocalAccount(user.id)?.mustChangePassword) {
    return NextResponse.json({ error: 'You must set a new password before doing anything else.' }, { status: 403 });
  }
  return user;
}
