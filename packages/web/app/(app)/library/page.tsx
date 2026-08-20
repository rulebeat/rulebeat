import { cookies } from 'next/headers';
import { Header } from '@/components/layout/header';
import { loadRules } from '@/lib/rules';
import { listCategories } from '@/lib/db/categories';
import { getCurrentUser } from '@/lib/api-auth';
import { LibraryClient } from './library-client';
import type { Rule } from '@/lib/types';
import packManifestJson from '@/data/packs/pack-manifest.json';

export interface PackManifestEntry {
  label: string;
  source: string;
  license: string;
  attribution: string;
  pinnedCommit: string;
  syncedAt: string;
  policyCount: number;
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  const rules = loadRules() as unknown as Rule[];
  const categories = listCategories();
  const cookieStore = await cookies();
  const initialSidebarPinned = cookieStore.get('sidebar:library')?.value !== 'false';
  const user = await getCurrentUser();
  return (
    <>
      <Header title="Library" description="Search, filter, and manage the rules that power your scans: built-in packs, community contributions, and your own custom checks" />
      <main className="flex-1 p-8">
        <LibraryClient
          initialRules={rules}
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
