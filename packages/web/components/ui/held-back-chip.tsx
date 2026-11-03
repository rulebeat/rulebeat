import { Badge } from '@/components/ui/badge';
import { heldBackNote } from '@/lib/held-back';
import { cn } from '@/lib/utils';

/* What stands where stored filter values the viewer's Access does not reach would be. It is a soft fill
 * with no outline and no remove control: the values are not the viewer's to read or to drop (ADR 0012 leaves
 * dropping them to a later, explicit action). It reads "N outside your access" beside visible values, and
 * only "Outside your access" when every value is held back.
 *
 * Plain `text-xs` (12px), never `label-grid`: this is a sentence, not metadata. */
export function HeldBackChip({ count, visible, className }: { count: number; visible: number; className?: string }) {
  return (
    <Badge variant="secondary" className={cn('text-ink-2', className)} data-held-back="">
      {heldBackNote(count, visible)}
    </Badge>
  );
}
