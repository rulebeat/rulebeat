import { getDashboard } from '@/lib/db/dashboards';
import type { AppUser } from '@/lib/db/users';
import type { Dashboard } from '@/lib/types';

/**
 * The dashboard `id` as `user` may open it, or null when the id is unknown or not theirs to see. The one
 * place that decides, so the dashboard page and Present answer the same way and a page title never names
 * a dashboard the page itself would refuse.
 */
export async function getOpenableDashboard(user: AppUser | null, id: string): Promise<Dashboard | null> {
  if (!user) return null;
  return getDashboard(id);
}
