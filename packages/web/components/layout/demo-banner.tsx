import { isDemoMode } from '@/lib/demo';

/**
 * A Visitor needs to know, at a glance and on every page, that this is synthetic data and that what
 * they change here is shared with everyone else on the Demo. Kept under 30px because this bar
 * appears in every screenshot taken of the product. Renders nothing at all outside a Demo.
 */
export async function DemoBanner() {
  if (!(await isDemoMode())) return null;

  return (
    <div className="flex h-[26px] shrink-0 items-center justify-center gap-1.5 bg-ink text-[12px] text-surface">
      <span className="font-semibold">Demo</span>
      <span className="opacity-75">Synthetic data. Every Visitor shares it, and it returns to its starting state on restart.</span>
    </div>
  );
}
