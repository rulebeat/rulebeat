import { Lock } from 'lucide-react';

/** What the Query page shows a person whose access is only resource groups, in place of the editor.
 *  Resource Graph cannot limit a request to a resource group, so no query they write can be run. */
export function QueryUnavailableState() {
  return (
    <div role="status" className="flex flex-col items-center justify-center bg-surface py-16 text-center">
      <Lock className="mb-4 size-7 text-ink-2" />
      <h3 className="mb-1 font-heading text-base font-semibold text-ink">Queries need a subscription</h3>
      <p className="max-w-md text-sm text-ink-2">
        Your access covers resource groups only. Resource Graph cannot limit a query to a resource group, so a
        query you write could read beyond what was shared with you. You can still see your findings. Ask an
        Admin to give you a subscription to write queries.
      </p>
    </div>
  );
}
