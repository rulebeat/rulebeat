import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../schema.pg';
import {
  definitionToColumns, installColumns, planRuleSeeding, versionKey,
  type SeedAction, type StoredRuleRow,
} from '../../rule-versions';
import { loadShippedCatalogue, type ShippedCatalogue } from '../../shipped-catalogue';
import { STARTER_DASHBOARD } from '../../dashboard-templates';
import { hashPasswordSync } from '../../password';
import { BUILTIN_CATEGORIES, OLD_SECURITY_RED, type SeedOptions } from '../migrate';

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
  opts: SeedOptions = {},
): Promise<void> {
  await seedRules(db, dataDir, opts.catalogue);
  await seedCategories(db);
  await seedDefaultDashboard(db);
  // Onboarding must be decided BEFORE the owner account exists (see runSeeds in migrate.ts).
  await seedOnboardingState(db);
  if (!opts.skipOwnerBootstrap) await seedOwnerAccount(db, dataDir);
  await seedInitialAdmin(db);
}

/**
 * The Postgres twin of `migrate.ts`'s `seedRules()`: the same plan (`planRuleSeeding()`), executed
 * with Drizzle. An upgrade adds versions beside the one a rule runs and never changes what an
 * enabled rule runs (ADR 0004).
 */
async function seedRules(db: PgDb, dataDir: string, catalogue: ShippedCatalogue | undefined): Promise<void> {
  const { rules, ruleVersions } = pgSchema;
  const shipped = catalogue ?? loadShippedCatalogue(dataDir);
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    const rows: StoredRuleRow[] = (await tx.select({
      id: rules.id, name: rules.name, description: rules.description, category: rules.category,
      severity: rules.severity, enabled: rules.enabled, scope: rules.scope, resourceTypes: rules.resourceTypes,
      conditions: rules.conditions, conditionGroups: rules.conditionGroups, visualQuery: rules.visualQuery,
      projectColumns: rules.projectColumns, rawKql: rules.rawKql, queryBackend: rules.queryBackend,
      kind: rules.kind, graphQuery: rules.graphQuery, logsQuery: rules.logsQuery, type: rules.type,
      pack: rules.pack, version: rules.version, retiredAt: rules.retiredAt, originRuleId: rules.originRuleId,
    }).from(rules));
    const recorded = new Set(
      (await tx.select({ ruleId: ruleVersions.ruleId, version: ruleVersions.version }).from(ruleVersions))
        .map(r => versionKey(r.ruleId, r.version)),
    );

    const execute = async (t: typeof tx, a: SeedAction): Promise<void> => {
      switch (a.action) {
        case 'insert':
          await t.insert(rules).values({
            id: a.rule.id, ...definitionToColumns(a.rule.definition), ...installColumns(a.rule), filter: null, type: 'builtin',
            enabled: a.rule.enabled, pack: a.rule.pack, version: a.rule.version,
          }).onConflictDoNothing();
          break;
        case 'adopt':
          await t.update(rules).set({ type: 'builtin', pack: a.pack }).where(eq(rules.id, a.ruleId));
          break;
        case 'backfill-graph':
          await t.update(rules).set({
            queryBackend: a.rule.definition.queryBackend,
            kind: a.rule.definition.kind,
            graphQuery: JSON.stringify(a.rule.definition.graphQuery),
          }).where(and(eq(rules.id, a.rule.id), isNull(rules.graphQuery)));
          break;
        case 'convert':
          await t.update(rules).set({
            type: 'custom', pack: null, version: null, retiredAt: null,
            originRuleId: a.ruleId, originVersion: a.originVersion,
          }).where(eq(rules.id, a.ruleId));
          break;
        case 'record':
          await t.insert(ruleVersions).values({
            ruleId: a.ruleId, version: a.version, sortKey: a.sortKey, releaseNote: a.releaseNote,
            definition: JSON.stringify(a.definition), upstreamRef: a.upstreamRef ?? null, firstSeenAt: now,
          }).onConflictDoNothing();
          break;
        case 'set-running':
          await t.update(rules).set({ version: a.version }).where(eq(rules.id, a.ruleId));
          break;
        case 'apply':
          await t.update(rules).set({ ...definitionToColumns(a.rule.definition, a.kind), version: a.rule.version })
            .where(eq(rules.id, a.rule.id));
          break;
        case 'retire':
          await t.update(rules).set({ retiredAt: now }).where(eq(rules.id, a.ruleId));
          break;
        case 'unretire':
          await t.update(rules).set({ retiredAt: null }).where(eq(rules.id, a.ruleId));
          break;
      }
    };

    for (const action of planRuleSeeding({ catalogue: shipped, rows, recorded })) {
      try {
        // A nested transaction is a savepoint: one rule that cannot be written (a malformed pack
        // entry) is skipped without aborting the rest, as a malformed pack file always was.
        await tx.transaction(async (savepoint) => execute(savepoint as unknown as typeof tx, action));
      } catch (err) {
        console.warn(`[rulebeat] could not seed a rule (${action.action}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
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
