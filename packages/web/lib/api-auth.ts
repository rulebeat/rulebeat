import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { can, type Action } from '@/lib/rbac';
import { getUser, type AppUser } from '@/lib/db/users';
import { getLocalAccount } from '@/lib/db/local-accounts';
import { isDemoMode, DEMO_VISITOR_ID } from '@/lib/demo';
import { lockedSurfaceMessage } from '@/lib/demo/locked';

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
    // A Visitor never signs in, so there is no uid to resolve: auth.config.ts's `authorized`
    // callback let the request through without a session. Act as the generator's seeded Visitor
    // row, an ordinary admin downstream (no new authorization mechanism). No session is minted for
    // it, so a Reset that rewrites the database can never strand a cookie. Gated on the full
    // isDemoMode() (env *and* the database's own demo-mode-v2 stamp), not isDemoEnv() alone: an
    // incompletely-configured Demo falls through to "no user" like any other anonymous request.
    return (await isDemoMode()) ? getUser(DEMO_VISITOR_ID) : null;
  }
  const dbUser = await getUser(uid);
  if (!dbUser) return null;
  // A token minted before this claim existed carries no epoch at all (`undefined`), which must
  // match a fresh row's default of 0 — otherwise every session in the world goes stale the moment
  // this ships. A real mismatch (some *other* number) means a local-password mutation happened
  // since this token was issued — see spec 020.
  if ((session.user?.epoch ?? 0) !== dbUser.sessionEpoch) return null;
  return dbUser;
}

/**
 * The authorization guard for API routes. Returns the acting user (so handlers get the audit
 * actor for free) or a ready-to-return 401/403, which callers check with `instanceof NextResponse`.
 *
 * Routes name the action they perform (`'rules:write'`), never a role, so the role→action mapping
 * lives in exactly one place: lib/rbac.ts.
 *
 * In a Demo, every Visitor is an admin, so the Locked surfaces (lib/demo/locked.ts) are refused
 * here with the reason. A handler that only reads a Locked surface passes `{ readOnly: true }` to
 * stay readable; leaving it off only ever makes a handler stricter. `route-guards.test.ts` checks
 * that `readOnly` appears only in GET handlers.
 */
export async function requireRole(
  action: Action,
  opts: { readOnly?: boolean } = {},
): Promise<AppUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!opts.readOnly && (await isDemoMode())) {
    const locked = lockedSurfaceMessage(action);
    if (locked) return NextResponse.json({ error: locked }, { status: 403 });
  }

  if (!can(user.role, action)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Mirrors app/(app)/layout.tsx's page-level redirect: a temporary password (first-boot owner,
  // or an admin reset) must be replaced before anything else is reachable. Without this, the API
  // never enforced it at all — a script using the printed password got permanent full access
  // without ever being forced to rotate off it (RB-QA-017).
  if (action !== 'account:self' && (await getLocalAccount(user.id))?.mustChangePassword) {
    return NextResponse.json({ error: 'You must set a new password before doing anything else.' }, { status: 403 });
  }
  return user;
}
