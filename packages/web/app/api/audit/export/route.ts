import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { csvCell } from '@/lib/csv';
import { listAllAuditEntries, type AuditEntry } from '@/lib/db/audit';

const HEADERS = ['id', 'occurredAt', 'actorEmail', 'action', 'entityType', 'entityId', 'summary', 'details'];

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
