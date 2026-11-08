import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { holdBackSavedViews, viewCopyWidened } from '@/lib/db/held-back';
import { withoutPlaceholder } from '@/lib/held-back';
import { canOpenItem, openableItems } from '@/lib/item-access';
import { createSavedView, getSavedView, listSavedViews } from '@/lib/db/saved-views';
import { SAVED_VIEW_FIELDS, parseSavedViewFields, savedViewNameTakenMessage } from '@/lib/saved-views';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  try {
    return Response.json(await holdBackSavedViews(actor.access, openableItems(actor, await listSavedViews())));
  } catch (err) {
    return serverError('Could not load saved views', err);
  }
}

/** The saved view a new one is being saved from (`from` in the body), when it exists and the person may open it. */
async function openedSource(actor: { id: string }, body: unknown) {
  const from = (body as { from?: unknown } | null)?.from;
  if (typeof from !== 'string') return null;
  const source = await getSavedView(from);
  return source && canOpenItem(actor, source) ? source : null;
}

export async function POST(req: Request) {
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<unknown>(req);
  if (body instanceof NextResponse) return body;
  const fields = parseSavedViewFields(body, 'create');
  if (!fields.ok) return Response.json({ error: fields.error }, { status: 400 });

  try {
    const result = await createSavedView({ ...fields.value, query: withoutPlaceholder(fields.value.query) }, actor.id);
    if (!result.ok) return Response.json({ error: savedViewNameTakenMessage(fields.value.name) }, { status: 409 });

    await writeAudit({
      actor,
      action: 'view.create',
      entityType: 'saved_view',
      entityId: result.view.id,
      // A Personal item is logged by id and kind only: its name is its owner's alone.
      summary: 'Saved a Personal view',
      details: { fields: SAVED_VIEW_FIELDS },
    });
    const [view] = await holdBackSavedViews(actor.access, [result.view]);
    // A view saved from an open one is a Duplicate: it says how many filters now show more than the original did.
    const source = await openedSource(actor, body);
    const widened = source ? await viewCopyWidened(actor.access, source, fields.value.query) : 0;
    return Response.json({ ...view, widened }, { status: 201 });
  } catch (err) {
    return serverError('Could not save the view', err);
  }
}
