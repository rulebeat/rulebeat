# Changelog

All notable changes to RuleBeat are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Rules now have a Kind, Problem or Advisory. An Advisory rule reports something worth knowing that is not a misconfiguration to fix now, such as a VM size Azure is retiring. Choose the kind in the rule form of a custom rule. A built-in rule's kind is set by RuleBeat as part of the rule's version and cannot be changed; duplicate the rule to run it as a different kind. Its findings are tracked with the same age, resolution and suppressions as any finding, appear on a new Advisories tab on the Scans page, and are left out of posture, the Results tiles and the dashboard counts. The Rules tab and the Library show each rule's kind. Switching a rule's kind moves its existing findings with it and keeps their age and suppressions. Log Analytics rules stay Activity.
- Notification channels have an Include advisories setting, off by default, and off for every channel that already exists. A channel with it on also receives the new Advisory findings from scheduled runs, in their own Advisories section of the email, Teams, Slack and webhook message with a link to the Advisories tab. The webhook JSON gets a separate `advisories` field and its other fields do not change. Problems and Activity go to every channel as before, a channel with the setting off gets exactly the message it got before, and suppressed Advisories are never sent. A scheduled run whose only new findings are Advisories now notifies the schedule's channels that include them.
- A dashboard can now show an Advisories widget. It lists open Advisories with rule, resource, severity and when each was last seen, most severe first and then most recently seen, follows the dashboard filters and its own Scope, and a row opens the Advisories tab. Its empty state says whether no Advisory rule is enabled or the enabled ones have nothing open, and a failed load shows Couldn't load this widget instead. Advisories still never count in any other widget.
- RuleBeat now ships a Service retirements rule, an Advisory in the Reliability category that is enabled on a fresh install. It reads the Azure Advisor recommendations for services and features Azure is retiring and reports one Advisory per affected resource. Every retirement is kept: a recommendation with no feature name is labelled with its problem text, and the retirement date is shown when Advisor gives one. Advisor's retirement coverage is incomplete and covers the public cloud only, and the rule's recommendation says so and points to the Azure updates retirements page. A pack rule can now declare its kind, which is part of the rule's version: a new version that changes it reaches an enabled rule only when you switch the rule to that version, and a disabled rule moves to it on its own. Syncing a pack from upstream keeps the kind declared on each of its rules. The rule is added on upgrade and enabled, so the Reliability category gains it on the next scan. You can disable it, or duplicate it to count retirements as problems. It does not count in posture or any problem count.
- A finding now keeps every distinct row its rule's query returned for it, not just the last. A row that repeats another in every column is kept once. A rule that returns two retirements for one VM, or three failing node pools for one cluster, gives one finding that lists all of them in query order, on the Results tab, in Run History and in the exports (the CSV has one line per row). Every row is kept however many there are; a finding with more than 20 rows shows them 20 to a page. The finding keeps the same identity, age, suppressions and resolution as before: it is fixed when the rule succeeds and returns no row for the resource. Counts do not change. This upgrade adds one column to findings and changes no existing data; a finding saved before it reads as one row until its next scan.
- A scheduled run now notifies when an open finding gains a row, such as a second retirement appearing on a VM that already had one. The email, Teams, Slack and webhook message gets a separate Changed section listing each changed finding and the rows it gained, and the webhook JSON gets a `changed` field while its other fields do not change. The assignment's scope and minimum severity apply, suppressed findings are left out, a changed Advisory goes only to channels that include advisories, and manual runs still never notify. A row that goes away sends nothing. When a rule's run is capped, failed or invalid, nothing is recorded for it and its findings keep the rows from the rule's last complete run, which the next complete run is compared against. Each added and lost row is recorded with the finding's events. This upgrade adds one column to finding events and one to scheduled runs and changes no existing data.

- Run History's compare of two runs now reads from the server, a page of 50 at a time, so comparing runs with tens of thousands of findings opens as fast as a small one. The three tiles, Added, Fixed and Persisted, show their counts at once and pick which side the table lists, and the export downloads every finding on that side as CSV or JSON, streamed. The page says why there is nothing to show when a run was not found, the two runs are of different categories, or a run from an earlier version has no stored findings, which is never reported as everything added or fixed. The side and page are in the address (`compareSide`, `comparePage`), and an older `?compare=` link opens the same comparison on the Added side. This upgrade changes no existing data.

- The Results and Advisories tabs can now keep a view under a name that everyone on the install can open. The new Views button saves the current filters, search, window, columns, sort and grouping (not the page), lists the saved views for the tab you are on, and opens one with a click. Editors and admins can save, update, rename and delete a saved view, viewers can open them, and a name is unique whatever its case. Each change is recorded in the audit log by field name only. This upgrade adds one table and changes no existing data.

- The Results and Advisories tabs can now show, filter and sort by any field a rule's query returned, not only the built-in columns. Pick fields in the new Columns menu in the By resource view, then use a column header to sort it or filter by its values. An Add filter button in the toolbar filters by any built-in field or returned field, and every active filter shows as a chip you can remove. The header filters on Resource, Rule, Category, Severity and First seen are part of the view now, so they are kept in the address and a link reproduces them. Empty values sort last in both directions, and the whole view (filters, columns, sort and page) is kept in the address so a link reproduces it. A finding's resource name now sorts last when empty instead of first. The address no longer double-encodes spaces and other characters, and a hand-written link with a bare `%` opens. The Advisories widget uses the same engine and looks the same.
- The Results and Advisories tabs can now group by one or more fields, built-in or returned by the rules, with the new Group by menu in the By resource view. Groups nest in the order you pick, each group shows its value, how many resources it holds and how many rows, and opening the last group lists its resources, 50 to a page with their own pager. A resource with rows in two groups appears under both, and rows with no value go in a No value group that always comes last. Groups sort by value or by resource count, ascending or descending. Sorting by severity keeps any value outside critical to info last in both directions. The top-level groups are paged too, and the grouping, its sort and the page are kept in the address (`group` and `gsort`), so a link reproduces the view. Grouping the Service retirements rule by its retiring feature and then its retirement date rebuilds the Azure Advisor retirement workbook. Counts, tiles and exports do not change, and with no grouping the list looks as it did.
- Every scan now also stores one short record per finding: its rule, severity, title, kind, category, resource, subscription and how many rows it held, as that scan saw them. A past run will keep reporting what it reported when a rule is later renamed or re-graded, and a deleted rule's records stay. Nothing on screen changes yet, the stored scan is kept as before, and moving back to the previous release loses nothing. Old scans go with their records when history is trimmed. This upgrade adds one table and one column to scans and, on its first start, converts every stored scan one scan at a time, so that start is slower on a large history. A scan that cannot be read is skipped with a message naming it in the log, is left as it was, and is tried again on the next start. A database that returns from the previous release has its newer scans converted on the next start.
- A past run's findings now open from the server, 50 at a time, instead of loading the whole scan into the page. The list can be filtered by severity and rule, searched by resource name, rule name, type and resource id, and exported in full as CSV or JSON, and a finding that still exists links to the live finding on its own tab. Every finding the scan returned is listed, including suppressed ones. A run that has aged out, an older run whose stored findings could not be read at upgrade, one that returned none and a failed load each say so. The filters, search and page are in the address.

### Changed

- A new Demo ships Missing Environment Tag switched off, with no findings and no history, and the Demo has data for it. A Visitor can switch it on and run a scan, and the run finishes successfully with the rule moving from unknown to passing or failing. Every other rule that starts switched off still has no data behind it. With `RULEBEAT_DEMO_RECORDING=1`, a partial run no longer names the Demo in its message and shows the same one a real install does.
- Posture and finding counts now share one definition of which rule kinds they include.
- Findings from Logs (Activity) rules no longer count in the Results tiles and severity breakdown, the By rule counts, the Rules tab's resources affected, or the dashboard's stat cards, recent findings, top rules, top resources, New vs Fixed and daily snapshots. They already did not count toward posture, so every count now agrees with it. They still appear in the Results table and the Activity Occurrences widget. If you have Logs rules, the open findings line on the trend chart may drop once on the day you upgrade. Nothing was fixed; earlier days were counted the old way and are not rewritten.
- Findings from Logs (Activity) rules now have their own Activity tab on the Scans page, beside Results and Advisories, and the Results tab lists only Problems, so its table matches its tiles. The Activity tab lists each pattern with when it was last seen and how many times, filters, sorts, groups, exports and keeps saved views like the other two, and has no Fixed status, tile or column, since activity is never fixed. Its empty state says whether no Logs rule is enabled, the enabled ones have not run, one did not complete, or they found nothing. A link from a scan comparison opens a finding on the tab that lists it.
- The Scans page and the dashboard send less data, so they load faster with many findings. The Run History, Rules and Schedules tabs no longer load every finding, and the dashboard widgets and filter lists no longer read finding rows they never show. Nothing on screen changes.
- A finding's rows are now stored in their own table, one record per row, which is what lets later releases page, group and filter findings on the server. This upgrade adds one table and two columns to findings, copies every finding's rows into the table, and checks that the copy matches exactly before the app reads from it. If the check fails, the app keeps reading the rows where they were before and tries the copy again on the next start. It changes no existing data, and the rows are still also saved where they were before, so going back to the previous release loses nothing. On SQLite the database keeps more of itself in memory, up to 64 MB of cache and a 256 MB memory map.
- The server can now answer a Results or Advisories view itself: a page of findings or groups, the tiles, the filter counts, the By rule rows and the returned columns, all from one consistent read, plus a finding's further rows, one group's contents and one returned column's values. Each scan now also keeps a list of the fields each rule has ever returned, so a column only a fixed finding had stays on offer. This upgrade adds one table, builds that list once from the rows already stored, and changes no existing data.
- The Results and Advisories tabs read each view from the server instead of loading every finding with the page, so they open and respond quickly with many findings. A column's filter list, a group's findings and a finding's further rows load when you open them, and each says so when it cannot load rather than showing an empty list. After you start a scan, the tab reads its findings again in place instead of refreshing the whole page. The Advisories widget and the dashboard filter lists read the same way. Grouping by subscription now lists groups by subscription id rather than display name (the name still labels each group).
- Export from the Results and Advisories tabs now streams the file from the server, so a large export starts downloading before the whole file is ready and holds neither the whole file in the browser nor on the server. It still writes one CSV line per row of every finding the view matches, with the same columns as before, and follows the view's filters, search, window and sort. An export reads one consistent copy of the findings and does not hold up scans or other pages while it downloads. If the export fails partway, the download is marked as failed rather than saved as a short file.

### Fixed

- Notifications now give Activity findings their own Activity section in the email, Teams, Slack and webhook message, after the Problems, with a link to the new findings on the Activity tab. Before, they were listed and counted with the Problems and linked to the Results tab, which no longer lists them. The Problems section, its summary and its link now cover Problems only. The webhook JSON keeps Activity in `findings`, `counts` and `totalNewFindings` as before and adds an `activity` field. A changed finding now links to the open findings on its own tab, Results, Activity or Advisories, instead of always to Results, and the webhook `changed` field adds `changedUrls` with one link per tab.
- A finding from a query rule that does not return `location` now gets its location even when the rule returns the resource id in different casing from Azure, for example lower-cased. Before, those findings had no location, so the Location filter and column left them out.
- In the Results tab's By rule view, the Active column is now called Open and counts every open finding for the rule, the same as the Open tile. It no longer changes with the New / Fixed window or the status filter. New is the part of it first seen inside the window, and Fixed now shows the findings fixed inside the window instead of staying blank.
- The status filter's options are now Open, New, Fixed and All, with the window in the New and Fixed labels. Fixed lists only findings fixed inside the window, so it matches the Fixed count above it. "Ongoing only" is gone, and a saved link that used it opens as Open.
- The Subscription, Resource Group, Location and Tags filter counts now follow every other filter, including severity and status, so they add up to what the table shows. They no longer count fixed findings while Open is selected.
- The Results tab now has an Info tile and an Info severity filter. Open findings with Info severity were counted in Open but had no tile and could not be filtered on, so the severity tiles did not add up to Open.
- Creating a rule through the API now answers with the rule as it was saved. The response used to repeat back fields the rule does not have, and a request could set the rule's last run status, which only a scan should write.

## [0.8.0] - 2026-10-07

### Added

- Shipped rules now have a Rule version selector with dates, release notes, newer versions marked New, and a before/after review with a query line diff. Admins can switch to any recorded version, forward or back, without starting a scan. Viewers and editors can review history read-only. Each switch is audited with the old and new versions and changed field names; matched findings keep their ages, history and suppressions on the next scan.

### Changed

- Every shipped rule now has a version, and each version is recorded with the definition it shipped with. RuleBeat Core rules are at `1.0.0` and the APRL pack's version is the date and time of the upstream commit it was synced from (shown as 2026-06-08). Pack versions are set per pack in `data/packs/pack-manifest.json`.
- Upgrading RuleBeat no longer changes what an enabled rule runs. A newer shipped definition is recorded next to the one that is running. A disabled shipped rule moves to the newest version on upgrade, since nothing it produces can change. Name, description, category, severity, query and conditions are no longer rewritten from the shipped files on every start, and your enabled state, tags, suppressions, schedules and findings are never touched.
- A rule that no pack ships any more is marked retired. It keeps running and keeps its findings. A rule whose stored definition differs from the shipped one the first time versions are recorded keeps running as "Before versioning" while it is enabled; a disabled one is recorded as "Before versioning" and then moves to the shipped version.
- An Identity built-in rule whose Microsoft Graph query was edited becomes a custom rule on upgrade. It keeps its id, query, findings and suppressions, and is no longer re-seeded.
- A built-in rule's query can no longer be edited. The query is read-only in the rule form, and updating a built-in rule with a different Microsoft Graph query answers 400. Duplicate the rule to get a custom copy you can change.
- The Library marks a rule that has a newer version than the one it runs with "New version", and a rule no pack ships any more with "Retired. <Pack> no longer ships this rule." The new Version filter in the toolbar narrows the list to either one. A custom rule copied from a shipped rule says "Duplicated from <rule> <version>" on its page, and adds "The original has a newer version." when one is recorded. A rule with no recorded origin shows nothing. A copy saved from the rule page's Duplicate button records its origin the same way the Library's Duplicate button does, and `POST /api/rules` now ignores any `version`, `retiredAt`, `originRuleId` or `originVersion` in the request body.
- The pack sync now versions each rule separately. A rule whose definition did not change keeps its version and release note, and a changed rule takes the upstream commit's date with a note naming the fields that changed, so a sync that touches 3 of 143 rules no longer gives every rule a new version.

### Removed

- The old `POST /api/scan/<category>` and `POST /api/scan/identity` routes are gone. They started a scan outside the scan lock and left no entry in Run History. Use `POST /api/scans/run`, which every part of the console already uses.

### Fixed

- Two dashboards can no longer end up with the same name when they are created, renamed, duplicated or restored from the starter at the same moment, and two dashboards created at once into an empty list no longer both become the default. Saving a dashboard without changing its name no longer fails when an older install already has another dashboard with the same name.
- A suppressed finding that comes back after its resource was fixed and broke again is no longer sent in notifications as new. Notifications now leave out every finding that is suppressed when they are sent, on scheduled runs and on runs whose notification is sent after a restart. An expired suppression no longer hides anything.
- A Log Analytics rule whose query ends in `take`, `limit` or `top` is now reported as capped, the same as a Resource Graph rule. Its results may be cut short, so the scan now shows partial coverage instead of reporting the rule as a full success.
- After a rule moves to another category, the dashboards stop counting its fixed findings under the old category as soon as the next scan runs. Before, the old category kept showing them as active until that category was scanned again. The finding's history also stays in one category: its resolved event is recorded under the category the finding was found in.
- Two rules can no longer end up with the same name when they are created or renamed at the same moment. The name check and the save now happen as one step, so the second request gets the usual "already exists" answer. Saving a rule without changing its name no longer fails when an older install already has another rule with the same name.
- Suppressing a finding or removing a suppression in the findings explorer now says so when the server refuses the change, and the screen keeps showing what is actually saved. Before, a refused removal looked like it worked until the next reload. When the dashboard widget cannot load suppressions, it now says it is unavailable instead of showing every finding as unsuppressed.
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

[Unreleased]: https://github.com/rulebeat/rulebeat/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/rulebeat/rulebeat/compare/v0.7.1...v0.8.0
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
