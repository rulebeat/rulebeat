import { notFound } from 'next/navigation';
import { DemoBanner } from '@/components/layout/demo-banner';
import { NoAccessState } from '@/components/findings/no-access-state';
import { requireAppEntry } from '@/lib/app-entry';
import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { holdsNoScope } from '@/lib/access-model';
import { getOpenableDashboard } from '@/lib/dashboard-visibility';
import { markDashboardConfig } from '@/lib/outside-access';
import { exitHref, presentFilters, type PresentSearchParams } from '@/lib/present';
import { PresentFrame, PresentGrid } from './present-screen';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<PresentSearchParams>;
}

/** Every value of every parameter, so a repeated one is carried to the ordinary view as it came. */
function toSearch(searchParams: PresentSearchParams): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, one);
  }
  return search;
}

/**
 * Present: a dashboard read-only and full screen. It sits outside the `(app)` layout, so it has no sidebar
 * and no Header, and makes that layout's checks itself. Opening it is not audited: it changes nothing.
 */
export default async function PresentPage({ params, searchParams }: Props) {
  const user = await requireAppEntry();
  const { id } = await params;
  const dashboard = await getOpenableDashboard(user, id);
  if (!dashboard) notFound();

  const query = await searchParams;
  const access = await resolveAccess(user);
  const filters = presentFilters(dashboard.config, query);
  // The URL filters can name a subscription outside the person's access just as a saved one can.
  const outsideAccess = markDashboardConfig(access, {
    ...dashboard.config,
    filters: { ...dashboard.config.filters, subscriptions: filters.subscriptions, resourceGroups: filters.resourceGroups },
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <DemoBanner />
      <PresentFrame name={dashboard.name} exitHref={exitHref(dashboard.id, toSearch(query))}>
        {holdsNoScope(access)
          ? <NoAccessState />
          : <PresentGrid dashboard={dashboard} filters={filters} outsideAccess={outsideAccess} />}
      </PresentFrame>
    </div>
  );
}

export async function generateMetadata({ params }: Pick<Props, 'params'>) {
  const { id } = await params;
  const dashboard = await getOpenableDashboard(await getCurrentUser(), id);
  return { title: dashboard ? `${dashboard.name} · RuleBeat` : 'Dashboard · RuleBeat' };
}
