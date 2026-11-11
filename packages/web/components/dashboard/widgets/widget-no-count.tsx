'use client';

import { Lock, SearchX } from 'lucide-react';
import type { WidgetNoCount } from '@/lib/widget-links';

/** Shared "nothing to count for you" state for dashboard widgets: the server's reason in place of a number
 *  or a link. Distinct from each widget's own empty copy, which says a count came back zero. */
export function WidgetNothingToCount({ reason }: { reason: WidgetNoCount }) {
  const Icon = reason.kind === 'outside-access' ? Lock : SearchX;
  return (
    <div role="status" className="flex h-full flex-col items-center justify-center gap-2 px-4 py-6 text-center">
      <Icon className="size-5 text-ink-2" aria-hidden="true" />
      <p className="text-sm font-semibold text-ink">{reason.title}</p>
      <p className="max-w-xs text-xs text-ink-2">{reason.detail}</p>
    </div>
  );
}
