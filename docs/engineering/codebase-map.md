# Key Files

> Referenced by `CLAUDE.md` but **not** `@`-imported. Read it on demand when navigating the codebase.

| File | Purpose |
|------|---------|
| `packages/core/src/types.ts` | Canonical types: `Finding`, `TenantContext`, `ScanSummary`, `Severity` |
| `packages/core/src/engine/types.ts` | Rule types: `Rule`, `Condition`, `ConditionGroup`, `RuleScope`, `RuleType` (renamed from `RuleSource`) |
| `packages/core/src/engine/kql.ts` | `buildRuleQuery`, `parseKqlToVisualQuery`, `DEFAULT_PROJECT_COLUMNS` |
| `packages/core/src/kql.ts` | Sub-path entry: client-safe re-export of KQL utilities |
| `packages/core/src/finding.ts` | `createFinding`/`computeFingerprint` (`sha256(ruleId::resourceId)`, `kind:'state'`) and `createActivityFinding`/`computeActivityFingerprint` (`sha256(ruleId::dimensionKey)`, `kind:'activity'`). Two parallel canonical fingerprint formulas, one per `RuleKind` |
| `packages/core/src/errors.ts` | `extractAzureErrorMessage()` unwraps the Azure SDK's real nested error text (`details[0].message` / `response.parsedBody.error.message`) instead of a generic `String(err)`; used by the runner's per-rule log line and `validate-kql/route.ts` |
| `packages/core/src/net/fetch-retry.ts` | `fetchWithRetry()`, `AZURE_CALL_TIMEOUT_MS` (30s, per single-shot call), `AZURE_LIST_TIMEOUT_MS` (60s, one operation-wide budget for an SDK pager). The one place a bounded timeout + `Retry-After`-aware backoff is implemented |
| `packages/core/src/index.ts` | All core exports |
| `packages/web/lib/types.ts` | Client-side type re-declarations (mirrors core, no ESM import) |
| `packages/web/lib/kql.ts` | Thin re-export of `@rulebeat/core/kql` for web use |
| `packages/web/lib/api-auth.ts` | `requireRole(action)`, the single authz guard for every API route (returns the actor, so audit writes need no param threading) + `getCurrentUser()` for server pages; `actor instanceof NextResponse` check pattern. Also blocks every action except `account:self` while `mustChangePassword` is set, mirroring `app/(app)/layout.tsx`'s page-level redirect |
| `packages/web/lib/api-error.ts` | `serverError()`/`safeErrorMessage()`: logs the real failure server-side, returns a client-safe message. Every route catching an Azure SDK error goes through it |
| `packages/web/lib/api-body.ts` | `parseJsonBody<T>()` turns malformed JSON into the same client-safe 400 every route already returns for a bad field, instead of an uncaught `req.json()` `SyntaxError` surfacing as a 500. Same `instanceof NextResponse` calling convention as `requireRole`; every mutating route uses it |
| `packages/web/lib/rbac.ts` | `Role`, `Action`, `can(role, action)`: the whole permission model, no Node/DB imports so client components share it |
| `packages/web/lib/azure-credential.ts` | **The only file allowed to construct an Azure credential.** `resolveAzureCredential()` (env → stored → chain), `createTenantContext()`, `getAzureConnectionStatus()`, `verifyAzureCredential()`, `describeCredentialFailure()`, `NO_SUBSCRIPTIONS_MESSAGE`. Everything touching Azure goes through it |
| `packages/web/lib/server-logger.ts` | `createScanLogger()`: the real `TenantContext.log` implementation `createTenantContext()` wires up (previously a no-op), writes one structured JSON line per call to stdout |
| `packages/web/lib/rule-identity-check.ts` | `checkRowsHaveIdentity()`: the identity-less-row probe shared by save-time validation (`POST/PUT /api/rules`) and `validate-kql`'s sample response, for `rawKql` rules only |
| `packages/web/lib/preflight.ts` | `runPreflight()`: "what can this credential see," 4 checks (credential/subscriptions/Resource Graph/Graph applications), every summary hand-written and client-safe. Takes an injected `TenantContext`, so it stays green under the credential chokepoint test and testable via `fakeTenantContext()`. Shared by onboarding step 2 and the diagnostics page |
| `packages/web/lib/diagnostics.ts` | `getSystemDiagnostics()` composes `getSchedulerStatus()` + `getSchemaCacheStatus()` into one client-safe `SystemDiagnostics` shape (instant local reads, no network) |
| `packages/web/app/api/diagnostics/system/route.ts` | Admin-only `GET` for local system health (scheduler + schema cache). Pair with the existing `diagnostics/preflight/route.ts` |
| `packages/web/app/(app)/diagnostics/page.tsx` | Diagnostics page, admin-only (`notFound()` gate like `/audit`), renders `DiagnosticsClient` |
| `packages/web/app/(app)/diagnostics/diagnostics-client.tsx` | Two-section diagnostic UI: Azure connectivity (manual-only, results persist to `localStorage` via `useLayoutEffect`) and System (auto-loads on mount) |
| `packages/web/components/diagnostics/preflight-checks.tsx` | Shared preflight check-list + collapsible subscription panel, used by onboarding step 2 and the diagnostics page |
| `packages/web/lib/onboarding.ts` | `getOnboardingState`/`setOnboardingState`/`isOnboardingPending`: the first-run wizard marker, one `meta` row, tolerant parse (corrupt value → `skipped`, never throws) |
| `packages/web/lib/secret-box.ts` | `encryptSecret`/`decryptSecret`: AES-256-GCM for credentials stored in the DB. Key from `RULEBEAT_ENCRYPTION_KEY`, else generated beside the database on first boot. Decrypt returns null (never throws) so a rotated key means "re-enter this", not a crash |
| `packages/web/lib/db/azure-credentials.ts` | Azure connection repository. `AzureCredentialSummary` (client-facing) **has no secret field at all**, so no handler can leak it by forgetting to strip it |
| `packages/web/lib/arm.ts` | `getArmCredential`/`getArmToken`/`getArmTenantId`/`armFetch`: a thin layer over the resolver; deliberately takes no tenant id |
| `packages/web/app/api/settings/azure-connection/` | `route.ts` (GET status / PUT save+verify / DELETE) + `test/route.ts` (verify typed-but-unsaved values, or whatever is live). Admin-only, audited |
| `packages/web/app/(app)/settings/azure-connection-section.tsx` | Settings → Azure connection. When env supplies the credential the form is not rendered at all. The card names the exact variables and files to edit instead |
| `packages/web/tests/unit/azure-credential-chokepoint.test.ts` | Architecture test: no file outside `lib/azure-credential.ts` may construct a credential, call `buildTenantContext()` bare, or read `AZURE_CLIENT_SECRET` |
| `packages/web/lib/db/users.ts` | Users repository + `getDefaultRole`/`setDefaultRole` (meta-backed); last-admin protection lives in `updateUserRole`/`deleteUser` |
| `packages/web/lib/db/audit.ts` | `writeAudit` (synchronous, never throws, because a failed audit must not fail the operation), `listAuditEntries`, `changedFields()` |
| `packages/web/lib/provision-user.ts` | `provisionUser()`: JIT user creation, invite-by-email oid linking, first-sign-in-wins admin bootstrap |
| `packages/web/lib/sign-in-config.ts` | `getSignInStatus`/`resolveSignInConfig`/`buildProviders`/`authorizeLocalAccount`: the sign-in equivalent of `azure-credential.ts`, one resolution order (env → Settings → Sign-in row). The Entra app registration used for sign-in is independent of the Azure connection's; either can optionally reuse the other's stored credential |
| `packages/web/lib/redirect-uri.ts` | `redirectUriFor(origin)`: the one place the Entra redirect URI string is built. Client-safe (no server imports) so both `sign-in-section.tsx` and the onboarding Connect step call it directly instead of duplicating the template |
| `packages/web/app/(app)/settings/sign-in-section.tsx` | Settings → Sign-in card: tenant/client id/secret fields, the reuse-Azure-connection checkbox, local sign-in policy (`always`/`break-glass`/`disabled`) |
| `packages/web/app/signin/` | `page.tsx` (server, reads `getSignInStatus()`) + `signin-client.tsx`: the Microsoft button shows as soon as sign-in is configured, not gated on `isActive`/verified — a bad config surfaces as `?error=` here instead |
| `packages/web/lib/fetch-json.ts` | `fetchJson<T>()` returns a `FetchResult<T>` (`{ok:true,data}` \| `{ok:false}`) instead of storing an error body as data or collapsing failure to null; every self-fetching widget goes through it |
| `packages/web/types/next-auth.d.ts` | Session augmentation carrying `user.oid` (the JWT needs none, since Auth.js types it as `Record<string, unknown>`) |
| `packages/web/app/(app)/settings/users-section.tsx` | Admin-only Users card: roles, invite-by-email, default role for new sign-ins |
| `packages/web/app/(app)/audit/audit-client.tsx` | Admin-only audit log viewer, expandable detail rows |
| `packages/web/lib/severity.ts` | `SEVERITY_ORDER`, `emptySeverityCounts()`: canonical severity ordering, shared by scan-runner/dashboard-data/snapshots |
| `packages/web/lib/rule-description.ts` | `splitLearnMore()` splits a rule description's optional trailing `\nLearn more: <url>` marker into text + link |
| `packages/web/lib/toggle-set.ts` | `toggleInSet()`: shared add/remove toggle for `Set`-based filter state |
| `packages/web/lib/rules.ts` | `loadRules`/`saveRules`/`isNameTaken`/`duplicateRule`/`allTagsFromRules`: the SQLite repository layer. `setRulesEnabled(ids, enabled)` is a single `UPDATE ... WHERE id IN (...)`, deliberately not `saveRules()` (delete + reinsert), for onboarding step 3's bulk toggle. `listRuleSummaries()` is the light `{id,category,severity,enabled}` projection that feeds it, never the full `Rule[]` with KQL/visual-query blobs |
| `packages/web/lib/builtin-rules.ts` | 13 built-in rules, fixed literal UUID `id` each (no `builtin::` prefix), seeded on startup |
| `packages/web/lib/rule-filters.ts` | `matchesRuleSearch()`: shared search predicate used by both Library and Scans |
| `packages/web/components/ui/checklist-dropdown.tsx` | Shared `ChecklistPanel` portal behind two triggers: `ChecklistDropdown` (toolbar) and `ColumnFilterIcon` (table column funnel) |
| `packages/web/app/(app)/library/page.tsx` | Library server page. Reads the `sidebar:library` cookie server-side so sidebar pin state renders correctly on first paint |
| `packages/web/app/(app)/library/library-client.tsx` | Library UI: collapsible secondary sidebar, read-only status/tag chips (tag *editing* only happens on the rule's own page), page-level scroll (no bounded inner scrollbox). Rule creation (`New rule`) lives here only |
| `packages/web/components/rules/tag-picker.tsx` | Multi-select tag chip picker, `lockedTags?` for non-removable system chips; used only in the rule form (Library shows read-only chips) |
| `packages/web/data/packs/aprl-v2.json` | 143 APRL v2 reliability policies (committed, version-pinned); `id` is the bare upstream APRL guid |
| `packages/web/data/packs/pack-manifest.json` | Pack registry: source, license, attribution, pinned commit |
| `scripts/sync-pack.ts` | Generic pack sync runner |
| `scripts/packs/aprl-v2.ts` | APRL v2 pack transform |
| `tsconfig.scripts.json` | TS config for `scripts/` (Node types, path alias for web types) |
| `packages/web/lib/db/schema.ts` | Drizzle schema: `rules`, `scans`, `suppressions`, `dashboards`, `categories`, `findings`, `finding_events`, `schedules`, `schedule_runs`, `posture_snapshots`, `azure_credentials`, `meta` |
| `packages/web/lib/db/client.ts` | Opens the connection and exports `db`. Thin by design: it calls `runMigrations` then `runSeeds` from `./migrate` at import time, and that order is asserted by the upgrade tests |
| `packages/web/lib/db/migrate.ts` | `openDatabase`/`runMigrations`/`runSeeds`: every schema change and seed the app applies on startup, extracted from `client.ts` so they can be run against a database other than the live one. **Statement order is load-bearing:** a `RENAME COLUMN` must precede the `ADD COLUMN` that would otherwise create the same name and strand the old column's data |
| `packages/web/lib/db/categories.ts` | Category repository CRUD (builtin-protected) |
| `packages/web/app/globals.css` | **The only source of colour in the app.** Grid design tokens, defined twice (light + dark) and exposed via Tailwind 4 `@theme inline`; `--radius: 0px`; the `label-grid`/`numeral-grid`/`scroll-x`/`scroll-y`/`scroll-both` utilities. See the Design system note in `CLAUDE.md` before adding a colour |
| `packages/web/lib/theme.ts` | `ThemePreference`, `THEME_COOKIE`, `DARK_CLASS`, `THEME_INIT_SCRIPT`: React-free and Node-free so server, client and the edge/proxy bundle can all import it. Cookie-based (not localStorage) so the server can stamp `.dark` before the first byte |
| `packages/web/components/theme/theme-provider.tsx` | Client theme context. Writes the cookie, applies `.dark`, listens to the OS `prefers-color-scheme` change while the preference is `system` |
| `packages/web/components/theme/theme-toggle.tsx` | Light/Dark/System control in the sidebar footer |
| `packages/web/components/layout/sidebar.tsx` | Sidebar: light in light, dark in dark (the old dark-navy-on-light-body rail is gone); collapsible via `useSidebarPref`; single static "Dashboards" entry, switching/creation lives in `DashboardTabs` instead |
| `packages/web/components/layout/header.tsx` | Page header |
| `packages/web/components/ui/card.tsx` | Card primitives: hairline border, hard corners, no shadow (only floating things get `--shadow-overlay`) |
| `packages/web/components/ui/switch.tsx` | Square toggle. "On" is a solid ink fill, never the accent red, because switches are everywhere and red means "wrong". `disabled` fades to 75%, not 50%: in read-only mode every switch on the page is disabled and still has to be readable |
| `packages/web/components/ui/button.tsx` | Button variants. `default` is a solid **ink** fill (deliberately not the accent red, see the Design system note); `outline` is the workhorse; `destructive` is the only red one |
| `packages/web/components/ui/select.tsx` | Value-picking dropdown, `@base-ui/react`: portalled, repositions on scroll, returns focus |
| `packages/web/components/ui/dropdown-menu.tsx` | Action menu (row `⋯`, export, widget menu), `@base-ui/react`. Distinct from Select: a Select holds a value, a menu performs actions |
| `packages/web/components/ui/popover.tsx` | Shared anchored-panel primitive, the target for the pickers that still hand-roll portals |
| `packages/web/components/ui/dialog.tsx` | Shared modal primitive on `@base-ui/react/dialog` (`Dialog`/`DialogPortal`/`DialogBackdrop`/`DialogViewport`/`DialogPopup`/`DialogTitle`/`DialogClose`). Focus trap, Escape and focus-return for free; `NewDashboardDialog` and `SlideOverPanel` are built on it |
| `packages/web/components/ui/input.tsx` | Text input / textarea / search field |
| `packages/web/components/ui/callout.tsx` | Info/warn/error/success message block. Reserved for problems or actionable detail. A normal state gets a quiet chip, never a filled panel |
| `packages/web/components/ui/code-block.tsx` | Monospace block for KQL and shell snippets |
| `packages/web/components/ui/toggle-chip.tsx` | Filter/segment chip |
| `packages/web/components/ui/table.tsx` | Table primitives: `table-layout: fixed` + a `<colgroup>` driven by `useResizableColumns`. A `max-width` on a `<td>` does nothing here; width comes from the colgroup |
| `packages/web/components/scans/run-status-dot.tsx` | Shared run-status marker (success/partial/error/running): one map, previously written inline on two screens and already drifted |
| `packages/web/components/findings/severity-badge.tsx` | Severity chip, encoded by weight rather than a hue rainbow |
| `packages/web/components/findings/category-badge.tsx` | `CategoryBadge`: unboxed identity swatch + name (a category is a label, not a measurement, so it gets no filled tint), used by Scans results/rules/history |
| `packages/web/components/dashboard/dashboard-constants.ts` | `CATEGORY_COLORS`/`CATEGORY_LABELS` plus `CHART_TICK`/`CHART_LEGEND_STYLE`. Chart chrome belongs to the design system, not to each widget, and recharts never inherits theme colour for ticks or legends |
| `packages/web/app/layout.tsx` | Root layout: Inter (body) + Inter Tight (display) + IBM Plex Mono (data), all self-hosted by `next/font`; reads the theme cookie and stamps `.dark` server-side, plus the pre-paint `THEME_INIT_SCRIPT` for `system`; `generateMetadata()` for title/description/`metadataBase`; renders `MinWidthGuard` as a sibling of `children` |
| `packages/web/components/layout/min-width-guard.tsx` | Fixed full-viewport overlay, CSS-shown only below 1024px (`max-[1023px]:flex`), covering body-level portals a wrapper-hides-children approach would miss |
| `packages/web/app/not-found.tsx` | Branded 404, covering both explicit `notFound()` calls and genuinely unmatched routes |
| `packages/web/app/error.tsx` | Client component error boundary for uncaught render errors within a route segment. Uses `unstable_retry()`, and renders no server error detail |
| `packages/web/app/global-error.tsx` | Fallback for a fatal error in the root layout itself. Defines its own minimal `<html>`/`<body>`, no dependency on `globals.css` or font loading |
| `packages/web/lib/metadata-base.ts` | Resolves the absolute origin relative metadata images (the OG card) are served against: `AUTH_URL`, else the request's own forwarded origin. Extracted from the layout so it is testable without fonts and CSS |
| `brand/` | Brand master kit + `source/build.py`, which regenerates it **and writes** the eight files the app serves (`app/favicon.ico`, `app/icon.png`, `app/apple-icon.png`, `app/opengraph-image.png`, `public/brand/*.png`). Never hand-edit those eight; re-run the script |
| `packages/web/components/modules/scans-client.tsx` | Unified Scans UI: `RunScanButton` + Results/Run History/Rules tabs; category is a filter, never a route |
| `packages/web/components/modules/scan-history-tab.tsx` | Run History tab: cross-category run list, drill-down, `ScanCompare` |
| `packages/web/lib/hooks/use-resizable-columns.tsx` | `useResizableColumns`: drag-to-resize column state; `flexCol` names the column that absorbs leftover width |
| `packages/web/lib/hooks/use-sidebar-pref.ts` | `useSidebarPref`: pin/hover-flyout state, cookie-persisted (not localStorage) so server render matches client on first paint |
| `packages/web/lib/hooks/use-widget-fetch.ts` | `useWidgetFetch<T>()` owns loading/failed/data plus a monotonic request id to discard stale responses; `retry()` is scoped to the one widget, not the dashboard-wide `refreshKey` |
| `packages/web/components/scans/target-picker.tsx` | `TargetPicker`: All/Categories/Tags/Rules selector shared by Run Scan and schedules |
| `packages/web/components/scans/run-scan-button.tsx` | `RunScanButton` popover → `POST /api/scans/run` |
| `packages/web/lib/run-executor.ts` | `executeTarget()`: shared execution core for manual and scheduled runs |
| `packages/web/lib/target-describe.ts` | `describeTarget()` turns a target into a human-readable string |
| `packages/web/lib/db/findings.ts` | `findings`/`finding_events` repository: `syncScanFindings()`, `listFindings()`, `deleteFindingsForRule()`, `getFindingEventCounts()` |
| `packages/web/components/findings/scan-compare.tsx` | `ScanCompare`: added/fixed/persisted diff between two scans |
| `packages/web/app/(app)/rules/[id]/rule-detail-client.tsx` | Rule detail: view/edit toggle, builtins always read-only. Owns Save button (top status bar, beside Edit) via `saveHandleRef`; `RuleForm` reports `dirty`/`saving` up so Save is only active with real unsaved changes |
| `packages/web/app/(app)/rules/new/page.tsx` | New rule form. `?copyFrom=<id>` pre-fills it (duplicate-as-draft) |
| `packages/web/lib/schema-cache.ts` | Schema cache read/write + `COMMON_RESOURCE_TYPES` |
| `packages/web/lib/db/snapshots.ts` | `upsertDailySnapshot`, `getSnapshots`/`getBaselineSnapshots`, `backfillSnapshots`. See the Dashboards architecture note in `CLAUDE.md` |
| `packages/web/lib/date-window.ts` | `DateWindow` type + `resolveDateWindow()`, which resolves at query time, not save time |
| `packages/web/lib/dashboard-filters.ts` | `WidgetFilters` type + `mergeWidgetFilters()`, where per-widget replaces and never intersects |
| `packages/web/lib/dashboard-data.ts` | `queryActiveFindings`/`computeWidgetSummary`. See the Dashboards trend-limits note in `CLAUDE.md` |
| `packages/web/lib/dashboard-templates.ts` | `STARTER_DASHBOARD`, shared by seed and restore-from-empty |
| `packages/web/lib/scans-link.ts` | `buildScansHref()`: the one shared click-through builder every widget uses |
| `packages/web/lib/dashboard-migrations.ts` | `migrateDashboardConfig()` rewrites deleted widget types and renamed metric ids on every read |
| `packages/web/app/(app)/dashboard/page.tsx` | Redirect: `/dashboard` → default dashboard, or `/dashboards` gallery if none exist |
| `packages/web/lib/db/dashboards.ts` | Dashboard CRUD. Delete is always allowed, and promotes the oldest remaining to default |
| `packages/web/app/(app)/dashboards/dashboards-gallery.tsx` | Manage-all-dashboards page |
| `packages/web/components/dashboard/dashboard-tabs.tsx` | Horizontal tab strip: default-first, `+` to create, "Manage" opens the gallery |
| `packages/web/components/ui/date-range-picker.tsx` | `DateRangePicker`: shared 24h/7d/30d + custom-range popover |
| `packages/web/components/dashboard/dashboard-filter-bar.tsx` | Dashboard-level filter bar, debounced persist |
| `packages/web/app/(app)/dashboards/[id]/dashboard-grid-client.tsx` | Multi-dashboard grid client: react-grid-layout, edit mode, merges filters into every widget fetch |
| `packages/web/components/dashboard/widget-config-panel.tsx` | Shared `ScopeSection` config drawer rendered for every widget type |
| `packages/web/components/dashboard/slide-over-panel.tsx` | `SlideOverPanel`: shared right-drawer shell used by `add-widget-panel.tsx` and `widget-config-panel.tsx` |
| `packages/web/components/dashboard/widgets/delta.tsx` | Shared `Delta` trend indicator (Up/Down/flat), used by the stat-card and posture-ring widgets |
| `packages/web/components/dashboard/widgets/` | 12 widget types. Every one self-fetches a `mergeWidgetFilters`-merged `WidgetFilters` via `useWidgetFetch` |
| `packages/web/components/dashboard/widgets/widget-unavailable.tsx` | Shared "Couldn't load this widget" + Retry state, distinct from each widget's own empty-result copy |
| `packages/web/components/dashboard/widgets/recent-findings-widget.tsx` | Replaces the old findings-table + findings-explorer widgets |
| `packages/web/app/api/widgets/` | Widget data APIs: `/summary`, `/filter-options`, `/findings`, `/top-rules`, `/top-resources`, `/rules` |
| `packages/web/lib/explorer-data.ts` | `buildExplorerData()`. Recency (new/active/fixed) is computed in the client, not here; see `getRecencyStatus()` in `findings-explorer-client.tsx` |
| `packages/web/components/findings/findings-explorer-client.tsx` | `FindingsExplorerClient`: the Results tab of `/scans`. `getRecencyStatus()` computes new/active/fixed from elapsed time, not "the previous scan"; `initialFilters`' URL-sync effect must stay symmetric with `scans/page.tsx`'s `searchParams` |
| `packages/web/lib/explorer-filters.ts` | `ExplorerFilterState` + `getRecencyStatus()`/`isWithinRange()`: the Results-tab filter predicate pulled out of the component into a plain, closure-free function so it can be unit-tested and compared against the dashboard's own `queryActiveFindings` instead of trusting two hand-written predicates to stay in sync |
| `packages/web/app/api/categories/route.ts` | `GET` list + `POST` create categories |
| `packages/web/app/api/categories/[id]/route.ts` | `GET`/`PUT`/`DELETE` single category; builtin DELETE returns 403 |
| `packages/web/app/api/scan/[category]/route.ts` | Legacy dynamic scan route. Still works, but unused by the UI |
| `packages/web/app/(app)/scans/page.tsx` | Single Scans page. Reads all `/scans` query params, renders `ScansClient` once |
| `packages/web/app/api/scans/run/route.ts` | `POST`: ad-hoc "Run Scan" trigger, fire-and-return-202 (now also returns `requestedAt`, server clock). `GET ?since=`: most recent run, for `use-run-progress.ts` to poll |
| `packages/web/lib/hooks/use-run-progress.ts` | `useRunProgress()` polls `GET /api/scans/run?since=` every 2s, with a 10-minute timeout state |
| `packages/web/app/api/rules/bulk/route.ts` | `PATCH`: `{enable?, disable?}` id lists, `setRulesEnabled()` under the hood, one audit row per batch not one per rule |
| `packages/web/app/api/diagnostics/preflight/route.ts` | `GET`, admin-only: `runPreflight()` behind `createTenantContext()` |
| `packages/web/app/api/onboarding/route.ts` | `GET`/`PUT` (`action: 'step'\|'skip'\|'complete'`) for the onboarding marker |
| `packages/web/app/onboarding/` | The first-run wizard: `page.tsx` (server, guards), `onboarding-client.tsx` (step state/chrome), `steps/{connect,preflight,scope,scan}-step.tsx` |
| `packages/web/components/ui/stepper.tsx` | Presentational step-progress indicator, used only by the onboarding wizard |
| `docs/public/permissions.md` | The Azure permissions guide: create the service principal, grant Reader, optionally grant Graph `Application.Read.All`. CLI + Portal for each step. Linked from onboarding steps 1 and 2 |
| `packages/web/app/(app)/settings/settings-client.tsx` | Settings UI: Categories CRUD (sign-in, Azure connection, users) |
| `packages/web/components/modules/schedules-tab.tsx` | Schedules tab UI: recurrence builder + target picker; lives in the Scans page (`?tab=schedules`) |
| `packages/web/lib/db/schedules.ts` | `Schedule` type + CRUD + `computeNextRun()`, a cron-free recurrence engine |
| `packages/web/lib/schedule-target.ts` | `resolveRulesForSchedule`/`resolveCategoriesForSchedule` |
| `packages/web/lib/scheduler.ts` | In-process scheduler: 30s tick loop, wraps `run-executor.ts`'s `executeTarget()` |
| `packages/web/lib/db/notification-channels.ts` | Notification channel address book: encrypted URL storage, `NotificationChannelSummary` (no URL), `recordChannelResult()`, `rowToStoredChannel()`. `deleteChannel()` cascades its `notification_deliveries` history |
| `packages/web/lib/db/schedule-notification-channels.ts` | Junction repo: `listLinksForSchedule`, `setLinksForSchedule`, `deleteLinksForSchedule`, `getChannelsForSchedule` (used by dispatcher) |
| `packages/web/lib/db/notification-deliveries.ts` | Per-attempt delivery history: `recordDelivery()`/`listDeliveriesForChannel()`/`deleteDeliveriesForChannel()`, capped at 50 rows per channel (oldest pruned) |
| `packages/web/lib/notifications/dispatch.ts` | `dispatchNotifications(run, newFindings)` reads the schedule's channel list, per-channel severity filter, scheduled runs only. `sendWithRetry()` retries transient failures up to 3 total attempts with 2s/8s backoff; a 4xx is never retried |
| `packages/web/lib/notifications/format.ts` | Per-type payload builders: Teams Adaptive Card, Slack Block Kit, generic JSON webhook |
| `packages/web/app/api/settings/notifications/route.ts` | Notification channel CRUD: `notifications:manage`, all verbs audited |
| `packages/web/app/api/settings/notifications/test/route.ts` | "Send test": saved channel (`{id}`) or typed-but-unsaved (`{type, url}`) |
| `packages/web/app/api/settings/notifications/history/route.ts` | `GET ?channelId=`: recent delivery attempts for one channel, `notifications:manage` guard |
| `packages/web/app/(app)/settings/notifications-section.tsx` | Settings → Notifications card: channel list, add/edit form, per-row send-test, "View history" expandable panel (lazy-fetched, explicit empty state) |
| `packages/web/lib/scan-runner.ts` | `runCategoryScan()`: shared scan execution path for manual and scheduled runs |
| `packages/core/src/engine/graph-runner.ts` | `runGraphRules()`: standalone Microsoft Graph engine, per-rule `try/catch` isolation, `'capped'` on `GraphTruncatedError` |
| `packages/web/lib/graph-rule-validation.ts` | `validateGraphQueryShape()`/`isAllowedGraphPath()`: server-side enforcement of the 7-path Graph resource allowlist, the real security boundary |
| `packages/web/lib/schedule-runs.ts` | Unified runs repository (manual + scheduled), powers Run History |
| `packages/web/lib/scan-history.ts` | `saveScanResult`/`getScanById`/`getScansForRun`/`listScanMetas` |
| `packages/web/app/api/schedules/` | CRUD + `[id]/run` (manual trigger) + `[id]/runs` (history) |
| `packages/web/app/api/rules/validate-kql/route.ts` | Validate KQL against ARG, return sample rows |
| `packages/web/app/api/rules/validate-graph/route.ts` | Validate a Graph query, mirroring `validate-kql`; `GraphTruncatedError` is a capped success, only a `Graph API 400:` message unwraps to something actionable |
| `packages/web/components/findings/findings-table.tsx` | Expandable findings table with evidence + remediation |
| `packages/web/components/findings/export-button.tsx` | CSV/JSON export with dynamic evidence columns |
| `packages/web/components/rules/rule-form.tsx` | Rule form. `readOnly` prop for view mode; KQL pane + Visual Builder, bidirectional sync via `parseKqlToVisualQuery`. Dirty-tracked by diffing a snapshot (scalar fields + generated `kqlFromGui`, never raw `visualQuery`, see the KQL lesson on parser id churn) against a `useRef` baseline; editing an existing rule saves via `router.refresh()`, never navigates away |
| `packages/web/components/rules/visual-query-builder.tsx` | Visual KQL Builder: 34 operators, `readOnly` wraps in `pointer-events-none` |
| `packages/web/components/rules/graph-rule-editor.tsx` | Directory rule editor: resource-type picker, `$filter` input, Validate action, "Flag expiring items" expand-config card |
| `packages/web/components/rules/field-combobox.tsx` | Portal-based property autocomplete |
| `packages/web/components/rules/scope-tree-picker.tsx` | Hierarchical MG+subscription scope picker |
| `packages/web/components/rules/resource-type-input.tsx` | Badge-based resource type picker |
| `packages/web/lib/schema-fetch-status.ts` | `classifySchemaStatus(ok, status)`: pure function turning a schema-route HTTP response into `'ok' \| 'not-found' \| 'unavailable'`, so `rule-form.tsx`'s multi-type check can tell a genuinely-schemaless type from an unreachable Azure |
| `packages/web/app/api/azure/scope-tree/route.ts` | ARM hierarchy endpoint, full MG→sub tree |
| `packages/web/app/(app)/suppressions/page.tsx` | Suppressions management page |
| `packages/web/app/(app)/suppressions/suppressions-client.tsx` | Suppressions table, active/expired grouping |
| `packages/web/instrumentation.ts` | Startup hook. Mirrors the configured public URL into `AUTH_URL` (must stay the first thing that imports `lib/sign-in-config`, which is where the operator's own value is captured), warms schema cache, runs backfills, starts the scheduler |
| `packages/web/lib/schema-warmer.ts` | Background cache warmer |
| `packages/web/auth.ts` | NextAuth config |
| `packages/web/proxy.ts` | Route protection (Next.js 16 renamed `middleware.ts` → `proxy.ts`) + `fixCallbackUrlOrigin`. Its `matcher` is the list of paths that never reach the guard. Filename exclusions need `[.]` and `$`, since Next drops `\.` while compiling; pinned by `tests/unit/proxy-matcher.test.ts` against Next's own compiler |
| `packages/web/components/dashboard/widgets/activity-occurrences-widget.tsx` | 12th dashboard widget: single-series bar chart of `getActivityOccurrenceCounts()`, daily counts for `kind:'activity'` findings. Excluded from `dashboard-templates.ts`'s starter dashboard and from Top Resources, since activity findings carry no `resourceId` |
| `packages/core/src/clients/log-analytics.ts` | `queryLogAnalyticsWorkspace()` wrapping `@azure/monitor-query-logs`'s `LogsQueryClient`; `LogAnalyticsTruncatedError` (PartialFailure) / `LogAnalyticsNotConfiguredError` (no workspace set) |
| `packages/web/lib/log-analytics-workspace.ts` | `resolveLogAnalyticsWorkspaceId()`: env (`RULEBEAT_LOG_ANALYTICS_WORKSPACE_ID`) then the single stored active row, no third ambient-chain fallback (unlike the Azure credential, a workspace id can't be discovered). `LogAnalyticsWorkspaceStatus` feeds the Settings card and diagnostics |
| `packages/web/lib/db/log-analytics-workspace.ts` | Workspace repository: `getActiveLogAnalyticsWorkspace`/`saveLogAnalyticsWorkspace`/`markLogAnalyticsWorkspaceVerified`, single-active-row invariant |
| `packages/web/app/api/settings/log-analytics-workspace/route.ts` | Admin-only (`azure:manage`) `GET`/`PUT`/`DELETE`: GUID validation, "managed by env" 409 guard, verify-before-persist, audited |
| `packages/web/app/(app)/settings/log-analytics-section.tsx` | Settings → Log Analytics card, same shape as the Azure connection card |
| `packages/core/src/engine/law-runner.ts` | `runLawRules()`: the third scan engine (ARG, Graph, now LAW), a structural mirror of `graph-runner.ts`: per-rule `try/catch`, `success\|failed\|capped` outcomes, always yields `kind:'activity'` findings via `createActivityFinding()`. A blank `dimensionKeyField` value on a row downgrades that rule's outcome to `'invalid'` |
| `packages/web/lib/log-analytics-rule-validation.ts` | `validateLogAnalyticsQueryShape()`: client- and server-side (`validate-logs/route.ts`) shape check for a Log Analytics rule's KQL |
| `packages/web/app/api/rules/validate-logs/route.ts` | `rules:validate`. Runs a Log Analytics rule's query, with the same `capped`/not-configured/generic three-way error handling `runLawRules()` uses |
| `packages/web/components/rules/log-analytics-rule-editor.tsx` | Log Analytics rule editor: KQL textarea + `dimensionKeyField` config |
| `packages/web/lib/rule-form-payload.ts` | `deriveDedicatedEditorFields()`: the one shared gate `rule-form.tsx`'s two save-payload blocks both call to decide which fields apply per backend; extracted after the two blocks drifted when Log Analytics became a third backend (see the lesson in `conventions/ui.md`) |
| `packages/web/app/(app)/query/page.tsx` + `packages/web/components/query/query-client.tsx` | `/query`: ad hoc workbench against all three backends, reuses the `rules:validate` action rather than a new one. Backend switcher, ARG visual↔KQL sync (same driver-ref pattern as the rule builder), save/load, "Save as rule" via `sessionStorage` handoff to `/rules/new` |
| `packages/web/app/api/query/` | `run-resource-graph`/`run-microsoft-graph`/`run-log-analytics` (one route per backend, each `rules:validate`) + `saved`/`saved/[id]` (CRUD) + `runs` (`GET` history) |
| `packages/web/lib/db/query-runs.ts` | `recordQueryRun()`/`listQueryRuns(ownerId)`: per-user run history, `MAX_RUNS_PER_OWNER = 20` oldest-pruned. A deliberate reversal of the original plan, which had scoped this to client-side `sessionStorage` only |
| `packages/web/lib/db/saved-queries.ts` | `getSavedQuery()`, on the schema's first per-user-owned table; returns `null` for both a nonexistent row and an existent-but-private-to-someone-else one, so a direct lookup 404s rather than 403ing (see the lesson in `docs/engineering/conventions/data.md`) |
| `packages/web/lib/query-to-rule.ts` | `buildRuleFromQuery()` converts a query-page snapshot into a draft `Rule` for the "Save as rule" flow |
| `vitest.config.mts` | Two projects (`core`, `web`), both `node` env, since browser behaviour is Playwright's job rather than jsdom's. `.mts` because the root package isn't ESM. Web project is `fileParallelism: false` (shared DB singleton) |
| `packages/web/tests/setup.ts` | Sets `RULEBEAT_DB_PATH` to a temp file **before** any repository import. `lib/db/client.ts` connects at import time, so nothing later can redirect it |
| `packages/web/tests/helpers/fake-azure.ts` | `fakeTenantContext()`, with no mocking library needed since `queryARG` is already injectable via `TenantContext`. Its `credential` throws, so a test can't reach real Azure |
| `packages/web/tests/helpers/db.ts` | `resetDb()` clears mutable tables only. `rules`/`categories`/`dashboards` are seeded on import by private functions, so wiping them yields a state no install is ever in |
| `packages/web/tests/unit/route-guards.test.ts` | Architecture test: reads every `app/api/**/route.ts` off disk and fails if one skips `requireRole` or under-guards a mutating verb. Adding a route means adding the guard |
| `packages/web/tests/unit/require-role-matrix.test.ts` | Exhaustive role × action matrix for `can()` in `lib/rbac.ts`: every action against every role, not just the paths individual route tests happen to exercise |
| `packages/web/tests/unit/api-body-safety.test.ts` | Confirms every mutating route that accepts a body goes through `parseJsonBody()` rather than a bare `req.json()`, and that malformed JSON yields the client-safe 400 rather than an uncaught 500 |
| `packages/web/tests/unit/cross-surface-filters.test.ts` | Asserts `lib/explorer-filters.ts`'s Results-tab predicate and `lib/dashboard-data.ts`'s `queryActiveFindings` agree on the same finding set for equivalent filters. The two were previously separate hand-written implementations that could silently diverge |
| `packages/web/tests/unit/finding-lifecycle-matrix.test.ts` | Exhaustive new/active/fixed classification matrix for `getRecencyStatus()` against elapsed-time boundaries, independent of any specific scan sequence |
| `packages/web/tests/unit/schedules-recurrence.test.ts` | `computeNextRun()` recurrence-engine cases against the hand-written Outlook-style date math in `lib/db/schedules.ts`, not cron |
| `packages/core/tests/kql-roundtrip.test.ts` | All 34 operators generate→parse→regenerate. Asserts *stability* (repeat cycles don't drift), not just operator equality. `it.fails` markers are known, still-unfixed bugs. The marker asserts the test currently fails, so a fix forces its removal |
| `packages/core/tests/graph-pagination.test.ts` | Microsoft Graph pager pagination: page-token continuation, timeout budget across pages |
| `packages/core/tests/resource-graph-pagination.test.ts` | ARG pagination: `$skipToken` continuation, the 1,000-subscription batching split, truncation detection feeding `capped` outcomes |
| `packages/web/tests/fixtures/db-shapes.ts` | Five sample databases in the shapes older versions left behind (`policies-era` … `current`). Builders, not committed `.db` files, because content has to be *derived* (a suppression's fingerprint must really be `computeFingerprint(...)` or the test asserts nothing) |
| `packages/web/tests/fixtures/upgrade.ts` | `upgradeInProcess` (fast, used everywhere) and `upgradeViaStartup` (spawns a process and imports `client.ts` for real). The golden suite asserts the two produce identical databases. That equivalence is what lets every other upgrade test use the fast path |
| `packages/web/tests/unit/db-migrations*.test.ts` | The upgrade path: data survival, the individual rename/backfill/id-rewrite mechanics, interrupted upgrades, idempotency. Assertions are all "the content is still there", never "it didn't throw" |
| `packages/web/tests/unit/db-migrations-golden.test.ts` | Snapshots what an upgrade produces for each shape. A deliberate behaviour change is *supposed* to diff here; an unexplained diff means something moved that shouldn't have |
| `.github/workflows/ci.yml` | build → typecheck (both) → test → JUnit artifact → build core+web for production → Playwright e2e (Chromium, cached, against the production build) → traces on failure, on every push/PR. `npm run lint` deliberately excluded (a backlog of pre-existing errors, tracked separately) |
| `packages/web/playwright.config.ts` | Two `next start` servers spun up per `global-setup.ts` (temp SQLite db, seeded admin via `scripts/seed-e2e.ts`), torn down by `global-teardown.ts` (kills the whole process tree, not just the spawned pid, because a bare `shell:true` child leaves `next start`'s node process orphaned otherwise) |
| `packages/web/scripts/seed-e2e.ts` | Seeds a throwaway e2e database with a known admin login before the Playwright servers start |
| `packages/web/tests/e2e/` | 6 specs (`auth`, `rules`, `suppressions`, `users-rbac`, `demo-mode`, `scans-tabs`) + `fixtures.ts`/`helpers.ts`. Runs against real `next start`, no mocked Azure. `generate-demo`'s synthetic tenant supplies the data |
| `.github/workflows/publish-image.yml` | Builds the Docker image and pushes `ghcr.io/rulebeat/rulebeat` on `v*.*.*` tags or manual dispatch. The source repo stays private, only the built image is public. First push creates the GHCR package as private by default; flip it to public by hand once, in GitHub's package settings |
| `.github/workflows/prepare-release.yml` | Stage 1 of cutting a release: manual dispatch, runs `release.mjs` on a throwaway branch, drops the local tag it creates, opens a `release: vX.Y.Z` PR. Nothing is tagged or published from this workflow |
| `.github/workflows/tag-release.yml` | Stage 2: fires when a `release/v*` PR merges into `main` (the merge is the approval gate). Re-verifies the version/CHANGELOG agree, then creates and pushes the `vX.Y.Z` tag that `publish-image.yml` listens for |
| `scripts/verify-release-version.mjs` | Refuses to promote a tagged release whose version disagrees with `package.json` (root/core/web) or `CHANGELOG.md`. Called by `publish-image.yml` on every real version tag, before anything else runs, and by `tag-release.yml` before it tags at all |
| `scripts/release.mjs` | `npm run release -- <patch\|minor\|major>`: bumps all three `package.json` files and `package-lock.json` together, moves `CHANGELOG.md`'s `[Unreleased]` content under a new dated header, commits, and tags. Never pushes. Runnable standalone or as `prepare-release.yml`'s stage 1 |
| `scripts/release-smoke-test.sh` | Runs `release.mjs` for real against a scratch fixture repo: real npm bump arithmetic, a regenerated lockfile verified with `npm ci`, the commit and annotated tag, the dirty-tree refusal, and the atomicity scenarios (an empty or malformed `[Unreleased]` must leave the tree byte-identical and `HEAD` unmoved) |
| `scripts/check-release-candidate.mjs` | Two pure checks the release pipeline used to take on trust: is this really a release PR (exact `release/vX.Y.Z`, same repo, expected author, matching version -- a branch name alone is not an identity), and is the candidate well formed (manifests and newest header agree, `[Unreleased]` empty at the tagged commit, the branch's own diff touches only the five release files). Called by `tag-release.yml` before it tags, and by `ci.yml` in `--candidate-only` mode on a release branch |
| `scripts/check-changelog-entry.mjs` | The changelog gate: fails a PR that changes shipping files without adding an `[Unreleased]` bullet. Parse-and-compare rather than diff-hunk parsing, so a rebase or a reflowed bullet is not mistaken for a new entry. Changed paths come from the merge base (`--no-renames`); `[Unreleased]` is compared against the *current* base, so inheriting someone else's bullet via a merge does not count. Unknown paths default to shipping |
| `scripts/check-changelog-entry.test.mjs` | `node:test` cases for it, including the shipping-file-into-docs rename, deletion, the merged-base-entries trap, and that `packages/web/public/brand` ships while top-level `brand/` does not |
| `.github/workflows/pr-checks.yml` | Fast fork-safe PR checks, separate from `ci.yml` because the `labeled`/`unlabeled` triggers the `no-changelog` escape hatch needs would otherwise re-run the ~10 minute build on every label change. Deliberately has no `paths:` filter: a required check whose workflow never runs blocks PRs forever |
| `.github/pull_request_template.md` | The Lane B four-line frame plus the changelog checkbox |
| `scripts/check-release-candidate.test.mjs` | `node:test` cases for both, including that a fork branch named `release/v0.3.0` is rejected rather than skipped |
| `scripts/release-bump-changelog.test.mjs` | `node:test` cases for `bumpChangelog()` and `updateChangelogFooterLinks()`, including fixtures built from the repo's own real `CHANGELOG.md` |
| `scripts/verify-release-version.test.mjs` | `node:test` cases for `checkReleaseVersion()` |
| `CHANGELOG.md` | Keep a Changelog format. `[Unreleased]` is the running record every behaviour-changing PR adds a line to; `release.mjs` moves it under a dated header at release time |
| `docs/engineering/conventions/releases.md` | The release/CHANGELOG conventions, each written after something broke |
