# Dashboards

![Dashboard with the Overall Posture ring, category scorecard and trend](img/dashboard.png)

The widget catalog, filters, date windows, and how to present or print a dashboard. If the question is
what "7 of 12" means, read [`posture.md`](posture.md) first.

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

## Present and print

A dashboard leaves your own screen in two ways, Present and paper. Both show what you can see under
your own [Access](access.md), never more, and both carry one **stamp**: an "As seen by" band that says
whose view it is.

### Present

Present shows a dashboard read-only and full screen, for a monitor on a wall or a screen in a meeting.
Nothing on it can be edited, and every number is still a link to Scans with the same filters applied.
Its address is `/dashboards/<id>/present`.

Present refreshes on its own, layout and numbers together. It uses the dashboard's refresh interval,
or every 5 minutes when that is Off. A `?refresh=` value in the address overrides it for that screen
only: `30s`, `1m`, `5m`, `15m`, `30m` or `1h`. Any other value falls back to the dashboard's interval.

### The stamp

The stamp has six cells.

| Cell | Shows |
|---|---|
| **As seen by** | The person the dashboard is shown to. |
| **Access** | That person's Access as counts by kind (for example subscriptions and resource groups), or Everything. |
| **Filters** | The filters in effect for this person. Values they do not hold are not shown, only a count: "+N outside your access". On screen a long list is cut short with "and N more". |
| **Updated** | When the numbers were last read. |
| **Widgets** | How many widgets are unavailable, so a dashboard with a failed widget cannot pass for a clean one. |
| **Refreshes every** | The interval Present is using. |

The same stamp is printed on paper.

### The Everything notice

An Admin, or anyone whose Access is Everything, sees a notice when presenting, because Present shows
everything they can see. It does not block the screen. If the screen is for other people, present as a
person with narrower Access instead ([A screen on the wall](#a-screen-on-the-wall)). The notice does
not appear in the Demo.

### When Present cannot show a dashboard

Present never goes blank without saying why.

- **Signed out.** The session ended, so Present shows a sign-in screen. After signing in you return to
  the dashboard you asked for.
- **Forbidden.** The person's Access no longer allows the dashboard, or the dashboard is no longer
  shared with them, and Present says so.
- **Unavailable.** The dashboard cannot be loaded, for example because it was deleted, and Present
  says so.
- **Not updated since.** If a refresh fails, Present keeps the last numbers it has and shows "Not
  updated since" with the time of the last good read, rather than showing stale numbers as current.

### Print

Use the Print action on a dashboard, or Ctrl/Cmd+P. The page is laid out for paper and carries the
stamp. Landscape fits the grid best. Safari does not pick it for you, so choose landscape yourself in
the print dialog.

One exception: when you print from the browser's own Print menu rather than the Print action, the
browser can scale charts differently from the rest of the page. If a chart looks off, use the Print
action instead.

### A screen on the wall

A wall screen is a dedicated person, signed in on a browser that stays open. It sees only what that
person's Access allows.

1. Invite a dedicated person as a Viewer with Manual access to only that team's Scopes. How to give
   Manual access is in [Manual access](access.md#manual-access); it is not repeated here.
2. Sign that person in on the screen, however your install's sign-in policy allows
   ([`configure.md`](configure.md#local-sign-in-and-the-first-admin)).
3. Open the dashboard in Present.

The session lasts while the screen keeps refreshing: each refresh renews it, so a screen left running
stays signed in. If the screen stops refreshing for longer than a session lasts
([`security.md`](security.md#authentication-and-sessions)), it shows the signed-out screen and someone
must sign in again.

There is no link-only or embed access. Every screen is a signed-in person under their own Access, and
RuleBeat refuses to be shown inside another page.

Present can't put the browser in full screen by itself after a reload. On a dedicated screen, start the
browser in kiosk mode: `--kiosk` for Chrome or Firefox.

A touch screen should run in kiosk mode. Without it, a stray tap leaves Present, and only someone with
a keyboard can undo it.

## Managing dashboards

Create a blank dashboard, duplicate one for a per-team variant, rename, delete, set the default, or
Restore starter to recreate the seeded Overview layout. Every dashboard is deletable including the
default; deleting it promotes the oldest remaining one. Layouts save per dashboard. Creating,
renaming and deleting is audited; dragging and resizing is not, since every drag would be an entry
and would bury real changes. Viewers see every dashboard, editing needs the editor role
([`rbac.md`](rbac.md)).
