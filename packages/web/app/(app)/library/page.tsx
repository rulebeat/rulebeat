import { cookies } from 'next/headers';
import { Header } from '@/components/layout/header';
import { loadRules } from '@/lib/rules';
import { listCategories } from '@/lib/db/categories';
import { loadRecordedVersions } from '@/lib/db/recorded-versions';
import { newerVersionsByRule } from '@/lib/rule-version-markers';
import { getCurrentUser } from '@/lib/api-auth';
import { resolveAccess } from '@/lib/access';
import { NO_ACCESS } from '@/lib/access-model';
import { listPersonalRules } from '@/lib/db/personal-rules';
import { can } from '@/lib/rbac';
import { NEEDS_SUBSCRIPTION_MESSAGE, mayWriteQueries } from '@/lib/written-query';
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
  const rules = await loadRules() as unknown as Rule[];
  const newerVersions = newerVersionsByRule(rules, await loadRecordedVersions());
  const categories = await listCategories();
  const cookieStore = await cookies();
  const initialSidebarPinned = cookieStore.get('sidebar:library')?.value !== 'false';
  const user = await getCurrentUser();

  // Only the signed-in person's own Personal rules are read, so no one else's can reach the page.
  const personalRules = user ? (await listPersonalRules(user.id)).map(({ lastRunCoveredScope: _scope, ...rule }) => rule) as unknown as Rule[] : [];
  const access = user ? await resolveAccess(user) : NO_ACCESS;
  const personalWriteBlockedReason = !user || !can(user.role, 'rules:personal')
    ? 'Personal rules are written by Editors. You can read the ones you already have.'
    : mayWriteQueries(access).ok ? null : NEEDS_SUBSCRIPTION_MESSAGE;
  return (
    <>
      <Header title="Library" description="Search, filter, and manage the rules that power your scans: built-in packs, community contributions, and your own custom checks" />
      <main className="flex-1 p-8">
        <LibraryClient
          initialRules={rules}
          personalRules={personalRules}
          personalWriteBlockedReason={personalWriteBlockedReason}
          newerVersions={newerVersions}
          initialSection={section}
          packManifest={packManifestJson as Record<string, PackManifestEntry>}
          categories={categories}
          initialSidebarPinned={initialSidebarPinned}
          role={user?.role ?? 'viewer'}
        />
      </main>
    </>
  );
}
