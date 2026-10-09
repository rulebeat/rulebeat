/**
 * What an export file holds, in one place for both ways a file gets written: the server streams it
 * (app/api/findings/export, a piece of a finding at a time) and a list that holds its findings
 * already writes it in the browser (`buildFindingsCsv`, `buildFindingsJson`). No imports from the
 * server, so a client component can use it.
 *
 * A finding is written once per row it holds, with its own fields repeated, so the file matches the
 * explorer's detail. Evidence keys come from rule queries and Azure resource data, so a column name
 * gets the same csvRow guard a data cell gets.
 */
import { csvRow } from '@/lib/csv';
import { findingRows, type FindingRow } from '@/lib/finding-rows';
import type { Finding } from '@/lib/types';

// The explorer's findings carry lifecycle fields Finding doesn't, exported as extra CSV columns when
// present, without forcing every caller to have them.
interface LifecycleFields {
  status?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  timesSeen?: number;
}

export const EXPORT_FORMATS = ['csv', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** A finding as a file takes it: its own fields, with the rows given beside it. */
export type ExportFinding = Omit<Finding, 'evidence' | 'rows'> & LifecycleFields;
/** A finding that holds its own rows, as the lists that write a file in the browser have them. */
export type HeldFinding = ExportFinding & { evidence?: FindingRow; rows?: FindingRow[] };

/** A run of one finding's matched rows. A finding may arrive in several, in query order: `start` is
 *  the first of them and `end` the last, which is the same piece when one holds every row. */
export interface ExportPiece {
  finding: ExportFinding;
  rows: FindingRow[];
  start: boolean;
  end: boolean;
}

// ---- CSV ----

const FIXED_HEADERS = [
  'Severity', 'Title', 'Resource', 'ResourceGroup', 'Location',
  'Subscription', 'ResourceType', 'RuleId', 'Violation', 'DetectedAt', 'PortalLink',
];
const LIFECYCLE_HEADERS = ['Status', 'FirstSeen', 'LastSeen', 'TimesSeen'];

/** The evidence columns the rows carry, internal `_rule` metadata left out, sorted. */
export function evidenceKeysOf(rows: Iterable<FindingRow>): string[] {
  const keys = new Set<string>();
  for (const row of rows) addEvidenceKeys(keys, row);
  return sortedKeys(keys);
}
export function addEvidenceKeys(into: Set<string>, row: FindingRow): void {
  for (const key of Object.keys(row)) if (key !== '_rule') into.add(key);
}
export const sortedKeys = (keys: ReadonlySet<string>): string[] => [...keys].sort();

export function csvHeaderLine(evidenceKeys: readonly string[], lifecycle: boolean): string {
  return csvRow([...FIXED_HEADERS, ...(lifecycle ? LIFECYCLE_HEADERS : []), ...evidenceKeys]);
}

/** One CSV line for one row of a finding. */
function csvLine(f: ExportFinding, ev: FindingRow, evidenceKeys: readonly string[], lifecycle: boolean): string {
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
    ...(lifecycle ? [f.status ?? '', f.firstSeenAt ?? '', f.lastSeenAt ?? '', f.timesSeen ?? ''] : []),
  ];
  return csvRow([...fixed, ...evidenceKeys.map(k => ev[k])]);
}

/** The rows a finding is written as: its own, or one blank row when it holds none. */
const rowsToWrite = (rows: FindingRow[]): FindingRow[] => (rows.length > 0 ? rows : [{}]);

/**
 * The findings CSV text, header and data rows alike. Extracted so it is testable without a DOM.
 * The header names every evidence key any row of any finding carries, so it cannot be written until
 * every row has been seen; a stream reads the rows twice for that (`CsvWriter`).
 */
export function buildFindingsCsv(findings: HeldFinding[]): string {
  const rowsOf = (f: HeldFinding) => rowsToWrite(findingRows(f));
  const evidenceKeys = evidenceKeysOf(findings.flatMap(rowsOf));
  const lifecycle = findings.some(f => f.status !== undefined);
  const lines = findings.flatMap(f => rowsOf(f).map(ev => csvLine(f, ev, evidenceKeys, lifecycle)));
  return [csvHeaderLine(evidenceKeys, lifecycle), ...lines].join('\n');
}

/** Writes the CSV a piece at a time, the same text `buildFindingsCsv` gives for the same findings:
 *  no trailing newline, so every line after the header opens with one. */
export class CsvWriter {
  private rowsOfFinding = 0;

  constructor(private readonly evidenceKeys: readonly string[], private readonly lifecycle: boolean) {}

  header(): string {
    return csvHeaderLine(this.evidenceKeys, this.lifecycle);
  }

  piece({ finding, rows, start, end }: ExportPiece): string {
    if (start) this.rowsOfFinding = 0;
    this.rowsOfFinding += rows.length;
    // A finding with no rows is still one line.
    const written = end && this.rowsOfFinding === 0 ? [{}] : rows;
    return written.map(ev => `\n${csvLine(finding, ev, this.evidenceKeys, this.lifecycle)}`).join('');
  }
}

// ---- JSON ----

const indented = (text: string, spaces: number) => text.replace(/\n/g, `\n${' '.repeat(spaces)}`);
const prettyAt = (value: unknown, spaces: number) => indented(JSON.stringify(value, null, 2), spaces);

/** A row as the JSON export writes it, without the visual builder's own `_rule` metadata. */
function withoutRule(row: FindingRow): { rule: unknown; data: FindingRow } {
  const { _rule, ...data } = row as { _rule?: unknown } & FindingRow;
  return { rule: _rule, data };
}

/** The findings JSON text: an array of each finding with its `rows`, its first row as `evidence`
 *  and that row's builder metadata as `violatedRule`. */
export function buildFindingsJson(findings: HeldFinding[]): string {
  const cleaned = findings.map(f => {
    const { rule, data } = withoutRule(f.evidence ?? {});
    const rows = findingRows(f).map(row => withoutRule(row).data);
    return { ...f, evidence: data, rows, violatedRule: rule };
  });
  return JSON.stringify(cleaned, null, 2);
}

/** Writes the same JSON `buildFindingsJson` gives, one piece at a time: the array element by element,
 *  and each element's rows one at a time. Its keys come in that function's order: the finding's own,
 *  then `rows`, `evidence` and `violatedRule`, which wait for the finding's last piece. */
export class JsonWriter {
  private elements = 0;
  private rowsOfFinding = 0;
  private first: { rule: unknown; data: FindingRow } | null = null;

  piece({ finding, rows, start, end }: ExportPiece): string {
    let text = '';
    if (start) {
      const fields = Object.entries(finding).filter(([, value]) => value !== undefined)
        .map(([key, value]) => `    ${JSON.stringify(key)}: ${prettyAt(value, 4)}`);
      text += `${this.elements === 0 ? '[\n' : ',\n'}  {\n${fields.join(',\n')},\n    "rows": `;
      this.elements += 1;
      this.rowsOfFinding = 0;
      this.first = null;
    }
    for (const row of rows) {
      const { data } = withoutRule(row);
      this.first ??= withoutRule(row);
      text += `${this.rowsOfFinding === 0 ? '[\n' : ',\n'}      ${prettyAt(data, 6)}`;
      this.rowsOfFinding += 1;
    }
    if (end) {
      const first = this.first ?? { rule: undefined, data: {} };
      text += `${this.rowsOfFinding === 0 ? '[]' : '\n    ]'},\n    "evidence": ${prettyAt(first.data, 4)}`;
      if (first.rule !== undefined) text += `,\n    "violatedRule": ${prettyAt(first.rule, 4)}`;
      text += '\n  }';
    }
    return text;
  }

  /** What closes the array. */
  close(): string {
    return this.elements === 0 ? '[]' : '\n]';
  }
}
