import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { listAllAuditEntries, type AuditEntry } from '@/lib/db/audit';

const HEADERS = ['id', 'occurredAt', 'actorEmail', 'action', 'entityType', 'entityId', 'summary', 'details'];

/**
 * Same quoting convention as components/findings/export-button.tsx's csvCell() (wrap in quotes,
 * double any embedded quote, only when the value contains a comma/quote/newline), plus a
 * formula-injection guard export-button.tsx doesn't need: summary/details are attacker-influenced
 * (e.g. a rule or resource name), so a value starting with =, +, -, or @ gets a leading apostrophe
 * before Excel/Sheets ever sees it.
 */
function csvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  let s = typeof val === 'object' ? JSON.stringify(val) : String(val);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function entryToRow(entry: AuditEntry): string {
  return [
    csvCell(entry.id),
    csvCell(entry.occurredAt),
    csvCell(entry.actorEmail),
    csvCell(entry.action),
    csvCell(entry.entityType),
    csvCell(entry.entityId),
    csvCell(entry.summary),
    csvCell(entry.details),
  ].join(',');
}

export async function GET() {
  const actor = await requireRole('audit:read');
  if (actor instanceof NextResponse) return actor;

  const entries = await listAllAuditEntries();
  const csv = [HEADERS.join(','), ...entries.map(entryToRow)].join('\n');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="audit-log.csv"',
    },
  });
}
