# Frequently asked questions

Short answers, each pointing at the page that has the long one. The comparisons name only
Microsoft's own services; RuleBeat does not publish comparisons with third-party tools it has not
verified hands-on.

## How is this different from Azure Policy?

Azure Policy evaluates built-in and custom definitions against your resources and can audit, deny
or modify them; it is the enforcement layer Microsoft provides, and nothing in RuleBeat replaces
it. RuleBeat is for the step before enforcement: write the check your team actually means, in KQL
or in the builder, run it on a schedule, watch the finding count over weeks, suppress the cases you
have accepted, and only then decide what is worth turning into a Policy definition. RuleBeat never
blocks a deployment, never modifies a resource and never holds the credentials that could. If you
already know exactly what to enforce, use Policy. If you are still working out what your standard
is, or you want history and suppressions on top of checks Policy does not express, use RuleBeat.
See [`how-it-works.md`](how-it-works.md).

## How is this different from Defender for Cloud or Azure Advisor?

Both produce recommendations Microsoft wrote, about security posture and Well-Architected best
practice respectively. Neither lets you write a check against your own tag standard, naming rule or
internal convention and then schedule it, suppress the known cases and watch the trend. RuleBeat's
rules cover whatever you can query: cost hygiene, reliability, identity, governance and security
alike. It also ships the Azure Proactive Resiliency Library as a pack, so the Microsoft-authored
reliability checks and your own run through one workflow. RuleBeat does not replace Defender's
threat detection or Advisor's cost figures; it sits next to them.

## What is the catch with read-only?

There is no one-click fix. A finding tells you what failed, why (the rule's recommendation), where
(a portal link) and, for pack rules, Microsoft's own guidance; you make the change in Azure with
whatever identity and process you already use. The trade: RuleBeat cannot break anything, a
compromised RuleBeat instance cannot change anything, and you can give it to a team without giving
that team write access. Generated fix steps are on the list ([`whats-next.md`](whats-next.md)); they
will still be steps you run, not actions RuleBeat takes.

## Does it need Owner or Contributor?

No. **Reader** on the subscriptions or management groups you want scanned, plus the Microsoft
Graph application permission `Application.Read.All` if you want the two Directory rules about
expiring app credentials. That is the complete list for a default install. Other Directory rules
you write need the matching Graph read permission for their object type. See
[`permissions.md`](permissions.md) and [`directory-rules.md`](directory-rules.md#permissions).

## Does anything leave my tenant?

Only what you point it at. Outbound connections are Azure and Microsoft Graph (with your
credential), the notification destinations you configure, and the SMTP server if you set up email.
There is no telemetry, no update check, no usage ping and no external font or script loaded at
runtime. See [`security.md`](security.md#no-telemetry).

## Can I scan a whole management group?

Yes. Grant Reader on the management group and every subscription under it becomes visible to the
scanning identity; by default a scan covers every subscription that identity can read. A rule can
additionally be scoped to particular management groups or subscriptions with the scope picker in
the rule editor. Subscription lists above Azure's per-request limit are batched automatically. See
[`permissions.md`](permissions.md) and [`authoring-rules.md`](authoring-rules.md#scope).

## Why did my posture drop after upgrading?

Because the formula got stricter. RuleBeat used to count a rule with zero findings as passing even
if its query had never actually run or had failed. It now counts such a rule as **unknown**, shown
separately and never added to passing. An install upgraded across that change shows a lower number
the next morning, for the same estate. The history written under the old formula is tagged with
its version and is not blended with the new one. See [`posture.md`](posture.md).

## Why are the APRL pack rules disabled by default?

<!-- count:pack-rules:aprl-v2 -->143 reliability rules turned on at once would make a first scan
slow and its result unreadable, and not all of them fit every estate. They ship disabled so a fresh
install starts with <!-- count:enabled-default -->12 enabled rules and you switch on the pack rules
that apply to you. Some upstream recommendations also ship with placeholder queries; enabling one
of those gives a "query failed" outcome rather than a finding, which the Rules tab shows. See
[`examples.md`](examples.md#example-c-a-reliability-rule-from-the-aprl-pack).

## Where is the admin password?

In `data/initial-password.txt` inside the data volume, written on first boot. It is never printed
to the container logs. You are forced to change it on first sign-in. See
[`install.md`](install.md).

## Can I use my Microsoft Entra ID sign-in?

Yes. Local accounts get you in on day one; an admin can then configure Microsoft Entra ID under
Settings → Sign-in (or through environment variables) and choose whether the local form stays
visible. Roles are assigned inside RuleBeat, not read from Entra groups. See [`rbac.md`](rbac.md)
and [`configure.md`](configure.md).

## Does it work on Azure Government or Azure China?

Not today. The Azure public cloud endpoints are the only ones wired in. See
[`whats-next.md`](whats-next.md).

## Can I run more than one replica?

Not supported today: one container, one data volume, one in-process scheduler. Two replicas on one
volume would double-fire schedules and contend for SQLite. See
[`install.md`](install.md#deployment-topology).

## Can I write a rule against sign-in logs, activity logs or diagnostic data?

Not yet. Rules run against Azure Resource Graph (resource configuration) and Microsoft Graph
(directory objects). The third kind, Logs & activity over Log Analytics, is designed and in build;
the picker shows it as not yet available. See [`whats-next.md`](whats-next.md).

## Can I export or import rules?

Findings export to CSV and JSON from the Scans page, and the audit log exports to CSV. Rules do not
have an import or export feature today; a rule is edited in the product, and the built-in and pack
rules arrive with the release. See [`whats-next.md`](whats-next.md).

## How do I back it up?

Copy the data volume: the SQLite database, the encryption key and the auth secret live there
together. A copy of the volume is a complete backup, and for the same reason it must be treated as
sensitive. See [`configure.md`](configure.md) and [`security.md`](security.md).

## Is it really free?

RuleBeat is open source (Apache-2.0) and free. There is no paid tier of the software and no feature
held back from the open version.
