import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { Sidebar } from '@/components/layout/sidebar';
import { DemoBanner } from '@/components/layout/demo-banner';
import { getCurrentUser } from '@/lib/api-auth';
import { getLocalAccount } from '@/lib/db/local-accounts';
import { can } from '@/lib/rbac';
import { isOnboardingPending } from '@/lib/onboarding';
import { getAppVersion } from '@/lib/version';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const initialPinned = cookieStore.get('sidebar:main')?.value !== 'false';
  // Resolved server-side so the nav renders correctly on first paint. Hiding a nav entry is
  // presentation only — the route and its API enforce the role themselves.
  const user = await getCurrentUser();

  // await getCurrentUser() returns null both for no session and for a session whose epoch claim no
  // longer matches the DB (spec 020 — a local-password mutation happened since this token was
  // issued). proxy.ts's authorized callback only checks that the JWT carries a uid claim, which a
  // stale token still does, so this is the one place page loads actually enforce "signed out" for
  // that case — every route under this layout, resolved via the redirect-short-circuits-nested-
  // rendering guarantee the two checks below already rely on. Demo mode is unaffected: its visitor
  // row comes back non-null with no token/epoch involved at all.
  if (!user) redirect('/signin');

  // A temporary password (the first-boot owner account, or an admin-reset one) must be replaced
  // before anything else in the app is reachable — /change-password lives outside this route
  // group specifically so this redirect doesn't loop back into itself.
  if (user && (await getLocalAccount(user.id))?.mustChangePassword) redirect('/change-password');

  // Must come after the mustChangePassword redirect above: requireRole blocks every action except
  // account:self while a temporary password is set (RB-QA-017), so onboarding's own API calls would
  // 403 if this ran first. Gated on the action, not role === 'admin' — lib/rbac.ts is the one place
  // that mapping lives.
  if (user && can(user.role, 'azure:manage') && await isOnboardingPending()) redirect('/onboarding');

  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-background">
      <DemoBanner />
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        <Sidebar initialPinned={initialPinned} role={user?.role ?? 'viewer'} version={getAppVersion()} />
        {/* The single scroll region for the whole app — sidebar and (per-page) header stay fixed
            while page content scrolls independently, instead of the browser scrolling the entire
            page (which dragged the sidebar/header off-screen too and, combined with any bounded
            inner grids, produced a confusing double-scrollbar feel). */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
