# Lessons: SQLite, migrations, seeding, external packs, data modelling

Read this before touching `packages/web/lib/db/*`, any migration, any seed function, or the scripts
that sync external rule packs.

The governing rule: **an upgrade must never disturb a user's existing configuration or data.**

---

## Migrations

**Test that a migration *preserved content*, never that it "ran without error."** Almost every migration is `try { … } catch {}` by design, and three of the five upgrade bugs threw nothing at all; they were only visible as missing rows or NULL columns.

**A migration guarded on "does this table exist" is dead code if `CREATE TABLE IF NOT EXISTS` runs above it.** The create makes the guard's condition false forever, so the rename never fires and old rows are orphaned. Any migration that inspects schema state must run *before* the block that establishes that state.

**A column rename must always come before the `ADD COLUMN` that would create the same name, and nullability is irrelevant.** SQLite rejects `RENAME old TO new` with "duplicate column name" once `new` exists; the surrounding `catch` swallows it and data stays in the old column.

**`sqlite.exec()` does not roll back, so a multi-statement rebuild left in a `try/catch` can strand a database permanently.** Wrap table rebuilds in `sqlite.transaction()` and clean up scaffolding before retrying.

**SQLite can't alter a primary key in place.** Widening one needs a full table rebuild: CREATE new table, INSERT ... SELECT old rows, DROP old, RENAME new, guarded by checking the new column doesn't already exist.

**Adding a NOT NULL column to an existing table needs an explicit migration-time `DEFAULT`**, or it crashes on existing rows. An ORM schema change alone only affects new table creation.

**A rename/backfill migration must wrap each item in its own try/catch, not one try/catch around the whole loop.** A single failure aborting the rest, combined with unconditional reseeding afterward, can cause duplicate rows.

**Renaming an ID doesn't retroactively fix references stored inside JSON blob columns.** Pair any ID-rename migration with a text `REPLACE()` over JSON columns that reference it.

**Renaming a dashboard widget type or stat metric id needs a `WIDGET_TYPE_MAP`/`STAT_METRIC_MAP` entry in `migrateDashboardConfig()` (`lib/dashboard-migrations.ts`), not a find-and-replace.** It's a read-time rewrite over the widget's stored JSON config, so an existing customer's saved dashboard (with the old string still in the DB) keeps rendering under the new code with no migration step. Give it test coverage: the function had none until the first rename work added a case.

**A one-time backfill that runs from a startup hook must never be able to throw.** Feeding old scan blobs into a `NOT NULL` insert can stop the app booting at the worst moment. Fill in missing data rather than rejecting it; scope the try/catch so one bad slice costs only its own.

**A foreign-key-shaped column can point at a row that never existed, not because of a rename but because the referenced table wasn't the source of truth yet.** `findings.rule_id` held identity-check ids for years before identity checks became real `rules` rows. The fix is seeding the missing row (`INSERT OR IGNORE`), and the test must seed the dangling reference *before* migrating, not after, or it never exercises the gap.

**A golden migration-snapshot test diffs against whatever `schema.ts`/`migrate.ts` currently produce, so in a working tree carrying more than one in-flight change it picks up every live schema change, not just your own.** Before running `-u`, read the diff line-by-line and attribute each hunk. Your own tables and columns are expected fallout; anything else needs cross-checking against what has already shipped before you trust it isn't corruption.

## Seeding and upserts

**`INSERT OR IGNORE` seeding never propagates field/name updates to existing rows.** Always pair it with an explicit `UPDATE ... WHERE id = ?` covering every column the seed definition owns. A column added later that's missing from the UPDATE stays NULL forever.

**An upsert's conflict-update clause must explicitly list every column that should refresh on re-sync.** Anything omitted freezes at its first-ever value forever. Grep every upsert when adding a new field to a record type.

**A field can exist on the type, the table and the source data and still be dead, so verify the seed INSERT *and* the row mapper both name it.** A column added after the seed/mapper were written is the usual cause; check both directions of the DB round-trip when auditing "why is this always empty."

**Appending a new default to installs that already seeded their config needs its own one-time marker row, not a comparison against "is this still the default."** Any prior user edit breaks a content-based match; a marker respects later user removal.

**Committed JSON files + a `seedX()` function (INSERT OR IGNORE + paired UPDATE) is the right pattern for external data seeding.** Drop a file, restart, done. No migration, no config change.

**Stale IDs from a failed sync can silently coexist with corrected ones.** `INSERT OR IGNORE` keys on the primary key, so a second fixed sync doesn't overwrite a first broken one. Clean up with a targeted migration.

**Renaming a JSON object key via parse→reassign→delete→stringify reorders that key to the end of every object**, turning a small rename into a full-file diff. Use raw text/regex substitution on committed JSON files instead.

## External packs and schema sources

**Schema/resource-type data must come from the ARM provider aliases API, never sampled resources.** It is the same authoritative source Azure Policy uses; cache with background refresh so the UI never blocks on a live ARM call.

**Some resource/entity types don't expose schema via the normal API** (e.g. ARM aliases returns 0 fields for resource-group/subscription/MG container types), so hardcode their known field sets.

**Never lowercase resource types from external sources, because casing carries semantic meaning** (ARM, docs URLs, display names). Lowercase only at comparison time, and backfill every DB column that stored the lowercased value.

**APRL docs URL pattern: strip the `Microsoft.` prefix, keep original casing** (`Provider/resourceType`, e.g. `Compute/virtualMachines`). The GitHub Pages site 404s on wrong casing.

**A synced external pack only carries the fields the upstream actually has, so check field coverage before defaulting it to enabled.** APRL ships descriptions and docs links but no remediation; seeding all 143 rules as `enabled: true` produced a wall of findings with no fix attached.

**When syncing structured content from an external repo, don't assume the data lives where the metadata does.** APRL's KQL queries live in separate `.kql` files, not inline in the YAML.

**Pair an external pack's query files to their recommendations by a stable id (the guid in the filename or `recommendationId`), never by directory index.** `scripts/packs/aprl-v2.ts` pairs by index, so 76 of 143 APRL rules carry another recommendation's KQL and 38 carry an `under-development` placeholder. Known and not yet fixed.

**`seedPackRules` resets a pack rule's name, pack label and resource types on every startup; only enabled state, severity, description and KQL edits survive.** Don't write "an upgrade never overwrites an edited pack rule" anywhere; say which fields are kept and which are re-synced.

**External data-source syncing: one generic runner + a small per-source transform.** Adding a new pack should be one new file implementing an interface, not a monolithic bespoke script.

**GitHub's recursive tree API silently truncates for repos above ~100k items, so always check the `truncated` flag** before trusting a full-tree fetch.

## Modelling

**DB-backed entities (categories, etc.) need no new files per instance.** A dynamic route handles any row automatically.

**A hardcoded-exception flag belongs on the item that actually varies, not on a coarser container it happens to sit inside.** `category.isSpecial` gated identity's whole category onto a separate execution path; it was replaced with `Rule.queryBackend` on each rule, partitioned inside one unconditional function, because the exception was never really category-shaped: a category can (and did) mix rules that need it with rules that don't.

**Category/module lists must be read live from the DB, never hardcoded.** Call the repository on every invocation so new rows appear everywhere automatically.

**Counts come from the lifecycle table's timestamps and historical scores from snapshots. Never subtract a snapshot count from a live count.** A past percentage needs a past denominator only a snapshot has; a delta count is exactly reconstructable from live timestamps.

**Concepts like "new" and "fixed" only make sense relative to a reference point, and "the previous run" isn't reliably definable once a run can target an arbitrary subset.** Prefer a pure elapsed-time window (first-seen/resolved within N days).

**A "relative" rolling window (e.g. "last 7 days") must resolve to concrete dates at query/render time, not at save time.** A saved "7d" preset should stay rolling every time it's viewed, not frozen to the day it was saved.

**Summing per-dimension aggregates across more than one value of that dimension doesn't reconstruct the correct result.** Per-subscription rule counts can't be added to get a correct blended pass rate. Cap support to a single dimension value.

**A result row with no identity collapses onto whatever fingerprint the missing field defaults to.** A raw-KQL rule whose rows omit `id` hashed every row to `sha256(ruleId::'')`, so many findings silently overwrote one record. Treat "rows came back but had no identity" as its own failure mode (`'invalid'`), not as success with fewer findings.

**The first per-user-owned table in an install-wide schema must return the same not-found response for a nonexistent row and an existent-but-invisible one, on every read path, not just the list endpoint.** `saved_queries`' `getSavedQuery()` returns `null` either way, so a private query owned by someone else 404s instead of 403ing. A 403 on a direct-by-id lookup would confirm the row exists to someone who shouldn't be able to tell.

**Don't force two sites computing "the same" formula into one shared function when their input shapes genuinely differ. Share the smallest reusable piece instead.** The posture split needed at `dashboard-data.ts` (live, `WidgetFilters`-filtered `queryActiveFindings()` results) and at `snapshots.ts` (a raw category-scoped DB aggregate, once per category not per request) don't take the same inputs; forcing one signature over both would abstract over the shape difference itself, not the duplication. `enabledRuleIdsForCategory()`/`splitRuleOutcomes()` are shared where four call sites really do share a shape; `snapshots.ts` keeps its own inline copy of the same logic on purpose.

## The Postgres twin (issue #73)

**Two schema twins, one import path for repositories.** `lib/db/schema.ts` is the SQLite twin, `lib/db/schema.pg.ts` the Postgres twin, column-for-column identical in names and nullability. Repositories never import either directly: `lib/db/tables.ts` exports the active backend's table objects, and `lib/db/exec.ts`'s `many()`/`one()`/`run()`/`inTransaction()` hide the dialect terminators. A repository that imports `./schema` or calls `.all()`/`.get()`/`.run()` works on SQLite and breaks on Postgres, and nothing on the SQLite run will tell you; the pg CI run is what catches it.

**Postgres starts empty and never runs `migrate.ts`.** `lib/db/pg/bootstrap.ts` creates the full schema with `CREATE TABLE IF NOT EXISTS` and `lib/db/pg/seeds.ts` mirrors `runSeeds`' ordered sequence with `onConflict*` upserts. The SQLite migration chain stays SQLite-only, and there is no data migration between backends in either direction. A schema change therefore lands in three places or it is incomplete: `schema.ts`, `schema.pg.ts`, and (for existing SQLite installs) `migrate.ts`.

**Dialect drift is handled at the column, never the call site.** Timestamps and JSON stay `text` in the pg twin so lexicographic ordering and the row mappers are byte-identical across backends; booleans are real columns in both twins (`integer({ mode: 'boolean' })` on SQLite, `boolean` on pg); insertion-order tiebreaks resolve through the order column `tables.ts` exports (`rowid` on SQLite, a `bigserial seq` on pg), never a literal `rowid` in a repository.

**The pg bootstrap is async behind `client.ts`'s exported `dbReady` promise.** Anything touching the database outside the exec seam (test helpers, raw assertions) must `await dbReady` first or it races schema creation and fails with "relation does not exist".
