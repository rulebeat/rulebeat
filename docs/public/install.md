# Installing RuleBeat

You need Docker. Connecting real Azure data needs a subscription with at least Reader access, and you
can explore the UI without connecting anything.

## Run it

bash or zsh:

```bash
docker run -d --name rulebeat --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -v rulebeat-data:/app/packages/web/data \
  -e AUTH_URL=http://localhost:3000 \
  ghcr.io/rulebeat/rulebeat:0.2.4
```

PowerShell:

```powershell
docker run -d --name rulebeat --restart unless-stopped -p 127.0.0.1:3000:3000 `
  -v rulebeat-data:/app/packages/web/data `
  -e AUTH_URL=http://localhost:3000 `
  ghcr.io/rulebeat/rulebeat:0.2.4
```

Confirm it reports healthy (a few seconds to move past `starting`), then continue with
[First sign-in](#first-sign-in):

```
docker inspect rulebeat --format '{{.State.Health.Status}}'
```

Two things that command decides for you. The port binding is loopback-only, because RuleBeat holds a
live Azure read credential and has no TLS of its own, so it is reachable from this machine and
nowhere else until you put a reverse proxy in front
([`configure.md`](configure.md#exposing-it-beyond-localhost)). And `AUTH_URL` uses `localhost` rather
than `127.0.0.1` because Entra ID accepts a sign-in redirect URI only over HTTPS or on
`http://localhost` and refuses an IP address.

Everything (the SQLite database, the generated admin password, the auth secret, the encryption key)
lives in the `rulebeat-data` named volume. Back that up, not the container.

Prefer Compose? Save this as `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  rulebeat:
    image: ghcr.io/rulebeat/rulebeat:0.2.4
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      AUTH_URL: http://localhost:3000
    volumes:
      - rulebeat-data:/app/packages/web/data
volumes:
  rulebeat-data:
```

The repo's own
[`docker-compose.yml`](https://github.com/rulebeat/rulebeat/blob/main/docker-compose.yml) is the
long-form version: it builds from source and documents every environment variable RuleBeat reads,
each optional. To build from source instead of pulling:

```
git clone https://github.com/rulebeat/rulebeat.git
cd rulebeat
docker compose up -d --build
```

The commands here pin the newest release and are rewritten automatically when one ships, so a copied
command installs a known version and never goes stale. `:latest` tracks the same image, and every
release keeps its own version tag on the
[releases page](https://github.com/rulebeat/rulebeat/releases). Every published image is signed and
carries an SBOM and build provenance you can verify yourself; see
[Verifying a published image](security.md#verifying-a-published-image).

## First sign-in

1. Read the generated admin password. It is written to `data/initial-password.txt` inside the data
   volume, never to the container logs, so it does not outlive the forced change in your log history:

   ```
   docker exec rulebeat cat data/initial-password.txt
   ```

2. Open `http://localhost:3000`, sign in with it, and change the password when prompted. The
   generated one is meant to be used exactly once.

   ![The sign-in page with the local email and password form](img/signin.png)

3. Follow the <!-- count:onboarding-steps -->four-step wizard that opens next: connect Azure, verify
   what the credential can reach, choose what to scan, and run a first scan. See
   [`permissions.md`](permissions.md) for the identity it asks for.

   ![Wizard step 1, Connect Azure, asking for a tenant id, client id and client secret](img/onboarding-connect.png)

   ![Wizard step 3, choosing which categories to scan](img/onboarding-scope.png)

   ![Wizard step 4, running the first scan or finishing later](img/onboarding-scan.png)

To show RuleBeat around before connecting a real tenant, run it in demo mode instead:
[`demo-mode.md`](demo-mode.md).

## Arriving pre-configured

All of the above works with a completely empty `.env`, and everything it sets up can be configured
later from the console. For a deployment that should arrive already configured, set the relevant
environment variables before the first boot. Environment variables always win over anything entered
in the console, so a template deployment never falls back to a setup screen. The full list is in
[`configure.md`](configure.md).

## Upgrading

A running instance shows its version in the sidebar footer and on the Diagnostics page; the
[releases page](https://github.com/rulebeat/rulebeat/releases) shows the newest and what changed.

1. `docker pull ghcr.io/rulebeat/rulebeat:0.2.4`
2. `docker stop rulebeat && docker rm rulebeat` (the data volume is untouched)
3. Start the new one with the same `docker run` command as the install above.

With Compose, update `image:` to the new tag, then `docker compose pull && docker compose up -d` does
both steps.

Migrations run automatically against the existing volume on startup. RuleBeat's test suite includes an
upgrade path test that synthesizes old database shapes and asserts rules, findings, dashboards, users
and suppressions all survive unchanged, specifically because migrations are where data loss tends to
hide.

## Deployment topology

The supported shape is **one replica, one data volume**. That is what is tested, and what the
scheduler and SQLite storage are built for. Two things stand in the way of more. The background
scheduler has no cross-instance coordination, so each replica's 30-second poll loop and busy flag are
in-process and two replicas both run the same due schedule, sending duplicate notifications and
history; `RULEBEAT_DISABLE_SCHEDULER=1` on every replica but one avoids that, but it is a manual
workaround rather than a high-availability story. And SQLite is a single-writer database, fine on a
local volume mounted by one container and not built for concurrent writers across replicas even with
the scheduler issue solved.

The data volume also has to be a local filesystem. RuleBeat opens SQLite in WAL mode, which SQLite
does not support over a network filesystem, so a Docker named volume on the host's own disk works,
and so does a block device such as an Azure managed disk or a block-mode Kubernetes volume. A file
share does not. Mount Azure Files, or any other SMB or NFS share, at `/app/packages/web/data` and the
database cannot be opened at all, so the container fails on startup rather than running with less.
That rules out the managed container platforms whose only persistent storage is a file share, among
them Azure Container Apps, Azure App Service and Azure Container Instances. Those can still run
RuleBeat on ephemeral storage, which is enough for a demo and loses the database on every restart.

Scale the container vertically for now. Multi-replica support (leader election, a real database
backend) is on the roadmap, not built.

## Local development

For contributing to RuleBeat itself, or running it outside Docker:

```bash
npm install
npm run build:core      # build packages/core before running or typechecking web
npm run dev             # http://localhost:3000
npm test                # everything, both packages
npm run typecheck       # typecheck both packages, from the repo root
```

Copy `.env.example` to `packages/web/.env.local` and fill in values. Run `az login` for local Azure
access: outside a container, `DefaultAzureCredential` falls back to your own CLI session.
`packages/web` imports `@rulebeat/core` from its compiled output rather than its source, so
`npm run build:core` has to re-run after a core change before `npm run dev` or a typecheck sees it.
