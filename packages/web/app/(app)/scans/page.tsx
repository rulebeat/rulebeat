import { Header } from '@/components/layout/header';
import { loadRules } from '@/lib/rules';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { countsAsAffected } from '@/lib/finding-kinds';
import { getScansForRun, listScanMetas } from '@/lib/scan-history';
import { loadSuppressions } from '@/lib/suppressions';
import { activityEmptyState, advisoriesEmptyState } from '@/lib/tab-empty-state';
import { listAllRuns, getRun, getLatestRun } from '@/lib/schedule-runs';
import { listSchedules } from '@/lib/db/schedules';
import { listLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { listChannels } from '@/lib/db/notification-channels';
import { ScansClient } from '@/components/modules/scans-client';
import { filterValues, viewFromSearchParams } from '@/lib/finding-view';
import { snapshotQueryFromParams } from '@/lib/snapshot-query';
import { compareQueryFromParams, parseCompareIds } from '@/lib/compare-query';
import { listCategories } from '@/lib/db/categories';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import type { Rule, Suppression } from '@/lib/types';

type TabKey = 'results' | 'advisories' | 'activity' | 'history' | 'rules' | 'schedules';

export default async function ScansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const tabParam = one(params.tab);
  const scanId = one(params.scan);
  const runId = one(params.run);
  const compare = one(params.compare);
  const compareCategory = one(params.compareCategory);
  // Every filter, column, sort and page param is read by the one reader the explorer writes with.
  const initialView = viewFromSearchParams(params);
  const initialSavedViewId = one(params.view);
  const categories = await listCategories();
  const user = await getCurrentUser();
  const role = user?.role ?? 'viewer';

  const activeTab: TabKey = (tabParam === 'advisories' || tabParam === 'activity' || tabParam === 'history' || tabParam === 'rules' || tabParam === 'schedules') ? tabParam : 'results';
  const initialSuppressions = await loadSuppressions() as Suppression[];
  const initialCategoryFilter = filterValues(initialView.filters, 'category');

  let runDetail: { run: NonNullable<Awaited<ReturnType<typeof getRun>>>; scans: Awaited<ReturnType<typeof getScansForRun>> } | null = null;
  let snapshotScanId: string | undefined;
  let compareIds: [string, string] | undefined;
  let compareCategoryScans: Awaited<ReturnType<typeof listScanMetas>> | undefined;

  const initialSchedules = activeTab === 'schedules'
    ? await Promise.all((await listSchedules()).map(async s => ({
        ...s,
        lastRun: await getLatestRun(s.id),
        notificationLinks: await listLinksForSchedule(s.id),
      })))
    : undefined;
  // Load channels for anyone who can edit schedules — the summary type carries no URL so it's
  // safe to send to editors. Admins manage the destinations; editors just assign them.
  const initialNotificationChannels = activeTab === 'schedules' && can(role, 'schedules:write')
    ? await listChannels()
    : undefined;

  // Rules tab's "N resources affected" column — same group-by-ruleId pattern as
  // api/widgets/top-rules/route.ts. dateWindow is required by the type but unused for an
  // active-findings query, so the value here is a harmless placeholder.
  let ruleFindingCounts: Record<string, number> | undefined;
  if (activeTab === 'rules') {
    ruleFindingCounts = {};
    for (const f of await queryActiveFindings({ dateWindow: { mode: 'relative', days: 7 } })) {
      if (!countsAsAffected(f)) continue;
      ruleFindingCounts[f.ruleId] = (ruleFindingCounts[f.ruleId] ?? 0) + 1;
    }
  }

  if (activeTab === 'history') {
    if (compare) {
      // The compare reads its own findings from the server a page at a time (ADR 0008), so the page passes
      // the ids through and never loads either scan. An id that is gone is the screen's to say.
      compareIds = parseCompareIds(compare) ?? undefined;
    } else if (compareCategory) {
      compareCategoryScans = await listScanMetas(compareCategory, 20);
    } else if (runId) {
      const run = await getRun(runId);
      if (run) {
        runDetail = { run, scans: await getScansForRun(runId) };
        // The snapshot reads its own findings from the server a page at a time (ADR 0008), so the page
        // passes the id through and never loads the scan.
        if (scanId) snapshotScanId = scanId;
      }
    }
  }

  // The Results, Advisories and Activity tabs send no findings: the explorer reads them from the
  // server view as the view changes, starting from `initialView`.
  const policies = await loadRules() as unknown as Rule[];
  const tabEmpty = activeTab === 'advisories' ? advisoriesEmptyState(policies)
    : activeTab === 'activity' ? activityEmptyState(policies)
    : undefined;

  return (
    <>
      <Header title="Scans" description="Every rule across every category. Filter, run, and review results" />
      <ScansClient
        policies={policies}
        categories={categories}
        role={role}
        activeTab={activeTab}
        initialSuppressions={initialSuppressions}
        initialCategoryFilter={initialCategoryFilter}
        initialView={initialView}
        initialSavedViewId={initialSavedViewId}
        runs={activeTab === 'history' ? await listAllRuns(50) : undefined}
        runDetail={runDetail}
        snapshotScanId={snapshotScanId}
        snapshotQuery={snapshotScanId ? snapshotQueryFromParams(params) : undefined}
        compareCategorySlug={compareCategory}
        compareCategoryScans={compareCategoryScans}
        compareIds={compareIds}
        compareQuery={compareIds ? compareQueryFromParams(params) : undefined}
        initialSchedules={initialSchedules}
        canEditSchedules={can(role, 'schedules:write')}
          notificationChannels={initialNotificationChannels}
        ruleFindingCounts={ruleFindingCounts}
        tabEmpty={tabEmpty}
      />
    </>
  );
}
