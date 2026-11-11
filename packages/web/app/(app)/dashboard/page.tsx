import { redirect } from 'next/navigation';
import { listDashboards } from '@/lib/db/dashboards';

interface Props { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** The default dashboard. The query comes along, so a link to `/dashboard?severity=high` keeps its filter changes. */
export default async function DashboardPage({ searchParams }: Props) {
  const dashboards = await listDashboards();
  const target = dashboards.find(d => d.isDefault) ?? dashboards[0];
  if (!target) redirect('/dashboards');
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, one);
  }
  redirect(query.size > 0 ? `/dashboards/${target.id}?${query}` : `/dashboards/${target.id}`);
}
