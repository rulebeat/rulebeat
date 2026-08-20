import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/* Covers both explicit notFound() calls in a route segment and genuinely unmatched routes — Next
 * routes both cases to the root app/not-found.tsx (see the not-found.js docs' "Good to know"). */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
      <div className="w-full max-w-sm px-6 text-center">
        <img src="/brand/mark.png" alt="RuleBeat" className="mx-auto mb-5 size-12 shrink-0 dark:hidden" />
        <img src="/brand/mark-dark.png" alt="RuleBeat" className="mx-auto mb-5 hidden size-12 shrink-0 dark:block" />
        <h1 className="font-heading text-2xl font-bold tracking-tight text-ink">Page not found</h1>
        <p className="mt-1.5 text-sm text-ink-2">
          The page you&apos;re looking for doesn&apos;t exist, or it may have been removed.
        </p>
        <Link href="/dashboard" className={cn(buttonVariants({ size: 'lg' }), 'mt-6 w-full')}>
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
