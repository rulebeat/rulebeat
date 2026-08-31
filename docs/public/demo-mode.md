# Demo mode

Demo mode runs the real RuleBeat build over a generated synthetic database, with no Azure tenant
connected. There is no hosted demo today, so this is how you run one yourself: for a team
walkthrough, a screenshot, or a first look before requesting a service principal.

## What it is

The normal build, pointed at a generated database instead of your real one, with three behaviours
switched on. Browsing is **anonymous and read-only**: a visitor opens the URL and is already looking
at dashboards, scans, findings, rules, suppressions and schedules as a viewer, and every request that
would change anything is refused. There is **no Azure access, structurally**: credential resolution
is short-circuited before it reads the environment or the database, so a demo instance cannot connect
to a tenant even with a real service principal in its environment. And there is **no background
work**: the scheduler does not start, and the onboarding and change-password pages are unreachable. A
black bar on every page reads "Demo. Synthetic data. Read-only. Nothing here can be changed." so a
screenshot never passes for a real tenant.

The generator builds a fictional four-subscription estate and replays sixty days of daily scans over
it, so history, trends and finding lifecycles look like a tenant scanned for two months: roughly 50
enabled rules (13 built-ins plus the APRL pack rules whose resource types exist in the estate, out of
<!-- count:pack-rules:aprl-v2 -->143), 28 fictional app registrations at various distances from
credential expiry, and several hundred findings, some fixed along the way. It is deterministic, so
two people generating the demo get the same estate, and every id is an obvious placeholder.

## How to run it

Demo mode runs from a source checkout: the generator is a repo script the published image does not
ship. Generation takes a few minutes.

bash or zsh:

```bash
git clone https://github.com/rulebeat/rulebeat.git
cd rulebeat
npm install
npm run build:core
cd packages/web
RULEBEAT_DEMO=1 npm run generate-demo
RULEBEAT_DEMO=1 npm run dev
```

PowerShell:

```powershell
git clone https://github.com/rulebeat/rulebeat.git
cd rulebeat
npm install
npm run build:core
cd packages/web
$env:RULEBEAT_DEMO = '1'
npm run generate-demo
npm run dev
```

`RULEBEAT_DEMO=1` points the app at `data/demo.db` instead of `data/rulebeat.db` and turns on the
anonymous read-only behaviour. The generator stamps the database it writes (`demo-mode-v1` in its
`meta` table). **Both** the variable and the stamp must be present for demo mode to be active, and
neither is ever set by the running app. Regenerate any time; the script deletes and rebuilds
`demo.db`, and your real database is never touched because the variable switched the file name
before anything else loaded.

## What a demo instance cannot prove

That **your** permissions are right (use the onboarding wizard or Diagnostics against your own
tenant, [`permissions.md`](permissions.md)), anything about performance on a real estate, or
anything about notifications, since no scan runs. The synthetic data also has no suppressions or
notification channels, and the visitor is a viewer, so the admin pages are not part of a
walkthrough.

Demo mode is anonymous by construction, so anyone who reaches the URL can read it. That is fine for
synthetic data, but never point a demo-mode instance at a database that was ever a real one: the
file name switch is the only thing keeping them apart, and `RULEBEAT_DEMO=1` against a stamped
database makes it world-readable.
