# RuleBeat documentation

RuleBeat is a self-hosted governance scanner for Azure: a single Docker container you run in
your own subscription. Your team writes rules that describe what should not exist in your estate,
RuleBeat runs them on a schedule, and every finding is tracked from first seen to fixed.

A rule is a check you author against Azure Resource Graph or Microsoft Graph, in a visual builder
or as raw KQL. Built-in and custom rules share one scan, history, suppression, dashboard and
notification workflow.

RuleBeat is read-only by design. It scans with a Reader credential you provide, never holds write
access, and never blocks a deployment.

RuleBeat is open source (Apache-2.0) and free.

These pages are plain markdown, rendered by GitHub, and describe the product as it ships today.
Nothing here promises a feature that is not in the code; where a page touches something
unshipped, it says plainly that the thing does not exist yet.

## Start here

| Page | What it answers |
|---|---|
| [`install.md`](install.md) | How to run RuleBeat in one container, sign in for the first time, and get through the onboarding wizard. |
| [`permissions.md`](permissions.md) | Which Azure and Microsoft Graph permissions the identity needs, and why each one is read-only. |
| [`scans-and-schedules.md`](scans-and-schedules.md) | How to run your first scan, what a scheduled run is, and what a run records per rule. |

## Understand

| Page | What it answers |
|---|---|
| [`why-run-rulebeat.md`](why-run-rulebeat.md) | What the visibility buys you, category by category: cost, security, compliance, identity, reliability, and how a team works on findings together. |
| [`how-it-works.md`](how-it-works.md) | What happens between a rule and a finding: the two query engines, fingerprints, the finding lifecycle, coverage, and where data lives. |
| [`posture.md`](posture.md) | What "X of Y passing" means exactly, what counts as unknown, and why the number can move when your estate did not. |
| [`examples.md`](examples.md) | Four worked rules end to end: a tag standard with Applies to, a raw KQL storage check, a rule enabled from the APRL pack, and a Directory rule for expiring app secrets. |

## Operate

| Page | What it answers |
|---|---|
| [`notifications.md`](notifications.md) | Teams, Slack, generic webhook and email channels, per-schedule thresholds, retries, delivery history and the outbound URL guard. |
| [`dashboards.md`](dashboards.md) | The widget catalog, filters, date windows, multiple dashboards, and what each widget can and cannot show. |
| [`suppressions.md`](suppressions.md) | What suppressing a finding does and does not do, reasons, expiry, who can suppress, and how it shows in export. |
| [`rbac.md`](rbac.md) | The three roles, what each can do, how role changes take effect, and what the audit log records. |
| [`configure.md`](configure.md) | Every setting, in the console and in the environment, and which one wins. |
| [`security.md`](security.md) | What RuleBeat reads, stores, encrypts, and never does. |
| [`troubleshooting.md`](troubleshooting.md) | The diagnostics page, the health endpoint, and the failure modes seen so far with their fixes. |

## Reference

| Page | What it answers |
|---|---|
| [`authoring-rules.md`](authoring-rules.md) | Scope, conditions, operators, Applies to, raw KQL, round-tripping, validation, provenance and tags. |
| [`directory-rules.md`](directory-rules.md) | Rules that read Microsoft Graph: object types, OData filters, expiring items, validation, permissions. |
| [`demo-mode.md`](demo-mode.md) | Running RuleBeat against synthetic data with no Azure access at all. |
| [`faq.md`](faq.md) | How RuleBeat relates to Azure Policy, Defender for Cloud and Advisor, and the questions people ask before installing. |

## Conventions used in these pages

- **Rule** is the thing you author and enable. **Finding** is one row a rule returned. **Suppression**
  is a finding you chose to hide, with a reason and an optional expiry. **Posture** is the "X of Y
  passing" measure. **Pack** is a version-pinned external rule set. **Category** is the configurable
  grouping a rule belongs to.
- Screenshots come from demo mode's synthetic estate or from a fresh install with placeholder
  values; no id, name or count in them belongs to a real tenant. Sample findings in
  [`examples.md`](examples.md) come from the same synthetic estate, and say so.
- Every number in these pages (rule counts, widget counts, role counts) is checked against the code
  by an automated test on every push, so a stale figure fails the build rather than staying stale.

If a page contradicts what the product does, that is a bug: open an issue with the page name and the
sentence.
