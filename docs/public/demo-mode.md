# Demo mode

This page answers: how do I show RuleBeat to someone, or look at it myself, without connecting an
Azure tenant, and what exactly is a demo instance unable to do?

There is no hosted demo today ([`whats-next.md`](whats-next.md)). Demo mode is how you run one
yourself, for a team walkthrough, a screenshot, or a first look before requesting a service
principal.

## What it is

Demo mode is the normal RuleBeat build, pointed at a **generated synthetic database** instead of
your real one, with three behaviours switched on:

- **Anonymous, read-only browsing.** A visitor opens the URL and is already looking at dashboards,
  scans, findings, rules, suppressions and schedules, as a viewer. No sign-in. Every request that
  would change anything is refused with "This is a read-only demo. Nothing here can be changed."
- **No Azure access, structurally.** Credential resolution is short-circuited before it reads the
  environment or the database: a demo instance cannot connect to a tenant even if a real service
  principal is sitting in its environment. "Run scan" and Validate fail with a message that says so.
- **No background work.** The scheduler does not start, and the onboarding wizard and
  change-password pages are not reachable.

A black bar at the top of every page reads "Demo. Synthetic data. Read-only. Nothing here can be
changed." so a screenshot never passes for a real tenant.

## What is in the synthetic data

The generator builds a fictional estate and replays sixty days of daily scans over it, so the
history, trends and finding lifecycles look like a tenant that has been scanned for two months:

- **4 subscriptions** (Contoso Platform Prod and Dev, Contoso Data & Analytics, Contoso Shared
  Services), each with a handful of resource groups and a few hundred resources in total across
  the common types (VMs, disks, NICs, storage accounts, key vaults, load balancers, and so on).
- **Around 50 enabled rules**: 13 hand-picked built-in rules plus every APRL pack rule whose
  resource types exist in the synthetic estate (about 35 of the pack's
  <!-- count:pack-rules:aprl-v2 -->143). The rest of the pack is left disabled, as on a real
  install.
- **28 fictional app registrations** with secrets and certificates at various distances from
  expiry, so the two Directory rules produce critical, high and medium findings, including a few
  already-expired ones.
- **60 days of scan runs** under one seeded schedule ("Daily posture scan"), giving roughly 300
  runs and several hundred findings, some of which get fixed along the way so the New vs Fixed and
  Trend widgets have something to draw.
- **One viewer account** (`demo-visitor`) that anonymous requests are served as.

Everything is deterministic: the generator uses fixed seeds, so two people generating the demo get
the same estate. Every id is an obvious placeholder (`00000000-0000-0000-0000-000000000001`); no
value in it came from a real tenant.

## How to run it

Demo mode runs from a source checkout: the generator is a repo script that the published Docker
image doesn't ship.

1. Clone and build once, from the repo root:

   ```
   git clone https://github.com/rulebeat/rulebeat.git
   cd rulebeat
   npm install
   npm run build:core
   ```

2. Generate the synthetic database, from `packages/web`.

   bash or zsh:

   ```bash
   RULEBEAT_DEMO=1 npm run generate-demo
   ```

   PowerShell:

   ```powershell
   $env:RULEBEAT_DEMO = '1'; npm run generate-demo
   ```

3. Start the app with the same variable in its environment.

   bash or zsh:

   ```bash
   RULEBEAT_DEMO=1 npm run dev
   ```

   PowerShell:

   ```powershell
   $env:RULEBEAT_DEMO = '1'; npm run dev
   ```

   The built `npm run start` works the same way, with the same variable set.

`RULEBEAT_DEMO=1` does two things: it points the app at `data/demo.db` instead of `data/rulebeat.db`,
and it turns on the anonymous read-only behaviour. The generator writes the synthetic database and
finishes by stamping it (`demo-mode-v1` in its `meta` table). **Both** the variable and the stamp
must be present for demo mode to be active: the variable alone against an empty or unstamped
database does not unlock anonymous access, and the stamp alone does nothing without the variable.
Neither is ever set by the running app.

Generation takes a few minutes. Regenerate any time; the script deletes and rebuilds `demo.db`.
Your real database is never touched, because the variable switched the file name before anything
else loaded.

Set `RULEBEAT_DISABLE_SCHEDULER=1` as well if you want to be explicit; in demo mode the scheduler
already refuses to run.

## What to show

A useful ten-minute walkthrough, in the order the product is meant to be read:

1. **Dashboard**: the Overall Posture ring, the Category Scorecard, the Trend over sixty days, Scan
   Coverage. Click a scorecard row or the Top Violating Rules widget through to the Scans page.
2. **Scans, Results tab**: filter by category and severity, open a finding, look at evidence, first
   seen and times seen, the recommendation text, the "Read the official guidance" link on an APRL
   finding.
3. **Scans, Rules tab**: the outcome chips, a rule's query in the builder and in raw KQL, the APRL
   pack label and the disabled rules waiting to be switched on.
4. **Scans, Run History tab**: sixty days of runs, each with its coverage badge.
5. **Schedules**: the seeded daily schedule. Try to edit it; the refusal is itself worth showing.

The synthetic data contains no suppressions, notification channels or Applies to populations, and
the visitor is a viewer, so the admin-only pages (users, audit log, Azure connection, sign-in,
notifications) are not part of the walkthrough. Show those on a real install.

## What a demo instance cannot prove

- That **your** permissions are right. Run the real onboarding wizard or the Diagnostics page
  against your own tenant for that ([`permissions.md`](permissions.md)).
- Anything about performance on a real estate; the synthetic one is small.
- Notifications: nothing is ever sent from a demo instance, because no scan runs.

## Exposing it

Demo mode is anonymous by construction, so if you put it on a public URL, anyone can read it. That
is fine for the synthetic data, but do not point a demo-mode instance at a database that was ever a
real one: the file name switch is the only thing keeping them apart, and `RULEBEAT_DEMO=1` against
a stamped database makes it world-readable. Keep `demo.db` as the generator wrote it.
