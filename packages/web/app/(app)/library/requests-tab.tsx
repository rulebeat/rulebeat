'use client';

import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableScroll } from '@/components/ui/table';
import { SeverityBadge } from '@/components/findings/severity-badge';
import type { Category, LibraryRequestSummary } from '@/lib/types';

const BACKEND_LABEL: Record<string, string> = {
  'resource-graph': 'Resource Graph',
  'microsoft-graph': 'Microsoft Graph',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The open Library requests, oldest first. Reached only by a reviewer: the server page sends nothing to anyone else. */
export function RequestsTab({ requests, categories }: { requests: LibraryRequestSummary[]; categories: Category[] }) {
  const categoryLabel = new Map(categories.map(c => [c.id, c.label]));

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-ink-2">
        <Inbox className="size-3.5 shrink-0" />
        Personal rules that Editors have sent to the library. Open one to read it, preview it and decide.
      </p>

      {requests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-20 text-center">
            <h3 className="title-grid">No open requests</h3>
            <p className="max-w-sm text-sm text-ink-2">
              Nothing is waiting for a decision. A request appears here when an Editor sends a personal rule to the library, and leaves when it is approved, rejected or withdrawn.
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
                  <TableHead>Sent by</TableHead>
                  <TableHead>Backend</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map(request => (
                  <TableRow key={request.id}>
                    <TableCell className="max-w-96">
                      <Link
                        href={`/library/requests/${encodeURIComponent(request.id)}`}
                        className="block truncate text-sm font-medium text-ink underline-offset-4 hover:underline"
                        title={request.name}
                      >
                        {request.name}
                      </Link>
                      {request.isResubmission && <span className="text-xs text-ink-2">Sent again after a rejection</span>}
                    </TableCell>
                    <TableCell className="text-xs">{request.author.label}</TableCell>
                    <TableCell className="text-xs">{BACKEND_LABEL[request.queryBackend] ?? request.queryBackend}</TableCell>
                    <TableCell className="text-xs">{categoryLabel.get(request.category) ?? request.category}</TableCell>
                    <TableCell shrink><SeverityBadge severity={request.severity} /></TableCell>
                    <TableCell className="text-xs">{formatDate(request.createdAt)}</TableCell>
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
