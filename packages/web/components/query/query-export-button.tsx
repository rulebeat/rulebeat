'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { csvRow } from '@/lib/csv';
import { Download, ChevronDown } from 'lucide-react';

interface QueryExportButtonProps {
  rows: Record<string, unknown>[];
}

/**
 * The query-results CSV text, header and data rows alike. Extracted so it is testable without a
 * DOM: a query result's column names come from the user's KQL, so a header cell needs the same
 * csvRow guard a data cell gets.
 */
export function buildQueryCsv(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
  const body = rows.map(row => csvRow(columns.map(c => row[c])));
  return [csvRow(columns), ...body].join('\n');
}

export function QueryExportButton({ rows }: QueryExportButtonProps) {
  function triggerDownload(filename: string, mimeType: string, content: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    triggerDownload('query-results.csv', 'text/csv', buildQueryCsv(rows));
  }

  function exportJson() {
    triggerDownload('query-results.json', 'application/json', JSON.stringify(rows, null, 2));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="xs" className="gap-1" disabled={rows.length === 0}>
            <Download className="size-3" />
            Export
            <ChevronDown className="size-3" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={exportCsv}>Export CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={exportJson}>Export JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
