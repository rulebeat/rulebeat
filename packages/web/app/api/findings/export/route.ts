import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { openExport } from '@/lib/db/finding-views';
import { streamExport } from '@/lib/export-stream';
import { parseExportFormat, parseViewRequest } from '@/lib/view-request';

const CONTENT_TYPES = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8' } as const;

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const params = new URL(req.url).searchParams;
  const request = parseViewRequest(params);
  if (!request.ok) return Response.json({ error: request.error }, { status: 400 });
  const format = parseExportFormat(params.get('format'));
  if (!format.ok) return Response.json({ error: format.error }, { status: 400 });

  try {
    const { view, tab, showSuppressed } = request.value;
    const body = await streamExport(openExport(view, { tab, showSuppressed }), format.value);
    return new Response(body, {
      headers: {
        'Content-Type': CONTENT_TYPES[format.value],
        'Content-Disposition': `attachment; filename="findings.${format.value}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return serverError('Could not export the findings', err);
  }
}
