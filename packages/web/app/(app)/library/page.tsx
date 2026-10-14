import { cookies } from 'next/headers';
import { Header } from '@/components/layout/header';
import { loadRules } from '@/lib/rules';
import { listCategories } from '@/lib/db/categories';
import { loadRecordedVersions } from '@/lib/db/recorded-versions';
import { newerVersionsByRule } from '@/lib/rule-version-markers';
import { getPageAccess } from '@/lib/page-access';
import { listPersonalRules } from '@/lib/db/personal-rules';
import { listOpenLibraryRequests } from '@/lib/db/library-requests';
import { requestSummary } from '@/lib/library-request-view';
import { mayAct } from '@/lib/rbac';
import { personalCopyReasons, personalWriteBlockedReason as personalWriteBlockedReasonFor } from '@/lib/personal-rule-request';
import { narrowRulesScope } from '@/lib/rule-scope-access';
import { writeControlsFor } from '@/lib/write-controls';
import { LibraryClient } from './library-client';
import type { Rule } from '@/lib/types';
import packManifestJson from '@/data/packs/pack-manifest.json';
import type { PackManifestEntry } from './pack-manifest';

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  const { user, access } = await getPageAccess();
  const rules = narrowRulesScope(await loadRules(), access) as unknown as Rule[];
  const newerVersions = newerVersionsByRule(rules, await loadRecordedVersions());
  const categories = await listCategories();
  const cookieStore = await cookies();
  const initialSidebarPinned = cookieStore.get('sidebar:library')?.value !== 'false';
  // Only the signed-in person's own Personal rules are read, so no one else's can reach the page.
  const personalRules = user ? (await listPersonalRules(user.id)).map(({ lastRunCoveredScope: _scope, ...rule }) => rule) as unknown as Rule[] : [];
  const personalWriteBlockedReason = personalWriteBlockedReasonFor(user?.role, access);
  const copyReasons = personalCopyReasons(user?.role, access);
  const controls = writeControlsFor(access);
  // The open Library requests go to a reviewer (rules:write, install-wide) and to no one else: for anyone
  // else the list is never read, so neither the Requests section nor its count reaches the page.
  const requests = mayAct(access, 'rules:write')
    ? await Promise.all((await listOpenLibraryRequests()).map(requestSummary))
    : null;
  return (
    <>
      <Header title="Library" description="Search, filter, and manage the rules that power your scans: built-in packs, community contributions, and your own custom checks" />
      <main className="flex-1 p-8">
        <LibraryClient
          initialRules={rules}
          personalRules={personalRules}
          personalWriteBlockedReason={personalWriteBlockedReason}
          personalCopyReasons={copyReasons}
          newerVersions={newerVersions}
          initialSection={section}
          requests={requests}
          packManifest={packManifestJson as Record<string, PackManifestEntry>}
          categories={categories}
          initialSidebarPinned={initialSidebarPinned}
          canAuthor={controls.rulesWrite}
          canDelete={controls.rulesDelete}
          writeReason={controls.reason}
        />
      </main>
    </>
  );
}
