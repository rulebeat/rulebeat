import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { createSavedView, listSavedViews } from '@/lib/db/saved-views';
import { SAVED_VIEW_FIELDS, parseSavedViewFields, savedViewNameTakenMessage } from '@/lib/saved-views';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  try {
    return Response.json(await listSavedViews());
  } catch (err) {
    return serverError('Could not load saved views', err);
  }
}

export async function POST(req: Request) {
  const actor = await requireRole('views:write');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<unknown>(req);
  if (body instanceof NextResponse) return body;
  const fields = parseSavedViewFields(body, 'create');
  if (!fields.ok) return Response.json({ error: fields.error }, { status: 400 });

  try {
    const result = await createSavedView(fields.value, actor.id);
    if (!result.ok) return Response.json({ error: savedViewNameTakenMessage(fields.value.name) }, { status: 409 });

    await writeAudit({
      actor,
      action: 'view.create',
      entityType: 'saved_view',
      entityId: result.view.id,
      summary: `Saved view "${result.view.name}"`,
      details: { fields: SAVED_VIEW_FIELDS },
    });
    return Response.json(result.view, { status: 201 });
  } catch (err) {
    return serverError('Could not save the view', err);
  }
}
