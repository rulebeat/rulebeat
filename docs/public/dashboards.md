# Dashboards

![Dashboard with the Overall Posture ring, category scorecard and trend](img/dashboard.png)

The widget catalog, filters and date windows. If the question is what "7 of 12" means, read
[`posture.md`](posture.md) first.

Every widget reads live state from the findings table plus, for trend lines, the daily posture
snapshots. No widget reads the last scan's result blob, so a narrow scheduled run cannot make a
dashboard swing. Suppressed findings are excluded everywhere on a dashboard; the Scans page is where
you see them.

## The widget catalog

<!-- count:widget-types -->Thirteen widget types, added from the Add Widget panel:

| Widget | Shows |
|---|---|
| **Stat Card** | One number from a metric you pick: posture, open findings, critical, high, rules scanned, categories healthy, new or fixed. Carries the window's delta and any unknown count. |
| **Posture Ring** | The "X of Y passing" gauge for one category or overall, with "N not yet proven" underneath. |
| **Trend Chart** | Posture % over time, one series per category. Needs stored history. |
| **Top Violating Rules** | The rules producing the most open findings. |
| **Category Scorecard** | One row per category: passing, open findings, delta. |
| **Recent Findings** | The newest findings, with category, severity and first-seen date. |
| **Severity Breakdown** | A donut of open findings by severity. |
| **Subscription Scorecard** | One row per subscription, graded against the rules that apply to it. |
| **Top Offending Resources** | The resources with the most open findings. |
| **Scan Coverage** | Last scan time per category, badged fresh, recent, stale or never against your threshold. |
| **New vs. Fixed** | Findings first seen against findings fixed, per day. |
| **Activity Occurrences** | Daily findings from activity rules. Empty until the Log Analytics backend lands. |
| **Advisories** | Open Advisories with rule, resource, severity and when each was last seen, most severe first and then most recently seen. Advisories are never counted as problems, so this is the one widget that lists them. A row opens the Advisories tab on Scans. |

Widgets showing findings or rules click through to the Scans page with the same filters applied, so
the list you land on is the list the number counted.

## Filters and scope

A dashboard has one filter bar applied to every widget: categories, subscriptions, resource groups,
tags, severities, rules, and a date window. A funnel indicator appears on the bar and on each widget
title while a filter is active, so a scoped number never looks global. Tags here are **rule** tags
(labels like `framework:iso27001`), not Azure resource tags.

Each widget also has a **Scope** panel with the same dimensions. A value set there **replaces** the
dashboard's value for that dimension on that widget; anything left on inherit takes the dashboard's.
Values never intersect, so if the dashboard is filtered to production and a widget's Scope names the
sandbox subscription, that widget shows the sandbox.

The date window is a rolling preset (24 hours, 7 or 30 days) or a custom range. A preset is stored as
"7 days" rather than two dates, so it keeps rolling. It drives anything that says new, fixed or
delta, the Trend and New vs. Fixed charts, and "vs baseline". It does not change what counts as open.

Three limits a widget will tell you about. Trend needs snapshots at the right grain, so under a
resource group, tag, severity or rule filter, or with two or more subscriptions selected, it says a
trend is not available rather than drawing a misleading blended line
([`posture.md`](posture.md#snapshots-and-trend)); the open-findings delta keeps working under every
filter. A failed data request shows "Couldn't load this widget" with a Retry, while genuinely absent
data shows an empty state, so a broken dashboard cannot pass for a clean tenant. And no enabled
rules in scope shows an empty posture rather than 0% or 100%.

## Managing dashboards

Create a blank dashboard, duplicate one for a per-team variant, rename, delete, set the default, or
Restore starter to recreate the seeded Overview layout. Every dashboard is deletable including the
default; deleting it promotes the oldest remaining one. Layouts save per dashboard. Creating,
renaming and deleting is audited; dragging and resizing is not, since every drag would be an entry
and would bury real changes. Viewers see every dashboard, editing needs the editor role
([`rbac.md`](rbac.md)).

## Present and print

A dashboard leaves your own screen in two ways, **Present** and paper. Both show it as you see it,
under your own Access, and both carry one stamp saying so. Neither is a way to share a dashboard with
someone who cannot sign in: everyone who sees a dashboard this way is a person on the install, seeing
only what their own Access allows.

### Present

Present opens a dashboard at `/dashboards/<id>/present`, read-only and full screen. Nothing on it can
be edited or dragged, and every number is still a link to the same count on Scans.

Present refreshes by itself, layout and numbers together, so a widget added or moved while it runs
shows up without a reload. It refreshes at the dashboard's own refresh interval, or every 5 minutes
when that is Off. To override it for one screen, add `?refresh=` to the address with one of `30s`,
`1m`, `5m`, `15m`, `30m` or `1h`. Any other value falls back to the dashboard's interval. The
override applies to that screen only and is never saved on the dashboard.

### The stamp

The stamp is a band at the top of Present and of every printed page. It has six cells.

| Cell | Says |
|---|---|
| **As seen by** | The person the dashboard is shown to. |
| **Access** | Their Access as counts by kind (for example subscriptions and resource groups), or Everything. |
| **Filters** | The filters that apply to what they see. A count such as "+2 outside your access" says how many values were held back because they sit outside the person's Access. On screen a long list is cut with "and N more"; on paper every value is printed. |
| **Updated** | When the numbers on the screen were last read. |
| **Widgets** | How many widgets are unavailable. It says so only when there are some. |
| **Refreshes every** | The interval Present is using. |

### The Everything notice

When an Admin, or anyone holding Everything, presents a dashboard, Present shows a notice that the
screen shows every finding on the install. It does not block anything and can be read and left alone.
It does not appear in the Demo. If the screen is for a team, present as a person scoped to that team
instead (see [A screen on the wall](#a-screen-on-the-wall)).

### When Present cannot show a dashboard

Present says why rather than showing an empty dashboard.

- **Signed out.** The session ended, so Present asks you to sign in and brings you back to the same
  dashboard afterwards.
- **Forbidden.** You are signed in, but your Access no longer allows this dashboard, or it has stopped
  being shared with you. Present clears the dashboard from the screen.
- **Unavailable.** The dashboard cannot be loaded now, or it was deleted. This is a different screen
  from an empty dashboard, so a broken screen cannot pass for a clean tenant.

If a refresh fails while the dashboard is already showing, Present keeps the last numbers on screen
and says **Not updated since** with the time of the last good read, instead of presenting old numbers
as current.

### Printing

Use the **Print** action on the dashboard, or Ctrl+P (Cmd+P on a Mac). The page is laid out for paper
with the stamp at the top. Landscape fits the grid best. Safari does not take the orientation from the
page, so Safari users choose landscape in the print dialog themselves.

One exception: charts are drawn at the size of the screen they were rendered on. The Print action
redraws them for the page first. When you print from the browser's own Print menu instead, charts keep
their on-screen size and may not scale to fit the page.

## A screen on the wall

A wall screen is a person signing in, not a special kind of link. To set one up for a team:

1. Invite a dedicated person as a **Viewer** with Manual access to only that team's Scopes, so the
   screen can show nothing else. How to give Manual access is in
   [`access.md`](access.md#manual-access).
2. Sign them in on the screen however the install's sign-in policy allows, with a local account or
   with Microsoft ([`configure.md`](configure.md#sign-in)).
3. Open the dashboard in Present.

The session lasts while the screen keeps refreshing, because each refresh renews it
([`security.md`](security.md#authentication-and-sessions)). If the screen is switched off for longer
than a session lasts, it shows the signed-out screen and someone signs in again.

There is no link-only access and no embed: a dashboard cannot be shown to a browser that is not signed
in, or inside another site's page.

Present can't put the browser in full screen by itself after a reload. On a dedicated screen, start
the browser in kiosk mode: `--kiosk` for Chrome or Firefox.

A touch screen should run in kiosk mode, since a stray tap leaves Present and only someone with a
keyboard can undo it.
