import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getDashboard, listDashboards } from '@/lib/db/dashboards';
import { DashboardTabs } from '@/components/dashboard/dashboard-tabs';
import { NoAccessState } from '@/components/findings/no-access-state';
import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { NO_ACCESS, holdsNoScope } from '@/lib/access-model';
import { markDashboardConfig } from '@/lib/outside-access';
import { itemPermissionsFor, mayChangeItemWith, openableItems, canOpenItem } from '@/lib/item-access-model';
import { DashboardGridClient } from './dashboard-grid-client';

interface Props { params: Promise<{ id: string }> }

export default async function DashboardPage({ params }: Props) {
  const { id } = await params;
  // Sentinel id for spec 015's error.tsx e2e coverage. A real dashboard id is a UUID and can
  // never collide with this string, so it's a safe, deterministic way to exercise the route's
  // error boundary without a dedicated test-only route.
  if (id === '__e2e-throw__') throw new Error('e2e-triggered render error');
  const user = await getCurrentUser();
  const dashboard = await getDashboard(id);
  // Someone else's Personal dashboard is a 404 like an unknown id, an Admin included.
  if (!dashboard || !canOpenItem({ id: user?.id ?? '' }, dashboard)) notFound();
  const dashboards = openableItems({ id: user?.id ?? '' }, await listDashboards());
  const access = user ? await resolveAccess(user) : NO_ACCESS;
  const permissions = itemPermissionsFor(access, 'dashboard');

  return (
    <>
      <Header title={dashboard.name} description={dashboard.description} />
      <div className="flex-1 min-h-0 flex flex-col">
        <DashboardTabs dashboards={dashboards} activeId={dashboard.id} />
        <div className="flex-1 min-h-0">
          {holdsNoScope(access)
            ? <NoAccessState />
            : <DashboardGridClient
                dashboard={dashboard}
                outsideAccess={markDashboardConfig(access, dashboard.config)}
                canChange={mayChangeItemWith({ id: user?.id ?? '' }, permissions, dashboard)}
                canSetDefault={permissions.manage}
              />}
        </div>
      </div>
    </>
  );
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const user = await getCurrentUser();
  const dashboard = await getDashboard(id);
  // The title is the name, so someone else's Personal dashboard gets the unknown id's title.
  return { title: dashboard && canOpenItem({ id: user?.id ?? '' }, dashboard) ? `${dashboard.name} · RuleBeat` : 'Dashboard · RuleBeat' };
}
