'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Inbox, Loader2, Send, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import type { AuthorLibraryRequest } from '@/lib/types';

interface Props {
  personalRuleId: string;
  /** This rule's requests, newest first. */
  requests: AuthorLibraryRequest[];
  /** The library rule this Personal rule was copied straight into, while it still exists. */
  copiedTo: { id: string; name: string } | null;
  /** Whether this person may still write Personal rules. A demoted author reads the status and changes nothing. */
  canWrite: boolean;
  /** Unsaved edits: the request sends the saved rule, so sending waits for a save. */
  dirty: boolean;
  /** Present for a reviewer only. `reason` is why the copy is off right now, worked out on the server; null when it is on. */
  copyToLibrary: { reason: string | null } | null;
  /** The custom library rules this rule can be sent to as an update. */
  updateTargets?: { id: string; name: string }[];
  /** Why this rule can only go as a new rule, or null. */
  newOnlyReason?: string | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const SEND_AFTER_SAVE = 'Save your changes first. A request sends the saved rule.';

function LibraryRuleLink({ rule }: { rule: { id: string; name: string } }) {
  return (
    <Link href={`/rules/${encodeURIComponent(rule.id)}`} className="font-medium text-ink underline underline-offset-2">
      {rule.name}
    </Link>
  );
}

/**
 * Where this Personal rule stands with the library: the latest Library request and what the author can
 * do with it, and, for a reviewer, a direct copy that needs no request. The status is the server's;
 * every control posts to a route and refreshes the page.
 */
export function LibraryRequestPanel({ personalRuleId, requests, copiedTo, canWrite, dirty, copyToLibrary, updateTargets = [], newOnlyReason = null }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<'send' | 'withdraw' | 'copy' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latest = requests[0];
  const approvedRule = latest?.status === 'approved' ? latest.libraryRule : undefined;
  // A new request is offered when there is none open, and the last one did not put the rule in the library.
  const canSend = canWrite && latest?.status !== 'open' && latest?.status !== 'rejected' && !approvedRule;
  const canResubmit = canWrite && latest?.status === 'rejected';
  // An update goes to a library rule that already exists, so it stays on offer after an approval.
  const canSendUpdate = canWrite && latest?.status !== 'open' && updateTargets.length > 0;

  async function post(kind: 'send' | 'withdraw' | 'copy', url: string, body?: unknown, after?: (json: { id?: string }) => void) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        const failure = await res.json().catch(() => null) as { error?: string } | null;
        setError(failure?.error ?? 'That did not go through.');
        return;
      }
      after?.(await res.json().catch(() => ({})) as { id?: string });
      router.refresh();
    } catch {
      setError('That did not go through. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  const sendUrl = `/api/personal-rules/${encodeURIComponent(personalRuleId)}/library-request`;
  const send = (resubmits?: string, updates?: string) =>
    post('send', sendUrl, resubmits || updates ? { ...(resubmits ? { resubmits } : {}), ...(updates ? { updates } : {}) } : undefined);
  const withdraw = (requestId: string) => post('withdraw', `/api/library-requests/${encodeURIComponent(requestId)}/withdraw`);
  const copy = () => {
    if (!confirm('Add this rule to the library now? It starts disabled, and everyone on the install will see it.')) return;
    void post('copy', `/api/personal-rules/${encodeURIComponent(personalRuleId)}/library-copy`, undefined,
      created => { if (created.id) router.push(`/rules/${encodeURIComponent(created.id)}`); });
  };

  const spinner = <Loader2 className="h-3 w-3 animate-spin" />;
  const sendBlocked = dirty ? SEND_AFTER_SAVE : undefined;

  return (
    <section aria-label="Library" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">
          <Inbox className="h-2.5 w-2.5 shrink-0" />
          Library
        </span>
        {canSend && (
          <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 gap-1.5" disabled={busy !== null || dirty} title={sendBlocked} onClick={() => { void send(); }}>
            {busy === 'send' ? spinner : <Send className="h-3 w-3" />}
            {updateTargets.length > 0 ? 'Send as new rule' : 'Send to library'}
          </Button>
        )}
        {canSendUpdate && updateTargets.map(target => (
          <Button key={target.id} size="sm" variant="outline" className="h-7 text-xs px-2.5 gap-1.5" disabled={busy !== null || dirty} title={sendBlocked} onClick={() => { void send(undefined, target.id); }}>
            {busy === 'send' ? spinner : <Send className="h-3 w-3" />}
            {`Send as update to ${target.name}`}
          </Button>
        ))}
        {canResubmit && latest && (
          <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 gap-1.5" disabled={busy !== null || dirty} title={sendBlocked} onClick={() => { void send(latest.id); }}>
            {busy === 'send' ? spinner : <Send className="h-3 w-3" />}
            Resubmit
          </Button>
        )}
        {canWrite && latest?.status === 'open' && (
          <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 gap-1.5" disabled={busy !== null} onClick={() => { void withdraw(latest.id); }}>
            {busy === 'withdraw' ? spinner : <Undo2 className="h-3 w-3" />}
            Withdraw
          </Button>
        )}
        {copyToLibrary && (
          <Button size="sm" variant="outline" className="h-7 text-xs px-2.5 gap-1.5" disabled={busy !== null || copyToLibrary.reason !== null} title={copyToLibrary.reason ?? undefined} onClick={copy}>
            {busy === 'copy' ? spinner : <Inbox className="h-3 w-3" />}
            Copy to library
          </Button>
        )}
      </div>

      {canWrite && newOnlyReason && latest?.status !== 'open' && <p className="text-xs text-ink-2">{newOnlyReason}</p>}
      {latest?.status === 'open' && (
        <Callout tone="info">{`Sent to the library${latest.isUpdate ? ` as an update to ${latest.target ? `"${latest.target.name}"` : 'a library rule that is gone'}` : ''} on ${formatDate(latest.createdAt)}. A reviewer has not decided yet. You can withdraw it until they do.`}</Callout>
      )}
      {latest?.status === 'rejected' && (
        <Callout tone="warn">
          <span className="flex flex-col gap-1">
            <span>{`Rejected on ${formatDate(latest.reviewedAt ?? latest.createdAt)}. Edit the rule and resubmit it, or leave it as a personal rule.`}</span>
            <span className="font-medium text-ink">{`Reason: ${latest.rejectionReason ?? 'No reason was recorded.'}`}</span>
          </span>
        </Callout>
      )}
      {latest?.status === 'approved' && (
        <Callout tone="success">
          {latest.isUpdate
            ? (approvedRule
              ? <>Sent as an update to <LibraryRuleLink rule={approvedRule} />, and approved. This personal rule stays as it was.</>
              : 'Approved as an update to a library rule that has since been deleted, so you can send this rule again.')
            : approvedRule
              ? <>Added to the library as <LibraryRuleLink rule={approvedRule} />. This personal rule stays as it was.</>
              : 'Approved and added to the library. That library rule has since been deleted, so you can send this rule again.'}
        </Callout>
      )}
      {!approvedRule && copiedTo && (
        <Callout tone="success">
          Copied to the library as <LibraryRuleLink rule={copiedTo} />. This personal rule stays as it was.
        </Callout>
      )}
      {error && <Callout tone="error">{error}</Callout>}
    </section>
  );
}
