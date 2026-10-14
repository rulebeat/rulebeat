'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, Loader2, Play, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardContent } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { PersonalRuleResults } from '@/components/rules/personal-rule-results';
import { ScopeTreePicker } from '@/components/rules/scope-tree-picker';
import type { CoveredScopeView } from '@/lib/run-scope';
import { reviewDiff } from '@/lib/library-request-diff';
import type { Category, LibraryRequestDetail, PersonalRuleResult, Severity } from '@/lib/types';

const SEVERITY_OPTIONS: readonly SelectOption[] = (['critical', 'high', 'medium', 'low', 'info'] as Severity[])
  .map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));

const BACKEND_LABEL: Record<string, string> = {
  'resource-graph': 'Resource Graph',
  'microsoft-graph': 'Microsoft Graph',
};

const CLOSED_TEXT: Record<'approved' | 'rejected' | 'withdrawn', string> = {
  approved: 'This request was approved and its rule is in the library.',
  rejected: 'This request was rejected.',
  withdrawn: 'The author withdrew this request.',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface Preview {
  status: 'success' | 'failed' | 'capped' | 'invalid';
  results: PersonalRuleResult[];
  covered: CoveredScopeView;
  ranAt: string;
}

interface Props {
  request: LibraryRequestDetail;
  /** The reason a reviewer gave, shown on a request that was rejected. */
  rejectionReason?: string;
  categories: Category[];
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="label-grid">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * A reviewer reads one request here: the rule as the author sent it, the query it runs, and what it
 * finds when previewed at the reviewer's own access. They can change the name, category, severity, scope
 * and starting state before approving, or reject with a reason the author will read.
 */
export function LibraryRequestReviewClient({ request, rejectionReason, categories }: Props) {
  const router = useRouter();
  const open = request.status === 'open';
  const { definition } = request;
  const isUpdate = request.isUpdate === true;
  const target = request.target ?? null;
  const targetGone = isUpdate && target === null;
  const targetEnabled = request.targetEnabled ?? false;

  const [name, setName] = useState(definition.name);
  const [category, setCategory] = useState(definition.category);
  const [severity, setSeverity] = useState<Severity>(definition.severity);
  const [subscriptions, setSubscriptions] = useState(definition.scope?.subscriptions ?? []);
  const [managementGroups, setManagementGroups] = useState(definition.scope?.managementGroups ?? []);
  // A new rule starts disabled. An update starts as the target is now, and only a change is sent.
  const [enabled, setEnabled] = useState(isUpdate ? targetEnabled : false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'preview' | 'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const categoryOptions: SelectOption[] = categories.map(c => ({ value: c.id, label: c.label }));
  const categoryMissing = !categories.some(c => c.id === category);
  if (categoryMissing) categoryOptions.push({ value: category, label: `${category} (no longer exists)` });

  const scope = { level: definition.scope?.level ?? 'subscription', subscriptions, managementGroups };
  // Redrawn as the reviewer edits, so the lines are what an approval would write. Falls back to the server's.
  const diff = reviewDiff(request, { name, category, severity, scope }) ?? request.diff;
  const base = `/api/library-requests/${encodeURIComponent(request.id)}`;

  async function send(kind: 'preview' | 'approve' | 'reject', path: string, body: unknown): Promise<unknown | null> {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`${base}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) {
        setError(json?.error ?? 'That did not go through.');
        return null;
      }
      return json;
    } catch {
      setError('That did not go through. Check your connection and try again.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runPreview() {
    const result = await send('preview', 'preview', { scope }) as Preview | null;
    if (result) setPreview(result);
  }

  async function approve() {
    const edits = { name, category, severity, scope, ...(!isUpdate || enabled !== targetEnabled ? { enabled } : {}) };
    const result = await send('approve', 'approve', edits) as { rule?: { id: string } } | null;
    if (result?.rule) router.push(`/rules/${encodeURIComponent(result.rule.id)}`);
  }

  async function reject() {
    const result = await send('reject', 'reject', { reason });
    if (result) router.push('/library?section=requests');
  }

  return (
    <main className="flex-1 p-4 space-y-4">
      <div className="max-w-[1600px] mx-auto space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/library?section=requests" className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
            <ArrowLeft className="size-3.5" />
            Requests
          </Link>
          <span className="bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">
            {`Sent by ${request.author.label} on ${formatDate(request.createdAt)}`}
          </span>
          {request.isResubmission && (
            <span className="bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">Sent again after a rejection</span>
          )}
          {isUpdate && (
            <span className="bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">
              {target ? <>Update to <Link href={`/rules/${encodeURIComponent(target.id)}`} className="text-ink underline underline-offset-2">{target.name}</Link></> : 'Update to a library rule that is gone'}
            </span>
          )}
        </div>

        {request.status !== 'open' && (
          <Callout tone="info">
            <span className="flex flex-col gap-1">
              <span>{request.status === 'approved' && isUpdate ? 'This request was approved and its library rule was updated.' : CLOSED_TEXT[request.status]}</span>
              {request.status === 'rejected' && rejectionReason && <span>{`Reason: ${rejectionReason}`}</span>}
            </span>
          </Callout>
        )}
        {open && targetGone && (
          <Callout tone="warn">The library rule this request updates no longer exists, so it cannot be approved. Reject it and the author can send the rule as a new one.</Callout>
        )}
        {open && request.targetChanged && target && (
          <Callout tone="warn">{`"${target.name}" changed after this request was sent. The lines below compare it as it is now with what was sent, and approving replaces its definition with what was sent.`}</Callout>
        )}
        {error && <Callout tone="error">{error}</Callout>}

        <Card>
          <div className="px-6 py-3"><h2 className="title-grid">What was sent</h2></div>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Backend">{BACKEND_LABEL[definition.queryBackend ?? 'resource-graph'] ?? definition.queryBackend}</Fact>
              <Fact label="Kind">{definition.kind === 'advisory' ? 'Advisory' : 'Problem'}</Fact>
              <Fact label="Category">{categories.find(c => c.id === definition.category)?.label ?? definition.category}</Fact>
              <Fact label="Severity">{definition.severity}</Fact>
              <Fact label="Tags">{definition.tags?.length ? definition.tags.join(', ') : 'None'}</Fact>
              <Fact label="Resource types">{definition.resourceTypes.length ? definition.resourceTypes.join(', ') : 'Any'}</Fact>
              <Fact label="Subscriptions">{definition.scope?.subscriptions?.length ? definition.scope.subscriptions.join(', ') : 'All the author held'}</Fact>
              <Fact label="Management groups">{definition.scope?.managementGroups?.length ? definition.scope.managementGroups.join(', ') : 'None named'}</Fact>
            </dl>
            {definition.description && <p className="mt-4 whitespace-pre-wrap text-sm text-ink-2">{definition.description}</p>}
          </CardContent>
        </Card>

        <div className="space-y-2">
          <h2 className="title-grid">Query</h2>
          {request.kql !== null ? (
            <CodeBlock code={request.kql} title="Resource Graph KQL" />
          ) : (
            <CodeBlock code={JSON.stringify(definition.graphQuery ?? {}, null, 2)} title="Microsoft Graph query" />
          )}
        </div>

        {open && isUpdate && target && diff && (
          <div className="space-y-2">
            <h2 className="title-grid">Changes to the library rule</h2>
            <p className="text-xs text-ink-2">- Removed from the library rule as it is now. + Added by this request.</p>
            <pre aria-label="Definition line diff" className="bg-surface-sunken p-3 whitespace-pre-wrap break-all text-xs">
              {diff.map((line, index) => (
                <span key={index} className={`block ${line.kind === 'removed' ? 'text-muted-foreground line-through' : line.kind === 'added' ? 'text-ink font-medium' : 'text-ink-2'}`}>
                  {line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '}{line.text || '\u00a0'}
                </span>
              ))}
            </pre>
          </div>
        )}

        <Card>
          <div className="px-6 py-3"><h2 className="title-grid">Decide</h2></div>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="md:col-span-3">
                <Label className="mb-1">Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} disabled={!open} aria-label="Name" />
              </div>
              <div>
                <Label className="mb-1">Category</Label>
                <Select value={category} onValueChange={setCategory} disabled={!open} options={categoryOptions} aria-label="Category" />
                {categoryMissing && <p className="mt-1 text-xs text-ink-2">The author&apos;s category was deleted. Pick another one before approving.</p>}
              </div>
              <div>
                <Label className="mb-1">Severity</Label>
                <Select value={severity} onValueChange={v => setSeverity(v as Severity)} disabled={!open} options={SEVERITY_OPTIONS} aria-label="Severity" />
              </div>
              <div>
                <Label className="mb-1">{isUpdate ? 'Enabled state' : 'Starting state'}</Label>
                <div className="flex h-9 items-center gap-3">
                  <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!open} />
                  <span className="text-sm text-ink">{enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
                <p className="mt-1 text-xs text-ink-2">
                  {isUpdate
                    ? 'The library rule keeps the state it has now unless you change this, so a scheduled rule keeps running.'
                    : 'An enabled rule runs in the next scheduled scan. A disabled one waits in the library.'}
                </p>
              </div>
              {definition.queryBackend !== 'microsoft-graph' && (
                <div className="md:col-span-3">
                  <Label className="mb-1">Scope</Label>
                  <div className={open ? undefined : 'pointer-events-none opacity-60'}>
                    <ScopeTreePicker
                      subscriptions={subscriptions}
                      managementGroups={managementGroups}
                      onChange={value => { setSubscriptions(value.subscriptions); setManagementGroups(value.managementGroups); }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-ink-2">
                    The author could only reach what they held. The library rule covers this scope for everyone; leave it empty to cover every subscription.
                  </p>
                </div>
              )}
            </div>

            {open && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={busy !== null} onClick={() => { void runPreview(); }}>
                  {busy === 'preview' ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  Preview
                </Button>
                <Button size="sm" className="h-8 gap-1.5" disabled={busy !== null || name.trim() === '' || categoryMissing || targetGone} onClick={() => { void approve(); }}>
                  {busy === 'approve' ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  Approve
                </Button>
                <span className="text-xs text-ink-2">Preview runs the query once at your own access and stores nothing.</span>
              </div>
            )}

            {open && (
              <div className="space-y-2 border-t border-border pt-4">
                <Label className="mb-1">Reason for rejecting</Label>
                <Textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  placeholder="What the author needs to change. They read this on their personal rule."
                  aria-label="Reason for rejecting"
                />
                <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={busy !== null || reason.trim() === ''} onClick={() => { void reject(); }}>
                  {busy === 'reject' ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                  Reject
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {preview && (
          <PersonalRuleResults
            results={preview.results}
            lastRunAt={preview.ranAt}
            lastRunStatus={preview.status}
            covered={preview.covered}
            runBlockedReason={null}
          />
        )}
      </div>
    </main>
  );
}
