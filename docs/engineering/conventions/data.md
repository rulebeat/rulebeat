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

**A correction that is derived from stored columns runs on every start and has no marker; the part that needs Azure is a separate startup step.** Finding placement (#271, `lib/db/finding-placement.ts`) only updates a row that does not already have the placement its own columns and its rule imply, so a second start changes nothing and a returning earlier release's rows (which take the column default and write the old values over a corrected one) are put right on the next start. A marker would have left them wrong forever. `migrate.ts` and `pg/bootstrap.ts` cannot call Resource Graph, so the one fact that needs it (which subscription a Logs finding's workspace is in) is `lib/workspace-placement.ts`, run from `instrumentation.ts`, which asks Azure only when a finding is waiting for it and never throws.

**When a backfill must run once per person but may not use a marker, make the person's own unset column the marker.** The access upgrade (#269, `lib/db/access-upgrade.ts`) gives a Viewer or Editor their Everything row only where `users.access_source IS NULL`, then sets it to `manual`. A person later narrowed to no Scope keeps `manual` and is never granted again, while a row an earlier release adds after a rollback still has a null source and is picked up on the next start. A `meta` marker would have failed both: it cannot tell a narrowed person from a new one. The source sits on the person, not on a row, because a person with no rows still needs one. The upgrade runs in one `sqlite.transaction()` (a savepoint on Postgres) and a failure is logged and retried on the next start, never thrown.

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

**Pair an external pack's query files to their recommendations by a stable id (the guid in the filename or `recommendationId`), never by directory index.** `pairRecommendations()` (`lib/aprl-pairing.ts`, pure) pairs an APRL recommendation with the `.kql` file named after its `aprlGuid` and nothing else: a recommendation with no such file ships no query, and a file not named by a guid is reported and paired with nothing. Pairing by index shifted every later recommendation onto another one's query whenever one was skipped (#221). A failed `.kql` fetch fails the sync rather than passing for "no file upstream". `pack-recommendation-ids.test.ts` reads the committed pack and fails when a rule's projected `recommendationId` is not its own; an id that is wrong upstream goes on its named allowlist. A query that is only comments and whitespace, such as `// under-development`, is no query: `pairRecommendations()` skips such a recommendation and counts it in `skipped`, the sync therefore ships no rule for it, and `isCommentOnlyQuery()` is the one predicate for that (`buildAprlFixtures()` uses it too). `pack-placeholder-queries.test.ts` fails when the committed pack holds one. An installed copy of such a rule is retired by the seeder like any rule no pack ships any more (#222).

**The startup seeder never overwrites a definition field of a rule that is enabled.** `seedRules()` records each shipped version in `rule_versions` and moves only a disabled rule to a newer one; the definition fields are name, description, category, severity, kind, query and its scope. Enabled state, tags, suppressions and schedules are never touched by an upgrade, and the seeding path writes no audit entry. A rule no pack ships any more is marked retired and keeps running. Only `type`, `pack` and a missing Graph query are re-asserted on every start.

**The first exception is the removed "Before versioning" step (`lib/rule-versions.ts`, #246, ADR 0009).** A built-in with no version, or on the old `before-versioning` pseudo-version, takes its pack's shipped definition and version whether it is enabled or not, and the `before-versioning` record is deleted. A built-in no pack ships keeps its stored definition with no version, and a custom rule's `origin_version` of `before-versioning` is cleared. `planRuleSeeding()` decides it and both seeders only execute it; the literal lives privately in that file, so nothing else may name it. Ids, enabled state, tags, findings and suppressions are never touched.

**The second exception is `APRL_QUERY_CORRECTION` (`lib/rule-versions.ts`, #221).** Most APRL rules had been shipped with another recommendation's query, so at pack `aprl-v2` and version `2026-06-08T13:06:47Z` only, a stored definition that differs from the shipped one is rewritten in place, enabled or not, together with the definition recorded for that version, and the rule's rows in `findings`, `finding_rows`, `finding_events` and `column_catalogue` are deleted (suppressions, `posture_snapshots` and `scan_findings` are not). `planRuleSeeding()` decides it as a `correct` action and both seeders only execute it. It is not a pattern: a rule of any other pack or version whose shipped definition changes at an unchanged version is still left alone, and a new exception needs its own ticket and its own named constant. A row with no version (an install from before 0.8.0) is not reached by it.

**A shipped rule's kind is part of its versioned definition.** A pack entry (or a RuleBeat Core definition) may declare `kind: 'advisory'`; `definitionKind()` (`lib/shipped-catalogue.ts`) is the one place a shipped entry, a stored row and a recorded version are read into a kind, so both seeders and `switchRuleVersion()` write it like any other definition field. An entry that declares no kind is a Problem, and a Logs rule is always Activity. The install cannot change a built-in's kind: `PUT /api/rules/[id]` refuses a different one and points at Duplicate. A corrected kind therefore reaches an enabled rule only when someone switches it to the version that ships it (ADR 0005, amended).

**A pack file needs an entry in `pack-manifest.json` that names its `versionScheme` and the field that version comes from** (`version`, `pinnedRelease` or `pinnedCommitDate`). Without one the pack is skipped with a warning, and its rules are never read as dropped. `scripts/sync-pack.ts` keeps the scheme and writes the commit's own timestamp as the pack's version.

**A pack sync versions each rule, not the pack.** `versionPackRules()` (`lib/pack-versioning.ts`, pure, tested with two fixture snapshots and no network) hashes each rule's definition against the previous pack file. A rule whose definition is unchanged keeps its `version`, `releaseNote` and `upstreamRef`; a changed rule gets the pinned commit's date and a note naming the changed fields. A pack entry with no `version` of its own still ships under the manifest's pack version, so a pack file written before this keeps working. Upstream never declares a `kind`, so one RuleBeat added to the previous file is carried onto the fetched entry before hashing, unless upstream now declares its own; dropping it would turn an Advisory back into a Problem under a new version (#186).

**A built-in's query is read-only everywhere, and a change to it ships as a new version.** `PUT /api/rules/[id]` answers 400 for a built-in whose body carries a different Graph query. A rule whose Graph query had been tuned before this became custom on upgrade, with the same id so its findings and suppressions stay attached.

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

**Postgres starts empty and never runs `migrate.ts`.** `lib/db/pg/bootstrap.ts` creates the full schema with `CREATE TABLE IF NOT EXISTS` and `lib/db/pg/seeds.ts` mirrors `runSeeds`' ordered sequence with `onConflict*` upserts. The SQLite migration chain stays SQLite-only, and there is no data migration between backends in either direction. A column therefore lives in five places, and a schema change is incomplete until all of them agree: `schema.ts`, `schema.pg.ts`, the `CREATE TABLE` in `migrate.ts` (a new table), the `ALTER TABLE ... ADD COLUMN` in `migrate.ts` (a new column on a table existing SQLite installs already have), and the `CREATE TABLE` in `pg/bootstrap.ts`. Once a column has shipped in a release, `pg/bootstrap.ts` also needs an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for databases bootstrapped before it existed.

Two tests hold the twins together. `tests/unit/schema-twins.test.ts` compares the tables, column names and nullability of `schema.ts` and `schema.pg.ts` through Drizzle's `getTableConfig`; the only declared difference is the pg-only `seq` column on `notification_deliveries`, `saved_queries` and `query_runs`, and any other difference fails until it is listed there with a reason. `tests/unit/pg-schema-columns.test.ts` runs only on the Postgres CI job and compares `information_schema.columns` after bootstrap with `schema.pg.ts`, which is what catches `pg/bootstrap.ts` drifting from it. `db-migrations.test.ts` covers `schema.ts` against the SQLite migration chain.

**Dialect drift is handled at the column, never the call site.** Timestamps and JSON stay `text` in the pg twin so lexicographic ordering and the row mappers are byte-identical across backends; booleans are real columns in both twins (`integer({ mode: 'boolean' })` on SQLite, `boolean` on pg); insertion-order tiebreaks resolve through the order column `tables.ts` exports (`rowid` on SQLite, a `bigserial seq` on pg), never a literal `rowid` in a repository.

**The pg bootstrap is async behind `client.ts`'s exported `dbReady` promise.** Anything touching the database outside the exec seam (test helpers, raw assertions) must `await dbReady` first or it races schema creation and fails with "relation does not exist".

## The trend record

The contract for Trend history ([ADR 0012](../decisions/0012-trend-history-records-the-inputs-to-posture.md)). Every rule here was written to keep the record equal to live state at every commit.

**Every posture input writes through the trend-record module, in its own transaction.** A scan sync, a suppression, an expiry, a rule write, a placement change and a rekey each call it inside the transaction of the action that caused them. Nothing else inserts into the trend tables; the writer allowlist test fails any other file that does.

**The record lock is taken last, after any name lock, and is held only for reads, record inserts and `trend_state` updates.** On Postgres it is one advisory lock. Taking it before the rule name lock, or holding it across a scan's Azure calls or a sync's findings upserts, is how two writers deadlock or queue the whole app behind one of them.

**A write is never dated before its key's newest row; `seq` breaks ties.** A key is a cell or a rule's facts. A clock step back, a restored clock or a late-finishing scan takes the newest row's date, not its own, so a point already read is never changed by a row inserted under it.

**A deletion writes the rule's cells to 0.** It does not delete the rule's rows, so past days still count what was open. The rule's last labels are kept as a rule fact.

**A failed write fails the action.** The record write is not wrapped in a `try { … } catch {}`; the scan, the suppression or the rule edit rolls back with it. A record that silently lagged would disagree with Scans for as long as nobody looked.

**The startup and daily recounts write only the keys that differ.** They recount from live state, and a key that already equals its newest row writes nothing, so a recount on a healthy install adds no rows. A correction is dated when the recount runs; earlier days are never rewritten.

**Retention keeps each key's newest row at or before the cutoff,** and the newest Recorded day marker older than the cutoff. Pruning to the cutoff alone would leave a key with no row for the first days inside the window and read them as 0.

**`seq` is a real column in both twins.** It is the tiebreak for rows of one key on one day. Do not take it from `rowid` on SQLite or a `bigserial` only on pg; `schema-twins.test.ts` has no declared difference for it.

**Every trend table date is TEXT, in both twins.** A Demo Reset shifts dates by rewriting text columns; a date column typed any other way is left where it was and the Demo's history stops ending today.

**`record_version` and its equality table.** Every row carries the `record_version` it was written under. A change to what is stored bumps it and adds a row to the equality table saying which versions read the same. A reader marks a day recorded under a version that does not equal the current one, and never converts it. The same table is what lets the daily posture snapshots bridge the days before recording.

**A rule-id rename covers the trend tables.** Cells and rule facts are keyed on the rule id, so a rename rewrites them with `findings`, `suppressions` and `scan_findings`. It is the one case where a past record changes. A rename that skips them strands the rule's history under an id nothing reads.

## Measuring the findings views

**A change to how findings views are read is measured with `npm run bench:views`, not guessed.** A read that got slower or heavier shows up there before a user feels it; the codebase map says how to run it.

## Measuring the trend

<!-- The medians of `bench:trend` are filled in by the bench ticket. -->
