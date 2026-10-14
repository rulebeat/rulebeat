'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import type { AppUserWithAccess } from '@/lib/access';
import { describeMirrorStatus, describeOrigins, describeOwnMirrorStatus, type MirrorStatus } from '@/lib/access-mirror-model';
import { describeScopePath } from '@/lib/access-picker';
import { ROLE_LABELS } from '@/lib/rbac';

const formatTime = (iso: string): string => new Date(iso).toLocaleString();

/**
 * The last refresh of a Linked account, in the reader's own time: a failure as an error, anything else as a line.
 * `own` words it for the person themselves, who has no Refresh to press.
 */
export function MirrorStatusLine({ status, own = false }: { status: MirrorStatus; own?: boolean }) {
  const text = (own ? describeOwnMirrorStatus : describeMirrorStatus)(status, formatTime);
  return status.error ? <Callout tone="error">{text}</Callout> : <p className="text-sm text-ink-2">{text}</p>;
}

/**
 * What a mirrored person's access is made of, for an Admin: the Linked account, when it was last read, why the
 * last refresh failed if it did, and each Scope with the Azure role that gave it and "through a group" where
 * Azure said so. Refresh reads the account again now. A failed refresh answers with the person as stored, so the
 * Scopes shown are always the last ones that loaded.
 */
export function MirroredDetailRow({ user, disabled, onChanged }: {
  user: AppUserWithAccess;
  disabled?: boolean;
  onChanged: (user: AppUserWithAccess) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/mirror/refresh`, { method: 'POST' });
      const body = await res.json() as Partial<AppUserWithAccess> & { error?: string };
      // A failed refresh still answers with the person as stored, status included, so the page shows what was recorded.
      if (body.id) onChanged(body as AppUserWithAccess);
      else setError(body.error ?? 'Could not refresh this access.');
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally {
      setRefreshing(false);
    }
  }

  const status = user.mirror;
  return (
    <tr className="border-b border-border bg-surface-sunken last:border-0">
      <td colSpan={7} className="px-3 py-3">
        <div className="flex max-w-3xl flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="label-grid">Linked account</span>
            <span className="font-mono text-xs text-ink-2">{user.linkedAccount?.objectId}</span>
            <span className="text-xs text-ink-2">Role: {ROLE_LABELS[user.role]}</span>
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              disabled={disabled || refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw className="size-3" />
              {refreshing ? 'Refreshing' : 'Refresh'}
            </Button>
          </div>
          {error && <Callout tone="error">{error}</Callout>}
          {status && <MirrorStatusLine status={status} />}
          {user.mirroredScopes.length === 0 ? (
            <p className="text-sm text-ink-2">
              The Linked account holds no Azure role assignments RuleBeat can see, so this person sees no findings.
            </p>
          ) : (
            <ul className="divide-y divide-border bg-surface">
              {user.mirroredScopes.map(s => (
                <li key={s.scope} className="flex items-baseline gap-3 px-3 py-1.5">
                  <span className="text-sm text-ink">{describeScopePath(s.scope)}</span>
                  <span className="font-mono text-xs text-ink-2">{s.scope}</span>
                  <span className="ml-auto text-xs text-ink-2">
                    {s.origins.length > 0 ? describeOrigins(s.origins) : 'Azure role not recorded'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </td>
    </tr>
  );
}
