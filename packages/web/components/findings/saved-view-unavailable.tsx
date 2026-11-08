import Link from 'next/link';
import { Bookmark } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SAVED_VIEW_UNAVAILABLE } from '@/lib/saved-view-query';

/** What a link to a saved view that is unknown, deleted or not the person's to open shows in place of
 *  the list: one notice, and the way to the same link without the view. The three cases read the same
 *  on purpose, so the page cannot be used to learn which views exist. */
export function SavedViewUnavailable({ keepHref }: { keepHref: string }) {
  return (
    <div role="status" className="flex flex-col items-center justify-center bg-surface py-16 text-center">
      <Bookmark className="mb-4 size-7 text-ink-2" />
      <h3 className="font-heading text-base font-semibold text-ink">{SAVED_VIEW_UNAVAILABLE}</h3>
      <Link href={keepHref} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4')}>
        Open Scans with only this link&apos;s filters
      </Link>
    </div>
  );
}
