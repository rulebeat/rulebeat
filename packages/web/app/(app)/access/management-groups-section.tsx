'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { describeHierarchyStatus, orderedTree, type HierarchyView } from '@/lib/management-group-tree';

const formatTime = (iso: string): string => new Date(iso).toLocaleString();

/**
 * RuleBeat's copy of the management group tree, for an Admin: every group with the subscriptions under
 * it, when it was last read, and a Refresh that reads it again. A person holding a management group sees
 * what is under it as of this copy, so a subscription moved in Azure is covered after the next refresh.
 */
export function ManagementGroupsSection({ initial }: { initial: HierarchyView }) {
  const [view, setView] = useState<HierarchyView>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const ordered = orderedTree(view.nodes);
  const failed = view.status.error !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Management groups</CardTitle>
        <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw className="size-3.5" />
          {refreshing ? 'Refreshing' : 'Refresh'}
        </Button>
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
        {ordered.length === 0 ? (
          <p className="px-6 pb-4 text-sm text-ink-2">
            {failed
              ? 'No tree has loaded, so there are no management groups to show.'
              : view.status.lastAttemptAt
                ? 'Azure returned no management groups.'
                : 'Nothing has been read yet.'}
          </p>
        ) : (
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
