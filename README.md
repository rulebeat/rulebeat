<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lockup/rulebeat-lockup-dark-306.png">
  <img src="brand/lockup/rulebeat-lockup-306.png" alt="RuleBeat" width="153">
</picture>

RuleBeat runs the governance checks your team writes for Azure on a schedule, tracks every
finding over time, and never holds write access.

A check is a rule you author against Azure Resource Graph or Microsoft Graph, in a visual builder
or as a raw query. Built-in and custom rules share one scan, history, suppression, dashboard and
notification workflow.

Use Azure Policy when you are ready to enforce. Use RuleBeat to define and observe your standards
first. It never blocks a deployment and never holds write credentials.

RuleBeat is open source (Apache-2.0) and free.

## The problem

Azure Policy can block deployments and enforce compliance, but that is exactly the friction most
platform teams want to avoid while they are still working out what "compliant" should mean for
their own estate. Defender for Cloud and Azure Advisor are broad but shallow on custom governance,
and neither lets you author your own checks against your own tags, naming conventions, or internal
standards and then watch them over time. RuleBeat sits in between. It stays read-only, so it never
gets in anyone's way, and it is rule-first, so you can express whatever "good" means for your
environment and see exactly where reality diverges from it, scan after scan.

## What it does

- **Rules you write, against two kinds of data.** A rule checks either *resource configuration*
  (Azure Resource Graph, built visually or as raw KQL) or *directory objects* (Microsoft Graph:
  applications, service principals, users, groups and more, with an OData filter). A third kind,
  *logs and activity* (Log Analytics), is visible in the rule picker but not yet available. Every
  row a query returns is a finding; there is no separate in-memory evaluation that could disagree
  with what the same query shows you in the Azure Portal.
- <!-- count:checks-total -->**158 checks out of the box.** <!-- count:builtin-rules -->15 written
  for RuleBeat plus <!-- count:pack-rules:aprl-v2 -->143 from the
  [Azure Proactive Resiliency Library](https://azure.github.io/Azure-Proactive-Resiliency-Library-v2/)
  (APRL), version-pinned to the upstream commit recorded in the pack manifest. A fresh install
  enables <!-- count:enabled-default -->12 of them so the first scan is a useful signal rather than
  a wall of findings. Everything else is one click away in the Rules tab.
- **A visual rule builder that round-trips with raw KQL.** Build a check by picking scope, resource
  type and conditions, or paste a query copied from the Portal and have it parsed back into the
  builder. What the builder cannot express is kept verbatim as a read-only condition, never
  dropped. See [`docs/public/authoring-rules.md`](docs/public/authoring-rules.md).
- **"X of Y passing", honestly counted.** A rule counts as passing only when it has zero active
  findings *and* its last run actually succeeded. A rule that has not run, whose query failed, or
  whose result was capped is shown as unknown, never as passing. Per-rule outcomes and a
  complete/partial coverage badge on every run make that visible. See
  [`docs/public/posture.md`](docs/public/posture.md).
- **"Applies to" populations.** A rule can define the population it is measured against, so a
  finding reads "3 of 40 affected" instead of a bare count.
- **A findings lifecycle, not a scan diff.** Every finding is keyed on rule plus resource, tracked
  as new, active or fixed over time, and can be suppressed with a reason and an optional expiry.
  Export as CSV or JSON.
- **Manual and scheduled scans** with an Outlook-style recurrence engine (once, hourly, daily,
  weekly, monthly, with intervals and end conditions), targeting everything, categories, tags, or
  specific rules. Runs never overlap.
- <!-- count:widget-types -->**12 dashboard widget types**: the Overall Posture ring, trend lines,
  category and subscription scorecards, top rules and resources, severity breakdown, coverage and
  freshness, new-versus-fixed velocity, activity occurrences, stat cards and a recent findings feed.
  Filter a whole dashboard by category, subscription, resource group, tag, severity, rule or date
  window; build as many dashboards as you need.
- **Notifications** to Microsoft Teams, Slack, a generic webhook, or email, chosen per schedule
  with a severity threshold, with retry on transient failures and a delivery history you can read.
- <!-- count:roles -->**Three roles** (viewer, editor, admin) enforced on every API route, not just
  in the UI, resolved from the database on every request, with an audit log covering every change.
  Sign in with local accounts or Microsoft Entra ID.
- **Installs as one container.** A generated admin password, a four-step onboarding wizard that
  verifies what your credential can actually reach, a diagnostics page for the support questions,
  and a demo mode that runs against synthetic data with no Azure access at all.

## Why not just use...

- **Azure Policy.** Policy supports audit-only modes and can enforce once you are ready. RuleBeat
  is built for the step before that: defining, observing and operationalizing your standards
  without touching enforcement at all. Use Azure Policy when you are ready to enforce; use RuleBeat
  to get there.
- **Defender for Cloud or Azure Advisor.** Both are valuable and both are security-first or
  recommendation-first. Neither lets you write a check against your own tag standard, naming
  convention or internal rule and then schedule it, suppress the known cases and watch the trend.
  RuleBeat's custom rules cover cost, reliability, identity and governance as well as security, and
  it is self-hosted with no vendor telemetry.
- **A spreadsheet or a one-off script.** Works fine until a second person needs to run it, or until
  you need history, scheduling, or an audit trail. RuleBeat gives you all three from day one.

## See it first

![Dashboard overview with the Overall Posture ring, trend, and stat cards](docs/public/img/dashboard.png)
![Results tab with a finding expanded](docs/public/img/findings.png)
![60 second walkthrough: sign-in, findings, rule builder, a scan run, and the dashboard](docs/public/img/walkthrough.gif)

There is no hosted demo instance yet. The fastest way to see RuleBeat is to run it yourself; the
quick start below takes about five minutes. To show it to someone without connecting an Azure
tenant at all, run it in [demo mode](docs/public/demo-mode.md).

## Quick start (self-host with Docker)

### Prerequisites

- Docker and Docker Compose
- An Azure subscription you have at least Reader access to, if you want to connect real Azure data
  (you can also explore the UI without connecting anything)

### Run it

Pull the built image:

```bash
docker run -d --name rulebeat --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -v rulebeat-data:/app/packages/web/data \
  ghcr.io/rulebeat/rulebeat:0.1.0
```

Or clone and build it yourself:

```bash
git clone https://github.com/rulebeat/rulebeat.git
```

then follow [Local development](#local-development) below.

Nothing else is required. RuleBeat boots with a generated local admin account.

Pin a version tag rather than `:latest`; see [`docs/public/install.md`](docs/public/install.md#upgrading)
for how to check the current version and upgrade deliberately. `:latest` is still published if you
want always-newest instead.

Prefer Docker Compose, or want the full list of optional environment variables (Azure credentials,
Microsoft sign-in, encryption key) documented inline? Save this as `docker-compose.yml`:

```yaml
services:
  rulebeat:
    image: ghcr.io/rulebeat/rulebeat:0.1.0
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - rulebeat-data:/app/packages/web/data
volumes:
  rulebeat-data:
```

then run `docker compose up -d`. See [`docs/public/configure.md`](docs/public/configure.md) for
every optional variable that can go under `environment:`, and for how to reach RuleBeat from
outside the host (put a reverse proxy with TLS in front, do not widen the port binding above).

### Sign in with the generated owner account

The password is written to `data/initial-password.txt` inside the data volume (never to the
container logs, so it does not outlive the forced password change in your log history):

```bash
docker exec rulebeat cat data/initial-password.txt
```

Open `http://localhost:3000`, sign in, and you will be asked to change the password immediately.

### Optional: Microsoft sign-in

If you would rather your team sign in with their work accounts than a shared local password,
configure Microsoft Entra ID from Settings → Sign-in once you are in, or set it up ahead of time
with environment variables. See [`.env.example`](.env.example) and
[`docs/public/configure.md`](docs/public/configure.md).

### Connect Azure

RuleBeat needs a read-only identity to scan with. Connect one from Settings → Azure connection
after signing in, or supply it as an environment variable so the container arrives pre-configured.
Either way, RuleBeat never creates this identity for you. See
[`docs/public/permissions.md`](docs/public/permissions.md) for the exact `az` commands and Portal
steps to create a service principal with Reader and grant it.

Five ways to supply the credential, ranked best first:

| Option | How | Why |
|---|---|---|
| Managed identity | Automatic when RuleBeat itself runs on Azure (VM, AKS, Container Apps) | No secret exists anywhere |
| Workload identity federation | `AZURE_FEDERATED_TOKEN_FILE` | No secret, and works off-Azure too (AKS workload identity, federated CI) |
| Certificate | `AZURE_CLIENT_CERTIFICATE_PATH` / `_PASSWORD` | A secret exists, but not a shared one |
| Client secret, mounted file | `AZURE_CLIENT_SECRET_FILE` | Rotatable without recreating the container, not visible in `docker inspect` |
| Client secret, plain variable | `AZURE_CLIENT_SECRET` | Works everywhere, weakest option |

If you go the service principal route:

```bash
az ad sp create-for-rbac --name rulebeat-reader --role Reader --scopes /subscriptions/<sub-id>
```

Full detail, including the optional Microsoft Graph permission for Directory rules, is in
[`docs/public/permissions.md`](docs/public/permissions.md).

## Local development

```bash
npm install
npm run build:core      # build packages/core before running or typechecking web
npm run dev             # http://localhost:3000
```

Copy `.env.example` (repo root) to `packages/web/.env.local` and fill in values. Run `az login`
for local Azure credential access. Outside a container, `DefaultAzureCredential` falls back to your
own CLI session if nothing else is configured.

```bash
npm test                # everything, both packages
npm run test:watch      # watch mode while working
npx tsc --noEmit        # typecheck, from packages/web or packages/core
```

## How it works

A browser action, like running a scan or saving a rule, goes through a Next.js API route, which
resolves an Azure credential from exactly one place and hands the rule to the engine for its query
backend. A Resource Graph rule runs as the KQL compiled from its conditions (or its raw KQL); a
Directory rule runs as a Microsoft Graph query. The two engines are separate code paths that share
one contract: every returned row is a finding, and every rule ends with exactly one outcome
(success, failed, capped, or invalid), so one rule's failure never hides behind another's success.

Findings persist in a lifecycle table (new, active, fixed) keyed on rule plus resource, and that is
what the Results tab, the dashboards and the trend snapshots all read from. Everything lives in a
SQLite database inside your own deployment; secrets you enter are encrypted at rest. See
[`docs/public/how-it-works.md`](docs/public/how-it-works.md) for the full request path, and
[`docs/public/README.md`](docs/public/README.md) for the index of every guide: installation,
configuration, authoring rules, posture, dashboards, suppressions, notifications, roles, security,
troubleshooting and worked examples. [`docs/public/security.md`](docs/public/security.md) covers
what RuleBeat reads, what it stores, and what it never does; [`SECURITY.md`](SECURITY.md) is how to
report a vulnerability.

## Status

RuleBeat is in public beta. The core product (scanning, rules, dashboards, scheduling,
notifications, RBAC, audit logging) is built and in daily use. What is designed but not yet built
is listed honestly in [`docs/public/whats-next.md`](docs/public/whats-next.md), starting with Logs
and activity rules and generated remediation steps.

The software is free, during beta and after; see License below. Right now this
is a feedback-gathering phase. If something breaks, is confusing, or is missing something you would
need to actually adopt this, [open an issue](https://github.com/rulebeat/rulebeat/issues).

## Feedback & contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Short version: the whole platform is open and
community-contributed under Apache-2.0. [Open an issue](https://github.com/rulebeat/rulebeat/issues)
with bug reports, feature requests, or rule ideas, or open a pull request directly.

## Sponsors

RuleBeat is free and stays that way regardless of sponsorship.
[Sponsoring on GitHub](https://github.com/sponsors/abdohanafy) funds the maintenance time behind
it: triaging issues, reviewing pull requests, writing new rules. See [`SPONSORS.md`](SPONSORS.md)
for the full list.

## License

RuleBeat's license is Apache-2.0, covering the whole platform. The [`LICENSE`](LICENSE) file beside
this README is what governs the copy you are
reading. The rules and content shipped with RuleBeat may carry their own separate license.
