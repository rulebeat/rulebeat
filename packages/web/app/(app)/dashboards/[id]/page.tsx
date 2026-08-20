import { notFound } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { getDashboard, listDashboards } from '@/lib/db/dashboards';
import { DashboardTabs } from '@/components/dashboard/dashboard-tabs';
import { DashboardGridClient } from './dashboard-grid-client';

interface Props { params: Promise<{ id: string }> }

export default async function DashboardPage({ params }: Props) {
  const { id } = await params;
  // Sentinel id for spec 015's error.tsx e2e coverage — a real dashboard id is a UUID and can
  // never collide with this string, so it's a safe, deterministic way to exercise the route's
  // error boundary without a dedicated test-only route.
  if (id === '__e2e-throw__') throw new Error('e2e-triggered render error');
  const dashboard = getDashboard(id);
  if (!dashboard) notFound();
  const dashboards = listDashboards();

  return (
    <>
      <Header title={dashboard.name} description={dashboard.description} />
      <div className="flex-1 min-h-0 flex flex-col">
        <DashboardTabs dashboards={dashboards} activeId={dashboard.id} />
        <div className="flex-1 min-h-0">
          <DashboardGridClient dashboard={dashboard} />
        </div>
      </div>
    </>
  );
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const dashboard = getDashboard(id);
  return { title: dashboard ? `${dashboard.name} — RuleBeat` : 'Dashboard — RuleBeat' };
}
