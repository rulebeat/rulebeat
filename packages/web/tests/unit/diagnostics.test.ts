/**
 * B4 · getSchedulerStatus + getSchemaCacheStatus
 *
 * Both are pure local reads — no network calls, no Azure SDK. `getSchedulerStatus` reads
 * `globalThis` flags set by the scheduler; `getSchemaCacheStatus` reads the schema-cache DB tables.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSchemaCache, writeResourceTypesCache, getSchemaCacheStatus } from '@/lib/schema-cache';
import { getSchedulerStatus } from '@/lib/scheduler';
import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';

// ── Schema-cache helpers ─────────────────────────────────────────────────────

function clearSchemaTables() {
  db.run(sql`DELETE FROM schema_cache`);
  db.run(sql`DELETE FROM resource_types_cache`);
}

/** Write a schema entry with a custom `cachedAt` timestamp by updating after insert. */
async function writeSchemaAt(resourceType: string, cachedAt: string) {
  await writeSchemaCache(resourceType, ['prop1', 'prop2']);
  db.run(sql.raw(`UPDATE schema_cache SET cached_at = '${cachedAt}' WHERE resource_type = '${resourceType}'`));
}

async function writeTypesAt(types: string[], cachedAt: string) {
  await writeResourceTypesCache(types);
  db.run(sql.raw(`UPDATE resource_types_cache SET cached_at = '${cachedAt}' WHERE id = 1`));
}

// ── Scheduler globals ────────────────────────────────────────────────────────

type SchedulerGlobals = {
  __rulebeatSchedulerStarted?: boolean;
  __rulebeatSchedulerLastTickAt?: string;
};

function g(): SchedulerGlobals {
  return globalThis as typeof globalThis & SchedulerGlobals;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('B4 · getSchemaCacheStatus', () => {
  beforeEach(clearSchemaTables);
  afterEach(clearSchemaTables);

  it('returns empty status when nothing is cached', async () => {
    const status = await getSchemaCacheStatus();
    expect(status.schemaEntryCount).toBe(0);
    expect(status.typeListCachedAt).toBeNull();
    expect(status.typeCount).toBe(0);
    expect(status.oldestSchemaAt).toBeNull();
    expect(status.newestSchemaAt).toBeNull();
    expect(status.staleSchemaCount).toBe(0);
  });

  it('reflects fresh schema entries correctly', async () => {
    const now = new Date().toISOString();
    await writeSchemaAt('microsoft.compute/virtualmachines', now);
    await writeSchemaAt('microsoft.storage/storageaccounts', now);
    await writeTypesAt(['microsoft.compute/virtualmachines', 'microsoft.storage/storageaccounts'], now);

    const status = await getSchemaCacheStatus();
    expect(status.schemaEntryCount).toBe(2);
    expect(status.staleSchemaCount).toBe(0);
    expect(status.typeCount).toBe(2);
    expect(status.typeListStale).toBe(false);
    expect(status.typeListCachedAt).toBe(now);
  });

  it('counts stale schema entries using the 7-day TTL', async () => {
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    const freshDate = new Date().toISOString();
    await writeSchemaAt('microsoft.compute/virtualmachines', staleDate);
    await writeSchemaAt('microsoft.storage/storageaccounts', freshDate);

    const status = await getSchemaCacheStatus();
    expect(status.schemaEntryCount).toBe(2);
    expect(status.staleSchemaCount).toBe(1);
  });

  it('marks type list as stale when older than 1 day', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
    await writeTypesAt(['microsoft.compute/virtualmachines'], staleDate);

    const status = await getSchemaCacheStatus();
    expect(status.typeListStale).toBe(true);
  });

  it('reports oldest and newest schema dates', async () => {
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const newer = new Date().toISOString();
    await writeSchemaAt('microsoft.compute/virtualmachines', older);
    await writeSchemaAt('microsoft.storage/storageaccounts', newer);

    const status = await getSchemaCacheStatus();
    expect(status.oldestSchemaAt).toBe(older);
    expect(status.newestSchemaAt).toBe(newer);
  });
});

describe('B4 · getSchedulerStatus', () => {
  const originalEnv = process.env.RULEBEAT_DISABLE_SCHEDULER;

  afterEach(async () => {
    // Restore env and globals after each test
    if (originalEnv === undefined) delete process.env.RULEBEAT_DISABLE_SCHEDULER;
    else process.env.RULEBEAT_DISABLE_SCHEDULER = originalEnv;
    delete g().__rulebeatSchedulerStarted;
    delete g().__rulebeatSchedulerLastTickAt;
  });

  it('reports enabled=false when RULEBEAT_DISABLE_SCHEDULER=1', async () => {
    process.env.RULEBEAT_DISABLE_SCHEDULER = '1';
    const status = getSchedulerStatus();
    expect(status.enabled).toBe(false);
  });

  it('reports enabled=true when the env var is absent', async () => {
    delete process.env.RULEBEAT_DISABLE_SCHEDULER;
    const status = getSchedulerStatus();
    expect(status.enabled).toBe(true);
  });

  it('reports started=false before startScheduler is called', async () => {
    delete g().__rulebeatSchedulerStarted;
    const status = getSchedulerStatus();
    expect(status.started).toBe(false);
  });

  it('reports started=true after the global is set', async () => {
    g().__rulebeatSchedulerStarted = true;
    const status = getSchedulerStatus();
    expect(status.started).toBe(true);
  });

  it('returns null secondsSinceTick when lastTickAt is unset', async () => {
    delete g().__rulebeatSchedulerLastTickAt;
    const status = getSchedulerStatus();
    expect(status.lastTickAt).toBeNull();
    expect(status.secondsSinceTick).toBeNull();
  });

  it('computes a finite secondsSinceTick from a recent lastTickAt', async () => {
    const tickAt = new Date(Date.now() - 10_000).toISOString(); // 10 seconds ago
    g().__rulebeatSchedulerLastTickAt = tickAt;
    const status = getSchedulerStatus();
    expect(status.lastTickAt).toBe(tickAt);
    expect(status.secondsSinceTick).toBeGreaterThanOrEqual(9);
    expect(status.secondsSinceTick).toBeLessThan(20);
  });
});
