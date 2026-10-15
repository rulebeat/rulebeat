'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ScopeTree } from '@/components/scope-tree';
import { describeHierarchyStatus, type HierarchyView } from '@/lib/management-group-tree';
import { hierarchyItems } from '@/lib/scope-tree';

const formatTime = (iso: string): string => new Date(iso).toLocaleString();

/**
 * RuleBeat's copy of the management group tree, for an Admin: when it was last read, a Refresh that reads it
 * again, and the tree itself, read-only and collapsed to its top level. Each group expands to the groups and
 * subscriptions under it, and the search opens the path to each match. A person holding a management group sees
 * what is under it as of this copy, so a subscription moved in Azure is covered after the next refresh. A failed
 * refresh always shows its error, above the tree it kept.
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
        {view.nodes.length === 0 ? (
          <p className="px-6 pb-4 text-sm text-ink-2">
            {failed
              ? 'No tree has loaded, so there are no management groups to show.'
              : view.status.lastAttemptAt
                ? 'Azure returned no management groups.'
                : 'Nothing has been read yet.'}
          </p>
        ) : (
          <div className="px-4 pb-4">
            <ScopeTree items={hierarchyItems(view.nodes)} searchLabel="Search the management group tree" searchPlaceholder="Search by name or id" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
