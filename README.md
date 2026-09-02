<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lockup/rulebeat-lockup-dark-306.png">
  <img src="brand/lockup/rulebeat-lockup-306.png" alt="RuleBeat" width="240">
</picture>

<h3>Azure governance checks you write, run on a schedule</h3>

<p>
A self-hosted governance scanner for Azure: one Docker container you run in your own subscription.<br>
Your rules describe what should not exist in your estate. RuleBeat finds where it does,<br>
and tracks every finding from first seen to fixed.
</p>

<p>
<a href="https://docs.rulebeat.com"><b>Documentation</b></a>
&nbsp;·&nbsp;
<a href="#quick-start"><b>Quick start</b></a>
&nbsp;·&nbsp;
<a href="docs/public/demo-mode.md"><b>Demo mode</b></a>
&nbsp;·&nbsp;
<a href="https://github.com/rulebeat/rulebeat/issues/new"><b>Report a bug</b></a>
&nbsp;·&nbsp;
<a href="https://github.com/rulebeat/rulebeat/issues/new"><b>Request a feature</b></a>
</p>

<p>
<a href="https://github.com/rulebeat/rulebeat/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/rulebeat/rulebeat/ci.yml?branch=main&amp;label=CI&amp;style=flat-square"></a>
<a href="https://github.com/rulebeat/rulebeat/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/rulebeat/rulebeat?label=release&amp;color=1f6feb&amp;style=flat-square"></a>
<a href="LICENSE"><img alt="Apache-2.0 licensed" src="https://img.shields.io/github/license/rulebeat/rulebeat?label=license&amp;color=1f6feb&amp;style=flat-square"></a>
<a href="https://github.com/rulebeat/rulebeat/pkgs/container/rulebeat"><img alt="Container image on GitHub Container Registry" src="https://img.shields.io/badge/container-ghcr.io-2496ED?logo=docker&amp;logoColor=white&amp;style=flat-square"></a>
</p>

<p>
<a href="https://docs.rulebeat.com"><img alt="Documentation" src="https://img.shields.io/badge/docs-docs.rulebeat.com-0a7d55?style=flat-square"></a>
<a href="https://rulebeat.com"><img alt="Website" src="https://img.shields.io/badge/website-rulebeat.com-111111?style=flat-square"></a>
<a href="CHANGELOG.md"><img alt="Changelog" src="https://img.shields.io/badge/changelog-keep%20a%20changelog-e05d24?style=flat-square"></a>
<a href="https://github.com/rulebeat/rulebeat/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/rulebeat/rulebeat?label=issues&amp;color=6f42c1&amp;style=flat-square"></a>
</p>

</div>

![Dashboard overview with the Overall Posture ring, trend, and stat cards](docs/public/img/dashboard.png)

A rule is a check you author against Azure Resource Graph or Microsoft Graph, in a visual builder
or as raw KQL. Built-in and custom rules share one scan, history, suppression, dashboard and
notification workflow.

RuleBeat is read-only by design. It scans with a Reader credential you provide, never holds write
access, and never blocks a deployment. It is open source (Apache-2.0) and free.

---

**Contents:** [The problem](#the-problem) · [What it does](#what-it-does) ·
[Why not just use...](#why-not-just-use) · [Quick start](#quick-start) ·
[Connect Azure](#connect-azure) · [Documentation](#documentation) · [Status](#status) ·
[Contributing](#feedback--contributing)

## The problem

Every platform team knows what should not exist in its Azure estate: resources nobody owns,
storage open to the internet, names that break the convention, required tags that are missing.
Azure gives those checks no first-class home. They live in someone's head, in a script only its
author runs, or in a wiki page that went stale the month it was written, and they surface only
when something breaks.

The quieter failure is the check that stops running. It does not turn red. It stays green, and the
estate drifts behind a number nobody has a reason to distrust.

RuleBeat is the home for those checks. Each rule describes one thing that should not exist, every
scan finds where it does, and a rule that comes back clean is a standard being met. The history
shows whether the estate is getting better or worse.

## What it does

- **Rules you write, against two kinds of data.** A rule checks either *resource configuration*
  (Azure Resource Graph, built visually or as raw KQL) or *directory objects* (Microsoft Graph, with
  an OData filter). Every row a query returns is a finding, so nothing can disagree with what the
  same query shows you in the Azure Portal. A third kind, *logs and activity*, is visible in the rule
  picker but not yet available.
- <!-- count:checks-total -->**158 checks out of the box.** <!-- count:builtin-rules -->15 written
  for RuleBeat plus <!-- count:pack-rules:aprl-v2 -->143 from the
  [Azure Proactive Resiliency Library](https://azure.github.io/Azure-Proactive-Resiliency-Library-v2/)
  (APRL), pinned to an upstream commit. A fresh install enables
  <!-- count:enabled-default -->12 of them, so the first scan is a signal rather than a wall.
- **A visual rule builder that round-trips with raw KQL.** Pick scope, resource type and conditions,
  or paste a query from the Portal and have it parsed back into the builder. What the builder cannot
  express is kept verbatim, never dropped.
- **"X of Y passing", honestly counted.** A rule passes only when it has zero active findings *and*
  its last run succeeded. A rule that never ran, whose query failed, or whose result was capped reads
  as unknown, never as passing. The number is sometimes uglier for it, and that is the point.
- **A findings lifecycle, not a scan diff.** Every finding is keyed on rule plus resource and tracked
  as new, active or fixed across scans. A suppression needs a reason and can carry an expiry date.
- **Scheduled scans, dashboards, notifications, roles.** An Outlook-style recurrence engine,
  <!-- count:widget-types -->12 dashboard widget types you can filter and arrange, alerts to Teams,
  Slack, a webhook or email per schedule, and <!-- count:roles -->three roles enforced on every API
  route with an audit log behind them.

**Read-only, permanently.** RuleBeat scans with a Reader credential you create, never holds write
access, and never blocks a deployment. The cost is real: there is no one-click fix. Remediation stays
your action under your own identity.

## A closer look

| | |
|:--|:--|
| ![Results tab with a finding expanded](docs/public/img/findings.png) | ![Visual rule builder showing a condition group mid-edit](docs/public/img/rule-builder.png) |
| **Findings.** Every row a rule returns, with its age, severity and the rule's own recommendation. | **The rule builder.** Scope, resource type and conditions, round-tripping with the raw KQL. |
| ![The Library page listing the APRL v2 pack rules alongside the built-in rules](docs/public/img/library.png) | ![The Run History tab listing scheduled runs with their duration, rule counts and findings](docs/public/img/run-history.png) |
| **The library.** RuleBeat's own rules and the APRL pack, side by side. | **Run history.** What ran, how long it took, and whether the coverage was complete. |

![Walkthrough: the dashboard, findings, the rule library, a rule's detail, and run history](docs/public/img/walkthrough.gif)

## Why not just use...

- **Azure Policy.** Policy is Azure's enforcement layer: it evaluates definitions inside the control
  plane and can audit, deny or modify a resource at deployment time, and it does that better than
  anything you would write yourself. RuleBeat does a different job: your own checks, run by your own
  service on a schedule, with history, suppressions and dashboards. Teams run both, and neither
  needs the other.
- **Defender for Cloud or Azure Advisor.** Both are valuable, and both are security-first or
  recommendation-first. Neither lets you write a check against your own tag standard, naming
  convention or internal rule and then schedule it, suppress the known cases and watch the trend.
- **A Workbook, a spreadsheet, or a one-off script.** Fine until a second person needs to run it, or
  until you need history, scheduling, or an audit trail. If one person owns the whole loop today,
  you probably do not need this.

## Quick start

You need Docker. Connecting real Azure data needs a subscription with at least Reader access, and
you can explore the UI without connecting anything.

1. Start the container.

   bash or zsh:

   ```bash
   docker run -d --name rulebeat --restart unless-stopped -p 127.0.0.1:3000:3000 \
     -v rulebeat-data:/app/packages/web/data \
     -e AUTH_URL=http://localhost:3000 \
     ghcr.io/rulebeat/rulebeat:0.3.0
   ```

   PowerShell:

   ```powershell
   docker run -d --name rulebeat --restart unless-stopped -p 127.0.0.1:3000:3000 `
     -v rulebeat-data:/app/packages/web/data `
     -e AUTH_URL=http://localhost:3000 `
     ghcr.io/rulebeat/rulebeat:0.3.0
   ```

2. Read the generated admin password. It is written to the data volume, never to the container
   logs:

   ```
   docker exec rulebeat cat data/initial-password.txt
   ```

3. Open `http://localhost:3000`, sign in, and change the password when prompted. A
   <!-- count:onboarding-steps -->four-step wizard then connects Azure, verifies what your
   credential can actually reach, and runs your first scan.

To see it without an Azure tenant at all, run [demo mode](docs/public/demo-mode.md) instead.

The app binds to `127.0.0.1` on purpose, because RuleBeat holds a live Azure read credential; to
reach it from another machine put a reverse proxy with TLS in front
([configure.md](docs/public/configure.md#exposing-it-beyond-localhost)). Docker Compose, upgrading,
backup, the optional [PostgreSQL backend](docs/public/install.md#run-it-on-postgresql), and
building from source are all in [`docs/public/install.md`](docs/public/install.md).

## Connect Azure

RuleBeat needs a read-only identity to scan with, and never creates one for you. Connect it from
Settings → Azure connection, or supply it as an environment variable so the container arrives
pre-configured. For a service principal, this one line works in bash, zsh and PowerShell:

```
az ad sp create-for-rbac --name rulebeat-reader --role Reader --scopes /subscriptions/<subscription-id>
```

Managed identity and workload identity federation are both supported and both better, since no
secret exists to leak; a mounted secret file beats a plain environment variable. The ranked list, the
exact `az` commands, the Portal steps, and the optional Microsoft Graph permission for Directory
rules are in [`permissions.md`](docs/public/permissions.md) and
[`configure.md`](docs/public/configure.md), which opens with a reference table of every
environment variable and also covers signing your team in with Microsoft Entra ID instead of a
shared password.

## Documentation

Published and searchable at [docs.rulebeat.com](https://docs.rulebeat.com), and in
[`docs/public/`](docs/public/README.md) in this repo.

| If you want to | Read |
|---|---|
| Run it | [install.md](docs/public/install.md), [permissions.md](docs/public/permissions.md) |
| Write a rule | [authoring-rules.md](docs/public/authoring-rules.md), [directory-rules.md](docs/public/directory-rules.md) |
| Understand what it does with a finding | [how-it-works.md](docs/public/how-it-works.md), [posture.md](docs/public/posture.md) |
| Know what it reads and stores | [security.md](docs/public/security.md) |
| Compare it to what you already run | [faq.md](docs/public/faq.md) |

Contributing to the code is [`CONTRIBUTING.md`](CONTRIBUTING.md); reporting a vulnerability is
[`SECURITY.md`](SECURITY.md). Local development:

```bash
npm install
npm run build:core      # build packages/core before running or typechecking web
npm run dev             # http://localhost:3000
npm test                # everything, both packages
```

## Status

RuleBeat is in public beta. The core product (scanning, rules, dashboards, scheduling, notifications,
RBAC, audit logging) is built and in daily use. Logs and activity rules and generated remediation
steps are designed but not yet built, and the docs say so wherever they come up. The software is
free, during beta and after. This is a feedback-gathering phase: if something breaks, is confusing,
or is missing something you would need to adopt it,
[open an issue](https://github.com/rulebeat/rulebeat/issues).

## Feedback & contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The whole platform is open and community-contributed under
Apache-2.0. [Open an issue](https://github.com/rulebeat/rulebeat/issues) with bug reports, feature
requests, or rule ideas, or open a pull request directly. [`SUPPORT.md`](SUPPORT.md) says where to
ask questions; everyone in the project's spaces follows the
[code of conduct](CODE_OF_CONDUCT.md).

## Sponsors

RuleBeat is free and stays that way regardless of sponsorship.
[Sponsoring on GitHub](https://github.com/sponsors/abdohanafy) funds the time behind it: triaging
issues, reviewing pull requests, writing new rules, and building out the pipeline. It unlocks nothing
in the software; see [`SPONSORS.md`](SPONSORS.md).

---

## License

Apache-2.0, covering the whole platform. The [`LICENSE`](LICENSE) file beside this README governs the
copy you are reading. The rules and content shipped with RuleBeat may carry their own separate
license.
