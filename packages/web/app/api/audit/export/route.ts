import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { csvRow } from '@/lib/csv';
import { listAllAuditEntries, type AuditEntry } from '@/lib/db/audit';

const HEADERS = ['id', 'occurredAt', 'actorEmail', 'action', 'entityType', 'entityId', 'summary', 'details'];

function entryToRow(entry: AuditEntry): string {
  return csvRow([
    entry.id,
    entry.occurredAt,
    entry.actorEmail,
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.summary,
    entry.details,
  ]);
}

export async function GET() {
  const actor = await requireRole('audit:read');
  if (actor instanceof NextResponse) return actor;

  const entries = await listAllAuditEntries();
  const csv = [csvRow(HEADERS), ...entries.map(entryToRow)].join('\n');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="audit-log.csv"',
    },
  });
}
