# Every surface that reads Azure data or findings

Inventory for issue #261 (map #254), taken from `main` on 2026-10-13. For each surface: what it
reads, the scope filter it applies today, and the file.

Nothing filters by person today. `users.scope` exists and is never read; every `requireRole` call
checks role only. The only ownership filtering is on saved queries and query runs. All Azure reads
use one app-wide identity.

## Where Resource Graph gets its subscriptions
- `lib/azure-credential.ts` `createTenantContext()` → core `buildTenantContext()`; with no
  `subscriptionIds` it calls `listAccessibleSubscriptions(credential)` (everything the identity sees).
- `ResourceGraphClient.query` (`packages/core/src/clients/resource-graph.ts`): explicit
  `scope.subscriptions`, else `scope.managementGroups`, else the tenant-wide list.
- Scans pass `rule.scope` (`packages/core/src/engine/runner.ts`): the rule's scope, not a person's.
- `ctx.graphGet` and `ctx.queryLogs` take no scope.

## (A) Live Azure surfaces
| Route | Reads | Filter today | Action |
|---|---|---|---|
| api/query/run-resource-graph POST | user KQL, rows | optional body scope, else tenant-wide | rules:validate |
| api/query/run-microsoft-graph POST | user Graph path | none | rules:validate |
| api/query/run-log-analytics POST | user Logs KQL, rows | none (one workspace) | rules:validate |
| api/rules/validate-kql POST | user KQL + `take 5`, samples with sub/RG | none | rules:validate |
| api/rules/validate-graph, validate-logs POST | 5 samples | none | rules:validate |
| api/rules POST, rules/[id] PUT | identity/shape probe, pass/fail only | none | rules:write |
| api/azure/subscriptions, management-groups, scope-tree GET | ARM lists | none | read |
| api/resources/types, properties; api/schemas | provider metadata + caches | none | read / schemas:refresh |
| api/diagnostics/preflight; settings/azure-connection/test; settings/log-analytics-workspace; onboarding | credential checks | none | azure:manage |

## (B) Findings and derived data (no person filter anywhere)
| Route | Repo function | Tables |
|---|---|---|
| api/findings/view, rows, group, column-values, export | `lib/db/finding-views.ts`, `lib/export-stream.ts` | findings, finding_rows |
| api/widgets/findings, top-resources, top-rules, advisories, filter-options, summary, rules | `lib/dashboard-data.ts`, `computeWidgetSummary`, `lib/advisories-widget-data.ts` | findings, finding_events, posture_snapshots, scans, rules |
| api/scans/[id]/snapshot (+export), api/scans/compare (+export) | `lib/db/scan-snapshots.ts`, `lib/db/scan-compare.ts` | scans, scan_findings, findings, finding_rows |
| api/scans/run GET/POST | `listAllRuns`, `runManualTarget` | schedule_runs |
| api/schedules, schedules/[id], [id]/runs | `lib/schedule-runs.ts` | schedule_runs, schedules |
| api/rules, rules/[id]/versions | `lib/rules.ts` | rules |
| api/rules/[id]/findings DELETE | `deleteFindingsForRule` | findings |
| api/suppressions GET/POST, [id] DELETE | `lib/suppressions.ts` | suppressions |

Server pages loading data directly: `scans/page.tsx` (findings, scan history, runs, schedules,
channels, suppressions, rules), `library`, `rules/[id]`, `rules/new`, `dashboards*` (config only),
`suppressions`, `audit` (audit:read), `settings`.
Other readers: `lib/db/findings.ts` (`listFindings`, `listFindingSummaries`,
`getFindingsByFingerprints`, `getFindingEventCounts`, `getActivityOccurrenceCounts`,
`loadFindingRows*`), `lib/db/snapshots.ts`, `lib/db/scan-blob-history.ts`, `lib/explorer-data.ts`.

## (C) Ownership
- saved_queries: owner, `private`/`shared`, scope JSON. Private reads as 404 to others; delete owner-only.
- query_runs: owner-only.
- saved_views: `created_by`/`updated_by` attribution only, unfiltered.
- dashboards, categories, rules, schedules, notification_channels: no owner.

## (D) Scheduler, notifications, exports, audit
- Scheduler: `instrumentation.ts` → `lib/scheduler.ts` → `lib/run-executor.ts` → `createScanContext`
  → `runCategoryScan`. Records `scans.subscriptions_scanned`.
- Notifications (`lib/notifications/dispatch.ts`): teams, slack, webhook, email. Per schedule×channel
  filter on min severity, categories, subscription ids. Admin-configured.
- Exports: findings, snapshot, compare (read); audit export (audit:read).
- Audit entries embedding data: suppression create/delete (resource id), rule.clear_findings,
  query.run (row count), scan.run, schema refresh, connection test.

## (E) Location stored on findings
- findings: subscription_id (NOT NULL), resource_group, resource_id, resource_type, location,
  dimension_key, kind. No management group, tenant or workspace column.
- scan_findings: also subscription_id and resource_group. posture_snapshots: (category,
  subscription_id, date). finding_events, finding_rows: join on fingerprint.
- Graph and Logs findings store `ctx.subscriptionIds[0] ?? ''` (`graph-runner.ts`, `law-runner.ts`).
  Logs findings record no workspace.
