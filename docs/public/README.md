# RuleBeat documentation

RuleBeat runs the governance checks your team writes for Azure on a schedule, tracks every finding
over time, and never holds write access.

A check is a rule you author against Azure Resource Graph or Microsoft Graph, in a visual builder or
as a raw query. Built-in and custom rules share one scan, history, suppression, dashboard and
notification workflow.

Use Azure Policy when you are ready to enforce. Use RuleBeat to define and observe your standards
first. It never blocks a deployment and never holds write credentials.

RuleBeat is open source (Apache-2.0) and free.

These pages are plain markdown, rendered by GitHub, and describe the product as it ships today.
Nothing here promises a feature that is not in the code; the forward list lives in
[`whats-next.md`](whats-next.md) and is the only page that talks about unshipped work.

## Start here

| Page | What it answers |
|---|---|
| [`install.md`](install.md) | How to run RuleBeat in one container, sign in for the first time, and get through the onboarding wizard. |
| [`permissions.md`](permissions.md) | Which Azure and Microsoft Graph permissions the identity needs, and why each one is read-only. |
| [`scans-and-schedules.md`](scans-and-schedules.md) | How to run your first scan, what a scheduled run is, and what a run records per rule. |

## Understand

| Page | What it answers |
|---|---|
| [`how-it-works.md`](how-it-works.md) | What happens between a rule and a finding: the two query engines, fingerprints, the finding lifecycle, coverage, and where data lives. |
| [`posture.md`](posture.md) | What "X of Y passing" means exactly, what counts as unknown, and why the number can move when your estate did not. |
| [`examples.md`](examples.md) | Four worked rules end to end: a tag standard with Applies to, a raw KQL storage check, a rule enabled from the APRL pack, and a Directory rule for expiring app secrets. |

## Operate

| Page | What it answers |
|---|---|
| [`scans-and-schedules.md`](scans-and-schedules.md) | Manual runs, recurrence, targeting, run history and per-rule outcomes. |
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
| [`whats-next.md`](whats-next.md) | What is designed or in build, and what is deliberately not planned. No dates. |

## Conventions used in these pages

- **Rule** is the thing you author and enable. **Finding** is one row a rule returned. **Suppression**
  is a finding you chose to hide, with a reason and an optional expiry. **Posture** is the "X of Y
  passing" measure. **Pack** is a version-pinned external rule set. **Category** is the configurable
  grouping a rule belongs to.
- Screenshots are taken from a real self-hosted install. Sample findings in
  [`examples.md`](examples.md) come from demo mode's synthetic estate, and say so.
- Every number in these pages (rule counts, widget counts, role counts) is checked against the code
  by an automated test on every push, so a stale figure fails the build rather than staying stale.

If a page contradicts what the product does, that is a bug: open an issue with the page name and the
sentence.
