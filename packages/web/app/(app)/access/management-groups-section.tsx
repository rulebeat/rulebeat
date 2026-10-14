'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { filterTree } from '@/lib/access-picker';
import { describeHierarchyStatus, orderedTree, type HierarchyView } from '@/lib/management-group-tree';

const formatTime = (iso: string): string => new Date(iso).toLocaleString();

/**
 * RuleBeat's copy of the management group tree, for an Admin: when it was last read and a Refresh that reads it
 * again, with the tree itself behind "Show tree". Open, it lists every group with the subscriptions under it, and
 * a filter by name or id keeps each match under its parents. A person holding a management group sees what is
 * under it as of this copy, so a subscription moved in Azure is covered after the next refresh. A failed refresh
 * always shows its error, and the tree it kept shows when the tree is open.
 */
export function ManagementGroupsSection({ initial, initiallyOpen = false }: { initial: HierarchyView; initiallyOpen?: boolean }) {
  const [view, setView] = useState<HierarchyView>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(initiallyOpen);
  const [filter, setFilter] = useState('');

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch('/api/access/management-groups/refresh', { method: 'POST' });
      const body = await res.json() as Partial<HierarchyView> & { error?: string };
      // A failed refresh still answers with the tree it kept and the status it recorded, so the page shows both.
      if (body.nodes && body.status) setView({ nodes: body.nodes, status: body.status });
      if (!res.ok && !body.status) setError(body.error ?? 'Could not refresh the management group tree.');
    } catch {
      setError('Could not reach the RuleBeat server.');
    } finally {
      setRefreshing(false);
    }
  }

  const ordered = orderedTree(filterTree(view.nodes, filter));
  const failed = view.status.error !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Management groups</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </Button>
          <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {open ? 'Hide tree' : 'Show tree'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {error && <Callout tone="error" className="border-x-0 border-t-0">{error}</Callout>}
        {failed && (
          <Callout tone="error" className="border-x-0 border-t-0">
            {view.status.error!.message}
          </Callout>
        )}
        <p className="px-6 py-3 text-sm text-ink-2">
          {describeHierarchyStatus(view.status, formatTime)} RuleBeat keeps its own copy of the tree and reads it again
          every hour. Someone given a management group sees the findings in every subscription under it as of this copy,
          including subscriptions moved under it later.
        </p>
        {open && view.nodes.length > 0 && (
          <div className="px-6 pb-3">
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter by name or id"
              aria-label="Filter the management group tree"
              className="max-w-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        {view.nodes.length === 0 && (
          <p className="px-6 pb-4 text-sm text-ink-2">
            {failed
              ? 'No tree has loaded, so there are no management groups to show.'
              : view.status.lastAttemptAt
                ? 'Azure returned no management groups.'
                : 'Nothing has been read yet.'}
          </p>
        )}
        {open && view.nodes.length > 0 && ordered.length === 0 && (
          <p className="px-6 pb-4 text-sm text-ink-2">No management group or subscription matched “{filter.trim()}”.</p>
        )}
        {open && ordered.length > 0 && (
          <ul className="pb-3">
            {ordered.map(({ node, depth }) => (
              <li
                key={`${node.kind}:${node.id}`}
                className="flex items-baseline gap-3 py-1 pr-6"
                style={{ paddingLeft: `${24 + depth * 20}px` }}
              >
                <span className={node.kind === 'managementGroup' ? 'text-sm font-medium text-ink' : 'text-sm text-ink'}>
                  {node.name}
                </span>
                <span className="font-mono text-xs text-ink-2">{node.id}</span>
                <span className="label-grid ml-auto">{node.kind === 'managementGroup' ? 'Group' : 'Subscription'}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
