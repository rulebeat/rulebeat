# RuleBeat documentation

RuleBeat is a self-hosted governance scanner for Azure: a single Docker container you run in your own
subscription. Your team writes rules describing what should not exist in your estate, RuleBeat runs
them on a schedule, and every finding is tracked from first seen to fixed. A rule is a check you
author against Azure Resource Graph or Microsoft Graph, in a visual builder or as raw KQL, and
built-in and custom rules share one scan, history, suppression, dashboard and notification workflow.

RuleBeat is read-only by design. It scans with a Reader credential you provide, never holds write
access, and never blocks a deployment. It is open source (Apache-2.0) and free.

**New here?** Read [Why run RuleBeat](why-run-rulebeat.md), then [Installing RuleBeat](install.md).
Everything else is reference you can come back to.

## Start here

| Page | What it answers |
|---|---|
| [Installing RuleBeat](install.md) | Running one container, first sign-in, and the onboarding wizard. |
| [Azure permissions](permissions.md) | Which Azure and Graph permissions the identity needs, and why each is read-only. |
| [Scans and schedules](scans-and-schedules.md) | Running your first scan, and what a scheduled run records per rule. |

## Understand

| Page | What it answers |
|---|---|
| [Why run RuleBeat](why-run-rulebeat.md) | What the visibility buys you: cost, security, compliance, identity, reliability. |
| [How it works](how-it-works.md) | What happens between a rule and a finding, and where data lives. |
| [Posture](posture.md) | What "X of Y passing" means exactly, and what counts as unknown. |

## Operate

| Page | What it answers |
|---|---|
| [Notifications](notifications.md) | Teams, Slack, webhook and email channels, thresholds, retries, delivery history. |
| [Dashboards](dashboards.md) | The widget catalog, filters, date windows, and what a widget cannot show. |
| [Suppressions](suppressions.md) | What suppressing a finding does and does not do, with reasons and expiry. |
| [Roles and permissions](rbac.md) | The three roles, and what the audit log records. |
| [Configuring RuleBeat](configure.md) | Every setting, in the console and the environment, and which one wins. |
| [Security and privacy](security.md) | What RuleBeat reads, stores, encrypts, and never does. |
| [Troubleshooting](troubleshooting.md) | The diagnostics page and the failure modes seen so far, with fixes. |

## Reference

| Page | What it answers |
|---|---|
| [Authoring rules](authoring-rules.md) | Scope, conditions, operators, Applies to, raw KQL, round-tripping, provenance. |
| [Directory rules](directory-rules.md) | Rules that read Microsoft Graph: object types, OData filters, expiring items. |
| [Demo mode](demo-mode.md) | Running RuleBeat against synthetic data with no Azure access at all. |
| [FAQ](faq.md) | How RuleBeat relates to Azure Policy, Defender and Advisor, and what people ask before installing. |

## Conventions used in these pages

- **Rule** is the thing you author and enable. **Finding** is one row a rule returned.
  **Suppression** is a finding you chose to hide, with a reason and an optional expiry. **Posture**
  is the "X of Y passing" measure. **Pack** is a version-pinned external rule set. **Category** is
  the configurable grouping a rule belongs to.
- Screenshots come from demo mode's synthetic estate or a fresh install with placeholder values. No
  id, name or count in them belongs to a real tenant.
- Every number in these pages is checked against the code by an automated test on every push.

These pages describe the product as it ships today. Where a page touches something unshipped, it says
so. If a page contradicts what the product does, that is a bug: open an issue with the page name and
the sentence.
