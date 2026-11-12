import { Callout } from '@/components/ui/callout';
import { Button } from '@/components/ui/button';
import { SAVED_VIEW_GONE_COPY } from '@/lib/held-back';

/** Said once, on whichever screen the page is showing, when `view=<id>` no longer opens (#373). */
export function SavedViewGoneNotice({ gone, onDismiss }: { gone: boolean; onDismiss: () => void }) {
  if (!gone) return null;
  return (
    <Callout tone="warn">
      <div className="flex items-center justify-between gap-3">
        <span>{SAVED_VIEW_GONE_COPY}</span>
        <Button variant="outline" size="xs" onClick={onDismiss}>Dismiss</Button>
      </div>
    </Callout>
  );
}
