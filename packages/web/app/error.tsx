'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/* Catches an uncaught render error within a route segment. `error.message` is already a generic,
 * identifier-only string when the throw came from a Server Component (Next strips the real detail
 * before it reaches the client) — matching the client-safe-message discipline lib/api-error.ts
 * applies to API routes, so no extra scrubbing is needed here. `unstable_retry` (not the older
 * `reset()`) re-fetches and re-renders the segment. */
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
      <div className="w-full max-w-sm px-6 text-center">
        <img src="/brand/mark.png" alt="RuleBeat" className="mx-auto mb-5 size-12 shrink-0 dark:hidden" />
        <img src="/brand/mark-dark.png" alt="RuleBeat" className="mx-auto mb-5 hidden size-12 shrink-0 dark:block" />
        <h1 className="font-heading text-2xl font-bold tracking-tight text-ink">Something went wrong</h1>
        <p className="mt-1.5 text-sm text-ink-2">
          An unexpected error occurred. Try again, or head back to your dashboard.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button size="lg" className="w-full" onClick={() => unstable_retry()}>
            Try again
          </Button>
          <Link href="/dashboard" className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}>
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
