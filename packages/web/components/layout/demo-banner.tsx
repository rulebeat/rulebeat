import { isDemoMode } from '@/lib/demo';
import { resolveDemoResetSettings } from '@/lib/demo/config';
import { getNextDemoResetAt } from '@/lib/demo/readiness';
import { DEMO_RESET_AT_KEY } from '@/lib/demo/reset';
import { getMeta } from '@/lib/db/meta';
import { DemoBannerStatus } from './demo-banner-status';

/**
 * A Visitor needs to know, at a glance and on every page, that this is synthetic data, that what
 * they change here is shared with everyone else on the Demo, and when it will be put back. Kept
 * under 30px because this bar appears in every screenshot taken of the product. Renders nothing
 * outside a Demo, and nothing in the Recording presentation.
 */
export async function DemoBanner() {
  if (!(await isDemoMode())) return null;
  if (resolveDemoResetSettings().recording) return null;

  return (
    <div className="flex h-[26px] shrink-0 items-center justify-center gap-1.5 bg-ink text-[12px] text-surface">
      <span className="font-semibold">Demo</span>
      <DemoBannerStatus
        resetAt={await getMeta(DEMO_RESET_AT_KEY)}
        nextResetAt={getNextDemoResetAt()?.toISOString() ?? null}
      />
    </div>
  );
}
