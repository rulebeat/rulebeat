'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { csvRow } from '@/lib/csv';
import type { Fetched } from '@/lib/explorer-session';
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

type ExportedFindings = (Finding & LifecycleFields)[];

/** The findings to export, either held already or read when the viewer asks, for a list that does not
 *  hold them all (the explorer). A read that fails says why and writes no file. */
type ExportButtonProps =
  | { findings: ExportedFindings; read?: undefined }
  | { read: () => Promise<Fetched<ExportedFindings>>; findings?: undefined };

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

export function ExportButton({ findings: held, read }: ExportButtonProps) {
  const [reading, setReading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /** The findings to write, or null when reading them failed (the failure is on screen). */
  async function findingsToExport(): Promise<ExportedFindings | null> {
    if (!read) return held ?? [];
    setReading(true);
    setFailure(null);
    const result = await read();
    setReading(false);
    if (!result.ok) {
      setFailure(result.message);
      return null;
    }
    return result.data;
  }

  function triggerDownload(filename: string, mimeType: string, content: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportCsv() {
    const findings = await findingsToExport();
    if (findings) triggerDownload('findings.csv', 'text/csv', buildFindingsCsv(findings));
  }

  async function exportJson() {
    const findings = await findingsToExport();
    if (!findings) return;
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
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="xs" className="gap-1" disabled={reading}>
              <Download className="size-3" />
              {reading ? 'Preparing export' : 'Export'}
              <ChevronDown className="size-3" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onClick={exportCsv}>Export CSV</DropdownMenuItem>
          <DropdownMenuItem onClick={exportJson}>Export JSON</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {failure && <span role="alert" className="text-xs text-ink">{failure}</span>}
    </>
  );
}
