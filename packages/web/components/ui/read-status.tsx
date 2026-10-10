import { cn } from '@/lib/utils';

/** What a read shows until it has its answer: the reason it failed with a way to try again, or that
 *  it is loading. The one place a failed read is worded and drawn, so none reads as an empty list.
 *  `className` is the spacing and alignment of the place it sits in. */
export function ReadStatus({
  failure, retry, loading, className,
}: {
  /** The message of a failed read, or null while it has not failed. */
  failure: string | null;
  retry: () => void;
  /** What is loading, as the status line says it. */
  loading: string;
  className?: string;
}) {
  if (failure) {
    return (
      <div role="alert" className={cn('space-y-2', className)}>
        <p className="text-xs text-ink">{failure}</p>
        <button
          type="button"
          onClick={retry}
          className="text-xs font-medium text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
        >
          Try again
        </button>
      </div>
    );
  }
  return <p role="status" className={cn('text-xs text-ink-2', className)}>{loading}</p>;
}
