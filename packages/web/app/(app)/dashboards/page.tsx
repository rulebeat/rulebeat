import { Header } from '@/components/layout/header';
import { listDashboards } from '@/lib/db/dashboards';
import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { holdBackDashboards } from '@/lib/db/held-back';
import { redirect } from 'next/navigation';
import { itemPermissionsFor, openableItems } from '@/lib/item-access-model';
import { installDefaultControlFor, shareControlFor } from '@/lib/write-controls';
import { getMyDefault } from '@/lib/db/default-dashboard';
import { noticeFor, withMyDefault } from '@/lib/default-dashboards';
import { DashboardsGallery } from './dashboards-gallery';

export default async function DashboardsPage({ searchParams }: { searchParams?: Promise<{ notice?: string | string[] }> }) {
  // await getCurrentUser(), not auth() directly: the only way an anonymous demo visitor (no session at
  // all) reaches past this gate, same as every other page-level check in the app.
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  const myDefaultId = (await getMyDefault(user.id)).dashboardId;
  const access = await resolveAccess(user);
  const dashboards = await holdBackDashboards(access, withMyDefault(openableItems(user, await listDashboards()), myDefaultId));
  const permissions = itemPermissionsFor(access, 'dashboard');
  const notice = noticeFor((await searchParams)?.notice);

  return (
    <>
      <Header title="Dashboards" description="Manage and create custom dashboards" />
      <DashboardsGallery initialDashboards={dashboards} currentUserId={user.id} permissions={permissions} shareControl={shareControlFor(access, 'dashboard')} installDefaultControl={installDefaultControlFor(access)} notice={notice} />
    </>
  );
}
