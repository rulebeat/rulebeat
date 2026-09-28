# Demo mode

Demo mode runs the real RuleBeat build over a generated synthetic database, with no Azure tenant
connected. Run one yourself for a team walkthrough, a screenshot, or a first look before requesting
a service principal.

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

The published image carries the generator, so a Demo runs from any release with one variable:

bash or zsh:

```bash
docker run -d --name rulebeat-demo -p 127.0.0.1:3000:3000   -v rulebeat-demo:/app/packages/web/data   -e RULEBEAT_DEMO=1 -e AUTH_URL=http://localhost:3000   ghcr.io/rulebeat/rulebeat:latest
```

PowerShell:

```powershell
docker run -d --name rulebeat-demo -p 127.0.0.1:3000:3000 `
  -v rulebeat-demo:/app/packages/web/data `
  -e RULEBEAT_DEMO=1 -e AUTH_URL=http://localhost:3000 `
  ghcr.io/rulebeat/rulebeat:latest
```

The first start generates the Demo before the server listens, which takes a minute or two; the
container reports healthy once it is ready. The result is kept as a snapshot in the data volume, and
every later start restores that snapshot instead of generating again, so a restart always returns the
Demo to its starting state. Pin a release tag instead of `latest` to get the same Demo every time.

From a source checkout, `npm run generate-demo` in `packages/web` forces a fresh generation without
starting the app, and `RULEBEAT_DEMO=1 npm run dev` then serves it.

## Choosing the data

A Demo is fully determined by three things: the Data set, the Seed and the release. The same three
always produce the same Demo, down to resource names and finding ages.

| Variable | Default | Meaning |
|---|---|---|
| `RULEBEAT_DEMO_DATASET` | `contoso` | The fictional estate to generate. `contoso` is the only one today. |
| `RULEBEAT_DEMO_SEED` | `0xc0ffee` | Varies names, tags and which resources violate which rule. Decimal or `0x` hex, 0 to 4294967295. |

Changing either one generates a new Demo on the next start. An unknown Data set or an invalid Seed
stops the container with the reason in its log.

## How it stays apart from a real install

`RULEBEAT_DEMO=1` points the app at `data/demo.db` instead of `data/rulebeat.db` and turns on the
anonymous read-only behaviour. The generator stamps the database it writes (`demo-mode-v2` in its
`meta` table). **Both** the variable and the stamp must be present for demo mode to be active, and
neither is ever set by a normal install.

Before it replaces a database, the Demo checks that file for its stamp. If `RULEBEAT_DB_PATH` points a
Demo at a database that is not a Demo database, the container refuses to start and leaves the file
alone. A database stamped by an earlier release's demo (`demo-mode-v1`) counts as a Demo database and
is regenerated.

A Demo runs on SQLite only. With `RULEBEAT_DATABASE_URL` set, it refuses to start.

## What a demo instance cannot prove

That **your** permissions are right (use the onboarding wizard or Diagnostics against your own
tenant, [`permissions.md`](permissions.md)), anything about performance on a real estate, or
anything about notifications, since no scan runs. The synthetic data also has no suppressions or
notification channels, and the visitor is a viewer, so the admin pages are not part of a
walkthrough.

Demo mode is anonymous by construction, so anyone who reaches the URL can read it. That is fine for
synthetic data, and the stamp check above is what keeps a real database out of it.
