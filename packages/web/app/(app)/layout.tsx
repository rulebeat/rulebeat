import { cookies } from 'next/headers';
import { Sidebar } from '@/components/layout/sidebar';
import { DemoBanner } from '@/components/layout/demo-banner';
import { requireAppEntry } from '@/lib/app-entry';
import { getAppVersion } from '@/lib/version';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const initialPinned = cookieStore.get('sidebar:main')?.value !== 'false';
  // Resolved server-side so the nav renders correctly on first paint. Hiding a nav entry is
  // presentation only: the route and its API enforce the role themselves.
  const user = await requireAppEntry();

  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-background">
      <DemoBanner />
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        <Sidebar initialPinned={initialPinned} role={user.role} version={getAppVersion()} />
        {/* The single scroll region for the whole app: sidebar and (per-page) header stay fixed
            while page content scrolls independently, instead of the browser scrolling the entire
            page (which dragged the sidebar/header off-screen too and, combined with any bounded
            inner grids, produced a confusing double-scrollbar feel). */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
