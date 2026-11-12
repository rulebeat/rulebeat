import { notFound } from 'next/navigation';
import { NoAccessState } from '@/components/findings/no-access-state';
import { Header } from '@/components/layout/header';
import { getDashboard, listDashboards } from '@/lib/db/dashboards';
import { DashboardTabs } from '@/components/dashboard/dashboard-tabs';
import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { NO_ACCESS, holdsNoScope } from '@/lib/access-model';
import { holdBackDashboards } from '@/lib/db/held-back';
import { itemPermissionsFor, mayChangeItemWith, openableItems, canOpenItem, isOwnItem } from '@/lib/item-access-model';
import { installDefaultControlFor, shareControlFor } from '@/lib/write-controls';
import { getMyDefault } from '@/lib/db/default-dashboard';
import { noticeFor, withMyDefault } from '@/lib/default-dashboards';
import { Callout } from '@/components/ui/callout';
import { DashboardGridClient } from './dashboard-grid-client';

interface Props { params: Promise<{ id: string }>; searchParams?: Promise<{ notice?: string | string[] }> }

export default async function DashboardPage({ params, searchParams }: Props) {
  const { id } = await params;
  const notice = noticeFor((await searchParams)?.notice);
  // Sentinel id for spec 015's error.tsx e2e coverage. A real dashboard id is a UUID and can
  // never collide with this string, so it's a safe, deterministic way to exercise the route's
  // error boundary without a dedicated test-only route.
  if (id === '__e2e-throw__') throw new Error('e2e-triggered render error');
  const user = await getCurrentUser();
  const dashboard = await getDashboard(id);
  // Someone else's Personal dashboard is a 404 like an unknown id, an Admin included.
  if (!dashboard || !canOpenItem({ id: user?.id ?? '' }, dashboard)) notFound();
  const myDefaultId = user ? (await getMyDefault(user.id)).dashboardId : null;
  const access = user ? await resolveAccess(user) : NO_ACCESS;
  // The page reaches the browser, so what it holds is trimmed the way the API's answer is.
  const dashboards = await holdBackDashboards(access, withMyDefault(openableItems({ id: user?.id ?? '' }, await listDashboards()), myDefaultId));
  // The stored config never goes to the browser, so a dashboard the list no longer holds is gone, not shown untrimmed.
  const held = dashboards.find(d => d.id === dashboard.id);
  if (!held) notFound();
  const permissions = itemPermissionsFor(access, 'dashboard');
  const ownsPersonal = dashboard.visibility === 'personal' && isOwnItem({ id: user?.id ?? '' }, dashboard);

  return (
    <>
      <Header title={dashboard.name} description={dashboard.description} />
      <div className="flex-1 min-h-0 flex flex-col">
        {notice && <Callout tone="info" className="shrink-0 border-b border-rule-strong">{notice}</Callout>}
        <DashboardTabs dashboards={dashboards} activeId={dashboard.id} />
        <div className="flex-1 min-h-0">
          {/* A person with no Scope keeps their own Personal dashboards to edit, but a Shared one would draw
              every widget empty ("No findings"), so they are told why instead. */}
          {holdsNoScope(access) && !ownsPersonal
            ? <NoAccessState />
            : <DashboardGridClient
                dashboard={held}
                canChange={mayChangeItemWith({ id: user?.id ?? '' }, permissions, dashboard)}
                canSetDefault={permissions.manage}
                currentUserId={user?.id ?? ''}
                permissions={permissions}
                shareControl={shareControlFor(access, 'dashboard')}
                installDefaultControl={installDefaultControlFor(access)}
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
