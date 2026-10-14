import { Badge } from '@/components/ui/badge';
import type { CoveredScopeView } from '@/lib/run-scope';

/** What a run covered: Everything, or each Scope it covered. One outside the reader's own access already
 *  reads "Outside your access" from the server, so no name or id ever reaches this component. */
export function CoveredScopeLabel({ scope }: { scope: CoveredScopeView }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Scope covered by this run">
      {scope.entries.map((entry, i) => (
        <Badge key={`${entry.label}-${i}`} variant="secondary" className="max-w-56 truncate" title={entry.outside ? undefined : entry.label}>
          {entry.label}
        </Badge>
      ))}
    </span>
  );
}

/** Why a count is not a number, for a reader below Everything whose run has no stored findings to recount from. */
export const COUNTS_UNAVAILABLE_MESSAGE =
  'Counts for your access are unavailable: this run has no stored findings to count them from.';
