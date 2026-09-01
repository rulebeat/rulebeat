import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { azureError } from '@/lib/api-error';
import { getAllResourceTypes } from '@rulebeat/core';
import { createTenantContext } from '@/lib/azure-credential';
import { readResourceTypesCache, writeResourceTypesCache } from '@/lib/schema-cache';

export const dynamic = 'force-dynamic';

async function fetchAndCache(): Promise<string[]> {
  const ctx = await createTenantContext();
  const types = await getAllResourceTypes(ctx);
  if (types.length > 0) await writeResourceTypesCache(types);
  return types;
}

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const cached = await readResourceTypesCache();

  if (cached && !cached.stale) {
    return NextResponse.json({ types: cached.types, source: 'cache' });
  }

  if (cached?.stale) {
    void fetchAndCache().catch(err => {
      console.error('[RuleBeat] background resource-types refresh failed:', err);
    });
    return NextResponse.json({ types: cached.types, source: 'cache-stale' });
  }

  try {
    const types = await fetchAndCache();
    return NextResponse.json({ types, source: 'arm' });
  } catch (err) {
    return azureError('Could not load resource types from Azure', err);
  }
}
