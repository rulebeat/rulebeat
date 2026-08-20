import { redirect } from 'next/navigation';
import { listDashboards } from '@/lib/db/dashboards';

export default function DashboardPage() {
  const dashboards = listDashboards();
  const target = dashboards.find(d => d.isDefault) ?? dashboards[0];
  redirect(target ? `/dashboards/${target.id}` : '/dashboards');
}
