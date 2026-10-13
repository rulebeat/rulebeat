import { Lock } from 'lucide-react';

/** What the Results, Advisories and Activity tabs show a person who holds no Scope. It is not
 *  "No findings yet": nothing a scan finds would change it, and only an Admin can. */
export function NoAccessState() {
  return (
    <div role="status" className="flex flex-col items-center justify-center bg-surface py-16 text-center">
      <Lock className="mb-4 size-7 text-ink-2" />
      <h3 className="mb-1 font-heading text-base font-semibold text-ink">You have been given no access</h3>
      <p className="max-w-sm text-sm text-ink-2">
        You can sign in, but no subscription, resource group or the Directory has been shared with you, so there
        is nothing to list. Ask an Admin to give you access.
      </p>
    </div>
  );
}
