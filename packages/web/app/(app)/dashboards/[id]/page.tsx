import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getDashboard, listDashboards } from '@/lib/db/dashboards';
import { DashboardTabs } from '@/components/dashboard/dashboard-tabs';
import { NoAccessState } from '@/components/findings/no-access-state';
import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { NO_ACCESS, holdsNoScope } from '@/lib/access-model';
import { buildBarState } from '@/lib/dashboard-bar';
import { savedFiltersOf } from '@/lib/dashboard-filters';
import { loadKnownValues } from '@/lib/dashboard-known-values';
import { dashboardAddress } from '@/lib/finding-view';
import { dashboardEditControlFor } from '@/lib/write-controls';
import { DashboardGridClient } from './dashboard-grid-client';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DashboardPage({ params, searchParams }: Props) {
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
  // The bar is worked out here, from the address in this request, so it and the widgets read the same changes.
  const saved = savedFiltersOf(dashboard.config);
  const { state, marks } = buildBarState({
    revision: dashboard.revision,
    saved,
    changes: dashboardAddress(saved).read(await searchParams),
    access,
    widgets: dashboard.config.widgets,
    known: await loadKnownValues(),
  });

  return (
    <>
      <Header title={dashboard.name} description={dashboard.description} />
      <div className="flex-1 min-h-0 flex flex-col">
        <DashboardTabs dashboards={dashboards} activeId={dashboard.id} />
        <div className="flex-1 min-h-0">
          {holdsNoScope(access)
            ? <NoAccessState />
            : <DashboardGridClient dashboard={dashboard} outsideAccess={marks} bar={state} edit={dashboardEditControlFor(access)} />}
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
