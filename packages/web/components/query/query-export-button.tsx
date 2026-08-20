'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Download, ChevronDown } from 'lucide-react';

interface QueryExportButtonProps {
  rows: Record<string, unknown>[];
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

  function csvCell(val: unknown): string {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
    const s = String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }

  function exportCsv() {
    const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
    const body = rows.map(row => columns.map(c => csvCell(row[c])).join(','));
    triggerDownload('query-results.csv', 'text/csv', [columns.join(','), ...body].join('\n'));
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
