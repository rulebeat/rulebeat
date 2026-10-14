import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getDashboard, listDashboards } from '@/lib/db/dashboards';
import { DashboardTabs } from '@/components/dashboard/dashboard-tabs';
import { NoAccessState } from '@/components/findings/no-access-state';
import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { NO_ACCESS, holdsNoScope } from '@/lib/access-model';
import { markDashboardConfig } from '@/lib/outside-access';
import { DashboardGridClient } from './dashboard-grid-client';

interface Props { params: Promise<{ id: string }> }

export default async function DashboardPage({ params }: Props) {
  const { id } = await params;
  // Sentinel id for spec 015's error.tsx e2e coverage. A real dashboard id is a UUID and can
  // never collide with this string, so it's a safe, deterministic way to exercise the route's
  // error boundary without a dedicated test-only route.
  if (id === '__e2e-throw__') throw new Error('e2e-triggered render error');
  const dashboard = await getDashboard(id);
  if (!dashboard) notFound();
  const dashboards = await listDashboards();
  const user = await getCurrentUser();
  const access = user ? await resolveAccess(user) : NO_ACCESS;

  return (
    <>
      <Header title={dashboard.name} description={dashboard.description} />
      <div className="flex-1 min-h-0 flex flex-col">
        <DashboardTabs dashboards={dashboards} activeId={dashboard.id} />
        <div className="flex-1 min-h-0">
          {holdsNoScope(access)
            ? <NoAccessState />
            : <DashboardGridClient dashboard={dashboard} outsideAccess={markDashboardConfig(access, dashboard.config)} />}
        </div>
      </div>
    </>
  );
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const dashboard = await getDashboard(id);
  return { title: dashboard ? `${dashboard.name} · RuleBeat` : 'Dashboard · RuleBeat' };
}
