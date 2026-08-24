# Changelog

All notable changes to RuleBeat are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `npm run release` now leaves the working tree byte-identical when it refuses. It bumped all three
  `package.json` files and regenerated `package-lock.json` before it ever read `CHANGELOG.md`, so an
  empty `[Unreleased]` section aborted the release with a half-bumped tree, despite the documentation
  promising a refusal changes nothing.

### Changed

- Releases are now tagged only after the exact merged commit has passed CI, and the tag points at
  that commit rather than at whatever `main` points to when the workflow starts. A release that
  fails CI now costs a revert instead of a permanently burned version number.
- A release is now identified by the branch pattern, source repository, author and version together,
  not by the branch name alone, which any fork could choose. A pull request shaped like a release
  that fails those checks fails the workflow rather than being skipped silently.
- A release is refused if `[Unreleased]` is not empty at the commit being tagged, or if the release
  branch changed anything beyond the five files the release script writes. Both catch a release
  branch that drifted from the snapshot it was generated from.

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

[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/rulebeat/rulebeat/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rulebeat/rulebeat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rulebeat/rulebeat/releases/tag/v0.1.0
