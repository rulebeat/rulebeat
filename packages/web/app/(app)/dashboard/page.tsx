import { redirect } from 'next/navigation';
import { listDashboards } from '@/lib/db/dashboards';

export default async function DashboardPage() {
  const dashboards = await listDashboards();
  const target = dashboards.find(d => d.isDefault) ?? dashboards[0];
  redirect(target ? `/dashboards/${target.id}` : '/dashboards');
}
