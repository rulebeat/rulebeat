# Changelog

All notable changes to RuleBeat are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  [`docs/public/whats-next.md`](docs/public/whats-next.md).
- Log Analytics rules are not offered. The engine supports the backend, but it can only target one
  tenant-wide workspace and has no visual builder, so it is not exposed in the rule editor or the
  query page in this release.

### Notes

- RuleBeat never holds standing write credentials and never creates its own service principal or
  role assignment. It reads with a Reader credential you provide, and it never changes anything in
  your tenant.

[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/rulebeat/rulebeat/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/rulebeat/rulebeat/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/rulebeat/rulebeat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rulebeat/rulebeat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rulebeat/rulebeat/releases/tag/v0.1.0
