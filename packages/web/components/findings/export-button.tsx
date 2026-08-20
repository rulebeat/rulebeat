'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

  function csvCell(val: unknown): string {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
    const s = String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }

  function exportCsv() {
    // Collect all evidence data keys across all findings (skip internal _rule metadata)
    const evidenceKeys = [
      ...new Set(
        findings.flatMap(f =>
          Object.keys(f.evidence as Record<string, unknown>).filter(k => k !== '_rule'),
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

    const rows = findings.map(f => {
      const ev = f.evidence as Record<string, unknown>;
      // Format violated rule as readable string
      const rule = (ev['_rule'] as Record<string, unknown> | undefined) ?? ev;
      const violation = [
        rule['field'],
        rule['operator'],
        rule['value'] != null ? `'${rule['value']}'` : null,
        Array.isArray(rule['values']) ? `[${(rule['values'] as string[]).join(', ')}]` : null,
      ].filter(Boolean).join(' ');

      const fixed = [
        csvCell(f.severity),
        csvCell(f.title),
        csvCell(f.resourceName),
        csvCell(f.resourceGroup ?? ''),
        csvCell(f.location ?? ''),
        csvCell(f.subscriptionId),
        csvCell(f.resourceType),
        csvCell(f.ruleId),
        csvCell(violation),
        csvCell(typeof f.detectedAt === 'string' ? f.detectedAt : new Date(f.detectedAt as string).toISOString()),
        csvCell(f.azurePortalLink ?? ''),
        ...(hasLifecycle ? [csvCell(f.status ?? ''), csvCell(f.firstSeenAt ?? ''), csvCell(f.lastSeenAt ?? ''), csvCell(f.timesSeen ?? '')] : []),
      ];

      const evCols = evidenceKeys.map(k => csvCell(ev[k]));
      return [...fixed, ...evCols].join(',');
    });

    triggerDownload(
      'findings.csv',
      'text/csv',
      [headers.join(','), ...rows].join('\n'),
    );
  }

  function exportJson() {
    // Flatten _rule into top-level for cleaner JSON output
    const cleaned = findings.map(f => {
      const ev = f.evidence as Record<string, unknown>;
      const { _rule, ...data } = ev as { _rule?: unknown } & Record<string, unknown>;
      return { ...f, evidence: data, violatedRule: _rule };
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
