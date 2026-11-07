import { redirect } from 'next/navigation';
import { listDashboards } from '@/lib/db/dashboards';
import { getCurrentUser } from '@/lib/api-auth';
import { openableItems } from '@/lib/item-access-model';

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/signin');
  // The Install default is a Shared dashboard an Admin chose. With none, the first one the person can open.
  const dashboards = openableItems(user, await listDashboards());
  const target = dashboards.find(d => d.isDefault && d.visibility === 'shared') ?? dashboards[0];
  redirect(target ? `/dashboards/${target.id}` : '/dashboards');
}
