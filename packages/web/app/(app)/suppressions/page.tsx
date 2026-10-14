import { Header } from '@/components/layout/header';
import { loadSuppressions } from '@/lib/suppressions';
import { getPageAccess } from '@/lib/page-access';
import { writeControlsFor } from '@/lib/write-controls';
import { SuppressionsClient } from './suppressions-client';

export default async function SuppressionsPage() {
  const { access } = await getPageAccess();
  const suppressions = await loadSuppressions(access);
  return (
    <>
      <Header title="Suppressions" description="Findings you have intentionally acknowledged" />
      <main className="flex-1 p-8">
        <SuppressionsClient
          initialSuppressions={suppressions}
          canEdit={writeControlsFor(access).suppress}
        />
      </main>
    </>
  );
}
