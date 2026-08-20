import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { getResourceTypeFields } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';
import { readSchemaCache, writeSchemaCache } from '@/lib/schema-cache';

export const dynamic = 'force-dynamic';

async function fetchAndCache(resourceType: string): Promise<string[] | null> {
  const ctx = await createTenantContext();
  const fields = await getResourceTypeFields(resourceType, ctx);
  if (fields.length === 0) return null;
  writeSchemaCache(resourceType, fields);
  return fields;
}

export async function GET(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const { searchParams } = new URL(req.url);
  const resourceType = searchParams.get('type')?.toLowerCase().trim();
  if (!resourceType) return NextResponse.json({ error: 'type is required' }, { status: 400 });

  const cached = readSchemaCache(resourceType);

  // Fresh cache — instant response
  if (cached && !cached.stale) {
    return NextResponse.json({
      fields: cached.entry.fields,
      source: 'cache' as const,
      cachedAt: cached.entry.cachedAt,
    });
  }

  // Stale cache — serve immediately, refresh in background
  if (cached?.stale) {
    void fetchAndCache(resourceType).catch(err => {
      console.error('[RuleBeat] background resource-schema refresh failed:', err);
    });
    return NextResponse.json({
      fields: cached.entry.fields,
      source: 'cache-stale' as const,
      cachedAt: cached.entry.cachedAt,
    });
  }

  // No cache — fetch from ARM now (first time for this type)
  try {
    const fields = await fetchAndCache(resourceType);
    if (!fields) {
      return NextResponse.json(
        { error: `No schema found for '${resourceType}'. Verify the resource type name (e.g. microsoft.compute/virtualmachines).` },
        { status: 404 },
      );
    }
    return NextResponse.json({
      fields,
      source: 'arm' as const,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    return azureError(`Could not load schema for '${resourceType}' from Azure`, err);
  }
}
