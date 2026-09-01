import { Header } from '@/components/layout/header';
import { listDashboards } from '@/lib/db/dashboards';
import { getCurrentUser } from '@/lib/api-auth';
import { redirect } from 'next/navigation';
import { DashboardsGallery } from './dashboards-gallery';

export default async function DashboardsPage() {
  // await getCurrentUser(), not auth() directly: the only way an anonymous demo visitor (no session at
  // all) reaches past this gate, same as every other page-level check in the app.
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  const dashboards = await listDashboards();

  return (
    <>
      <Header title="Dashboards" description="Manage and create custom dashboards" />
      <DashboardsGallery initialDashboards={dashboards} />
    </>
  );
}
