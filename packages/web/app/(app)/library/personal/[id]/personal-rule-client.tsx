'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Lock, Pencil, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { PersonalRuleResults } from '@/components/rules/personal-rule-results';
import { RuleForm } from '@/components/rules/rule-form';
import type { CoveredScopeView } from '@/lib/run-scope';
import { LibraryRequestPanel } from './library-request-panel';
import type { AuthorLibraryRequest, Category, PersonalRuleResult, Rule } from '@/lib/types';

interface Props {
  rule: Rule;
  /** When the definition was last saved; a new value rebuilds the form from what the server now holds. */
  updatedAt: string;
  results: PersonalRuleResult[];
  lastRunCovered: CoveredScopeView | null;
  allTags: string[];
  categories: Category[];
  /** Whether this person may still write Personal rules. A demoted author may not, and sees the rule read-only. */
  canWrite: boolean;
  /** Why Run is unavailable right now, or null when it is available. */
  runBlockedReason: string | null;
  scopeLimit?: { subscriptions: string[]; managementGroups: string[] };
  /** The shared rule this was copied from, while it still exists; null otherwise. */
  source: { id: string; name: string } | null;
  /** This rule's Library requests, newest first. */
  requests: AuthorLibraryRequest[];
  /** The library rule a direct copy made, while it still exists. */
  copiedTo: { id: string; name: string } | null;
  /** Set for a reviewer only; `reason` is why Copy to library is off, or null. */
  copyToLibrary: { reason: string | null } | null;
  /** The custom library rules this one can be sent to as an update: its own library rule, and the rule it was copied from when that is custom. */
  updateTargets?: { id: string; name: string }[];
  /** Why this rule can only be sent as a new rule (its source is a built-in), or null. */
  newOnlyReason?: string | null;
}

export function PersonalRuleClient({ rule, source, requests, copiedTo, copyToLibrary, updateTargets, newOnlyReason, updatedAt, results, lastRunCovered, allTags, categories, canWrite, runBlockedReason, scopeLimit }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveHandleRef = useRef<(() => void) | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/personal-rules/${encodeURIComponent(rule.id)}/run`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? 'The run did not finish.');
        return;
      }
      router.refresh();
    } catch {
      setError('The run did not finish. Check your connection and try again.');
    } finally {
      setRunning(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete the personal rule "${rule.name}" and its results?`)) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/personal-rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? 'The rule was not deleted.');
        return;
      }
      router.push('/library?section=personal');
    } catch {
      setError('The rule was not deleted. Check your connection and try again.');
    } finally {
      setDeleting(false);
    }
  }

  const runDisabled = running || runBlockedReason !== null || dirty;

  return (
    <main className="flex-1 p-4 space-y-4">
      <div className="max-w-[1600px] mx-auto space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">
            <Lock className="h-2.5 w-2.5 shrink-0" />
            Personal · only you can see this rule
          </span>
          {!canWrite ? (
            <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">
              Read-only
            </span>
          ) : editing ? (
            <>
              <span className="inline-flex items-center gap-1.5 border border-status-warn/40 px-2 py-1 text-xs font-medium text-status-warn">Editing</span>
              <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => setEditing(false)}>Cancel edit</Button>
              <Button size="sm" className="h-6 text-xs px-2 gap-1" disabled={!dirty || saving} onClick={() => saveHandleRef.current?.()}>
                {saving && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 bg-surface-sunken px-2 py-1 text-xs font-medium text-ink-2">Viewing</span>
              <Button variant="outline" size="sm" className="h-6 text-xs px-2 gap-1" onClick={() => setEditing(true)}>
                <Pencil className="h-2.5 w-2.5" />
                Edit
              </Button>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {canWrite && (
              <Button variant="outline" size="sm" className="h-7 text-xs px-2.5 gap-1.5" disabled={deleting} onClick={remove}>
                <Trash2 className="h-3 w-3" />
                Delete
              </Button>
            )}
            <Button
              size="sm"
              className="h-7 text-xs px-2.5 gap-1.5"
              disabled={runDisabled}
              title={runBlockedReason ?? (dirty ? 'Save your changes before running' : undefined)}
              onClick={run}
            >
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {running ? 'Running…' : 'Run'}
            </Button>
          </div>
        </div>

        {source && (
          <p className="text-xs text-ink-2">
            Copied from{' '}
            <Link href={`/rules/${encodeURIComponent(source.id)}`} className="font-medium text-ink underline underline-offset-2">
              {source.name}
            </Link>
          </p>
        )}
        <LibraryRequestPanel
          personalRuleId={rule.id}
          requests={requests}
          copiedTo={copiedTo}
          canWrite={canWrite}
          dirty={dirty}
          copyToLibrary={copyToLibrary}
          updateTargets={updateTargets}
          newOnlyReason={newOnlyReason}
        />
        {runBlockedReason && <Callout tone="warn">{`Run is unavailable: ${runBlockedReason}`}</Callout>}
        {error && <Callout tone="error">{error}</Callout>}
      </div>

      <RuleForm
        key={updatedAt}
        initial={rule}
        readOnly={!canWrite || !editing}
        allTags={allTags}
        categories={categories}
        canAuthor={canWrite}
        personal
        scopeLimit={scopeLimit}
        onDirtyChange={setDirty}
        onSavingChange={setSaving}
        saveHandleRef={saveHandleRef}
      />

      <div className="max-w-[1600px] mx-auto">
        <PersonalRuleResults
          results={results}
          lastRunAt={rule.lastRunAt}
          lastRunStatus={rule.lastRunStatus}
          covered={lastRunCovered}
          runBlockedReason={runBlockedReason}
        />
      </div>
    </main>
  );
}
