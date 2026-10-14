'use client';

import Link from 'next/link';
import { Lock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll } from '@/components/ui/table';
import { SeverityBadge } from '@/components/findings/severity-badge';
import type { Category, Rule } from '@/lib/types';

const BACKEND_LABEL: Record<string, string> = {
  'resource-graph': 'Resource Graph',
  'microsoft-graph': 'Microsoft Graph',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The Personal tab: the signed-in person's own rules and nothing else. The server page loads only
 *  those, so nothing here filters other people's rules out. */
export function PersonalRulesTab({
  rules, categories, writeBlockedReason,
}: {
  rules: Rule[];
  categories: Category[];
  /** Why this person cannot write a Personal rule now, or null when they can. */
  writeBlockedReason: string | null;
}) {
  const categoryLabel = new Map(categories.map(c => [c.id, c.label]));
  const canWrite = writeBlockedReason === null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Lock className="size-3.5 shrink-0" />
          Only you can see these rules and run them. Their results count nowhere else.
        </p>
        {canWrite && (
          <Link href="/library/personal/new">
            <Button variant="outline" size="sm"><Plus className="size-4" />New personal rule</Button>
          </Link>
        )}
      </div>

      {!canWrite && <Callout tone="info">{writeBlockedReason}</Callout>}

      {rules.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-20 text-center">
            <h3 className="title-grid">No personal rules</h3>
            <p className="max-w-sm text-sm text-ink-2">
              {canWrite
                ? 'A personal rule is a check only you can see and run, over the subscriptions and management groups you hold. Create one to try a query before it goes anywhere shared.'
                : 'You have not written any personal rules.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>Backend</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Last run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map(rule => (
                  <TableRow key={rule.id}>
                    <TableCell className="max-w-96">
                      <Link
                        href={`/library/personal/${encodeURIComponent(rule.id)}`}
                        className="block truncate text-sm font-medium text-ink underline-offset-4 hover:underline"
                        title={rule.name}
                      >
                        {rule.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">{BACKEND_LABEL[rule.queryBackend ?? 'resource-graph'] ?? rule.queryBackend}</TableCell>
                    <TableCell className="text-xs">{categoryLabel.get(rule.category) ?? rule.category}</TableCell>
                    <TableCell shrink><SeverityBadge severity={rule.severity} /></TableCell>
                    <TableCell className="text-xs">{rule.lastRunAt ? formatDate(rule.lastRunAt) : 'Never run'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </Card>
      )}
    </div>
  );
}
