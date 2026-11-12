import { redirect } from 'next/navigation';
import { getDashboard, getInstallDefaultId } from '@/lib/db/dashboards';
import { getMyDefault, takeUnavailableNotice } from '@/lib/db/default-dashboard';
import { getCurrentUser } from '@/lib/api-auth';
import { canOpenItem } from '@/lib/item-access-model';
import { withNotice } from '@/lib/default-dashboards';

/**
 * Where the dashboard link lands (ADR 0012): the person's My default, then the Install default, then the
 * gallery, which says there is none. Nothing is chosen for them: the first dashboard they can open is not a
 * fallback, and this page never writes a My default. The one thing it writes is the "no longer available"
 * flag, cleared as it redirects with the notice, so the person is told once.
 */
export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  const noticePending = await takeUnavailableNotice(user.id);
  // A My default the person cannot open is skipped rather than followed to a "not found".
  const chosen = (await getMyDefault(user.id)).dashboardId;
  const mine = chosen ? await getDashboard(chosen) : null;
  const target = mine && canOpenItem(user, mine) ? mine.id : await getInstallDefaultId();
  const path = target ? `/dashboards/${target}` : '/dashboards';
  redirect(noticePending ? withNotice(path) : path);
}
