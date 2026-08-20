import {
  COMMON_RESOURCE_TYPES,
  readSchemaCache, writeSchemaCache,
  readResourceTypesCache, writeResourceTypesCache,
} from './schema-cache';
import { getResourceTypeFields, getAllResourceTypes } from '@rulebeat/core';
import { createTenantContext } from './azure-credential';

export async function warmSchemaCache(): Promise<void> {
  try {
    const ctx = await createTenantContext();

    // 1. Resource types list (1-day TTL)
    const typesCached = readResourceTypesCache();
    if (!typesCached || typesCached.stale) {
      try {
        const types = await getAllResourceTypes(ctx);
        if (types.length > 0) {
          writeResourceTypesCache(types);
          console.log(`[RuleBeat] Resource types: ${types.length} types cached`);
        }
      } catch {
        // non-fatal
      }
    }

    // 2. Field schemas for common resource types (7-day TTL)
    let warmed = 0;
    let skipped = 0;
    for (const type of COMMON_RESOURCE_TYPES) {
      const cached = readSchemaCache(type);
      if (cached && !cached.stale) { skipped++; continue; }
      try {
        const fields = await getResourceTypeFields(type, ctx);
        if (fields.length > 0) {
          writeSchemaCache(type, fields);
          warmed++;
        }
      } catch {
        // skip types that fail — don't abort the whole warm
      }
    }

    console.log(`[RuleBeat] Field schemas: ${warmed} refreshed, ${skipped} already fresh`);
  } catch (err) {
    // Credentials unavailable (e.g. az login not run) — silently skip
    console.log('[RuleBeat] Schema cache warm skipped:', err instanceof Error ? err.message : String(err));
  }
}
