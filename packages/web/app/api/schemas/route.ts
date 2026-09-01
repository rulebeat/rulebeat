import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { azureError, safeErrorMessage } from '@/lib/api-error';
import { getResourceTypeFields } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';
import { writeAudit } from '@/lib/db/audit';
import { listCachedSchemas, writeSchemaCache, COMMON_RESOURCE_TYPES } from '@/lib/schema-cache';

export const dynamic = 'force-dynamic';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const cached = await listCachedSchemas();
  const cachedTypes = new Set(cached.map(e => e.resourceType));
  const missing = COMMON_RESOURCE_TYPES.filter(t => !cachedTypes.has(t));

  return NextResponse.json({ cached, missing, total: COMMON_RESOURCE_TYPES.length });
}

export async function POST() {
  const actor = await requireRole('schemas:refresh');
  if (actor instanceof NextResponse) return actor;

  let ctx;
  try {
    ctx = await createTenantContext();
  } catch (err) {
    return azureError('Could not connect to Azure to refresh schemas', err);
  }

  const results: { type: string; status: 'ok' | 'empty' | 'error'; count?: number; error?: string }[] = [];

  for (const type of COMMON_RESOURCE_TYPES) {
    try {
      const fields = await getResourceTypeFields(type, ctx);
      if (fields.length > 0) {
        await writeSchemaCache(type, fields);
        results.push({ type, status: 'ok', count: fields.length });
      } else {
        // Azure answered but this type genuinely has no properties — not a failure to reach Azure.
        results.push({ type, status: 'empty' });
      }
    } catch (err) {
      // The ARM call itself failed (timeout, credential, throttling) — distinct from a genuinely empty schema.
      results.push({ type, status: 'error', error: safeErrorMessage(`Schema refresh failed for ${type}`, err) });
    }
  }

  const okCount = results.filter(r => r.status === 'ok').length;
  await writeAudit({
    actor,
    action: 'schema_cache.refresh',
    entityType: 'schema_cache',
    summary: `${actor.email} refreshed the resource schema cache (${okCount}/${results.length} types)`,
  });

  return NextResponse.json({ results });
}
