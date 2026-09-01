import { Header } from '@/components/layout/header';
import { loadRules } from '@/lib/rules';
import { queryActiveFindings } from '@/lib/dashboard-data';
import { getScanById, getScansForRun, listScanMetas } from '@/lib/scan-history';
import { loadSuppressions } from '@/lib/suppressions';
import { buildExplorerData } from '@/lib/explorer-data';
import { listAllRuns, getRun, getLatestRun } from '@/lib/schedule-runs';
import { listSchedules } from '@/lib/db/schedules';
import { listLinksForSchedule } from '@/lib/db/schedule-notification-channels';
import { listChannels } from '@/lib/db/notification-channels';
import { ScansClient } from '@/components/modules/scans-client';
import { parseCategoryParam } from '@/lib/scans-link';
import { listCategories } from '@/lib/db/categories';
import { getCurrentUser } from '@/lib/api-auth';
import { can } from '@/lib/rbac';
import type { Rule, ScanSummary, Severity, Suppression } from '@/lib/types';

type TabKey = 'results' | 'history' | 'rules' | 'schedules';

export default async function ScansPage({
  searchParams,
}: {
  searchParams: Promise<{
    category?: string; tab?: string; scan?: string; run?: string; compare?: string;
    compareCategory?: string; status?: string; ruleId?: string;
    severity?: string; subscription?: string; rg?: string; location?: string; tags?: string;
    window?: string; from?: string; to?: string; q?: string;
  }>;
}) {
  const {
    category: sectionParam, tab: tabParam, scan: scanId, run: runId, compare, compareCategory, status, ruleId,
    severity, subscription, rg, location, tags, window, from, to, q,
  } = await searchParams;
  const categories = await listCategories();
  const user = await getCurrentUser();
  const role = user?.role ?? 'viewer';

  const activeTab: TabKey = (tabParam === 'history' || tabParam === 'rules' || tabParam === 'schedules') ? tabParam : 'results';
  const initialSuppressions = await loadSuppressions() as Suppression[];
  const initialCategoryFilter = parseCategoryParam(sectionParam);

  let runDetail: { run: NonNullable<Awaited<ReturnType<typeof getRun>>>; scans: Awaited<ReturnType<typeof getScansForRun>> } | null = null;
  let snapshotScan: ScanSummary | null = null;
  let compareScans: [ScanSummary, ScanSummary] | null = null;
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
      ruleFindingCounts[f.ruleId] = (ruleFindingCounts[f.ruleId] ?? 0) + 1;
    }
  }

  if (activeTab === 'history') {
    if (compare) {
      const [idA, idB] = compare.split('..');
      const scanA = idA ? await getScanById(idA) : null;
      const scanB = idB ? await getScanById(idB) : null;
      if (scanA && scanB) compareScans = [scanA, scanB];
    } else if (compareCategory) {
      compareCategoryScans = await listScanMetas(compareCategory, 20);
    } else if (runId) {
      const run = await getRun(runId);
      if (run) {
        runDetail = { run, scans: await getScansForRun(runId) };
        if (scanId) snapshotScan = await getScanById(scanId);
      }
    }
  }

  const explorerData = await buildExplorerData();

  return (
    <>
      <Header title="Scans" description="Every rule across every category. Filter, run, and review results" />
      <ScansClient
        policies={await loadRules() as unknown as Rule[]}
        categories={categories}
        role={role}
        activeTab={activeTab}
        explorerData={explorerData}
        initialSuppressions={initialSuppressions}
        initialCategoryFilter={initialCategoryFilter}
        resultsInitialFilters={{
          categories: initialCategoryFilter,
          status,
          ruleId,
          severities: severity ? (severity.split(',').filter(Boolean) as Severity[]) : undefined,
          subscriptions: subscription ? subscription.split(',').filter(Boolean) : undefined,
          resourceGroups: rg ? rg.split(',').filter(Boolean) : undefined,
          locations: location ? location.split(',').filter(Boolean) : undefined,
          tags: tags ? tags.split(',').filter(Boolean) : undefined,
          windowDays: window ? Number(window) : undefined,
          from,
          to,
          search: q,
        }}
        runs={activeTab === 'history' ? await listAllRuns(50) : undefined}
        runDetail={runDetail}
        snapshotScan={snapshotScan}
        compareCategorySlug={compareCategory}
        compareCategoryScans={compareCategoryScans}
        compareScans={compareScans}
        initialSchedules={initialSchedules}
        canEditSchedules={can(role, 'schedules:write')}
          notificationChannels={initialNotificationChannels}
        ruleFindingCounts={ruleFindingCounts}
      />
    </>
  );
}
