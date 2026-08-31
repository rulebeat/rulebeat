# Frequently asked questions

Short answers, each pointing at the page with the long one. The comparisons name only Microsoft's
own services; RuleBeat does not publish comparisons with tools it has not used hands-on.

## How is this different from Azure Policy?

Policy is Azure's enforcement layer: it decides whether a resource may exist in a given state, and
can audit, deny or modify at deployment time. RuleBeat runs the checks you write yourself, on a
schedule, and keeps the finding history, suppressions and dashboards that show how posture moves.
It never blocks a deployment, never modifies a resource, and never holds the credentials that
could. The two are independent and neither needs the other. See
[`how-it-works.md`](how-it-works.md).

## How is this different from Defender for Cloud or Azure Advisor?

Both produce recommendations Microsoft wrote. Neither lets you write a check against your own tag
standard, naming rule or internal convention and then schedule it, suppress the known cases and
watch the trend. RuleBeat sits next to them and does not replace Defender's threat detection or
Advisor's cost figures. See [`why-run-rulebeat.md`](why-run-rulebeat.md).

## What is the catch with read-only?

There is no one-click fix. A finding tells you what failed, why, and where, with a portal link and
Microsoft's own guidance on pack rules. You make the change with whatever identity and process you
already use. The trade: RuleBeat cannot break anything, a compromised instance cannot change
anything, and you can hand it to a team without handing them write access.

## Does it need Owner or Contributor?

No. **Reader** on the subscriptions or management groups you want scanned, plus the Microsoft Graph
permission `Application.Read.All` if you want the built-in rules about expiring app credentials.
Other Directory rules need the matching Graph read permission for their object type. See
[`permissions.md`](permissions.md).

## Does anything leave my tenant?

Only what you point it at: Azure and Microsoft Graph with your credential, the notification
destinations you configure, and your SMTP server if you set up email. No telemetry, no update
check, no usage ping, no external font or script at runtime. See
[`security.md`](security.md#no-telemetry).

## Can I scan a whole management group?

Yes. Grant Reader on the management group and every subscription under it becomes visible. A rule
can be scoped further with the scope picker. Subscription lists above Azure's per-request limit are
batched automatically. See [`authoring-rules.md`](authoring-rules.md#scope).

## Why did my posture drop after upgrading?

The formula got stricter. A rule with zero findings whose query never ran or failed used to count
as passing; it now counts as **unknown** and is never added to passing. History written under the
old formula is tagged with its version and not blended with the new one. See
[`posture.md`](posture.md).

## Why are the APRL pack rules disabled by default?

<!-- count:pack-rules:aprl-v2 -->143 reliability rules at once would make a first scan slow and its
result unreadable, and not all of them fit every estate. A fresh install starts with
<!-- count:enabled-default -->12 enabled rules and you switch on what applies to you. Some upstream
recommendations ship with placeholder queries; enabling one gives a "query failed" outcome rather
than a finding, which the Rules tab shows.

## Where is the admin password?

In `data/initial-password.txt` inside the data volume, written on first boot and never printed to
the container logs. You are forced to change it on first sign-in. See [`install.md`](install.md).

## Can I use my Microsoft Entra ID sign-in?

Yes. Local accounts get you in on day one; an admin can then configure Entra ID under Settings →
Sign-in and choose whether the local form stays visible. Roles are assigned inside RuleBeat, not
read from Entra groups. See [`rbac.md`](rbac.md).

## Does it work on Azure Government or Azure China?

Not today. The Azure public cloud endpoints are the only ones wired in.

## Can I run more than one replica?

Not supported today: one container, one data volume, one in-process scheduler. Two replicas on one
volume would double-fire schedules and contend for SQLite. See
[`install.md`](install.md#deployment-topology).

## Can I write a rule against sign-in logs, activity logs or diagnostic data?

Not yet. Rules run against Azure Resource Graph and Microsoft Graph. Logs & activity over Log
Analytics is designed and in build; the picker shows it as not yet available.

## Can I export or import rules?

Findings export to CSV and JSON, and the audit log to CSV. Rules have no import or export today.

## How do I back it up?

Copy the data volume. The SQLite database, the encryption key and the auth secret live there
together, so a copy is a complete backup and must be treated as sensitive. See
[`security.md`](security.md).

## Is it really free?

Yes. Open source under Apache-2.0, with no paid tier and no feature held back from the open
version.
