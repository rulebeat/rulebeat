'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { buildFindingsCsv, buildFindingsJson, type ExportFormat, type HeldFinding } from '@/lib/findings-export';
import { Download, ChevronDown } from 'lucide-react';

/** Where the findings come from. A list that holds them all writes the file here, in the browser. A
 *  list that does not (the explorer) names the server's export route for a format, and the browser
 *  streams that response to disk without reading it. */
type ExportButtonProps =
  | { findings: HeldFinding[]; exportUrl?: undefined }
  | { exportUrl: (format: ExportFormat) => string; findings?: undefined };

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
}

function downloadHeld(filename: string, mimeType: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

export function ExportButton({ findings, exportUrl }: ExportButtonProps) {
  function exportAs(format: ExportFormat) {
    if (exportUrl) {
      triggerDownload(exportUrl(format), `findings.${format}`);
    } else if (format === 'csv') {
      downloadHeld('findings.csv', 'text/csv', buildFindingsCsv(findings ?? []));
    } else {
      downloadHeld('findings.json', 'application/json', buildFindingsJson(findings ?? []));
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="xs" className="gap-1">
            <Download className="size-3" />
            Export
            <ChevronDown className="size-3" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={() => exportAs('csv')}>Export CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportAs('json')}>Export JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
