import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Callout } from '@/components/ui/callout';
import type { Action } from '@/lib/rbac';
import { lockedSurfaceMessage } from '@/lib/demo/locked';

/**
 * A section every Visitor can see but not change in a Demo. The server refuses the change anyway
 * (requireRole() in lib/api-auth.ts); this says why before anyone tries, and disables the form
 * controls inside so nothing looks clickable. Outside a Demo it renders its children untouched.
 */
export function LockedSurface({ demo, action, children }: { demo: boolean; action: Action; children: ReactNode }) {
  const message = demo ? lockedSurfaceMessage(action) : null;
  if (!message) return <>{children}</>;
  return (
    <div className="space-y-2">
      <Callout icon={Lock}>{message}</Callout>
      <fieldset disabled className="contents">{children}</fieldset>
    </div>
  );
}
