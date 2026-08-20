'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  onRetry: () => void;
}

/** Shared "the fetch failed" state for dashboard widgets — distinct from each widget's own
 *  empty-state branch, which only runs once a fetch has actually succeeded. See spec 010. */
export function WidgetUnavailable({ onRetry }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <AlertTriangle className="size-5 text-status-warn" />
      <p className="text-sm text-ink">Couldn&apos;t load this widget</p>
      <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
    </div>
  );
}
