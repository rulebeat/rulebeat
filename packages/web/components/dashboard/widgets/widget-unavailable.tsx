'use client';

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** A known reason a widget, or one part of it, has nothing to show. */
export interface UnavailableReason { title: string; detail: string }

type Props =
  | { onRetry: () => void; reason?: undefined; inline?: undefined }
  | { reason: UnavailableReason; inline?: boolean; onRetry?: undefined };

/** Shared "the fetch failed" state for dashboard widgets: distinct from each widget's own
 *  empty-state branch, which only runs once a fetch has actually succeeded. See spec 010.
 *
 *  With a `reason` the state is known rather than failed, so there is nothing to retry: it renders
 *  as a status with no warning icon and no Retry, over the whole tile or, with `inline`, in the
 *  slot of one figure (the delta under a number) while the rest of the widget stays live. */
export function WidgetUnavailable(props: Props) {
  if (props.reason) {
    const { title, detail } = props.reason;
    if (props.inline) {
      return (
        <div role="status" className="space-y-0.5 text-xs">
          <p className="font-medium text-ink-2">{title}</p>
          <p className="max-w-xs text-ink-muted">{detail}</p>
        </div>
      );
    }
    return (
      <div role="status" className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="max-w-xs text-xs text-ink-2">{detail}</p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <AlertTriangle className="size-5 text-status-warn" />
      <p className="text-sm text-ink">Couldn&apos;t load this widget</p>
      <Button size="sm" variant="outline" onClick={props.onRetry}>Retry</Button>
    </div>
  );
}
