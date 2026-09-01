import { eq } from 'drizzle-orm';
import { db } from './db/client';
import { schemaCache as schemaCacheTable, resourceTypesCache as resourceTypesCacheTable } from './db/tables';
import { many, one, run } from './db/exec';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;    // 7 days
const TYPES_TTL_MS = 24 * 60 * 60 * 1000;  // 1 day

export interface SchemaCacheEntry {
  resourceType: string;
  fields: string[];
  cachedAt: string;
  fieldCount: number;
}

export const COMMON_RESOURCE_TYPES = [
  'microsoft.compute/virtualmachines',
  'microsoft.compute/disks',
  'microsoft.compute/snapshots',
  'microsoft.compute/virtualmachinescalesets',
  'microsoft.storage/storageaccounts',
  'microsoft.network/virtualnetworks',
  'microsoft.network/networksecuritygroups',
  'microsoft.network/publicipaddresses',
  'microsoft.network/networkinterfaces',
  'microsoft.network/loadbalancers',
  'microsoft.network/applicationgateways',
  'microsoft.keyvault/vaults',
  'microsoft.sql/servers',
  'microsoft.sql/servers/databases',
  'microsoft.web/sites',
  'microsoft.web/serverfarms',
  'microsoft.containerservice/managedclusters',
  'microsoft.insights/components',
  'microsoft.operationalinsights/workspaces',
  'microsoft.managedidentity/userassignedidentities',
];

export async function readSchemaCache(resourceType: string): Promise<{ entry: SchemaCacheEntry; stale: boolean } | null> {
  const row = await one(db
    .select()
    .from(schemaCacheTable)
    .where(eq(schemaCacheTable.resourceType, resourceType.toLowerCase())));
  if (!row) return null;
  const fields = JSON.parse(row.fields) as string[];
  if (fields.length === 0) return null; // empty entry → treat as miss, re-fetch from ARM
  const entry: SchemaCacheEntry = {
    resourceType: row.resourceType,
    fields,
    cachedAt: row.cachedAt,
    fieldCount: row.fieldCount,
  };
  const stale = Date.now() - new Date(row.cachedAt).getTime() > TTL_MS;
  return { entry, stale };
}

export async function writeSchemaCache(resourceType: string, fields: string[]): Promise<void> {
  const now = new Date().toISOString();
  await run(db.insert(schemaCacheTable).values({
    resourceType: resourceType.toLowerCase(),
    fields: JSON.stringify(fields),
    cachedAt: now,
    fieldCount: fields.length,
  }).onConflictDoUpdate({
    target: schemaCacheTable.resourceType,
    set: { fields: JSON.stringify(fields), cachedAt: now, fieldCount: fields.length },
  }));
}

export async function readResourceTypesCache(): Promise<{ types: string[]; stale: boolean; cachedAt: string } | null> {
  const row = await one(db.select().from(resourceTypesCacheTable).where(eq(resourceTypesCacheTable.id, 1)));
  if (!row) return null;
  const stale = Date.now() - new Date(row.cachedAt).getTime() > TYPES_TTL_MS;
  return { types: JSON.parse(row.types) as string[], stale, cachedAt: row.cachedAt };
}

export async function writeResourceTypesCache(types: string[]): Promise<void> {
  const now = new Date().toISOString();
  await run(db.insert(resourceTypesCacheTable).values({ id: 1, types: JSON.stringify(types), cachedAt: now })
    .onConflictDoUpdate({
      target: resourceTypesCacheTable.id,
      set: { types: JSON.stringify(types), cachedAt: now },
    }));
}

export async function listCachedSchemas(): Promise<SchemaCacheEntry[]> {
  return (await many(db.select().from(schemaCacheTable))).map(row => ({
    resourceType: row.resourceType,
    fields: JSON.parse(row.fields) as string[],
    cachedAt: row.cachedAt,
    fieldCount: row.fieldCount,
  }));
}

export interface SchemaCacheStatus {
  typeListCachedAt: string | null;
  typeListStale: boolean;
  typeCount: number;
  schemaEntryCount: number;
  oldestSchemaAt: string | null;
  newestSchemaAt: string | null;
  staleSchemaCount: number;
}

export async function getSchemaCacheStatus(): Promise<SchemaCacheStatus> {
  const typesCache = await readResourceTypesCache();
  const schemas = await listCachedSchemas();
  const now = Date.now();
  const cachedAts = schemas.map(s => s.cachedAt).sort();
  return {
    typeListCachedAt: typesCache?.cachedAt ?? null,
    typeListStale: typesCache?.stale ?? false,
    typeCount: typesCache?.types.length ?? 0,
    schemaEntryCount: schemas.length,
    oldestSchemaAt: cachedAts[0] ?? null,
    newestSchemaAt: cachedAts[cachedAts.length - 1] ?? null,
    staleSchemaCount: schemas.filter(s => now - new Date(s.cachedAt).getTime() > TTL_MS).length,
  };
}
