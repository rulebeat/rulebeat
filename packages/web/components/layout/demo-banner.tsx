import { isDemoMode } from '@/lib/demo';

/**
 * A visitor browsing the public demo instance needs to know, at a glance and on every page, that
 * this is synthetic data and nothing they do here changes anything. Kept under 30px because this
 * bar appears in every screenshot taken of the product. Renders nothing at all outside demo mode.
 */
export async function DemoBanner() {
  if (!(await isDemoMode())) return null;

  return (
    <div className="flex h-[26px] shrink-0 items-center justify-center gap-1.5 bg-ink text-[12px] text-surface">
      <span className="font-semibold">Demo</span>
      <span className="opacity-75">Synthetic data. Read-only. Nothing here can be changed.</span>
    </div>
  );
}
