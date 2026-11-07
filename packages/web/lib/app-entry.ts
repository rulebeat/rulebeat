import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/api-auth';
import { getLocalAccount } from '@/lib/db/local-accounts';
import { can } from '@/lib/rbac';
import { isOnboardingPending } from '@/lib/onboarding';
import { isDemoMode } from '@/lib/demo';
import type { AppUser } from '@/lib/db/users';

/**
 * The checks every signed-in page makes before it renders anything, in order: signed in, no temporary
 * password, onboarding done. The `(app)` layout calls this, and so does any page that sits outside that
 * layout (Present has no sidebar), so the two cannot drift apart. Each failure is a redirect, which
 * short-circuits whatever would have rendered below it.
 */
export async function requireAppEntry(): Promise<AppUser> {
  const user = await getCurrentUser();

  // await getCurrentUser() returns null both for no session and for a session whose epoch claim no
  // longer matches the DB (spec 020: a local-password mutation happened since this token was
  // issued). proxy.ts's authorized callback only checks that the JWT carries a uid claim, which a
  // stale token still does, so this is the one place page loads actually enforce "signed out" for
  // that case: every route under the (app) layout, resolved via the redirect-short-circuits-nested-
  // rendering guarantee the two checks below already rely on. Demo mode is unaffected: its visitor
  // row comes back non-null with no token/epoch involved at all.
  if (!user) redirect('/signin');

  // A temporary password (the first-boot owner account, or an admin-reset one) must be replaced
  // before anything else in the app is reachable: /change-password lives outside the (app) route
  // group specifically so this redirect doesn't loop back into itself.
  if ((await getLocalAccount(user.id))?.mustChangePassword) redirect('/change-password');

  // Must come after the mustChangePassword redirect above: requireRole blocks every action except
  // account:self while a temporary password is set (RB-QA-017), so onboarding's own API calls would
  // 403 if this ran first. Gated on the action, not role === 'admin': lib/rbac.ts is the one place
  // that mapping lives. A Demo has no onboarding (/onboarding is a 404 there), and its Visitor is an
  // admin, so the redirect would send every Visitor to a page that does not exist.
  if (can(user.role, 'azure:manage') && !(await isDemoMode()) && await isOnboardingPending()) redirect('/onboarding');

  return user;
}
