'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { csvRow } from '@/lib/csv';
import { findingRows } from '@/lib/finding-rows';
import type { Finding } from '@/lib/types';
import { Download, ChevronDown } from 'lucide-react';

// Findings-explorer rows (ExplorerFinding) carry lifecycle fields Finding doesn't — exported as
// extra CSV columns when present, without forcing every ExportButton caller to have them.
interface LifecycleFields {
  status?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  timesSeen?: number;
}

interface ExportButtonProps {
  findings: (Finding & LifecycleFields)[];
}

/**
 * The findings CSV text, header and data rows alike. Extracted so it is testable without a DOM:
 * evidence keys come from rule queries and Azure resource data, so a column name needs the same
 * csvRow guard a data cell gets. A finding holds every row its rule returned for it, and each row
 * is its own line with the finding's fields repeated, so the export matches the explorer's detail.
 */
export function buildFindingsCsv(findings: (Finding & LifecycleFields)[]): string {
  const rowsOf = (f: Finding): Record<string, unknown>[] => {
    const rows = findingRows(f);
    return rows.length > 0 ? rows : [{}];
  };

  // Collect all evidence data keys across every row of all findings (skip internal _rule metadata)
  const evidenceKeys = [
    ...new Set(
      findings.flatMap(f =>
        rowsOf(f).flatMap(row => Object.keys(row).filter(k => k !== '_rule')),
      ),
    ),
  ].sort();

  const hasLifecycle = findings.some(f => f.status !== undefined);

  const fixedHeaders = [
    'Severity', 'Title', 'Resource', 'ResourceGroup', 'Location',
    'Subscription', 'ResourceType', 'RuleId', 'Violation', 'DetectedAt', 'PortalLink',
    ...(hasLifecycle ? ['Status', 'FirstSeen', 'LastSeen', 'TimesSeen'] : []),
  ];
  const headers = [...fixedHeaders, ...evidenceKeys];

  const lines = findings.flatMap(f => rowsOf(f).map(ev => {
    // Format violated rule as readable string
    const rule = (ev['_rule'] as Record<string, unknown> | undefined) ?? ev;
    const violation = [
      rule['field'],
      rule['operator'],
      rule['value'] != null ? `'${rule['value']}'` : null,
      Array.isArray(rule['values']) ? `[${(rule['values'] as string[]).join(', ')}]` : null,
    ].filter(Boolean).join(' ');

    const fixed = [
      f.severity,
      f.title,
      f.resourceName,
      f.resourceGroup ?? '',
      f.location ?? '',
      f.subscriptionId,
      f.resourceType,
      f.ruleId,
      violation,
      typeof f.detectedAt === 'string' ? f.detectedAt : new Date(f.detectedAt as string).toISOString(),
      f.azurePortalLink ?? '',
      ...(hasLifecycle ? [f.status ?? '', f.firstSeenAt ?? '', f.lastSeenAt ?? '', f.timesSeen ?? ''] : []),
    ];

    const evCols = evidenceKeys.map(k => ev[k]);
    return csvRow([...fixed, ...evCols]);
  }));

  return [csvRow(headers), ...lines].join('\n');
}

export function ExportButton({ findings }: ExportButtonProps) {
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
    triggerDownload('findings.csv', 'text/csv', buildFindingsCsv(findings));
  }

  function exportJson() {
    // Flatten _rule into top-level for cleaner JSON output
    const cleaned = findings.map(f => {
      const ev = f.evidence as Record<string, unknown>;
      const { _rule, ...data } = ev as { _rule?: unknown } & Record<string, unknown>;
      const rows = findingRows(f).map(row => {
        const { _rule: _ignored, ...rowData } = row as { _rule?: unknown } & Record<string, unknown>;
        return rowData;
      });
      return { ...f, evidence: data, rows, violatedRule: _rule };
    });
    triggerDownload('findings.json', 'application/json', JSON.stringify(cleaned, null, 2));
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
        <DropdownMenuItem onClick={exportCsv}>Export CSV</DropdownMenuItem>
        <DropdownMenuItem onClick={exportJson}>Export JSON</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
