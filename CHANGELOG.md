# Changelog

All notable changes to RuleBeat are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed

- The old `POST /api/scan/<category>` and `POST /api/scan/identity` routes are gone. They started a scan outside the scan lock and left no entry in Run History. Use `POST /api/scans/run`, which every part of the console already uses.

### Fixed

- A rule condition whose value contains `//`, such as a URL, now survives being opened in the visual builder. The parser used to treat everything after `//` as a comment even inside a quoted value, so saving the rule from the builder wrote broken KQL. A real `//` comment outside any quoted value is still ignored.
- A rule with an empty resource type list now checks every resource type, the same as `*`. It used to generate a query with an empty `type in~ ()` filter that Resource Graph rejects.
- Starting a scan with an unknown `targetType` now answers 400 before anything runs. A scan that fails to start after the request was accepted is now logged instead of failing silently.
- Saving, creating or deleting one rule now writes only that rule. Before, every save rewrote the whole rules table from a copy read earlier, so two people editing different rules at the same time could undo each other's change, and a scan finishing during a save could lose the rules' last run status. Deleting a rule now removes its findings in the same step, so a failure part-way can no longer leave findings for a rule that is gone. Adding or removing a suppression now writes only that suppression, for the same reason.
- Creating or saving a rule with no name, a blank name, or a name that is not text now answers 400 with "A rule needs a name." instead of a server error.
- Moving a rule to another category no longer leaves its old findings open forever. Findings the rule stops returning are now resolved on its next successful scan, whichever category they were recorded under. Findings already stuck this way are resolved the next time that rule runs.
- Two admins demoting or deleting each other at the same moment can no longer leave the install with no admin; one of the two changes is refused. Deleting a user now removes their private saved queries, their query history and the user together, or none of them if something fails part-way.

### Security

- The column names in findings and query result CSV exports are now encoded the same way as the cells below them. A column name taken from resource data or a query can no longer split the header row or be read by a spreadsheet as a formula.
- Local sign-in now limits how many password checks run at once. When too many arrive together, the sign-in form asks you to try again in a minute instead of queueing them. The 5-attempt lockout is applied in one step, so attempts sent at the same time all count toward it. A failed sign-in takes the same time whether or not the account is locked, and sign-in passwords over 1024 characters are rejected without being checked.
- Signing in with Microsoft now clears a local account's lockout, so a user locked out of their password after 5 wrong attempts can use it again straight away instead of waiting 15 minutes.
- A Microsoft Graph rule's expansion array field must now be a plain property name: letters, numbers and underscores, starting with a letter. Saving a rule with any other value is refused, and a stored rule with one is reported as failed when it runs instead of being sent to Graph.
- CSV exports of the audit log, findings and query results now put an apostrophe in front of any text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return, so a spreadsheet shows it as text instead of running it as a formula. A cell containing a carriage return is now quoted, so it can no longer split a row.
- Webhook and email notifications now connect only to the address that was checked as public, and each send, including each retry, checks it again. IPv6 addresses that carry an IPv4 address inside them (NAT64 and 6to4) are checked against that IPv4 address, and Teredo addresses are refused. "Send test" and scheduled notifications now send the same way.
- An email notification now tries the mail server's other checked addresses when the first one cannot be reached, giving each address 10 seconds to accept the connection. It moves on only when the connection itself failed, so a rejected login or recipient is never retried elsewhere. Two more IPv6 address forms that are never public destinations (`::a.b.c.d` and `100::/64`) are now refused for webhooks and mail servers.
- Every page, the sign-in page included, now carries a Content-Security-Policy that only runs scripts RuleBeat rendered itself, using a new random value for each request. Requests that arrive over HTTPS now get `Strict-Transport-Security` for one year, without `includeSubDomains` or `preload`. If a browser extension or a reverse proxy that injects scripts stops working, `RULEBEAT_CSP=off` drops the script policy and keeps the other headers.
- A request that changes anything is now refused with 403 when its browser `Origin` matches neither the address the browser used to reach RuleBeat nor the configured public URL, so another site cannot make a signed-in browser submit changes. Requests with no `Origin`, such as scripts and `curl`, are unaffected. Routes that read a JSON body now require `Content-Type: application/json` and answer 415 otherwise.

## [0.7.1] - 2026-10-05

### Fixed

- Rescanning a resource no longer resolves its finding and opens a new one when Azure returns the resource id with different casing, for example a resource group name in capitals on one scan and in lowercase on the next. Azure resource ids are case-insensitive, and findings now match them that way. On upgrade, existing findings, their history and suppressions move to the new matching on both SQLite and Postgres, so finding ages are kept and suppressions keep working. Findings that were already split in two by this are merged back into one, keeping the earliest first-seen date.

## [0.7.0] - 2026-10-02

### Added

- The Rules tab can enable or disable many rules at once. Select rules with the checkboxes, or select every rule the current filters show, then use the action bar. Each button counts only the selected rules it would change, and a rule the filters hide is never part of the action. Editors and admins see the checkboxes; viewers see the list as before.

### Removed

- Applies to is removed. Rules that used it now show a plain count of affected resources, and their Applies to definitions are deleted on upgrade. Creating or updating a rule with `appliesTo` now returns an error.

### Fixed

- The enable switch on the Rules tab now changes only when the change was saved. If saving fails, the switch stays where it was and the tab shows why.

## [0.6.0] - 2026-09-28

### Changed

- The published image now includes the demo data generator. A container started with `RULEBEAT_DEMO=1` generates its Demo on first start, keeps it as a snapshot in the data volume, and restores that snapshot on every later start, so a restart returns the Demo to its starting state. `RULEBEAT_DEMO_DATASET` and `RULEBEAT_DEMO_SEED` choose what is generated. A Demo refuses to start on Postgres or against a database that is not a Demo database. The Docker health check now allows three minutes for a first start.
- A Demo is now writable and shared. Every Visitor is signed in automatically as the same admin and can create and edit rules, run scans, suppress findings, and change schedules, dashboards and notification channels. The Azure connection, sign-in configuration and users are Locked surfaces: visible, but refused with the reason. A Demo records every notification as not sent instead of sending it, and "Send test" answers that it is a Demo. `/signin` redirects to the console in a Demo.
- A Demo now resets itself. Every hour by default, on the clock, it returns to its starting state and moves its history forward so it ends at the Reset, keeping every finding's age. A Reset waits for a running scan. `RULEBEAT_DEMO_RESET_MINUTES` sets the interval (`0` turns it off), `RULEBEAT_DEMO_RECORDING=1` hides the Demo bar and turns the timer off, and `rulebeat-demo reset` inside the container resets it now. The Demo bar shows when the next Reset is and tells a returning Visitor once that earlier changes are gone. `/api/health` answers 503 until a Demo has its data.
- Run now works in a Demo. It scans the synthetic estate the Demo was generated from, and a rule the Demo has no data for fails with a reason that says so.

### Dependencies

- Updated `drizzle-orm` from 0.45.2 to 0.45.3.
- Updated `lucide-react` from 1.47.0 to 1.48.0.
- Updated `nodemailer` from 9.0.5 to 10.0.10.

## [0.5.1] - 2026-09-27

### Security

- Next.js is upgraded from 16.3.2 to 16.3.5, which fixes two critical remote code execution vulnerabilities in Next.js itself: CVE-2026-75604, which affects servers hosted on Windows, and GHSA-2xp9-vwfh-vxw4, in the image optimization endpoint when AVIF files are served. The Docker image failed its vulnerability scan on 16.3.2. No configuration change is needed.

### Dependencies

- Updated `@azure/identity` from 4.13.2 to 4.13.3.
- Updated `@base-ui/react` from 1.7.0 to 1.8.0.
- Updated `lucide-react` from 1.33.0 to 1.47.0.
- Updated `react` from 19.2.8 to 19.3.0.
- Updated `react-dom` from 19.2.8 to 19.3.0.
- Updated `tailwind-merge` from 3.6.0 to 3.7.0.

## [0.5.0] - 2026-09-05

### Added

- A rule's findings can now be cleared without deleting the rule, built-in rules included. A Clear findings control on the Scans page's Rules tab (editor and admin) deletes every finding the rule produced, active and fixed, with their history, keeps the rule, and writes an audit entry naming the rule and the count. Disabling a rule stops it being scanned but leaves its findings counted, since only a rule that ran can resolve its own findings, so a rule that turned out to be wrong had no way out before. Suppressions, past runs and past trend days are untouched (issue #98).

### Fixed

- A rolling deploy, where the old and new container overlap for up to a minute, no longer runs a due schedule twice, sends the same notification batch twice, or reports the old container's live scan as crashed. A due schedule is now claimed with one conditional database update before its scan starts, a notification batch is claimed the same way before it is sent, a running scan records a heartbeat every 30 seconds and recovery only reaps a run whose heartbeat is five minutes old, and the PostgreSQL schema bootstrap takes an advisory lock so two first boots cannot collide. Recovery of interrupted runs and unsent notifications now also runs on every scheduler tick, not only at startup. One consequence: a scan interrupted by a crash is reported as not completed and its schedule waits for the next occurrence instead of re-running at boot. Existing run history is untouched; the three new `schedule_runs` columns are added on upgrade and read as stale for old rows (issue #88).

## [0.4.0] - 2026-09-02

### Added

- The sign-in page shows the running version under the sign-in panel, the same value the sidebar footer and Diagnostics show after signing in, so checking that an upgrade took no longer needs a sign-in first (issue #92).
- `RULEBEAT_DATABASE_BACKEND` names the storage backend on purpose: `postgres` refuses to start when the connection string is missing, with the reason in the log, instead of silently booting a SQLite database inside the container that the next restart deletes; `sqlite` refuses a connection string. Unset keeps today's selection by `RULEBEAT_DATABASE_URL`, so existing installs are unaffected. The boot log now prints one `[startup] storage:` line naming the active backend, and the Diagnostics page shows the same under System, with host, port, database and user for Postgres or the file path for SQLite, never the password (issue #91).

### Changed

- Every environment variable RuleBeat reads is now explained once, in a reference table at the top of `docs/public/configure.md` with a "required when" column, and `.env.example` is a short index that points into that table instead of repeating the explanations. `docs/public/install.md` gains an Azure Container Apps walkthrough for the portal that names the variables a deployment with no data volume must set (`AUTH_SECRET`, `RULEBEAT_ENCRYPTION_KEY`, `RULEBEAT_INITIAL_PASSWORD`) and how to produce the values without a local terminal. `SCAN_HISTORY_LIMIT` was the one variable missing from `.env.example` and is now listed.

### Fixed

- The onboarding wizard can now be completed with a managed identity. With only `AZURE_TENANT_ID` set and no service principal, the Connect Azure step showed the service principal form and kept Continue disabled, so the only way out was "Skip for now" and the Finish button was never reachable. The step now recognises the host's managed identity (or a local `az login` session), says there is nothing to enter, and offers the same Verify button an environment-supplied credential gets (issue #89).

## [0.3.0] - 2026-09-02

### Added

- CI now proves the Postgres backend on every change: the whole web test suite runs a second time against a real PostgreSQL 17 service, and the backend parity suite grew to cover rules with their KQL, users, dashboards and suppressions alongside the findings lifecycle. docker-compose.yml gains an optional `postgres` profile, off by default so the single-container SQLite install is unchanged, with a matching `RULEBEAT_DATABASE_URL` entry in .env.example (issue #73, phase 3).

- The whole app now runs on PostgreSQL: every database repository and every caller through the pages and API routes is asynchronous, so setting RULEBEAT_DATABASE_URL runs scans, dashboards, schedules, auth and audit against Postgres, not just the spike's three repositories (issue #73, phase 2). The SQLite default is unchanged and needs nothing.

- The PostgreSQL backend now creates the complete schema and seeds the same built-in content as a fresh SQLite install: built-in rules, external pack rules, categories, the starter dashboard, onboarding state and the initial local admin account with its printed first password. The app itself still needs the remaining repository sweep before it fully runs on Postgres (issue #73, phase 1).

- Groundwork for an optional PostgreSQL backend (issue #73, Phase 0 spike). RuleBeat can now open
  either its built-in SQLite database (the default, unchanged) or a PostgreSQL database named by
  the new `RULEBEAT_DATABASE_URL` setting (`RULEBEAT_DATABASE_URL_FILE` for Docker secrets). In
  this phase only the meta, findings and notification repositories run on both backends; the rest
  of the app still requires SQLite and fails loudly if pointed at Postgres. Leave the variable
  unset and nothing changes. Adds one runtime dependency to the web package: `pg` (node-postgres).

### Changed

- Install and upgrade commands in the README and docs pin the exact release version again,
  instead of `:latest`. The release script now rewrites the pinned tags in the same commit that
  bumps the version, and a test fails the build if any doc names `:latest` or a stale version,
  so the pins cannot go stale the way they did before 0.2.4.

### Dependencies

- Added `@types/pg` 8.23.1.

## [0.2.4] - 2026-08-25

### Changed

- Documentation overhaul ahead of launch: the README rewritten around the current product,
  install and configure commands given in both bash and PowerShell, every screenshot retaken
  from synthetic data, a recorded product walkthrough, and install commands now reference the
  image as `:latest` so they do not go stale between releases.

### Fixed

- The onboarding access check now reports a credential that fails to authenticate as a failing
  check. Resolving the credential happens before any individual check runs, so a bad client
  secret made the whole endpoint answer with one generic server error, and the verify-access
  step showed "Failed to run preflight checks" instead of the per-check list it exists to
  render. That failure now comes back as a normal result: the credential check fails with the
  same actionable wording used everywhere else, the checks that never ran say why they were
  skipped, and the raw Azure error still goes only to the server log.
- Opening a dashboard no longer shows a "Save changes" button nobody earned. The grid reports
  machine-made position changes through the same callback as a person's drag: the mount-time
  compaction of the stored layout, the automatic fit-to-content pass, and the reset right after
  Cancel. The 300ms window meant to filter those out lost the race whenever two of them
  overlapped, which a fresh load with a dozen widgets does routinely. Unsaved-changes tracking
  is now gated on edit mode, the only place dragging and resizing exist at all.

## [0.2.3] - 2026-08-25

### Fixed

- Microsoft sign-in could not be configured at all from the documented install. That install binds
  to 127.0.0.1, so the redirect URI shown in Settings and in onboarding used that address, and
  Microsoft rejects a redirect URI on an IP address. Both places now show the localhost form and
  say what else has to match, instead of an address no app registration can accept.
- Opening a brand-new database no longer fails with `database is locked` when several processes
  race to be the first. SQLite refuses the losing side of its WAL conversion immediately, before
  the configured busy timeout is ever consulted, so the loser now retries the conversion instead
  of dying on it. In practice the loser was one of `next build`'s parallel workers inside the
  Docker image build, which failed the whole build often enough that releases could need a manual
  CI re-run before they could be tagged.
- Signing in no longer lands on `http://0.0.0.0:3000` when no public URL is configured. The
  standalone server the Docker image runs rebuilds every request's address from the address it
  binds to, so with `AUTH_URL` unset, the post-sign-in redirect, the sign-in error redirect and
  the redirect URI sent to Microsoft all named an address no browser can be on. The real address
  still arrives with every request, so it is now restored before sign-in reads it. This also
  makes an install behind a reverse proxy honour `X-Forwarded-Host` without setting `AUTH_URL`,
  though setting the public URL explicitly is still the recommended configuration.

## [0.2.2] - 2026-08-25

### Fixed

- The container image is now built against the dependency versions the manifests declare. The
  build stage copied only the top-level `node_modules`, so a dependency npm placed inside
  `packages/web` was absent while the app was compiled and resolution fell back to whatever
  compatible copy happened to sit at the top level. `nodemailer` resolved this way to 8.0.11, a
  package pulled in indirectly by something else, rather than the 9.0.5 the manifest pins, and
  that is the copy the build traced into the image. Anyone relying on email notifications was
  running a different version of it than the release notes described.

### Security

- Corrects the 0.2.1 release note. That release recorded a nodemailer update to 9.0.5 for upstream
  header and CRLF injection fixes, but the image it produced resolved nodemailer to 8.0.11 and so
  did not contain them. The build defect responsible is the one fixed above. This is the first
  image that carries the 9.0.5 the manifest pins. If you have email notifications configured and
  are running 0.2.1, upgrade.

### Dependencies

- Updated `@azure/arm-resources-subscriptions` from 2.1.0 to 3.0.0.

## [0.2.1] - 2026-08-24

### Security

- Updated nodemailer to 9.0.5, which includes upstream fixes for header and CRLF injection in
  outgoing mail (List-* header comments, DKIM tags, parsed addresses) and hardened STARTTLS
  socket handling.

### Changed

- Updated better-sqlite3 (SQLite engine to 3.53.4), `@azure/arm-resources`, and
  `@azure/arm-resourcegraph` to their current major versions, plus the routine npm minor/patch
  group (`@auth/core`, `@azure/identity`, Next.js, React, and others).

## [0.2.0] - 2026-08-24

### Added

- Settings → Sign-in (and the onboarding Connect Azure step) can reuse the Azure connection's
  app registration for Microsoft sign-in instead of registering a second one, when the two are
  meant to share credentials.
- A concrete deployment example in `docs/public/configure.md`: running RuleBeat as an Azure
  Container Instance behind Application Gateway, with VNet isolation and an Azure Files volume
  for persistent storage.

### Changed

- The sidebar footer shows the running version instead of a "Community / Free plan" badge, which
  implied a pricing tier RuleBeat does not have.

### Fixed

- The Microsoft sign-in button now appears on the sign-in page as soon as sign-in is configured,
  instead of staying hidden until a first sign-in had verified it (previously reachable only
  through an undiscoverable `/signin?test=1` link).
- A local (non-Entra) sign-in now updates the account's last-seen time, so a local admin who signs
  in regularly no longer shows as "Never signed in" in Settings → Users.
- Two em dashes removed from product-facing copy (the sign-in `AccessDenied` error and the
  onboarding scope step), per the no-em-dash rule.
- A `database is locked` failure that could hit startup migrations under concurrent access (for
  example, `next build`'s parallel page-data-collection workers all opening a brand-new database
  file at once). Several seed transactions read before writing without acquiring SQLite's write
  lock up front, which could lose a WAL-mode retry race that `busy_timeout` alone doesn't cover.

## [0.1.0] - 2026-08-22

First public release.

### Added

- Rule-based Azure scanning, manual and scheduled, with a recurrence engine (once, hourly,
  daily, weekly, monthly) targeting by category, tag, or specific rule. Every run records a
  per-rule outcome (success, failed, capped, or invalid) and a complete/partial coverage badge
  instead of treating a failed query as "nothing found".
- Two kinds of check: Resource configuration rules run against Azure Resource Graph; Directory
  rules run against Microsoft Graph for checks about the directory itself (app registrations,
  service principals, and other object types your permission allows), through a separate engine
  with per-rule failure isolation.
- 158 checks out of the box: 15 written for RuleBeat plus 143 from the
  [Azure Proactive Resiliency Library](https://azure.github.io/Azure-Proactive-Resiliency-Library-v2/)
  (APRL), pinned to a named upstream commit. A fresh install enables 12 of them so the first scan
  is a useful signal, not a wall of findings.
- A visual rule builder backed by real Resource Graph KQL, round-tripping between the visual
  builder and raw KQL; anything the builder cannot express is kept verbatim as a read-only
  passthrough rather than dropped. Directory rules get an OData filter and a "flag expiring items"
  pattern with severity-by-days bands. Optional "Applies to" populations show findings as
  "3 of 40 affected" instead of a bare count. See
  [`docs/public/authoring-rules.md`](docs/public/authoring-rules.md).
- Five seeded categories (compliance, cost, security, identity, reliability), each with its own
  "X of Y passing" posture from live findings rather than one blended score. A rule counts as
  passing only when it has no active findings and its last run succeeded. Categories are
  configurable, not fixed.
- 12 dashboard widget types (posture ring, trend lines, top rules and resources, severity
  breakdown, new-vs-fixed velocity, coverage and freshness, and more), assembled into dashboards
  you can filter, rearrange, duplicate, and delete, including the default one.
- A findings lifecycle (new, active, fixed) derived from elapsed time against live data, not a
  diff between scan snapshots, with suppressions (reason and optional expiry) and CSV/JSON export.
- Notifications to Microsoft Teams, Slack, generic webhooks, or email, configured per schedule
  with a severity threshold and optional category/subscription scope, with retry/backoff and a
  per-channel delivery history.
- Local accounts plus optional Microsoft Entra ID sign-in; three roles (viewer, editor, admin)
  enforced on every API route, with an audit log covering every mutation.
- A first-run onboarding wizard and an admin diagnostics page covering Azure connectivity,
  scheduler liveness, and schema-cache health.
- Light and dark themes, following the OS by default, with fonts served from your own install.
- Read-only demo mode for trying RuleBeat against synthetic data with no real Azure access.

### Not yet

- Guided remediation is not built. A finding shows the rule's own recommendation text and, for
  APRL rules, a link to Microsoft's upstream guidance. See
  `docs/public/whats-next.md` (a page later retired).
- Log Analytics rules are not offered. The engine supports the backend, but it can only target one
  tenant-wide workspace and has no visual builder, so it is not exposed in the rule editor or the
  query page in this release.

### Notes

- RuleBeat never holds standing write credentials and never creates its own service principal or
  role assignment. It reads with a Reader credential you provide, and it never changes anything in
  your tenant.

[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/rulebeat/rulebeat/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/rulebeat/rulebeat/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rulebeat/rulebeat/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/rulebeat/rulebeat/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/rulebeat/rulebeat/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rulebeat/rulebeat/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rulebeat/rulebeat/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/rulebeat/rulebeat/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/rulebeat/rulebeat/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/rulebeat/rulebeat/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/rulebeat/rulebeat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rulebeat/rulebeat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rulebeat/rulebeat/releases/tag/v0.1.0
