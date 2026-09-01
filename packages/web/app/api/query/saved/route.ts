import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { writeAudit } from '@/lib/db/audit';
import { createSavedQuery, listSavedQueries, type CreateSavedQueryInput } from '@/lib/db/saved-queries';
import type { QueryBackend, QueryVisibility } from '@/lib/types';

const BACKENDS: QueryBackend[] = ['resource-graph', 'microsoft-graph', 'log-analytics'];
const VISIBILITIES: QueryVisibility[] = ['private', 'shared'];

export async function GET() {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  return NextResponse.json(await listSavedQueries(actor.id));
}

export async function POST(req: Request) {
  const actor = await requireRole('rules:validate');
  if (actor instanceof NextResponse) return actor;

  const parsed = await parseJsonBody<Partial<CreateSavedQueryInput>>(req);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  if (!body.queryBackend || !BACKENDS.includes(body.queryBackend)) {
    return NextResponse.json({ error: 'queryBackend must be one of resource-graph, microsoft-graph, log-analytics' }, { status: 400 });
  }
  if (!body.visibility || !VISIBILITIES.includes(body.visibility)) {
    return NextResponse.json({ error: 'visibility must be one of private, shared' }, { status: 400 });
  }
  if (body.queryBackend === 'resource-graph' && !body.visualQuery && !body.rawKql?.trim()) {
    return NextResponse.json({ error: 'A resource-graph query needs a visual query or raw KQL.' }, { status: 400 });
  }
  if (body.queryBackend === 'microsoft-graph' && !body.graphQuery) {
    return NextResponse.json({ error: 'A microsoft-graph query needs a graphQuery.' }, { status: 400 });
  }
  if (body.queryBackend === 'log-analytics' && !body.logsQuery?.kql?.trim()) {
    return NextResponse.json({ error: 'A log-analytics query needs a logsQuery.' }, { status: 400 });
  }

  const saved = await createSavedQuery({
    name: body.name.trim(),
    queryBackend: body.queryBackend,
    scope: body.scope,
    visualQuery: body.visualQuery,
    rawKql: body.rawKql,
    graphQuery: body.graphQuery,
    logsQuery: body.logsQuery,
    visibility: body.visibility,
    ownerId: actor.id,
    ownerEmail: actor.email,
  });

  await writeAudit({
    actor,
    action: 'query.save',
    entityType: 'query',
    entityId: saved.id,
    summary: `Saved a ${saved.queryBackend} query "${saved.name}" (${saved.visibility})`,
  });

  return NextResponse.json(saved, { status: 201 });
}
