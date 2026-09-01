import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { and, count, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../schema.pg';
import { BUILTIN_RULES } from '../../builtin-rules';
import { STARTER_DASHBOARD } from '../../dashboard-templates';
import { hashPasswordSync } from '../../password';
import { BUILTIN_CATEGORIES, OLD_SECURITY_RED } from '../migrate';

type PgDb = NodePgDatabase<typeof pgSchema>;

/**
 * Seeds built-in content into a Postgres database: the async, `onConflictDoNothing`-based twin of
 * `migrate.ts`'s `runSeeds()`. Each function mirrors its SQLite namesake body-for-body, and the
 * call order is preserved because it is load-bearing: onboarding state must be decided before the
 * owner account creates the first user, or a fresh install would report onboarding "skipped".
 *
 * Differences from the SQLite path, all deliberate:
 *  - No `seedFromJson()` and no legacy `orphan::`/`standards::` rule-id cleanup. Both only ever
 *    apply to data that predates the current SQLite schema, and a Postgres database starts empty
 *    by definition (issue #73 scopes out SQLite-to-Postgres data migration), so there is nothing
 *    to import or clean up.
 *  - `categories` has no `is_special` column on Postgres (SQLite keeps it physically only), so
 *    the category insert simply omits it.
 *  - SQLite's `.immediate()` transactions become plain `db.transaction()`: Postgres has no
 *    deferred-lock equivalent of that problem, and its transactions already serialize the
 *    concurrent-first-boot races the `.immediate()` calls exist for.
 */
export async function seedPg(
  db: PgDb,
  dataDir: string,
  opts: { skipOwnerBootstrap?: boolean } = {},
): Promise<void> {
  await seedBuiltinRules(db);
  await seedPackRules(db, dataDir);
  await seedCategories(db);
  await seedDefaultDashboard(db);
  // Onboarding must be decided BEFORE the owner account exists (see runSeeds in migrate.ts).
  await seedOnboardingState(db);
  if (!opts.skipOwnerBootstrap) await seedOwnerAccount(db, dataDir);
  await seedInitialAdmin(db);
}

// Mirrors deriveKind() in lib/rules.ts, duplicated for the same reason migrate.ts duplicates it:
// lib/rules.ts imports the db client, and importing it back from the seed path would cycle.
function deriveKindForSeed(queryBackend: string): 'state' | 'activity' {
  return queryBackend === 'log-analytics' ? 'activity' : 'state';
}

async function seedBuiltinRules(db: PgDb): Promise<void> {
  const { rules } = pgSchema;
  await db.transaction(async (tx) => {
    for (const r of BUILTIN_RULES) {
      const queryBackend = r.queryBackend ?? 'resource-graph';
      const shape = r.shape ?? 'detect';
      const kind = r.kind ?? deriveKindForSeed(queryBackend);
      const graphQuery = r.graphQuery ? JSON.stringify(r.graphQuery) : null;
      await tx.insert(rules).values({
        id: r.id,
        name: r.name,
        description: r.description,
        category: r.category,
        severity: r.severity,
        enabled: r.enabled,
        scope: JSON.stringify(r.scope),
        resourceTypes: JSON.stringify(r.resourceTypes),
        filter: null,
        conditions: JSON.stringify(r.conditions),
        rawKql: r.rawKql ?? null,
        type: 'builtin',
        pack: r.pack ?? 'rulebeat-core',
        queryBackend,
        shape,
        kind,
        graphQuery,
      }).onConflictDoNothing();
      // Backfill type/pack/name/raw_kql/taxonomy on rows that already existed (the insert above
      // skips them). graph_query only fills a genuine NULL: spec 032 makes a builtin's graphQuery
      // user-editable, so re-asserting the seed default would silently revert that edit. Same
      // COALESCE contract as migrate.ts's seedBuiltinRules.
      await tx.update(rules).set({
        type: 'builtin',
        pack: r.pack ?? 'rulebeat-core',
        name: r.name,
        rawKql: r.rawKql ?? null,
        queryBackend,
        shape,
        kind,
        graphQuery: sql`COALESCE(${rules.graphQuery}, ${graphQuery})`,
      }).where(eq(rules.id, r.id));
    }
  });
}

async function seedPackRules(db: PgDb, dataDir: string): Promise<void> {
  const packsDir = join(dataDir, 'packs');
  if (!existsSync(packsDir)) return;
  const { rules } = pgSchema;

  const files = readdirSync(packsDir).filter(f => f.endsWith('.json') && f !== 'pack-manifest.json');
  for (const file of files) {
    try {
      const packRules = JSON.parse(readFileSync(join(packsDir, file), 'utf-8')) as Array<Record<string, unknown>>;
      await db.transaction(async (tx) => {
        for (const p of packRules) {
          // Pack JSON uses 'rules' field (old name), read as conditions for backward compat.
          const conditions = p.conditions ?? p.rules ?? [];
          const resourceTypes =
            typeof p.resourceTypes === 'string' ? p.resourceTypes : JSON.stringify(p.resourceTypes ?? []);
          await tx.insert(rules).values({
            id: p.id as string,
            name: p.name as string,
            description: p.description as string,
            category: p.category as string,
            severity: p.severity as string,
            enabled: !!p.enabled,
            scope: typeof p.scope === 'string' ? p.scope : JSON.stringify(p.scope),
            resourceTypes,
            filter: null,
            conditions: typeof conditions === 'string' ? conditions : JSON.stringify(conditions),
            rawKql: (p.rawKql as string | undefined) ?? null,
            type: 'builtin',
            pack: (p.pack as string | undefined) ?? null,
          }).onConflictDoNothing();
          await tx.update(rules).set({
            name: p.name as string,
            type: 'builtin',
            pack: (p.pack as string | undefined) ?? null,
            resourceTypes,
          }).where(eq(rules.id, p.id as string));
        }
      });
    } catch { /* malformed pack file: skip */ }
  }
}

async function seedCategories(db: PgDb): Promise<void> {
  const { categories } = pgSchema;
  await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    for (const c of BUILTIN_CATEGORIES) {
      await tx.insert(categories).values({
        id: c.id,
        label: c.label,
        color: c.color,
        icon: c.icon,
        sortOrder: c.sortOrder,
        isBuiltin: true,
        createdAt: now,
      }).onConflictDoNothing();
      // label/color/icon are user-editable in Settings and must never be reverted by a restart;
      // only sort_order and the is_builtin flag are structural and safe to re-assert.
      await tx.update(categories)
        .set({ sortOrder: c.sortOrder, isBuiltin: true })
        .where(eq(categories.id, c.id));
    }
    // Migrate Security's old seeded red default, but only where the exact untouched old value
    // still stands; an admin's own colour choice is kept. See migrate.ts for the full story.
    const security = BUILTIN_CATEGORIES.find(c => c.id === 'security')!;
    await tx.update(categories)
      .set({ color: security.color })
      .where(and(eq(categories.id, 'security'), eq(categories.color, OLD_SECURITY_RED)));
  });
}

async function seedDefaultDashboard(db: PgDb): Promise<void> {
  const { dashboards, meta } = pgSchema;
  await db.transaction(async (tx) => {
    const marker = await tx.select({ value: meta.value }).from(meta)
      .where(eq(meta.key, 'dashboards-seeded-v1'));
    if (marker.length > 0) return;

    const [{ n }] = await tx.select({ n: count() }).from(dashboards);
    if (n === 0) {
      await tx.insert(dashboards).values({
        id: 'default',
        name: STARTER_DASHBOARD.name,
        description: STARTER_DASHBOARD.description,
        config: JSON.stringify(STARTER_DASHBOARD.config),
        isDefault: true,
        createdAt: new Date().toISOString(),
      }).onConflictDoNothing();
    }

    await tx.insert(meta).values({ key: 'dashboards-seeded-v1', value: '1' }).onConflictDoNothing();
  });
}

async function seedOnboardingState(db: PgDb): Promise<void> {
  const { meta, users } = pgSchema;
  const marker = await db.select({ value: meta.value }).from(meta)
    .where(eq(meta.key, 'onboarding-v1'));
  if (marker.length > 0) return;

  const [{ n }] = await db.select({ n: count() }).from(users);
  const status: 'pending' | 'skipped' = n === 0 ? 'pending' : 'skipped';
  const state = { status, lastStep: 1, completedAt: null, completedBy: null };

  await db.insert(meta).values({ key: 'onboarding-v1', value: JSON.stringify(state) }).onConflictDoNothing();
}

async function seedOwnerAccount(db: PgDb, dataDir: string): Promise<void> {
  const { users, localAccounts } = pgSchema;
  const email = process.env.RULEBEAT_INITIAL_ADMIN?.trim().toLowerCase() || 'admin@rulebeat.local';
  const password = process.env.RULEBEAT_INITIAL_PASSWORD?.trim() || randomBytes(18).toString('base64url');
  const userId = randomUUID();
  const now = new Date().toISOString();

  let created = false;
  try {
    created = await db.transaction(async (tx) => {
      const [{ n }] = await tx.select({ n: count() }).from(users);
      if (n > 0) return false;

      await tx.insert(users).values({ id: userId, email, role: 'admin', createdAt: now });
      await tx.insert(localAccounts).values({
        userId,
        passwordHash: hashPasswordSync(password),
        mustChangePassword: true,
        createdAt: now,
      });
      return true;
    });
  } catch {
    // Lost a concurrent first-boot race (email UNIQUE): the winner's account stands.
    created = false;
  }
  if (!created) return;

  // Password artifacts and console banner: mirrors migrate.ts's seedOwnerAccount().
  const passwordFile = join(dataDir, 'initial-password.txt');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(passwordFile, `${email}\n${password}\n`, { mode: 0o600 });
    try { chmodSync(passwordFile, 0o600); } catch { /* no-op on Windows */ }
  } catch (err) {
    console.error('[RuleBeat] could not write the initial password file:', err);
  }

  console.log('');
  console.log('==========================================================================');
  console.log('  RuleBeat: no account exists yet. Created one for first sign-in:');
  console.log(`    Email:    ${email}`);
  console.log(`    Password: see ${passwordFile}`);
  console.log('  You will be asked to set a new password on first sign-in.');
  console.log('==========================================================================');
  console.log('');
}

async function seedInitialAdmin(db: PgDb): Promise<void> {
  const { users } = pgSchema;
  const email = process.env.RULEBEAT_INITIAL_ADMIN?.trim().toLowerCase();
  if (!email) return;

  const [{ n }] = await db.select({ n: count() }).from(users).where(eq(users.role, 'admin'));
  if (n > 0) return;

  try {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      await db.update(users).set({ role: 'admin' }).where(eq(users.id, existing[0]!.id));
    } else {
      await db.insert(users).values({
        id: randomUUID(), email, role: 'admin', createdAt: new Date().toISOString(),
      });
    }
  } catch { /* email UNIQUE collision: someone already holds this row; leave it alone */ }
}
